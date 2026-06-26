const GHOST_ID_KEY = "ghostcall.ghost_id";
const RECENT_CONTACTS_KEY = "ghostcall.recent_contacts";
const WS_RETRY_BASE_MS = 700;
const WS_RETRY_MAX_MS = 10000;
const HEARTBEAT_MS = 12000;
const STALE_SOCKET_MS = 32000;
const INCOMING_TIMEOUT_SECONDS = 30;

const elements = {
  ghostId: document.querySelector("#ghostId"),
  copyIdButton: document.querySelector("#copyIdButton"),
  connectionStatus: document.querySelector("#connectionStatus"),
  installButton: document.querySelector("#installButton"),
  notificationButton: document.querySelector("#notificationButton"),
  targetId: document.querySelector("#targetId"),
  callButton: document.querySelector("#callButton"),
  recentContacts: document.querySelector("#recentContacts"),
  recentList: document.querySelector("#recentList"),
  clearRecentButton: document.querySelector("#clearRecentButton"),
  recentEmpty: document.querySelector("#recentEmpty"),
  dialerPanel: document.querySelector("#dialerPanel"),
  incomingPanel: document.querySelector("#incomingPanel"),
  incomingFrom: document.querySelector("#incomingFrom"),
  incomingCountdown: document.querySelector("#incomingCountdown"),
  acceptButton: document.querySelector("#acceptButton"),
  declineButton: document.querySelector("#declineButton"),
  callPanel: document.querySelector("#callPanel"),
  callLabel: document.querySelector("#callLabel"),
  peerId: document.querySelector("#peerId"),
  timer: document.querySelector("#timer"),
  muteButton: document.querySelector("#muteButton"),
  recordButton: document.querySelector("#recordButton"),
  endButton: document.querySelector("#endButton"),
  message: document.querySelector("#message"),
  remoteAudio: document.querySelector("#remoteAudio"),
};

const state = {
  ghostId: loadGhostId(),
  socket: null,
  reconnectTimer: null,
  reconnectAttempt: 0,
  manualClose: false,
  lastSocketMessageAt: 0,
  heartbeatTimer: null,
  staleTimer: null,
  sendQueue: [],
  iceServers: [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }],
  callId: null,
  peerId: null,
  role: null,
  pendingIncoming: null,
  pendingIce: [],
  pendingLocalIce: [],
  peerConnection: null,
  localStream: null,
  remoteStream: new MediaStream(),
  callStartedAt: null,
  timerInterval: null,
  incomingTimeout: null,
  incomingCountdownTimer: null,
  muted: false,
  recorder: null,
  recordedChunks: [],
  mixedAudioContext: null,
  ringtoneContext: null,
  ringtoneInterval: null,
  installPrompt: null,
};

elements.ghostId.textContent = state.ghostId;
boot();

elements.copyIdButton.addEventListener("click", copyGhostId);
elements.callButton.addEventListener("click", startOutgoingCall);
elements.targetId.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    startOutgoingCall();
  }
});
elements.acceptButton.addEventListener("click", acceptIncomingCall);
elements.declineButton.addEventListener("click", () => declineIncomingCall("declined"));
elements.muteButton.addEventListener("click", toggleMute);
elements.recordButton.addEventListener("click", toggleRecording);
elements.endButton.addEventListener("click", () => endCall(true));
elements.installButton.addEventListener("click", installApp);
elements.notificationButton.addEventListener("click", () => registerPushSubscription({ forcePrompt: true }));
elements.clearRecentButton.addEventListener("click", clearRecentContacts);

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  state.installPrompt = event;
  elements.installButton.textContent = "Install app";
});

window.addEventListener("online", () => {
  showMessage("Back online.");
  connectSocket();
});

window.addEventListener("offline", () => {
  setConnectionStatus("offline", "Offline");
  showMessage("You are offline.");
});

