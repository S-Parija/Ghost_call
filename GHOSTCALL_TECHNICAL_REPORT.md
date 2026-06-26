# GhostCall Technical Report

This document explains the current GhostCall codebase in detail: what each module does, what each important function does, what problems were found, how they were fixed, and what was added or changed during the upgrade work.

Current live deployment:

```text
https://ghost-call.fastapicloud.dev
```

## 1. Project Goal

GhostCall is a privacy-first browser voice calling application.

The application allows two users to call each other directly from their browsers using WebRTC audio. The backend does not carry the voice stream. It only performs signaling, presence tracking, call state coordination, and optional Web Push notification delivery.

The main privacy rules are:

- No accounts.
- No passwords.
- No email required from users.
- No phone numbers.
- No database.
- No analytics.
- No chat history.
- No call history stored on the server.
- No server-side recordings.
- Ghost IDs are anonymous and generated in the browser.
- Server state is in memory only.

## 2. Current Tech Stack

- Frontend: HTML, CSS, JavaScript.
- Backend: Python, FastAPI.
- Real-time signaling: FastAPI WebSockets.
- Audio calls: WebRTC.
- PWA: Web App Manifest and Service Worker.
- Push notifications: Web Push API with VAPID keys and `pywebpush`.
- Dependency manager: `uv`.
- Deployment: FastAPI Cloud.

## 3. High-Level Architecture

GhostCall has three layers.

### Layer 1: Persistent WebSocket Session

Purpose: Keep users online, registered, and reachable while the browser is open.

Implemented by:

- `static/app.js`
  - Opens the WebSocket immediately when the app starts.
  - Sends heartbeat messages every 12 seconds.
  - Reconnects automatically with exponential backoff.
  - Blocks new calls until the WebSocket is actually online.

- `app/signaling.py`
  - Stores `ghost_id -> websocket` in memory.
  - Updates `last_active` on every message.
  - Removes stale clients after heartbeat timeout.
  - Restores call state if a client briefly reconnects.

### Layer 2: PWA and Push Notification System

Purpose: Let users install GhostCall and receive incoming call notifications when possible.

Implemented by:

- `static/manifest.json`
  - Makes the app installable.

- `static/service-worker.js`
  - Caches app shell files.
  - Shows push notifications.
  - Opens/focuses GhostCall when a notification is tapped.

- `app/main.py`
  - Exposes push public key endpoint.
  - Accepts push subscriptions.

- `app/signaling.py`
  - Stores push subscriptions in memory.
  - Sends push notifications through Web Push when a recipient is offline but subscribed.
  - Creates an ephemeral pending call that can be delivered when the recipient opens GhostCall.

Important limitation: push subscriptions are in memory only. If the FastAPI process restarts, push subscriptions are lost and the user must open GhostCall again to register push.

### Layer 3: Local Call Cache

Purpose: Make repeated calls easier without creating server-side history.

Implemented by:

- `static/app.js`
  - Stores recent Ghost IDs in browser `localStorage`.
  - Shows quick dial buttons.
  - Provides a clear local list button.

No recent contacts are sent to the server.

## 4. Project File Structure

```text
app/
  __init__.py
  main.py
  signaling.py

static/
  index.html
  styles.css
  app.js
  service-worker.js
  manifest.json
  offline.html
  favicon.svg

main.py
pyproject.toml
uv.lock
.env.example
README.md
GHOSTCALL_TECHNICAL_REPORT.md
```

## 5. Backend: `app/main.py`

`app/main.py` creates the FastAPI application, serves static files, exposes PWA and push endpoints, and hosts the WebSocket endpoint.

### Imports

```python
import json
import os
import asyncio
from contextlib import asynccontextmanager
from pathlib import Path
```

These imports are used for:

- `json`: parsing WebSocket and API payloads.
- `os`: reading environment variables such as `ICE_SERVERS_JSON` and VAPID keys.
- `asyncio`: starting the background heartbeat monitor.
- `asynccontextmanager`: defining FastAPI lifespan startup/shutdown behavior.
- `Path`: resolving the project and static directories.

FastAPI imports:

- `FastAPI`: creates the app.
- `Query`: validates WebSocket query parameters.
- `Request`: reads JSON request bodies.
- `WebSocket`: represents WebSocket clients.
- `WebSocketDisconnect`: catches WebSocket disconnect events.
- `GZipMiddleware`: compresses larger HTTP responses.
- `FileResponse`: returns static HTML, manifest, service worker, and favicon files.
- `JSONResponse`: returns structured API errors.
- `StaticFiles`: serves the `/static` folder.

Application imports:

- `MAX_MESSAGE_BYTES`: max accepted WebSocket message size.
- `SignalError`: custom validation error.
- `SignalingHub`: in-memory signaling and presence manager.
- `normalize_ghost_id`: Ghost ID validation and normalization.

### Global Setup

```python
load_dotenv()
BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "static"
hub = SignalingHub()
```

What this does:

- Loads `.env` locally.
- Finds the project root.
- Finds the static directory.
- Creates one in-memory `SignalingHub`.

The `hub` is process-local. It is not stored in any database.

### `lifespan`

```python
@asynccontextmanager
async def lifespan(_: FastAPI):
    monitor_task = asyncio.create_task(hub.monitor_stale_clients())
    try:
        yield
    finally:
        monitor_task.cancel()
```

