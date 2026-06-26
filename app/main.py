from __future__ import annotations

import json
import os
import asyncio
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from app.signaling import MAX_MESSAGE_BYTES, SignalError, SignalingHub, normalize_ghost_id


load_dotenv()

BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "static"
hub = SignalingHub()


@asynccontextmanager
async def lifespan(_: FastAPI):
    monitor_task = asyncio.create_task(hub.monitor_stale_clients())
    try:
        yield
    finally:
        monitor_task.cancel()


app = FastAPI(
    title="GhostCall",
    description="Privacy-first browser voice calling with WebRTC signaling over WebSockets.",
    version="1.0.0",
    lifespan=lifespan,
)
app.add_middleware(GZipMiddleware, minimum_size=800)

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/manifest.json", include_in_schema=False)
async def manifest() -> FileResponse:
    return FileResponse(STATIC_DIR / "manifest.json", media_type="application/manifest+json")


@app.get("/service-worker.js", include_in_schema=False)
async def service_worker() -> FileResponse:
    return FileResponse(STATIC_DIR / "service-worker.js", media_type="application/javascript")


@app.get("/favicon.ico", include_in_schema=False)
async def favicon() -> FileResponse:
    return FileResponse(STATIC_DIR / "favicon.svg", media_type="image/svg+xml")


@app.get("/api/push/public-key")
async def push_public_key() -> dict[str, str | bool]:
    public_key = os.getenv("VAPID_PUBLIC_KEY", "").strip()
    return {"enabled": bool(public_key), "public_key": public_key}


@app.post("/api/push/subscribe")
async def subscribe_push(request: Request) -> JSONResponse:
    try:
        payload = await request.json()
        ghost_id = normalize_ghost_id(payload.get("ghost_id", ""))
        subscription = payload.get("subscription")
        if not isinstance(subscription, dict):
            raise SignalError("malformed_subscription", "Push subscription is invalid.")
        await hub.register_push_subscription(ghost_id, subscription)
        return JSONResponse({"status": "ok"})
    except (json.JSONDecodeError, SignalError) as exc:
        message = exc.message if isinstance(exc, SignalError) else "Request must be valid JSON."
        return JSONResponse({"status": "error", "message": message}, status_code=400)


@app.post("/api/push/unsubscribe")
async def unsubscribe_push(request: Request) -> JSONResponse:
    try:
        payload = await request.json()
        await hub.remove_push_subscription(payload.get("ghost_id", ""))
        return JSONResponse({"status": "ok"})
    except (json.JSONDecodeError, SignalError) as exc:
        message = exc.message if isinstance(exc, SignalError) else "Request must be valid JSON."
        return JSONResponse({"status": "error", "message": message}, status_code=400)


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket, ghost_id: str = Query(..., min_length=3, max_length=32)) -> None:
    try:
        normalized_id = normalize_ghost_id(ghost_id)
    except SignalError as exc:
        await websocket.close(code=1008, reason=exc.message)
        return

    await websocket.accept()
    client = await hub.register(normalized_id, websocket)
    await websocket.send_json(
        {
            "type": "registered",
            "ghost_id": client.ghost_id,
            "ice_servers": _ice_servers(),
        }
    )

    try:
        while True:
            raw_text = await websocket.receive_text()
            if len(raw_text.encode("utf-8")) > MAX_MESSAGE_BYTES:
                await websocket.send_json({"type": "error", "code": "message_too_large", "message": "Message is too large."})
                continue

            try:
                message = json.loads(raw_text)
                await hub.handle(client.ghost_id, message)
            except json.JSONDecodeError:
                await websocket.send_json({"type": "error", "code": "invalid_json", "message": "Message must be valid JSON."})
            except SignalError as exc:
                await websocket.send_json({"type": "error", "code": exc.code, "message": exc.message})
    except WebSocketDisconnect:
        pass
    finally:
        await hub.unregister(client.ghost_id, websocket)


def _ice_servers() -> list[dict[str, object]]:
    configured = os.getenv("ICE_SERVERS_JSON", "").strip()
    if configured:
        try:
            servers = json.loads(configured)
            if isinstance(servers, list):
                return servers
        except json.JSONDecodeError:
            pass
    return [{"urls": ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"]}]