window.addEventListener("beforeunload", () => {
  state.manualClose = true;
  if (state.callId) {
    send({ type: "end_call", call_id: state.callId }, { queue: false });
  }
  state.socket?.close();
});

async function boot() {
  renderRecentContacts();
  refreshNotificationButton();
  connectSocket();
  setupPwaServices();
}

async function setupPwaServices() {
  await registerServiceWorker();
  await registerPushSubscription();
  refreshNotificationButton();
}

function loadGhostId() {
  const existing = localStorage.getItem(GHOST_ID_KEY);
  if (isValidGhostId(existing)) {
    return existing.toLowerCase();
  }
  const generated = generateGhostId();
  localStorage.setItem(GHOST_ID_KEY, generated);
  return generated;
}

function generateGhostId() {
  const adjectives = ["silent", "hidden", "silver", "quiet", "bright", "lunar", "misty", "north"];
  const nouns = ["signal", "echo", "cipher", "comet", "ember", "orbit", "nova", "shade"];
  const bytes = new Uint8Array(2);
  crypto.getRandomValues(bytes);
  const number = ((bytes[0] << 8) + bytes[1]).toString().padStart(4, "0").slice(-4);
  const adjective = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  return `@${adjective}-${noun}-${number}`;
}

function isValidGhostId(value) {
  return typeof value === "string" && /^@?[a-zA-Z0-9][a-zA-Z0-9_-]{2,31}$/.test(value);
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    return;
  }
  try {
    const registration = await navigator.serviceWorker.register("/service-worker.js");
    navigator.serviceWorker.addEventListener("message", (event) => {
      if (event.data?.type === "notification_clicked" && state.pendingIncoming) {
        showIncoming(state.pendingIncoming.from);
      }
    });
    await navigator.serviceWorker.ready;
    return registration;
  } catch {
    showMessage("Offline install support is unavailable in this browser.");
  }
}

async function registerPushSubscription(options = {}) {
  const { forcePrompt = false } = options;
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    elements.notificationButton.textContent = "Alerts unavailable";
    elements.notificationButton.disabled = true;
    return;
  }
  try {
    const keyResponse = await fetch("/api/push/public-key");
    const keyData = await keyResponse.json();
    if (!keyData.enabled) {
      elements.notificationButton.textContent = "Alerts not configured";
      elements.notificationButton.disabled = true;
      return;
    }
    if (Notification.permission === "denied") {
      elements.notificationButton.textContent = "Alerts blocked";
      elements.notificationButton.disabled = true;
      return;
    }

    const permission =
      Notification.permission === "granted"
        ? "granted"
        : forcePrompt
          ? await Notification.requestPermission()
          : Notification.permission;
    if (permission !== "granted") {
      refreshNotificationButton();
      return;
    }

    const registration = await navigator.serviceWorker.ready;
    const subscription =
      (await registration.pushManager.getSubscription()) ||
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64UrlToUint8Array(keyData.public_key),
      }));

    await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ghost_id: state.ghostId, subscription }),
    });
    elements.notificationButton.textContent = "Ring alerts on";
    elements.notificationButton.disabled = false;
  } catch {
    showMessage("Ring alerts could not be enabled.");
    refreshNotificationButton();
  }
}

function refreshNotificationButton() {
  if (!("Notification" in window)) {
    elements.notificationButton.textContent = "Alerts unavailable";
    elements.notificationButton.disabled = true;
    return;
  }
  if (Notification.permission === "granted") {
    elements.notificationButton.textContent = "Ring alerts on";
    return;
  }
  if (Notification.permission === "denied") {
    elements.notificationButton.textContent = "Alerts blocked";
    elements.notificationButton.disabled = true;
    return;
  }
  elements.notificationButton.textContent = "Enable ring alerts";
}

