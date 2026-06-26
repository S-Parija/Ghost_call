from __future__ import annotations

import asyncio
import base64
import json
import os
import re
import secrets
import time
from dataclasses import dataclass, field
from typing import Any, Literal

from fastapi import WebSocket
from pywebpush import WebPushException, webpush
from starlette.websockets import WebSocketDisconnect, WebSocketState


GHOST_ID_PATTERN = re.compile(r"^@?[a-zA-Z0-9][a-zA-Z0-9_-]{2,31}$")
MAX_MESSAGE_BYTES = 64_000
HEARTBEAT_TIMEOUT_SECONDS = 35
CALL_RING_TIMEOUT_SECONDS = 30


class SignalError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass
class Client:
    ghost_id: str
    websocket: WebSocket
    state: Literal["online", "calling", "ringing", "in_call"] = "online"
    call_id: str | None = None
    connected_at: float = field(default_factory=time.time)
    last_active: float = field(default_factory=time.time)


@dataclass
class Call:
    call_id: str
    caller: str
    callee: str
    offer: dict[str, Any]
    state: Literal["pending", "ringing", "active"] = "ringing"
    created_at: float = field(default_factory=time.time)
    disconnected_at: float | None = None


def normalize_ghost_id(raw: str) -> str:
    ghost_id = raw.strip()
    if not GHOST_ID_PATTERN.fullmatch(ghost_id):
        raise SignalError(
            "invalid_ghost_id",
            "Ghost ID must be 3-32 characters and use letters, numbers, _, -, or a leading @.",
        )
    return ghost_id.lower()


def validate_payload(message: Any) -> dict[str, Any]:
    if not isinstance(message, dict):
        raise SignalError("malformed_message", "Message must be a JSON object.")
    message_type = message.get("type")
    if not isinstance(message_type, str):
        raise SignalError("malformed_message", "Message type is required.")
    return message