Purpose:

- Starts a background task when FastAPI starts.
- The task checks stale WebSocket clients and expired calls.
- Cancels the task when the application shuts down.

Why this was added:

- Earlier versions depended only on disconnect events.
- Mobile browsers and networks can silently break connections.
- The monitor prevents ghost users from staying online forever.

### FastAPI App Creation

```python
app = FastAPI(...)
app.add_middleware(GZipMiddleware, minimum_size=800)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
```

Purpose:

- Defines app metadata.
- Enables gzip compression for larger static/API responses.
- Serves all frontend assets under `/static`.

### `index`

```python
@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")
```

Serves the main GhostCall UI.

### `health`

```python
@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
```

Used for:

- FastAPI Cloud health checks.
- Manual deployment verification.

### `manifest`

```python
@app.get("/manifest.json", include_in_schema=False)
async def manifest() -> FileResponse:
    return FileResponse(STATIC_DIR / "manifest.json", media_type="application/manifest+json")
```

Serves the PWA manifest. This allows browsers to identify GhostCall as an installable app.

### `service_worker`

```python
@app.get("/service-worker.js", include_in_schema=False)
async def service_worker() -> FileResponse:
    return FileResponse(STATIC_DIR / "service-worker.js", media_type="application/javascript")
```

Serves the service worker from the root scope. This is required so the service worker can control the whole app.

### `favicon`

```python
@app.get("/favicon.ico", include_in_schema=False)
async def favicon() -> FileResponse:
    return FileResponse(STATIC_DIR / "favicon.svg", media_type="image/svg+xml")
```

Prevents repeated `404` requests for favicon and provides a small app icon.

### `push_public_key`

```python
@app.get("/api/push/public-key")
async def push_public_key() -> dict[str, str | bool]:
    public_key = os.getenv("VAPID_PUBLIC_KEY", "").strip()
    return {"enabled": bool(public_key), "public_key": public_key}
```

Purpose:

- Lets the browser know whether Web Push is configured.
- Sends the browser the VAPID public key.

If `VAPID_PUBLIC_KEY` is missing, the frontend shows alerts as unavailable/not configured.

### `subscribe_push`

```python
@app.post("/api/push/subscribe")
async def subscribe_push(request: Request) -> JSONResponse:
```

Purpose:

- Receives a browser push subscription.
- Validates the Ghost ID.
- Validates that the subscription has the required shape.
- Stores the subscription in memory.

Error handling:

- Invalid JSON returns HTTP 400.
- Invalid Ghost ID returns HTTP 400.
- Invalid subscription returns HTTP 400.

Privacy:

- Subscription is not written to disk.
- Subscription disappears when the process restarts.

### `unsubscribe_push`

```python
@app.post("/api/push/unsubscribe")
async def unsubscribe_push(request: Request) -> JSONResponse:
```

Purpose:

- Removes a Ghost ID push subscription from memory.

### `websocket_endpoint`

```python
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket, ghost_id: str = Query(..., min_length=3, max_length=32)) -> None:
```

Purpose:

- Main WebSocket endpoint for presence, heartbeat, calls, and ICE signaling.

Flow:

1. Validate `ghost_id`.
2. Accept WebSocket.
3. Register Ghost ID in the `SignalingHub`.
4. Send `registered` message to browser.
5. Continuously receive JSON text messages.
6. Reject oversized messages.
7. Parse JSON.
8. Delegate valid messages to `hub.handle`.
9. On disconnect, unregister the exact WebSocket.

Security:

- Ghost ID is validated before use.
- Message size is capped.
- JSON errors are handled.
- Unknown or malformed messages return structured errors.

### `_ice_servers`

```python
def _ice_servers() -> list[dict[str, object]]:
```

Purpose:

- Reads `ICE_SERVERS_JSON` from environment.
- If valid, sends configured STUN/TURN servers to browsers.
- If missing, falls back to Google STUN servers.

Important note:

- STUN is not enough for all networks.
- For reliable production calls, a TURN server should be configured.

## 6. Backend: `app/signaling.py`

`app/signaling.py` contains the in-memory real-time communication logic.

It does not use a database. All state is process-local.

### Constants

```python
GHOST_ID_PATTERN = re.compile(r"^@?[a-zA-Z0-9][a-zA-Z0-9_-]{2,31}$")
MAX_MESSAGE_BYTES = 64_000
HEARTBEAT_TIMEOUT_SECONDS = 35
CALL_RING_TIMEOUT_SECONDS = 30
```

Meaning:

- `GHOST_ID_PATTERN`: allowed Ghost ID format.
- `MAX_MESSAGE_BYTES`: protects server from very large WebSocket messages.
- `HEARTBEAT_TIMEOUT_SECONDS`: stale WebSocket timeout.
- `CALL_RING_TIMEOUT_SECONDS`: incoming call timeout.

### `SignalError`

```python
class SignalError(ValueError):
```

Purpose:

- Represents signaling validation errors.
- Carries a machine-readable `code`.
- Carries a human-readable `message`.

Used when:

- Ghost ID is invalid.
- Message type is missing.
- Payload is malformed.
- Call ID is invalid.

### `Client`

```python
@dataclass
class Client:
```

Represents one active browser WebSocket.

Fields:

- `ghost_id`: normalized Ghost ID.
- `websocket`: active FastAPI WebSocket.
- `state`: `online`, `calling`, `ringing`, or `in_call`.
- `call_id`: current call ID if busy.
- `connected_at`: connection creation timestamp.
- `last_active`: last message/heartbeat timestamp.

### `Call`

```python
@dataclass
class Call:
```

Represents one temporary call.

Fields:

- `call_id`: random call token.
- `caller`: caller Ghost ID.
- `callee`: receiver Ghost ID.
- `offer`: caller WebRTC offer.
- `state`: `pending`, `ringing`, or `active`.
- `created_at`: call creation timestamp.
- `disconnected_at`: timestamp when a call participant disconnected.

Call states:

- `pending`: callee was offline but push was sent.
- `ringing`: callee is online and incoming UI should show.
- `active`: callee accepted and WebRTC answer was sent.

### `normalize_ghost_id`

```python
def normalize_ghost_id(raw: str) -> str:
```

Purpose:

- Trims whitespace.
- Validates format.
- Converts ID to lowercase.

Mitigates:

- Ghost ID injection.
- Invalid routing keys.
- Case mismatch between caller and callee.

### `validate_payload`

```python
def validate_payload(message: Any) -> dict[str, Any]:
```

Purpose:

- Ensures WebSocket message is a JSON object.
- Ensures message has a string `type`.

### `SignalingHub`

```python
class SignalingHub:
```

Central in-memory signaling manager.

Internal maps:

- `_clients`: active Ghost ID to WebSocket client.
- `_calls`: active or pending calls.
- `_push_subscriptions`: Ghost ID to browser push subscription.
- `_lock`: async lock to protect maps from concurrent access.

### `SignalingHub.__init__`

Initializes empty in-memory maps.

No persistent storage is used.

### `register`

```python
async def register(self, ghost_id: str, websocket: WebSocket) -> Client:
```

Purpose:

- Registers a Ghost ID as online.
- Replaces older WebSocket for the same Ghost ID.
- Restores pending/ringing/active call state for reconnecting users.

Important behavior:

- If the same Ghost ID opens elsewhere, the old connection is closed.
- The new connection becomes authoritative.
- `_restore_call_for_client_unlocked` is called to recover pending call state.

Problem fixed:

- Earlier, refresh/reconnect cleared broken state manually.
- Now reconnect can restore server-side call state without requiring full manual recovery.

### `unregister`

```python
async def unregister(self, ghost_id: str, websocket: WebSocket) -> None:
```

Purpose:

- Removes a client when its exact WebSocket disconnects.

Important safety:

- It checks `client.websocket is websocket`.
- This prevents an old socket cleanup from deleting a newer reconnect.

### `register_push_subscription`

```python
async def register_push_subscription(self, ghost_id: str, subscription: dict[str, Any]) -> None:
```

Purpose:

- Stores push subscription for a Ghost ID.

Validation:

- Ghost ID must be valid.
- Subscription must contain HTTPS endpoint.
- Subscription must contain `p256dh` and `auth` keys.

### `remove_push_subscription`

Removes the push subscription for a Ghost ID.

### `handle`

```python
async def handle(self, sender_id: str, raw_message: Any) -> None:
```

Purpose:

- Main message router for WebSocket messages.

Supported message types:

- `heartbeat`
- `presence`
- `call`
- `accept_call`
- `decline_call`
- `ice_candidate`
- `end_call`

For every valid message:

- Payload is validated.
- `last_active` is updated.
- The matching handler is called.

Unknown message types produce `SignalError`.

### `monitor_stale_clients`

```python
async def monitor_stale_clients(self) -> None:
```

Purpose:

- Background loop running every 10 seconds.
- Removes stale clients with no heartbeat.
- Expires pending/ringing calls after 30 seconds.
- Expires active calls if a disconnected peer does not return within heartbeat timeout.

Problems mitigated:

- Mobile browsers silently stopping network activity.
- Users staying falsely online.
- Calls stuck forever in ringing state.

### `_presence`

Sends requester the online/offline state of another Ghost ID.

Currently available for protocol support, though the UI does not expose a separate presence check button.

### `_touch`

Updates `last_active` timestamp for a client.

Called whenever the server receives a valid WebSocket message.

### `_start_call`

```python
async def _start_call(self, caller_id: str, callee_id: str, offer: dict[str, Any]) -> None:
```

Purpose:

- Starts a call using an offer-first WebRTC flow.

Flow for online callee:

1. Validate caller is not calling self.
2. Check caller exists.
3. Check caller is `online`.
4. Check callee exists.
5. Check callee is `online`.
6. Generate `call_id`.
7. Store call in `_calls`.
8. Mark caller `calling`.
9. Mark callee `ringing`.
10. Send `call_ringing` to caller.
11. Send `incoming_call` with WebRTC offer to callee.
12. Also try push notification.

Flow for offline callee with push subscription:

1. Generate `call_id`.
2. Store call as `pending`.
3. Mark caller `calling`.
4. Send Web Push notification.
5. If push succeeds, send `call_ringing` with `delivery: push`.
6. When callee opens app, `_restore_call_for_client_unlocked` delivers the pending call.

Flow for offline callee without push:

1. Clear temporary call.
2. Notify caller with `call_unavailable`, reason `offline`.

### `_accept_call`