function connectSocket() {
  clearTimeout(state.reconnectTimer);
  if (state.socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(state.socket.readyState)) {
    return;
  }

  setConnectionStatus(state.reconnectAttempt > 0 ? "reconnecting" : "connecting", state.reconnectAttempt > 0 ? "Reconnecting" : "Connecting");
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  const url = `${scheme}://${window.location.host}/ws?ghost_id=${encodeURIComponent(state.ghostId)}`;
  state.socket = new WebSocket(url);

  state.socket.addEventListener("open", () => {
    state.reconnectAttempt = 0;
    state.lastSocketMessageAt = Date.now();
    setConnectionStatus("online", "Online");
    startHeartbeat();
    flushSendQueue();
    showMessage("Online and ready.");
  });

  state.socket.addEventListener("message", (event) => {
    state.lastSocketMessageAt = Date.now();
    try {
      Promise.resolve(handleSignal(JSON.parse(event.data))).catch((error) => {
        showMessage(error?.message || "Could not handle call signal.");
        if (state.callId) {
          endCall(true);
        }
      });
    } catch {
      showMessage("Received an invalid server message.");
    }
  });

  state.socket.addEventListener("close", () => {
    stopHeartbeat();
    if (!state.manualClose) {
      setConnectionStatus("reconnecting", "Reconnecting");
      scheduleReconnect();
    }
  });

  state.socket.addEventListener("error", () => {
    showMessage("Connection issue. Reconnecting if needed.");
  });
}

function startHeartbeat() {
  stopHeartbeat();
  state.heartbeatTimer = setInterval(() => send({ type: "heartbeat" }, { queue: false, quiet: true }), HEARTBEAT_MS);
  state.staleTimer = setInterval(() => {
    if (Date.now() - state.lastSocketMessageAt > STALE_SOCKET_MS) {
      state.socket?.close();
      scheduleReconnect();
    }
  }, HEARTBEAT_MS);
}

function stopHeartbeat() {
  clearInterval(state.heartbeatTimer);
  clearInterval(state.staleTimer);
  state.heartbeatTimer = null;
  state.staleTimer = null;
}

function scheduleReconnect() {
  clearTimeout(state.reconnectTimer);
  const delay = Math.min(WS_RETRY_BASE_MS * 2 ** state.reconnectAttempt, WS_RETRY_MAX_MS);
  state.reconnectAttempt += 1;
  state.reconnectTimer = setTimeout(connectSocket, delay);
}

async function handleSignal(message) {
  switch (message.type) {
    case "registered":
      state.iceServers = Array.isArray(message.ice_servers) ? message.ice_servers : state.iceServers;
      break;
    case "heartbeat_ack":
      break;
    case "connection_replaced":
      showMessage("This Ghost ID opened in another browser tab.");
      break;
    case "call_ringing":
      state.callId = message.call_id;
      state.peerId = message.to;
      state.role = "caller";
      flushLocalIce();
      showCalling(message.to, message.delivery === "push" ? "Waiting" : "Ringing");
      showMessage(message.delivery === "push" ? "Push alert sent. Waiting for them to open GhostCall." : "Ringing now.");
      break;
    case "incoming_call":
      state.pendingIncoming = { callId: message.call_id, from: message.from, offer: message.payload };
      showIncoming(message.from);
      await showLocalIncomingNotification(message.from);
      break;
    case "call_accepted":
      state.callId = message.call_id;
      state.peerId = message.by;
      state.role = "caller";
      await receiveAnswer(message.payload);
      startActiveCall("Connected");
      break;
    case "call_ready":
      startActiveCall("Connected");
      break;
    case "session_resumed":
      state.callId = message.call_id;
      state.peerId = message.with;
      showMessage("Session restored.");
      if (state.peerConnection) {
        startActiveCall("Connected");
      }
      break;
    case "peer_reconnecting":
      showMessage(`${message.with} is reconnecting.`);
      break;
    case "peer_reconnected":
      showMessage(`${message.with} reconnected.`);
      if (state.callId === message.call_id) {
        startActiveCall("Connected");
      }
      break;
    case "call_declined":
      showMessage(message.reason === "timeout" ? "Call timed out." : "Call declined.");
      await endCall(false);
      break;
    case "call_unavailable":
      showMessage(message.reason === "busy" ? "User is busy." : "User is offline.");
      await endCall(false);
      break;
    case "ice_candidate":
      await receiveIceCandidate(message.payload);
      break;
    case "call_ended":
      showMessage(message.reason === "peer_disconnected" ? "Peer disconnected." : "Call ended.");
      await endCall(false);
      break;
    case "error":
      showMessage(message.message || "Request failed.");
      break;
    default:
      break;
  }
}