class SignalingHub:
    def __init__(self) -> None:
        self._clients: dict[str, Client] = {}
        self._calls: dict[str, Call] = {}
        self._push_subscriptions: dict[str, dict[str, Any]] = {}
        self._lock = asyncio.Lock()

    async def register(self, ghost_id: str, websocket: WebSocket) -> Client:
        normalized_id = normalize_ghost_id(ghost_id)
        async with self._lock:
            old_client = self._clients.get(normalized_id)
            if old_client is not None:
                await self._safe_send(
                    old_client.websocket,
                    {"type": "connection_replaced", "message": "This Ghost ID connected elsewhere."},
                )
                await self._safe_close(old_client.websocket, code=4002)
                await self._cleanup_client_unlocked(normalized_id, notify_peer=True)

            client = Client(ghost_id=normalized_id, websocket=websocket)
            self._clients[normalized_id] = client
            await self._restore_call_for_client_unlocked(client)
            return client

    async def unregister(self, ghost_id: str, websocket: WebSocket) -> None:
        async with self._lock:
            client = self._clients.get(ghost_id)
            if client is None or client.websocket is not websocket:
                return
            await self._cleanup_client_unlocked(ghost_id, notify_peer=True)

    async def register_push_subscription(self, ghost_id: str, subscription: dict[str, Any]) -> None:
        normalized_id = normalize_ghost_id(ghost_id)
        if not _valid_push_subscription(subscription):
            raise SignalError("malformed_subscription", "Push subscription is invalid.")
        async with self._lock:
            self._push_subscriptions[normalized_id] = subscription

    async def remove_push_subscription(self, ghost_id: str) -> None:
        normalized_id = normalize_ghost_id(ghost_id)
        async with self._lock:
            self._push_subscriptions.pop(normalized_id, None)

    async def handle(self, sender_id: str, raw_message: Any) -> None:
        message = validate_payload(raw_message)
        message_type = message["type"]
        await self._touch(sender_id)

        if message_type == "heartbeat":
            await self._send_to(sender_id, {"type": "heartbeat_ack", "server_time": int(time.time())})
            return

        if message_type == "presence":
            await self._presence(sender_id, self._require_ghost_id(message, "ghost_id"))
            return

        if message_type == "call":
            await self._start_call(sender_id, self._require_ghost_id(message, "to"), self._require_webrtc_payload(message))
            return

        if message_type == "accept_call":
            await self._accept_call(sender_id, self._require_call_id(message), self._require_webrtc_payload(message))
            return

        if message_type == "decline_call":
            await self._decline_call(sender_id, self._require_call_id(message), message.get("reason", "declined"))
            return

        if message_type == "ice_candidate":
            await self._relay_signal(sender_id, self._require_call_id(message), message_type, self._require_webrtc_payload(message))
            return

        if message_type == "end_call":
            await self._end_call(sender_id, self._require_call_id(message), "remote_ended")
            return

        raise SignalError("unknown_message_type", f"Unsupported message type: {message_type}")

    async def monitor_stale_clients(self) -> None:
        while True:
            await asyncio.sleep(10)
            now = time.time()
            async with self._lock:
                stale_clients = [
                    ghost_id
                    for ghost_id, client in self._clients.items()
                    if now - client.last_active > HEARTBEAT_TIMEOUT_SECONDS
                ]
                expired_calls = [
                    call_id
                    for call_id, call in self._calls.items()
                    if (
                        call.state in {"pending", "ringing"}
                        and now - call.created_at > CALL_RING_TIMEOUT_SECONDS
                    )
                    or (
                        call.state == "active"
                        and call.disconnected_at is not None
                        and now - call.disconnected_at > HEARTBEAT_TIMEOUT_SECONDS
                    )
                ]
                for ghost_id in stale_clients:
                    await self._cleanup_client_unlocked(ghost_id, notify_peer=True)
                for call_id in expired_calls:
                    call = self._calls.get(call_id)
                    if call is None:
                        continue
                    caller = self._clients.get(call.caller)
                    callee = self._clients.get(call.callee)
                    if caller is not None:
                        await self._safe_send(caller.websocket, {"type": "call_declined", "call_id": call_id, "reason": "timeout"})
                    if callee is not None:
                        await self._safe_send(callee.websocket, {"type": "call_ended", "call_id": call_id, "reason": "timeout"})
                    await self._clear_call_unlocked(call_id)

    async def _presence(self, requester_id: str, ghost_id: str) -> None:
        async with self._lock:
            client = self._clients.get(requester_id)
            target = self._clients.get(ghost_id)
            if client is not None:
                await self._safe_send(
                    client.websocket,
                    {
                        "type": "presence",
                        "ghost_id": ghost_id,
                        "online": target is not None,
                        "state": target.state if target is not None else "offline",
                    },
                )

    async def _touch(self, ghost_id: str) -> None:
        async with self._lock:
            client = self._clients.get(ghost_id)
            if client is not None:
                client.last_active = time.time()

    async def _start_call(self, caller_id: str, callee_id: str, offer: dict[str, Any]) -> None:
        if caller_id == callee_id:
            raise SignalError("invalid_call", "You cannot call your own Ghost ID.")

        async with self._lock:
            caller = self._clients.get(caller_id)
            callee = self._clients.get(callee_id)
            if caller is None:
                return
            if caller.state != "online":
                await self._safe_send(caller.websocket, {"type": "error", "code": "busy", "message": "You are already in a call."})
                return
            if callee is None:
                call_id = secrets.token_urlsafe(18)
                call = Call(call_id=call_id, caller=caller_id, callee=callee_id, offer=offer, state="pending")
                self._calls[call_id] = call
                caller.state = "calling"
                caller.call_id = call_id
                push_sent = await self._send_push_unlocked(callee_id, caller_id, call_id)
                if push_sent:
                    await self._safe_send(
                        caller.websocket,
                        {"type": "call_ringing", "call_id": call_id, "to": callee_id, "delivery": "push"},
                    )
                    return
                await self._clear_call_unlocked(call_id)
                await self._safe_send(caller.websocket, {"type": "call_unavailable", "reason": "offline", "to": callee_id})
                return
            if callee.state != "online":
                await self._safe_send(caller.websocket, {"type": "call_unavailable", "reason": "busy", "to": callee_id})
                return

            call_id = secrets.token_urlsafe(18)
            self._calls[call_id] = Call(call_id=call_id, caller=caller_id, callee=callee_id, offer=offer)
            caller.state = "calling"
            caller.call_id = call_id
            callee.state = "ringing"
            callee.call_id = call_id

            await self._safe_send(caller.websocket, {"type": "call_ringing", "call_id": call_id, "to": callee_id})
            await self._safe_send(callee.websocket, {"type": "incoming_call", "call_id": call_id, "from": caller_id, "payload": offer})
            await self._send_push_unlocked(callee_id, caller_id, call_id)

    async def _accept_call(self, callee_id: str, call_id: str, answer: dict[str, Any]) -> None:
        async with self._lock:
            call = self._calls.get(call_id)
            callee = self._clients.get(callee_id)
            caller = self._clients.get(call.caller) if call else None
            if call is None or callee is None or caller is None or call.callee != callee_id or call.state != "ringing":
                raise SignalError("invalid_call", "This call is no longer available.")

            call.state = "active"
            caller.state = "in_call"
            callee.state = "in_call"
            await self._safe_send(caller.websocket, {"type": "call_accepted", "call_id": call_id, "by": callee_id, "payload": answer})
            await self._safe_send(callee.websocket, {"type": "call_ready", "call_id": call_id, "with": caller.ghost_id})

    async def _decline_call(self, callee_id: str, call_id: str, reason: Any) -> None:
        async with self._lock:
            call = self._calls.get(call_id)
            if call is None or call.callee != callee_id:
                return
            caller = self._clients.get(call.caller)
            if caller is not None:
                await self._safe_send(
                    caller.websocket,
                    {"type": "call_declined", "call_id": call_id, "by": callee_id, "reason": reason if isinstance(reason, str) else "declined"},
                )
            await self._clear_call_unlocked(call_id)

    async def _relay_signal(self, sender_id: str, call_id: str, message_type: str, payload: dict[str, Any]) -> None:
        async with self._lock:
            call = self._calls.get(call_id)
            if call is None or sender_id not in {call.caller, call.callee}:
                raise SignalError("invalid_call", "No active call found for this signal.")

            recipient_id = call.callee if sender_id == call.caller else call.caller
            recipient = self._clients.get(recipient_id)
            if recipient is None:
                return

            await self._safe_send(
                recipient.websocket,
                {"type": message_type, "call_id": call_id, "from": sender_id, "payload": payload},
            )

    async def _end_call(self, sender_id: str, call_id: str, reason: str) -> None:
        async with self._lock:
            call = self._calls.get(call_id)
            if call is None or sender_id not in {call.caller, call.callee}:
                return

            recipient_id = call.callee if sender_id == call.caller else call.caller
            recipient = self._clients.get(recipient_id)
            if recipient is not None:
                await self._safe_send(recipient.websocket, {"type": "call_ended", "call_id": call_id, "reason": reason})
            await self._clear_call_unlocked(call_id)

    async def _cleanup_client_unlocked(self, ghost_id: str, notify_peer: bool) -> None:
        client = self._clients.pop(ghost_id, None)
        if client is None or client.call_id is None:
            return

        call = self._calls.get(client.call_id)
        if call is None:
            return

        call.disconnected_at = time.time()
        if call.state in {"ringing", "active"}:
            peer_id = call.callee if ghost_id == call.caller else call.caller
            peer = self._clients.get(peer_id)
            if peer is not None and call.state == "active":
                await self._safe_send(peer.websocket, {"type": "peer_reconnecting", "call_id": call.call_id, "with": ghost_id})
            return

        peer_id = call.callee if ghost_id == call.caller else call.caller
        peer = self._clients.get(peer_id)
        if peer is not None:
            peer.state = "online"
            peer.call_id = None
            if notify_peer:
                await self._safe_send(peer.websocket, {"type": "call_ended", "call_id": call.call_id, "reason": "peer_disconnected"})
        self._calls.pop(call.call_id, None)

    async def _clear_call_unlocked(self, call_id: str) -> None:
        call = self._calls.pop(call_id, None)
        if call is None:
            return
        for ghost_id in (call.caller, call.callee):
            client = self._clients.get(ghost_id)
            if client is not None and client.call_id == call_id:
                client.state = "online"
                client.call_id = None

    async def _restore_call_for_client_unlocked(self, client: Client) -> None:
        for call in list(self._calls.values()):
            if client.ghost_id not in {call.caller, call.callee}:
                continue
            call.disconnected_at = None

            if call.state == "pending" and call.callee == client.ghost_id:
                caller = self._clients.get(call.caller)
                if caller is None:
                    self._calls.pop(call.call_id, None)
                    continue
                call.state = "ringing"
                client.state = "ringing"
                client.call_id = call.call_id
                await self._safe_send(
                    client.websocket,
                    {"type": "incoming_call", "call_id": call.call_id, "from": call.caller, "payload": call.offer, "delivery": "push_open"},
                )
                return

            if call.state == "ringing" and call.callee == client.ghost_id:
                client.state = "ringing"
                client.call_id = call.call_id
                await self._safe_send(
                    client.websocket,
                    {"type": "incoming_call", "call_id": call.call_id, "from": call.caller, "payload": call.offer, "delivery": "reconnect"},
                )
                return

            if call.state == "ringing" and call.caller == client.ghost_id:
                client.state = "calling"
                client.call_id = call.call_id
                await self._safe_send(
                    client.websocket,
                    {"type": "call_ringing", "call_id": call.call_id, "to": call.callee, "delivery": "reconnect"},
                )
                return

            if call.state == "active":
                client.state = "in_call"
                client.call_id = call.call_id
                peer_id = call.callee if client.ghost_id == call.caller else call.caller
                await self._safe_send(
                    client.websocket,
                    {"type": "session_resumed", "call_id": call.call_id, "with": peer_id},
                )
                peer = self._clients.get(peer_id)
                if peer is not None:
                    await self._safe_send(peer.websocket, {"type": "peer_reconnected", "call_id": call.call_id, "with": client.ghost_id})
                return
            return

    async def _send_to(self, ghost_id: str, message: dict[str, Any]) -> None:
        async with self._lock:
            client = self._clients.get(ghost_id)
            if client is not None:
                await self._safe_send(client.websocket, message)

    async def _send_push_unlocked(self, callee_id: str, caller_id: str, call_id: str | None) -> bool:
        subscription = self._push_subscriptions.get(callee_id)
        private_key = _vapid_private_key()
        subject = os.getenv("VAPID_SUBJECT", "mailto:admin@example.com").strip()
        if subscription is None or not private_key:
            return False

        payload = json.dumps(
            {
                "title": "Incoming GhostCall",
                "body": f"Incoming GhostCall from {caller_id}",
                "url": "/",
                "call_id": call_id,
                "caller": caller_id,
            }
        )
        try:
            await asyncio.to_thread(
                webpush,
                subscription_info=subscription,
                data=payload,
                vapid_private_key=private_key,
                vapid_claims={"sub": subject},
            )
            return True
        except WebPushException:
            self._push_subscriptions.pop(callee_id, None)
            return False

    @staticmethod
    def _require_call_id(message: dict[str, Any]) -> str:
        call_id = message.get("call_id")
        if not isinstance(call_id, str) or not 10 <= len(call_id) <= 64:
            raise SignalError("malformed_message", "A valid call_id is required.")
        return call_id

    @staticmethod
    def _require_ghost_id(message: dict[str, Any], key: str) -> str:
        value = message.get(key)
        if not isinstance(value, str):
            raise SignalError("malformed_message", f"{key} must be a Ghost ID.")
        return normalize_ghost_id(value)

    @staticmethod
    def _require_webrtc_payload(message: dict[str, Any]) -> dict[str, Any]:
        payload = message.get("payload")
        if not isinstance(payload, dict):
            raise SignalError("malformed_message", "WebRTC payload must be an object.")
        return payload

    @staticmethod
    async def _safe_send(websocket: WebSocket, message: dict[str, Any]) -> None:
        if websocket.application_state == WebSocketState.CONNECTED:
            try:
                await websocket.send_json(message)
            except (RuntimeError, WebSocketDisconnect):
                pass

    @staticmethod
    async def _safe_close(websocket: WebSocket, code: int) -> None:
        if websocket.application_state == WebSocketState.CONNECTED:
            try:
                await websocket.close(code=code)
            except (RuntimeError, WebSocketDisconnect):
                pass


def _valid_push_subscription(subscription: dict[str, Any]) -> bool:
    keys = subscription.get("keys")
    endpoint = subscription.get("endpoint")
    return (
        isinstance(endpoint, str)
        and endpoint.startswith("https://")
        and isinstance(keys, dict)
        and isinstance(keys.get("p256dh"), str)
        and isinstance(keys.get("auth"), str)
    )


def _vapid_private_key() -> str:
    encoded_key = os.getenv("VAPID_PRIVATE_KEY_B64", "").strip()
    if encoded_key:
        try:
            return base64.b64decode(encoded_key).decode("utf-8")
        except (ValueError, UnicodeDecodeError):
            return ""
    return os.getenv("VAPID_PRIVATE_KEY", "").strip()