```python
async def _accept_call(self, callee_id: str, call_id: str, answer: dict[str, Any]) -> None:
```

Purpose:

- Completes WebRTC signaling when callee accepts.

Flow:

1. Find call.
2. Ensure callee matches call.
3. Ensure caller still exists.
4. Ensure call is `ringing`.
5. Mark call `active`.
6. Mark both clients `in_call`.
7. Send `call_accepted` and WebRTC answer to caller.
8. Send `call_ready` to callee.

### `_decline_call`

Purpose:

- Handles callee decline or auto-timeout.

Flow:

1. Verify call belongs to callee.
2. Notify caller with `call_declined`.
3. Clear call state.

### `_relay_signal`

Purpose:

- Relays ICE candidates between peers.

Important fix:

- If recipient is temporarily disconnected, it now returns without clearing the call.
- This avoids destroying calls during short reconnect windows.

### `_end_call`

Purpose:

- Handles explicit end call.

Flow:

1. Validate call exists.
2. Validate sender is caller or callee.
3. Notify peer with `call_ended`.
4. Clear call state.

### `_cleanup_client_unlocked`

Purpose:

- Handles WebSocket disconnect cleanup.

Current behavior:

- Removes the Ghost ID from active `_clients` immediately.
- If no call is active, cleanup stops.
- If the client was in ringing/active call state, records `disconnected_at`.
- If active peer is still connected, sends `peer_reconnecting`.
- Does not immediately delete active call state.

Why this matters:

- Previously, a short WebSocket drop could end the whole call.
- Now the user has a recovery window.

### `_clear_call_unlocked`

Purpose:

- Removes call record.
- Resets caller/callee client states to `online` if still connected.

### `_restore_call_for_client_unlocked`

Purpose:

- Restores call state after reconnect.

Cases handled:

- `pending` call and callee reconnects: sends `incoming_call`.
- `ringing` call and callee reconnects: sends `incoming_call`.
- `ringing` call and caller reconnects: sends `call_ringing`.
- `active` call and either peer reconnects: sends `session_resumed` to reconnecting peer and `peer_reconnected` to the other peer.

### `_send_to`

Sends a JSON message to one connected Ghost ID.

### `_send_push_unlocked`

Purpose:

- Sends Web Push notification for incoming call.

Payload:

- Title: `Incoming GhostCall`
- Body: `Incoming GhostCall from @caller`
- URL: `/`
- Call ID
- Caller ID

Uses:

- `pywebpush.webpush`
- `VAPID_PRIVATE_KEY` or `VAPID_PRIVATE_KEY_B64`
- `VAPID_SUBJECT`

If push fails:

- Subscription is removed from memory.
- Function returns `False`.

### `_require_call_id`

Validates `call_id` exists and has a reasonable length.

### `_require_ghost_id`

Validates a message field as Ghost ID.

### `_require_webrtc_payload`

Ensures WebRTC payload is an object.

Used for:

- Offers
- Answers
- ICE candidates

### `_safe_send`

Safely sends JSON over WebSocket.

Catches:

- `RuntimeError`
- `WebSocketDisconnect`

This was added because normal browser/test-client disconnects could otherwise throw ASGI errors during cleanup.

### `_safe_close`

Safely closes a WebSocket.

### `_valid_push_subscription`

Checks the subscription format:

- HTTPS endpoint.
- `keys.p256dh`.
- `keys.auth`.

### `_vapid_private_key`

Reads VAPID private key.

Priority:

1. `VAPID_PRIVATE_KEY_B64`: base64 encoded PEM for cloud.
2. `VAPID_PRIVATE_KEY`: path or encoded string.

Reason:

- Cloud environment variables work better with one-line base64 strings than multiline PEM files.

## 7. Frontend: `static/index.html`

This file defines the application structure.

Main sections:

- Top bar with title and connection status.
- Install and notification action buttons.
- Ghost ID display and copy button.
- Dialer input and call button.
- Local quick dial list.
- Fullscreen incoming call panel.
- Active call panel.
- Hidden audio element for remote audio playback.

Important elements:

- `#connectionStatus`: shows Connecting, Online, Reconnecting, Offline.
- `#installButton`: visible install control.
- `#notificationButton`: visible alert enabling control.
- `#ghostId`: current anonymous ID.
- `#targetId`: Ghost ID to call.
- `#callButton`: starts outgoing call.
- `#recentContacts`: local-only quick dial list.
- `#incomingPanel`: fullscreen incoming call UI.
- `#acceptButton`: accepts incoming call.
- `#declineButton`: declines incoming call.
- `#callPanel`: active call UI.
- `#muteButton`: toggles microphone.
- `#recordButton`: starts/stops local recording.
- `#endButton`: ends call.
- `#remoteAudio`: receives remote WebRTC audio stream.

## 8. Frontend: `static/styles.css`

This file implements the UI.

Major design features:

- Dark theme.
- Glassmorphism panels.
- Mobile-first responsive layout.
- Fullscreen incoming call screen.
- Clear connection status pill.
- Touch-friendly controls.
- Quick dial list.

Important classes:

- `.shell`: centers the phone UI.
- `.phone`: phone-like container.
- `.topbar`: title and connection status.
- `.status`: online/offline/reconnecting indicator.
- `.quick-actions`: install and alert buttons.
- `.identity`: Ghost ID display.
- `.dialer`: input and call controls.
- `.recent`: quick dial list.
- `.incoming`: fullscreen incoming call panel.
- `.call`: active call panel.
- `.controls`: mute, record, end call controls.
- `.hidden`: hides inactive panels.