function send(message, options = {}) {
  const { queue = true, quiet = false } = options;
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
    if (queue && state.sendQueue.length < 25) {
      state.sendQueue.push(message);
    }
    if (!quiet) {
      showMessage("Reconnecting.");
    }
    return false;
  }
  state.socket.send(JSON.stringify(message));
  return true;
}

function flushSendQueue() {
  const queue = state.sendQueue.splice(0, state.sendQueue.length);
  queue.forEach((message) => send(message, { queue: false, quiet: true }));
}

async function startOutgoingCall() {
  const target = elements.targetId.value.trim().toLowerCase();
  if (!isSocketOpen()) {
    showMessage("Still connecting. Wait for Online, then call again.");
    connectSocket();
    return;
  }
  if (!isValidGhostId(target)) {
    showMessage("Enter a valid Ghost ID.");
    return;
  }
  if (target === state.ghostId) {
    showMessage("You cannot call yourself.");
    return;
  }
  if (state.callId || state.pendingIncoming) {
    showMessage("You are already busy.");
    return;
  }

  elements.callButton.disabled = true;
  state.peerId = target;
  state.role = "caller";
  saveRecentContact(target);
  showCalling(target, "Calling");

  try {
    await preparePeerConnection();
    const offer = await state.peerConnection.createOffer();
    await state.peerConnection.setLocalDescription(offer);
    if (!send({ type: "call", to: target, payload: offer }, { queue: false })) {
      showMessage("Call was not sent. Reconnecting.");
      await endCall(false);
    }
  } catch (error) {
    showMessage(error?.message || "Could not start the call.");
    await endCall(false);
  }
}

function isSocketOpen() {
  return state.socket?.readyState === WebSocket.OPEN;
}

async function acceptIncomingCall() {
  if (!state.pendingIncoming) {
    return;
  }
  stopIncomingTimers();
  stopRingtone();
  state.callId = state.pendingIncoming.callId;
  state.peerId = state.pendingIncoming.from;
  state.role = "callee";
  saveRecentContact(state.peerId);
  showCalling(state.peerId, "Connecting");

  try {
    await preparePeerConnection();
    await state.peerConnection.setRemoteDescription(new RTCSessionDescription(state.pendingIncoming.offer));
    await drainPendingIce();
    const answer = await state.peerConnection.createAnswer();
    await state.peerConnection.setLocalDescription(answer);
    send({ type: "accept_call", call_id: state.callId, payload: answer });
    state.pendingIncoming = null;
    startActiveCall("Connected");
  } catch (error) {
    showMessage(error?.message || "Could not accept the call.");
    await endCall(true);
  }
}

function declineIncomingCall(reason) {
  if (!state.pendingIncoming) {
    return;
  }
  send({ type: "decline_call", call_id: state.pendingIncoming.callId, reason });
  stopIncomingTimers();
  stopRingtone();
  state.pendingIncoming = null;
  setPanel("dialer");
  showMessage(reason === "timeout" ? "Call timed out." : "Call declined.");
}

