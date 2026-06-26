# GhostCall

GhostCall is a privacy-first browser voice calling app. It lets two users call each other directly from their browsers with anonymous Ghost IDs, WebRTC audio, FastAPI WebSocket signaling, PWA support, and optional Web Push incoming-call alerts.

Live app:

```text
https://ghost-call.fastapicloud.dev
```

## What GhostCall Does

- Generates an anonymous Ghost ID in the browser.
- Keeps users online through a persistent WebSocket session.
- Lets one Ghost ID call another Ghost ID.
- Shows a fullscreen incoming call screen with ringtone.
- Uses WebRTC for encrypted peer-to-peer audio.
- Supports mute, end call, call timer, and local-only recording.
- Reconnects WebSocket automatically after short network drops.
- Supports installable PWA behavior.
- Supports Web Push incoming-call alerts when configured.
- Stores recent contacts locally only in the browser.
- Uses no database and no user accounts.

## Privacy Model

GhostCall intentionally avoids user accounts and persistent server storage.

The browser stores:

- Anonymous Ghost ID in `localStorage`.
- Recent Ghost IDs for quick dial in `localStorage`.
- Optional PWA cache.
- Local recordings downloaded by the user.

The server stores only in memory:

- Active Ghost ID to WebSocket connection map.
- Temporary call state while a call is pending, ringing, or active.
- Temporary push subscriptions while the process is running.

The server does not store:

- Names
- Emails
- Phone numbers
- Passwords
- Call history
- Chat history
- Analytics
- Audio recordings
- Persistent profiles

## Main Architecture

GhostCall has three main reliability layers.

### Layer 1: Persistent WebSocket Session

The WebSocket keeps each Ghost ID reachable while the browser is open.

Backend responsibilities:

- Keep an in-memory `ghost_id -> websocket` map.
- Validate Ghost IDs.
- Track online, calling, ringing, and in-call states.
- Update heartbeat timestamps.
- Remove stale users.
- Restore temporary call state after reconnect.

Frontend responsibilities:

- Connect WebSocket immediately when the app opens.
- Send heartbeat every 12 seconds.
- Reconnect with exponential backoff.
- Reuse the same Ghost ID on reconnect.
- Block calls until the app is actually `Online`.

### Layer 2: PWA and Push Notifications

The PWA layer makes GhostCall installable and enables incoming-call alerts.

Components:

- `manifest.json` makes the app installable.
- `service-worker.js` caches the app shell and handles push notifications.
- `/api/push/public-key` gives browsers the VAPID public key.
- `/api/push/subscribe` stores a push subscription in memory.
- The backend sends Web Push alerts for offline recipients with active subscriptions.

Offline-call flow:

```text
Caller -> FastAPI backend -> push service -> service worker -> notification -> user taps -> GhostCall opens -> pending call is delivered
```

### Layer 3: Local Quick Dial Cache

Recent contacts are stored locally only.

- Recent Ghost IDs appear in the Quick dial section.
- Quick dial buttons call saved IDs.
- Clear local list removes the browser-only history.
- No recent contacts are sent to the server.

## Module-by-Module Explanation

### `app/main.py`

FastAPI entrypoint for HTTP routes, static files, push API routes, and the WebSocket endpoint.

Responsibilities:

- Creates the FastAPI app.
- Starts the stale-client monitor during app lifespan.
- Serves `/`, `/static/*`, `/manifest.json`, `/service-worker.js`, and `/favicon.ico`.
- Provides `/health` for deployment health checks.
- Provides push endpoints:
  - `GET /api/push/public-key`
  - `POST /api/push/subscribe`
  - `POST /api/push/unsubscribe`
- Provides `WebSocket /ws`.
- Validates incoming WebSocket message size.
- Parses WebSocket JSON messages.
- Delegates signaling logic to `SignalingHub`.
- Sends ICE server configuration to clients.

Important functions:

- `lifespan`: starts and stops the background stale-client monitor.
- `index`: serves the main UI.
- `health`: returns `{"status": "ok"}`.
- `manifest`: serves the PWA manifest.
- `service_worker`: serves the service worker from root scope.
- `push_public_key`: exposes VAPID public key for browser push setup.
- `subscribe_push`: validates and stores push subscriptions in memory.
- `unsubscribe_push`: removes push subscriptions from memory.
- `websocket_endpoint`: accepts and manages WebSocket signaling sessions.
- `_ice_servers`: loads STUN/TURN config from `ICE_SERVERS_JSON`.

### `app/signaling.py`

Core in-memory real-time signaling system.

Responsibilities:

- Validate Ghost IDs and WebSocket messages.
- Store active users in memory.
- Store temporary call state in memory.
- Store push subscriptions in memory.
- Handle heartbeat.
- Handle presence lookup.
- Start calls.
- Accept calls.
- Decline calls.
- Relay ICE candidates.
- End calls.
- Send push notifications.
- Restore calls after reconnect.

Important classes:

- `SignalError`: structured validation error.
- `Client`: one online WebSocket client.
- `Call`: one pending, ringing, or active call.
- `SignalingHub`: central in-memory signaling manager.

Important functions and methods:

- `normalize_ghost_id`: validates and normalizes Ghost IDs.
- `validate_payload`: validates WebSocket message shape.
- `SignalingHub.register`: registers a Ghost ID as online and restores pending call state.
- `SignalingHub.unregister`: removes an exact WebSocket connection.
- `register_push_subscription`: stores push subscription in memory.
- `remove_push_subscription`: removes push subscription.
- `handle`: routes WebSocket messages by type.
- `monitor_stale_clients`: removes stale users and expired calls.
- `_start_call`: creates call state and sends incoming call or push alert.
- `_accept_call`: accepts call and sends WebRTC answer.
- `_decline_call`: declines or times out a call.
- `_relay_signal`: relays ICE candidates.
- `_end_call`: ends call for both sides.
- `_cleanup_client_unlocked`: handles disconnect without immediately destroying active calls.
- `_restore_call_for_client_unlocked`: restores pending/ringing/active call state after reconnect.
- `_send_push_unlocked`: sends Web Push notification.
- `_safe_send`: sends WebSocket JSON safely.
- `_vapid_private_key`: loads VAPID private key from file, string, or base64 env var.

### `static/index.html`

Main browser UI structure.

Contains:

- Header with app name and connection status.
- Install app button.
- Enable ring alerts button.
- Ghost ID display and copy button.
- Dialer input and Call button.
- Quick dial local recent contacts.
- Fullscreen incoming call panel.
- Active call panel.
- Mute, record, and end call buttons.
- Hidden audio element for remote WebRTC audio.

### `static/styles.css`

All visual design and responsive layout.

Contains:

- Dark theme.
- Glassmorphism phone-like layout.
- Responsive mobile styling.
- Connection status indicators.
- Fullscreen incoming call screen.
- Quick dial list styling.
- Call controls.
- Smooth button and panel styling.

### `static/app.js`

Main frontend application logic.

Responsibilities:

- Generate and load anonymous Ghost ID.
- Register service worker.
- Set up push notifications.
- Connect WebSocket immediately on page load.
- Send heartbeat.
- Reconnect automatically.
- Start outgoing calls.
- Show incoming calls.
- Accept and decline calls.
- Create WebRTC offers and answers.
- Buffer ICE candidates until call ID or peer connection is ready.
- Play ringtone.
- Show local notification when tab is backgrounded.
- Record calls locally with `MediaRecorder`.
- Download recordings as WebM.
- Store recent contacts locally.
- Handle install button and notification button.

Important functions:

- `boot`: starts UI, WebSocket, and background PWA setup.
- `setupPwaServices`: registers service worker and push after WebSocket startup.
- `loadGhostId`: loads or creates anonymous ID.
- `generateGhostId`: creates random Ghost ID.
- `registerServiceWorker`: registers PWA service worker.
- `registerPushSubscription`: requests notification permission and stores push subscription.
- `connectSocket`: opens WebSocket and handles reconnect.
- `startHeartbeat`: sends heartbeat every 12 seconds.
- `handleSignal`: routes server messages.
- `send`: sends WebSocket JSON safely.
- `startOutgoingCall`: creates WebRTC offer and sends call request.
- `acceptIncomingCall`: creates WebRTC answer and accepts incoming call.
- `declineIncomingCall`: declines incoming call.
- `preparePeerConnection`: creates microphone stream and RTCPeerConnection.
- `receiveAnswer`: applies remote WebRTC answer.
- `receiveIceCandidate`: applies or buffers remote ICE candidate.
- `sendIceCandidate`: sends or buffers local ICE candidate.
- `flushLocalIce`: sends early ICE candidates once call ID exists.
- `endCall`: ends call and clears resources.
- `toggleMute`: mutes/unmutes microphone.
- `toggleRecording`: starts/stops local recording.
- `downloadRecording`: downloads WebM recording.
- `startRingtone`: plays ringtone using Web Audio API.
- `saveRecentContact`: stores quick dial entry locally.
- `renderRecentContacts`: renders local quick dial buttons.
- `installApp`: opens browser PWA install prompt when available.

### `static/service-worker.js`

PWA service worker.

Current cache version:

```text
ghostcall-v6
```

Responsibilities:

- Cache app shell.
- Delete old caches.
- Use network-first loading so new deployments reach phones faster.
- Show Web Push notifications.
- Focus or open GhostCall when notification is clicked.

Important events:

- `install`: caches app shell and activates quickly.
- `activate`: deletes old caches and claims clients.
- `fetch`: serves network-first app files with cache fallback.
- `push`: displays incoming call notification.
- `notificationclick`: opens or focuses GhostCall.

### `static/manifest.json`

PWA manifest.

Defines:

- App name.
- Short name.
- Start URL.
- Scope.
- Standalone display mode.
- Theme color.
- App icon.

### `static/offline.html`

Offline fallback page shown when navigation fails.

### `static/favicon.svg`

Small app icon used for browser favicon and notifications.

### `main.py`

Root launcher.

Responsibilities:

- Exports `app` for FastAPI CLI and FastAPI Cloud auto-discovery.
- Runs Uvicorn locally when called with `python main.py`.

### `pyproject.toml`