## 9. Frontend: `static/app.js`

This is the main browser application logic.

### Constants

- `GHOST_ID_KEY`: localStorage key for anonymous identity.
- `RECENT_CONTACTS_KEY`: localStorage key for quick dial list.
- `WS_RETRY_BASE_MS`: reconnect base delay.
- `WS_RETRY_MAX_MS`: reconnect max delay.
- `HEARTBEAT_MS`: heartbeat interval, currently 12 seconds.
- `STALE_SOCKET_MS`: stale connection detection, currently 32 seconds.
- `INCOMING_TIMEOUT_SECONDS`: incoming call auto-decline timeout, 30 seconds.

### `elements`

Stores DOM references used by the app.

This avoids repeated `document.querySelector` calls.

### `state`

Stores current browser runtime state.

Important fields:

- `ghostId`: current anonymous identity.
- `socket`: WebSocket instance.
- `reconnectAttempt`: reconnect attempt count.
- `lastSocketMessageAt`: stale socket detection timestamp.
- `sendQueue`: short buffer for messages during reconnect.
- `iceServers`: STUN/TURN servers from backend.
- `callId`: active call ID.
- `peerId`: other user ID.
- `pendingIncoming`: incoming call data.
- `pendingIce`: remote ICE candidates received before peer connection is ready.
- `pendingLocalIce`: local ICE candidates generated before call ID is known.
- `peerConnection`: RTCPeerConnection object.
- `localStream`: microphone stream.
- `remoteStream`: remote audio stream.
- `recorder`: MediaRecorder for local recording.
- `installPrompt`: captured PWA install prompt.

### Event Listeners

The script wires:

- Copy Ghost ID.
- Call button.
- Enter key in dialer.
- Accept call.
- Decline call.
- Mute.
- Record.
- End call.
- Install app.
- Enable ring alerts.
- Clear recent contacts.
- Online/offline browser events.
- Before unload cleanup.

### `boot`

```javascript
async function boot() {
  renderRecentContacts();
  refreshNotificationButton();
  connectSocket();
  setupPwaServices();
}
```

Purpose:

- Display quick dial list.
- Show notification button state.
- Connect WebSocket immediately.
- Start PWA/push setup in background.

Important fix:

- Previously the app waited for service worker/push setup before WebSocket connection.
- On phones, this could delay or block registration.
- This caused the receiver to appear open but not actually be online.
- Now signaling connects first.

### `setupPwaServices`

Registers service worker and push subscription after WebSocket startup.

### `loadGhostId`

Reads Ghost ID from localStorage or generates a new one.

### `generateGhostId`

Creates a random anonymous ID such as:

```text
@silent-orbit-1234
```

### `isValidGhostId`

Checks Ghost ID format on the client.

Server also validates again. Client validation is for user feedback only.

### `registerServiceWorker`

Registers `/service-worker.js`.

Also listens for service worker messages, such as notification click events.

### `registerPushSubscription`

Purpose:

- Checks browser Push API support.
- Fetches VAPID public key.
- Requests notification permission when user clicks the button.
- Creates or reuses PushManager subscription.
- Sends subscription to backend.

Important behavior:

- Does not block WebSocket startup anymore.
- Updates button text: alerts unavailable, not configured, blocked, enabled.

### `refreshNotificationButton`

Updates the notification button based on browser permission state.

### `connectSocket`

Purpose:

- Opens WebSocket to `/ws?ghost_id=...`.
- Registers event handlers.
- Starts heartbeat after open.
- Flushes queued messages.
- Updates connection status UI.

Important behavior:

- Uses `wss://` automatically on HTTPS.
- Uses `ws://` locally.
- Reuses current connection if already open or connecting.

### `startHeartbeat`

Sends heartbeat every 12 seconds.

Also checks if no message has been received for too long and reconnects.

### `stopHeartbeat`

Clears heartbeat and stale-socket timers.

### `scheduleReconnect`

Reconnects using exponential backoff.

Max reconnect delay: 10 seconds.

### `handleSignal`

Main frontend WebSocket message router.

Handles:

- `registered`
- `heartbeat_ack`
- `connection_replaced`
- `call_ringing`
- `incoming_call`
- `call_accepted`
- `call_ready`
- `session_resumed`
- `peer_reconnecting`
- `peer_reconnected`
- `call_declined`
- `call_unavailable`
- `ice_candidate`
- `call_ended`
- `error`

### `send`

Sends JSON over WebSocket.

If socket is not open:

- Queues message if allowed.
- Shows reconnecting message unless quiet.

For actual call request, queueing is disabled. This prevents fake call screens when signaling was not sent.

### `flushSendQueue`

Sends queued messages after reconnect.

### `startOutgoingCall`

Purpose:

- Starts a call from caller side.

Flow:

1. Ensure WebSocket is open.
2. Validate target Ghost ID.
3. Prevent self-call.
4. Prevent calling while busy.
5. Save target to local recent contacts.
6. Show calling UI.
7. Request microphone.
8. Create RTCPeerConnection.
9. Create WebRTC offer.
10. Send `call` with offer to backend.
11. If send fails, reset call state.