async function preparePeerConnection() {
  if (state.peerConnection) {
    return;
  }

  state.localStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: false,
  });

  state.remoteStream = new MediaStream();
  elements.remoteAudio.srcObject = state.remoteStream;

  const peerConnection = new RTCPeerConnection({ iceServers: state.iceServers });
  state.localStream.getTracks().forEach((track) => peerConnection.addTrack(track, state.localStream));

  peerConnection.addEventListener("track", (event) => {
    event.streams[0]?.getAudioTracks().forEach((track) => {
      if (!state.remoteStream.getTracks().includes(track)) {
        state.remoteStream.addTrack(track);
      }
    });
    elements.remoteAudio.play().catch(() => showMessage("Tap the screen to enable audio playback."));
  });

  peerConnection.addEventListener("icecandidate", (event) => {
    if (event.candidate) {
      sendIceCandidate(event.candidate.toJSON());
    }
  });

  peerConnection.addEventListener("connectionstatechange", () => {
    if (["failed", "closed"].includes(peerConnection.connectionState)) {
      showMessage("Call connection ended.");
      endCall(true);
    }
  });

  state.peerConnection = peerConnection;
}

async function receiveAnswer(answer) {
  if (!state.peerConnection || !answer) {
    return;
  }
  await state.peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
  await drainPendingIce();
}

async function receiveIceCandidate(candidate) {
  if (!candidate) {
    return;
  }
  if (!state.peerConnection || !state.peerConnection.remoteDescription) {
    state.pendingIce.push(candidate);
    return;
  }
  try {
    await state.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
  } catch {
    showMessage("Could not add a network candidate.");
  }
}

function sendIceCandidate(candidate) {
  if (!state.callId) {
    state.pendingLocalIce.push(candidate);
    return;
  }
  send({ type: "ice_candidate", call_id: state.callId, payload: candidate });
}

function flushLocalIce() {
  const candidates = state.pendingLocalIce.splice(0, state.pendingLocalIce.length);
  candidates.forEach((candidate) => sendIceCandidate(candidate));
}

async function drainPendingIce() {
  const candidates = state.pendingIce.splice(0, state.pendingIce.length);
  for (const candidate of candidates) {
    await receiveIceCandidate(candidate);
  }
}

async function endCall(notifyPeer) {
  const callId = state.callId || state.pendingIncoming?.callId;
  if (notifyPeer && callId) {
    send({ type: "end_call", call_id: callId }, { queue: false });
  }
  await stopRecording();
  stopTimer();
  stopIncomingTimers();
  stopRingtone();
  closePeerResources();
  resetCallState();
}

function closePeerResources() {
  state.peerConnection?.getSenders().forEach((sender) => sender.track?.stop());
  state.peerConnection?.close();
  state.localStream?.getTracks().forEach((track) => track.stop());
  state.remoteStream?.getTracks().forEach((track) => track.stop());
  elements.remoteAudio.srcObject = null;
  state.peerConnection = null;
  state.localStream = null;
  state.remoteStream = new MediaStream();
  state.pendingIce = [];
  state.pendingLocalIce = [];
}

function resetCallState() {
  state.callId = null;
  state.peerId = null;
  state.role = null;
  state.pendingIncoming = null;
  state.muted = false;
  elements.muteButton.textContent = "Mute";
  elements.muteButton.classList.remove("is-active");
  elements.callButton.disabled = false;
  setPanel("dialer");
}

function showIncoming(from) {
  elements.incomingFrom.textContent = from;
  elements.incomingCountdown.textContent = String(INCOMING_TIMEOUT_SECONDS);
  setPanel("incoming");
  startRingtone();
  startIncomingTimeout();
  showMessage("");
}

function startIncomingTimeout() {
  stopIncomingTimers();
  let secondsLeft = INCOMING_TIMEOUT_SECONDS;
  elements.incomingCountdown.textContent = String(secondsLeft);
  state.incomingCountdownTimer = setInterval(() => {
    secondsLeft -= 1;
    elements.incomingCountdown.textContent = String(Math.max(secondsLeft, 0));
  }, 1000);
  state.incomingTimeout = setTimeout(() => declineIncomingCall("timeout"), INCOMING_TIMEOUT_SECONDS * 1000);
}