Python project metadata and dependencies.

Main dependencies:

- `fastapi[standard]`
- `python-dotenv`
- `pywebpush`

### `render.yaml`

Render deployment blueprint.

### `.env.example`

Example environment configuration.

Important variables:

- `PORT`
- `ICE_SERVERS_JSON`
- `VAPID_PRIVATE_KEY`
- `VAPID_PRIVATE_KEY_B64`
- `VAPID_PUBLIC_KEY`
- `VAPID_SUBJECT`

### `GHOSTCALL_TECHNICAL_REPORT.md`

Detailed engineering report with function-by-function explanations, problem history, fixes, privacy notes, verification, and limitations.

## Major Problems Fixed

### 1. Receiver did not ring

Problem:

The receiver phone could show the app but not actually be registered online because WebSocket connection waited behind PWA/push setup.

Fix:

`static/app.js` now connects WebSocket immediately. PWA and push setup run in the background.

### 2. Caller saw a call screen even when call was not sent

Problem:

The UI could enter calling state before signaling was confirmed.

Fix:

Calls are blocked until WebSocket is open. The call request is not queued. If the call message cannot be sent, the call is cancelled locally.

### 3. Calls disconnected after about 14 seconds

Problem:

Early ICE candidates could be created before `call_id` existed, so they were dropped.

Fix:

Added local ICE buffering with `pendingLocalIce`, `sendIceCandidate`, and `flushLocalIce`.

### 4. Refresh acted as crash recovery

Problem:

Refresh reconnected WebSocket, cleared broken state, and restarted ICE negotiation manually.

Fix:

Added automatic reconnect, heartbeat, stale socket detection, and session restoration.

### 5. Old JavaScript stayed on phones

Problem:

Service worker caching could keep old app logic.

Fix:

Service worker uses `ghostcall-v6` and network-first asset loading.

### 6. Push notifications were not actually enabled in production

Problem:

VAPID keys were missing from cloud environment.

Fix:

Added VAPID env support and configured FastAPI Cloud with VAPID keys.

### 7. WebSocket disconnects could raise server errors

Problem:

Normal disconnects could raise `WebSocketDisconnect` during cleanup sends.

Fix:

`_safe_send` and `_safe_close` catch both `RuntimeError` and `WebSocketDisconnect`.

## Local Setup

Install dependencies:

```powershell
uv sync
```

Run locally:

```powershell
uv run python main.py
```

Open:

```text
http://localhost:8000
```

FastAPI CLI alternative:

```powershell
uv run fastapi dev main.py
```

## Configuration

Copy example config:

```powershell
Copy-Item .env.example .env
```

Generate VAPID keys:

```powershell
uv run vapid --gen
uv run vapid --applicationServerKey --private-key private_key.pem
```

For local development:

```text
VAPID_PRIVATE_KEY=private_key.pem
VAPID_PUBLIC_KEY=<application server key>
VAPID_SUBJECT=mailto:you@example.com
```

For cloud deployments, base64 encode the private PEM and use:

```text
VAPID_PRIVATE_KEY_B64=<base64 pem>
```

## Deployment

### FastAPI Cloud

Deploy:

```powershell
$env:PYTHONIOENCODING='utf-8'
uv run fastapi deploy
```

### Render

This repo includes `render.yaml`.

Add required environment variables in Render:

- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY` or `VAPID_PRIVATE_KEY_B64`
- `VAPID_SUBJECT`
- `ICE_SERVERS_JSON` if using TURN

## GitHub Upload Safety

Files and folders intentionally ignored:

- `.venv/`
- `.env`
- `.agents/`
- `.fastapicloud/`
- `__pycache__/`
- `.pytest_cache/`
- `.ruff_cache/`
- `.mypy_cache/`
- `private_key.pem`
- `public_key.pem`
- Python bytecode
- OS metadata

Important files that should be uploaded:

- `app/`
- `static/`
- `main.py`
- `pyproject.toml`
- `uv.lock`
- `.python-version`
- `.env.example`
- `.gitignore`
- `README.md`
- `GHOSTCALL_TECHNICAL_REPORT.md`
- `render.yaml`

## Upload to GitHub

Git and GitHub CLI are not available in this current environment, so the repository cannot be pushed from here.

Run these commands on a machine where Git is installed:

```powershell
cd D:\Project\ghost_call
git init
git add .
git status
git commit -m "Initial GhostCall privacy-first WebRTC calling app"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPOSITORY.git
git push -u origin main
```

Before pushing, confirm `git status` does not include:

- `.venv`
- `.env`
- `.fastapicloud`
- `.agents`
- `private_key.pem`
- `public_key.pem`
- `__pycache__`

## Recommended GitHub Repository Description

```text
Privacy-first browser voice calling app using FastAPI, WebSockets, WebRTC, PWA, and Web Push.
```

## Recommended GitHub Topics

```text
fastapi
webrtc
websocket
pwa
web-push
privacy
voice-calling
javascript
python
no-database
```

## More Details

For a deeper engineering report, read:

[GHOSTCALL_TECHNICAL_REPORT.md](GHOSTCALL_TECHNICAL_REPORT.md)