Important fix:

- Calls are blocked until the app is truly `Online`.
- This prevents the caller from entering a fake call state when the WebSocket is not ready.

### `isSocketOpen`

Returns true if WebSocket is currently open.

### `acceptIncomingCall`

Purpose:

- Accepts incoming call.

Flow:

1. Stop ringtone and incoming timers.
2. Set call ID and peer ID.
3. Save caller to local recent contacts.
4. Request microphone.
5. Create peer connection.
6. Set remote offer.
7. Drain queued ICE.
8. Create answer.
9. Send `accept_call` with answer.
10. Start call timer.

### `declineIncomingCall`

Sends `decline_call`, stops ringtone, clears incoming state, and returns to dialer.

Used for both manual decline and timeout.

### `preparePeerConnection`

Purpose:

- Creates microphone stream.
- Creates RTCPeerConnection.
- Adds microphone track.
- Handles remote audio tracks.
- Handles local ICE candidates.
- Handles connection failure.

Important detail:

- Local ICE candidates are passed to `sendIceCandidate`.
- If call ID is not known yet, candidates are buffered.

### `receiveAnswer`

Sets caller's remote description using callee answer.

Then drains queued remote ICE candidates.

### `receiveIceCandidate`

Adds remote ICE candidate.

If peer connection or remote description is not ready:

- Candidate is stored in `pendingIce`.
- Later processed by `drainPendingIce`.

### `sendIceCandidate`

Sends local ICE candidate if `callId` exists.

If `callId` does not exist yet:

- Candidate is stored in `pendingLocalIce`.

Problem fixed:

- Earlier, early ICE candidates were dropped before the server returned `call_id`.
- This caused calls to disconnect after about 10-20 seconds on some networks.

### `flushLocalIce`

Sends buffered local ICE candidates after `call_ringing` returns a call ID.

### `drainPendingIce`

Processes remote ICE candidates that arrived before the peer connection was ready.

### `endCall`

Ends a call.

Flow:

1. Send `end_call` if requested.
2. Stop recording.
3. Stop timer.
4. Stop incoming timers.
5. Stop ringtone.
6. Close peer resources.
7. Reset call state.

### `closePeerResources`

Stops local tracks, remote tracks, closes RTCPeerConnection, clears ICE buffers.

### `resetCallState`

Returns UI and state to idle.

### `showIncoming`

Shows fullscreen incoming call UI, starts ringtone, starts 30-second timeout.

### `startIncomingTimeout`

Counts down from 30 seconds and auto-declines if unanswered.

### `stopIncomingTimers`

Clears incoming countdown and timeout.

### `showCalling`

Shows call screen for caller or callee.

### `startActiveCall`

Starts call timer and marks call as connected.

### `updateTimer`

Updates timer text in `MM:SS`.

### `stopTimer`

Stops and resets timer.

### `toggleMute`

Enables/disables local microphone tracks.

### `toggleRecording`

Starts or stops local browser recording.

Uses `MediaRecorder`.

No recording is sent to the server.

### `createMixedRecordingStream`

Mixes local and remote audio into one recording stream using Web Audio API.

### `stopRecording`

Stops MediaRecorder and closes audio context.

### `downloadRecording`

Creates a WebM blob and downloads it locally.

### `startRingtone`

Creates a looping ringtone using Web Audio API oscillator.

No audio file is needed.

### `stopRingtone`

Stops ringtone interval and closes audio context.

### `showLocalIncomingNotification`

If page is hidden and notifications are granted, shows a local notification for an incoming WebSocket call.

This is separate from server-side push. It helps when the tab is open but backgrounded.

### `copyGhostId`

Copies current Ghost ID to clipboard.

### `getRecentContacts`

Reads local quick dial contacts from localStorage.

### `saveRecentContact`

Adds a Ghost ID to local recent contacts.

Keeps only the latest six.

### `clearRecentContacts`

Clears local quick dial list.

### `renderRecentContacts`

Displays recent contact buttons.

Shows an empty message when no recent contacts exist.

### `installApp`

Uses captured PWA install prompt if available.

If browser does not expose install prompt, shows guidance to use browser menu.

### `setPanel`

Shows the active UI panel:

- Dialer.
- Incoming call.
- Active call.

### `setConnectionStatus`

Updates connection status pill.

### `showMessage`

Writes status message to the UI.

### `base64UrlToUint8Array`

Converts VAPID public key into the binary format required by PushManager.

## 10. Service Worker: `static/service-worker.js`

Current cache version:

```javascript
const CACHE_NAME = "ghostcall-v6";
```

Purpose:

- Make GhostCall installable.
- Cache app shell.
- Provide offline fallback.
- Show push notifications.
- Open/focus app when notification is clicked.

### `install` event

Caches:

- `/`
- `/static/index.html`
- `/static/styles.css`
- `/static/app.js`
- `/static/favicon.svg`
- `/static/offline.html`
- `/manifest.json`

Calls `self.skipWaiting()` so new service worker activates faster.

### `activate` event

Deletes old caches and claims clients.

This is important because old service worker versions were causing old JS to remain on phones.

### `fetch` event

Behavior:

- Navigations use network first, offline fallback if network fails.
- Static files use network first, then cache fallback.

Why network-first:

- Earlier cache-first behavior could leave phones on old code after deployment.
- Network-first makes redeploys visible faster.