function stopIncomingTimers() {
  clearTimeout(state.incomingTimeout);
  clearInterval(state.incomingCountdownTimer);
  state.incomingTimeout = null;
  state.incomingCountdownTimer = null;
}

function showCalling(peerId, label) {
  elements.peerId.textContent = peerId;
  elements.callLabel.textContent = label;
  elements.timer.textContent = "00:00";
  elements.callButton.disabled = true;
  setPanel("call");
}

function startActiveCall(label) {
  elements.callLabel.textContent = label;
  if (!state.callStartedAt) {
    state.callStartedAt = Date.now();
    state.timerInterval = setInterval(updateTimer, 1000);
    updateTimer();
  }
}

function updateTimer() {
  const seconds = Math.floor((Date.now() - state.callStartedAt) / 1000);
  const mins = Math.floor(seconds / 60).toString().padStart(2, "0");
  const secs = (seconds % 60).toString().padStart(2, "0");
  elements.timer.textContent = `${mins}:${secs}`;
}

function stopTimer() {
  clearInterval(state.timerInterval);
  state.timerInterval = null;
  state.callStartedAt = null;
  elements.timer.textContent = "00:00";
}

function toggleMute() {
  if (!state.localStream) {
    return;
  }
  state.muted = !state.muted;
  state.localStream.getAudioTracks().forEach((track) => {
    track.enabled = !state.muted;
  });
  elements.muteButton.textContent = state.muted ? "Unmute" : "Mute";
  elements.muteButton.classList.toggle("is-active", state.muted);
}

async function toggleRecording() {
  if (state.recorder?.state === "recording") {
    await stopRecording();
    return;
  }
  if (!state.localStream || !state.remoteStream) {
    showMessage("Start a call before recording.");
    return;
  }
  const mixedStream = createMixedRecordingStream();
  const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
  state.recordedChunks = [];
  state.recorder = new MediaRecorder(mixedStream, { mimeType });
  state.recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) {
      state.recordedChunks.push(event.data);
    }
  });
  state.recorder.addEventListener("stop", downloadRecording);
  state.recorder.start(1000);
  elements.recordButton.textContent = "Stop rec";
  elements.recordButton.classList.add("is-active");
  showMessage("Recording locally.");
}

function createMixedRecordingStream() {
  state.mixedAudioContext?.close();
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  state.mixedAudioContext = new AudioContextClass();
  const destination = state.mixedAudioContext.createMediaStreamDestination();

  if (state.localStream.getAudioTracks().length > 0) {
    state.mixedAudioContext.createMediaStreamSource(state.localStream).connect(destination);
  }
  if (state.remoteStream.getAudioTracks().length > 0) {
    state.mixedAudioContext.createMediaStreamSource(state.remoteStream).connect(destination);
  }

  return destination.stream;
}

async function stopRecording() {
  if (state.recorder?.state === "recording") {
    await new Promise((resolve) => {
      state.recorder.addEventListener("stop", resolve, { once: true });
      state.recorder.stop();
    });
  }
  elements.recordButton.textContent = "Record";
  elements.recordButton.classList.remove("is-active");
  await state.mixedAudioContext?.close().catch(() => undefined);
  state.mixedAudioContext = null;
}

