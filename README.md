# GhostCall

GhostCall is a privacy-first browser voice calling app built with FastAPI, WebSockets, WebRTC, and Progressive Web App support. It lets two users call each other directly from their browsers using anonymous Ghost IDs, with no accounts, phone numbers, email addresses, passwords, analytics, database, server-side recordings, or persistent profiles.

## Live App

[Open GhostCall](https://ghost-call.fastapicloud.dev/)

```text
https://ghost-call.fastapicloud.dev/
```

## What GhostCall Does

- Generates an anonymous Ghost ID in the browser.
- Registers the Ghost ID only while the browser is connected.
- Lets one Ghost ID call another Ghost ID.
- Shows a full incoming call screen with ringtone.
- Uses WebRTC encrypted audio for browser-to-browser calling.
- Uses FastAPI WebSockets only for signaling.
- Supports mute, end call, call timer, and local-only recording.
- Reconnects WebSocket sessions automatically after short network drops.
- Supports installable PWA behavior.
- Supports Web Push incoming-call alerts when configured.
- Stores recent contacts locally in the browser only.
- Uses no database.

## Privacy Model

GhostCall is designed to collect the minimum information needed for a call to work.

The browser stores:

- Anonymous Ghost ID in `localStorage`.
- Recent Ghost IDs for quick dial in `localStorage`.
- Optional PWA cache.
- Local recordings downloaded by the user.

The server stores only in memory:

- Active Ghost ID to WebSocket connection mapping.
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

## Main Features

- Anonymous Ghost ID generation
- Copy Ghost ID button
- Connection status indicator
- Online/offline detection
- Call another Ghost ID
- Incoming call screen
- Accept and decline buttons
- Busy status
- Call timer
- Mute and unmute microphone
- End call
- Automatic WebSocket reconnection
- Heartbeat-based active user tracking
- ICE candidate buffering for more reliable WebRTC setup
- Local-only recording with WebM download
- PWA install support
- Web Push support for incoming-call notifications
- Local recent contacts list
- Clear local list button

## Architecture

GhostCall uses three reliability layers.

| Layer | Purpose | Main Files |
| --- | --- | --- |
| Persistent WebSocket session | Keeps Ghost IDs online, restores sessions after brief disconnects, and routes signaling messages. | `app/signaling.py`, `static/app.js` |
| PWA and Web Push | Makes the app installable and enables incoming-call alerts when the browser supports push. | `static/service-worker.js`, `static/manifest.json`, `app/main.py` |
| Local quick dial cache | Stores frequently used Ghost IDs only in the user's browser. | `static/app.js` |

## Project Structure

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
.gitignore
README.md
GHOSTCALL_TECHNICAL_REPORT.md
```

## Module Guide

| File | Purpose |
| --- | --- |
| `app/main.py` | Creates the FastAPI app, serves the frontend, exposes health and push endpoints, and hosts the WebSocket endpoint. |
| `app/signaling.py` | Contains the in-memory signaling hub, active user registry, heartbeat handling, call state, push delivery, and WebRTC signaling relay. |
| `static/index.html` | Defines the phone-style UI structure. |
| `static/styles.css` | Provides the dark glassmorphism layout, responsive design, incoming call screen, dialer, and call controls. |
| `static/app.js` | Runs the frontend application logic: Ghost ID generation, WebSocket reconnect, WebRTC setup, ringtone, recording, quick dial, and PWA setup. |
| `static/service-worker.js` | Handles PWA caching, push notifications, and notification click behavior. |
| `static/manifest.json` | Defines installable PWA metadata. |
| `static/offline.html` | Provides the offline fallback page. |
| `static/favicon.svg` | App icon used by the browser and notifications. |
| `main.py` | Root launcher and FastAPI Cloud auto-discovery entrypoint. |
| `pyproject.toml` | Python package metadata and dependencies. |
| `.env.example` | Example runtime configuration. |
| `GHOSTCALL_TECHNICAL_REPORT.md` | Detailed engineering report explaining modules, functions, problems fixed, and deployment notes. |

## Calling Flow

### Online Recipient

1. User opens GhostCall.
2. Browser loads or generates the local Ghost ID.
3. Browser opens a WebSocket connection.
4. Server registers the Ghost ID in memory.
5. Caller enters another Ghost ID and clicks Call.
6. Caller creates a WebRTC offer and sends it through the signaling WebSocket.
7. Server checks whether the recipient is online and available.
8. Recipient receives `incoming_call`.
9. Recipient accepts or declines.
10. If accepted, WebRTC answer and ICE candidates are exchanged.
11. Audio flows peer-to-peer through WebRTC.
12. When either user ends the call, both peers clean up call state.

### Offline Recipient With Push Subscription

1. Caller starts a call to a Ghost ID that is not currently connected.
2. If the server has a temporary in-memory push subscription, it sends a Web Push notification.
3. The service worker shows an incoming call notification.
4. User taps the notification.
5. GhostCall opens and reconnects with the same Ghost ID.
6. The server delivers the pending incoming call if it has not expired.

Push subscriptions are intentionally in memory only. If the server process restarts, users must reopen GhostCall to register push again.

## Important Problems Fixed

| Problem | Fix |
| --- | --- |
| Receiver did not ring because WebSocket setup waited behind PWA setup. | WebSocket now connects immediately; PWA setup runs in the background. |
| Caller could see a call screen before signaling succeeded. | Calls are blocked until WebSocket is online, and the initial call request is not silently queued. |
| Calls disconnected after a short time because early ICE candidates could be lost. | Local ICE candidates are buffered until a call ID exists. |
| Refresh acted as crash recovery. | Added reconnect, heartbeat, stale socket cleanup, and session restoration. |
| Phones could keep old JavaScript from service worker cache. | Service worker uses network-first loading with an updated cache version. |
| Push was present in code but disabled without VAPID config. | Added VAPID environment support and push status handling. |
| Normal disconnects could create noisy WebSocket errors. | Safe send and close helpers now handle expected disconnect exceptions. |

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

If port `8000` is already in use, run on another port:

```powershell
$env:PORT=8003
uv run python main.py
```

## Environment Variables

Copy the example file for local configuration:

```powershell
Copy-Item .env.example .env
```

Common variables:

| Variable | Purpose |
| --- | --- |
| `PORT` | Local/server port. Defaults to `8000`. |
| `ICE_SERVERS_JSON` | Optional STUN/TURN server list for WebRTC. |
| `VAPID_PUBLIC_KEY` | Public browser application server key for Web Push. |
| `VAPID_PRIVATE_KEY` | Local VAPID private key path or value. |
| `VAPID_PRIVATE_KEY_B64` | Base64-encoded VAPID private PEM for cloud environments. |
| `VAPID_SUBJECT` | Web Push subject, usually `mailto:you@example.com`. |

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

For FastAPI Cloud, use `VAPID_PRIVATE_KEY_B64` instead of uploading a private key file.

## FastAPI Cloud Deployment

GhostCall is deployed at:

[https://ghost-call.fastapicloud.dev/](https://ghost-call.fastapicloud.dev/)

Deploy from the project root:

```powershell
$env:PYTHONIOENCODING='utf-8'
uv run fastapi deploy
```

The root `main.py` exports the FastAPI `app`, so the FastAPI CLI can auto-detect the application.

After deployment, verify:

```text
https://ghost-call.fastapicloud.dev/health
```

Expected response:

```json
{"status":"ok"}
```