### `push` event

Shows notification:

- Title: incoming call.
- Body: caller ID.
- Icon and badge.
- Notification data includes URL, call ID, caller.

### `notificationclick` event

When user taps notification:

1. Close notification.
2. Focus existing GhostCall window if open.
3. Otherwise open `/`.
4. Post a message to focused client.

## 11. PWA Manifest: `static/manifest.json`

Defines:

- App name.
- Short name.
- Start URL.
- Scope.
- Standalone display mode.
- Portrait orientation.
- Theme/background colors.
- App icon.

This makes GhostCall installable on supported Android and desktop browsers.

## 12. Offline Page: `static/offline.html`

Shown when app navigation fails due to network loss.

It tells the user they are offline and must reconnect to place or receive calls.

## 13. Root Launcher: `main.py`

Purpose:

- Exports `app` for FastAPI CLI auto-discovery.
- Runs Uvicorn when invoked directly.

Important line:

```python
from app.main import app
```

This was required for FastAPI Cloud to auto-detect the application.

## 14. Dependency Config: `pyproject.toml`

Important dependencies:

- `fastapi[standard]`: FastAPI, Uvicorn, CLI, and recommended runtime dependencies.
- `python-dotenv`: local `.env` loading.
- `pywebpush`: Web Push delivery.

## 15. Environment Config: `.env.example`

Important variables:

- `PORT`: local/server port.
- `ICE_SERVERS_JSON`: STUN/TURN server list.
- `VAPID_PRIVATE_KEY`: local PEM file path or encoded key.
- `VAPID_PRIVATE_KEY_B64`: base64 PEM for cloud deployment.
- `VAPID_PUBLIC_KEY`: browser application server key.
- `VAPID_SUBJECT`: Web Push subject claim.

## 16. FastAPI Cloud Deployment

GhostCall is deployed with FastAPI Cloud.

Live URL:

```text
https://ghost-call.fastapicloud.dev/
```

Deploy command:

```text
uv run fastapi deploy
```

The root `main.py` exports the FastAPI application so the FastAPI CLI can auto-detect the app.

## 17. Problems Found and Fixes Applied

### Problem 1: Receiver did not ring

Symptom:

- Caller saw call screen.
- Receiver phone did not show incoming call.

Root cause:

- Browser startup waited for service worker and push setup before opening WebSocket.
- On phones, service worker or push setup can stall.
- Receiver looked open, but was not registered online.

Fix:

- `boot()` now calls `connectSocket()` first.
- PWA/push setup runs in `setupPwaServices()` in the background.
- Call button blocks until WebSocket is open.

### Problem 2: Call looked started even if not actually sent

Root cause:

- UI moved into call state before guaranteed signaling delivery.

Fix:

- `startOutgoingCall` checks `isSocketOpen()`.
- `send(..., { queue: false })` is used for the initial call request.
- If send fails, call state resets.
- Caller only gets strong feedback after server sends `call_ringing`.

### Problem 3: Calls disconnected after around 14 seconds

Likely root cause:

- Early local ICE candidates were generated before server returned `call_id`.
- Those candidates were dropped.
- WebRTC could start briefly and later fail when ICE negotiation was incomplete.

Fix:

- Added `pendingLocalIce`.
- Added `sendIceCandidate`.
- Added `flushLocalIce`.
- Local ICE is buffered until `call_id` exists.

### Problem 4: Refresh fixed everything

Root cause:

- Refresh manually reset:
  - WebSocket connection.
  - Ghost ID registration.
  - Broken call state.
  - Peer connection.

Fix:

- WebSocket auto reconnect.
- Heartbeat and stale socket detection.
- Server-side call state recovery.
- Session restored messages.
- Peer reconnecting/reconnected messages.

### Problem 5: Service worker served old JavaScript

Root cause:

- Earlier service worker cache could keep old `app.js`.

Fix:

- Service worker is now `ghostcall-v6`.
- Fetch strategy is network-first.
- Old caches are deleted on activation.

### Problem 6: Push notifications were configured in code but disabled in production

Root cause:

- VAPID keys were missing from FastAPI Cloud environment.

Fix:

- Added `VAPID_PRIVATE_KEY_B64`.
- Generated and set VAPID public/private values in FastAPI Cloud.
- Verified `/api/push/public-key` returns `enabled: true`.

### Problem 7: ASGI error on normal WebSocket disconnect

Root cause:

- `_safe_send` caught `RuntimeError` but not `WebSocketDisconnect`.

Fix:

- `_safe_send` and `_safe_close` now catch both.

### Problem 8: ICE sent while peer reconnecting could clear call

Root cause:

- Server cleared call state when ICE recipient was temporarily disconnected.

Fix:

- `_relay_signal` now returns if recipient is absent instead of clearing the call immediately.

### Problem 9: Recent contacts were invisible when empty

Root cause:

- Recent panel was hidden until contacts existed.

Fix:

- Quick dial panel is always visible.
- Empty state explains that recent Ghost IDs are stored locally.
- Clear button is visible but disabled when list is empty.

## 18. What Was Added

Backend:

- Heartbeat tracking.
- Stale client monitor.
- Pending call support.
- Reconnect call restoration.
- Push subscription endpoints.
- Web Push delivery.
- VAPID base64 key support.
- Safer WebSocket cleanup.