function downloadRecording() {
  if (state.recordedChunks.length === 0) {
    return;
  }
  const blob = new Blob(state.recordedChunks, { type: "audio/webm" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `ghostcall-${new Date().toISOString().replace(/[:.]/g, "-")}.webm`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  state.recordedChunks = [];
  showMessage("Recording downloaded.");
}

function startRingtone() {
  stopRingtone();
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  state.ringtoneContext = new AudioContextClass();
  const playTone = () => {
    if (!state.ringtoneContext) {
      return;
    }
    const oscillator = state.ringtoneContext.createOscillator();
    const gain = state.ringtoneContext.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = 720;
    gain.gain.setValueAtTime(0.0001, state.ringtoneContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.14, state.ringtoneContext.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, state.ringtoneContext.currentTime + 0.5);
    oscillator.connect(gain);
    gain.connect(state.ringtoneContext.destination);
    oscillator.start();
    oscillator.stop(state.ringtoneContext.currentTime + 0.56);
  };
  playTone();
  state.ringtoneInterval = setInterval(playTone, 1200);
}

function stopRingtone() {
  clearInterval(state.ringtoneInterval);
  state.ringtoneInterval = null;
  state.ringtoneContext?.close().catch(() => undefined);
  state.ringtoneContext = null;
}

async function showLocalIncomingNotification(from) {
  if (!("Notification" in window) || Notification.permission !== "granted" || document.visibilityState === "visible") {
    return;
  }
  const registration = await navigator.serviceWorker?.ready;
  registration?.showNotification("Incoming GhostCall", {
    body: `Incoming GhostCall from ${from}`,
    icon: "/static/favicon.svg",
    badge: "/static/favicon.svg",
    tag: state.pendingIncoming?.callId || "ghostcall-incoming",
    requireInteraction: true,
    data: { url: "/", caller: from },
  });
}

async function copyGhostId() {
  try {
    await navigator.clipboard.writeText(state.ghostId);
    showMessage("Ghost ID copied.");
  } catch {
    showMessage("Copy failed.");
  }
}

function getRecentContacts() {
  try {
    const contacts = JSON.parse(localStorage.getItem(RECENT_CONTACTS_KEY) || "[]");
    return Array.isArray(contacts) ? contacts.filter(isValidGhostId).slice(0, 6) : [];
  } catch {
    return [];
  }
}

function saveRecentContact(ghostId) {
  if (!isValidGhostId(ghostId) || ghostId === state.ghostId) {
    return;
  }
  const normalized = ghostId.toLowerCase();
  const contacts = [normalized, ...getRecentContacts().filter((contact) => contact !== normalized)].slice(0, 6);
  localStorage.setItem(RECENT_CONTACTS_KEY, JSON.stringify(contacts));
  renderRecentContacts();
}

function clearRecentContacts() {
  localStorage.removeItem(RECENT_CONTACTS_KEY);
  renderRecentContacts();
  showMessage("Recent contacts cleared.");
}

function renderRecentContacts() {
  const contacts = getRecentContacts();
  elements.recentEmpty.classList.toggle("hidden", contacts.length !== 0);
  elements.clearRecentButton.disabled = contacts.length === 0;
  elements.recentList.replaceChildren(
    ...contacts.map((contact) => {
      const button = document.createElement("button");
      button.className = "recent-item";
      button.type = "button";
      button.innerHTML = `<span></span><strong>Call</strong>`;
      button.querySelector("span").textContent = contact;
      button.addEventListener("click", () => {
        elements.targetId.value = contact;
        startOutgoingCall();
      });
      return button;
    }),
  );
}

async function installApp() {
  if (!state.installPrompt) {
    showMessage("Use your browser menu to install GhostCall if the install prompt is not shown.");
    return;
  }
  state.installPrompt.prompt();
  await state.installPrompt.userChoice;
  state.installPrompt = null;
  elements.installButton.classList.add("hidden");
}

function setPanel(panel) {
  elements.dialerPanel.classList.toggle("hidden", panel !== "dialer");
  elements.incomingPanel.classList.toggle("hidden", panel !== "incoming");
  elements.callPanel.classList.toggle("hidden", panel !== "call");
}

function setConnectionStatus(status, label) {
  elements.connectionStatus.className = `status is-${status}`;
  elements.connectionStatus.querySelector("strong").textContent = label;
}

function showMessage(message) {
  elements.message.textContent = message;
}

function base64UrlToUint8Array(base64Url) {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
}