Frontend:

- Immediate WebSocket startup.
- Background PWA setup.
- Install button.
- Enable ring alerts button.
- Quick dial list.
- Clear local list button.
- Fullscreen incoming call UI.
- Ringtone.
- 30-second timeout.
- ICE buffering.
- Local recording.
- Better connection messages.

PWA:

- Manifest.
- Service worker.
- Offline fallback.
- Push notification handling.
- Notification click handling.

Deployment:

- FastAPI Cloud deployment.
- VAPID environment variables.

## 19. What Was Removed or Replaced

Removed/replaced behavior:

- Deployment documentation was focused on FastAPI Cloud.
- Call flow was changed from accept-then-offer to offer-first.
- Cache-first service worker behavior was replaced with network-first.
- Hidden install/recent controls were replaced with visible controls.
- Immediate call deletion on disconnect was replaced with reconnect grace state.

## 20. Current Call Flow

### Online Recipient

1. Caller waits until status is `Online`.
2. Caller enters callee Ghost ID.
3. Caller clicks Call.
4. Browser requests microphone.
5. Caller creates WebRTC offer.
6. Caller sends `call` message with offer.
7. Server finds callee online.
8. Server creates call ID.
9. Server sends `call_ringing` to caller.
10. Server sends `incoming_call` to callee.
11. Callee sees fullscreen incoming screen and hears ringtone.
12. Callee clicks Accept.
13. Callee creates WebRTC answer.
14. Callee sends `accept_call`.
15. Server sends answer to caller.
16. Both exchange ICE candidates.
17. Audio flows peer-to-peer.

### Offline Recipient With Push Subscription

1. Caller sends call.
2. Server does not find active callee WebSocket.
3. Server checks push subscription.
4. Server creates pending call.
5. Server sends Web Push.
6. Recipient taps notification.
7. App opens.
8. WebSocket connects.
9. Server restores pending call and sends `incoming_call`.
10. Recipient accepts.

### Offline Recipient Without Push Subscription

1. Caller sends call.
2. Server cannot find callee.
3. No push subscription exists.
4. Server returns `call_unavailable`, reason `offline`.

## 21. Privacy Review

Server stores in memory:

- Active WebSocket clients.
- Temporary call records.
- Ephemeral push subscriptions.

Browser stores locally:

- Ghost ID.
- Recent contacts.
- PWA cache.
- Optional push subscription.
- Local recordings downloaded by user.

Server does not store:

- Accounts.
- Passwords.
- Phone numbers.
- Emails.
- Call recordings.
- Call history.
- Chat history.
- Analytics.

## 22. Known Limitations

### No Database Means Push Subscriptions Are Ephemeral

If the server restarts, push subscriptions are lost. Users must open GhostCall again so the browser can register push again.

This matches the no-database privacy requirement, but it limits offline-call reliability.

### STUN Alone Is Not Fully Reliable

The default ICE config uses public STUN servers.

Some mobile networks, corporate networks, and symmetric NATs require TURN.

For production reliability, set `ICE_SERVERS_JSON` with TURN credentials.

### Mobile Browsers Can Suspend Apps

Even with PWA support, mobile OS behavior may limit background execution. Push notifications help wake the user, but WebRTC cannot continue if the OS kills the browser process.

### Notification Permission Is User Controlled

If user blocks notifications, GhostCall cannot show offline call alerts.

## 23. Verification Performed

Local verification:

- Python compile check passed.
- App import check passed.
- `/health` returned OK.
- Static app JS served.
- Service worker served.
- Push public-key endpoint served.
- Two WebSocket clients registered.
- Caller sent `call`.
- Receiver got `incoming_call`.
- Receiver accepted.
- Caller got `call_accepted`.
- Receiver got `call_ready`.
- WebSocket disconnect cleanup produced no ASGI error after patch.

Live verification:

- FastAPI Cloud deployment status: success.
- `/health` returns OK.
- `/static/app.js` contains startup-order fix.
- `/service-worker.js` contains `ghostcall-v6`.
- `wss://ghost-call.fastapicloud.dev/ws` registers a Ghost ID.

## 24. User Testing Checklist

On both phones:

1. Close GhostCall completely.
2. Reopen `https://ghost-call.fastapicloud.dev`.
3. Wait for status to show `Online`.
4. Tap `Enable ring alerts` on receiver phone.
5. Allow notification permission.
6. Copy receiver Ghost ID.
7. Paste into caller phone.
8. Tap Call.
9. Receiver should show incoming call screen and ringtone.
10. Tap Accept.
11. Allow microphone permission.
12. Audio should connect.

If installed PWA still acts old:

1. Remove installed GhostCall app.
2. Reopen website in browser.
3. Refresh once.
4. Install again.

Reason:

- Mobile browsers sometimes keep an old service worker until the app is closed or reinstalled.

## 25. Recommended Next Improvements

For production reliability:

1. Add TURN server credentials to `ICE_SERVERS_JSON`.
2. Move push subscriptions to an encrypted short-lived store if persistent offline calling becomes more important than no-persistence privacy.
3. Add an in-app diagnostic panel showing:
   - WebSocket state.
   - Last heartbeat.
   - ICE connection state.
   - Peer connection state.
4. Add server-side structured logs for call lifecycle events.
5. Add browser automated tests with Playwright.
