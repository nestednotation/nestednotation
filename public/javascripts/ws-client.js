let ws;
let pingTimer;

let isReady = false;
let pingCountToReady = 3;
let timeStampOffset = 0;
let timeStampRate = 1.0;

// ── WebSocket reconnect ─────────────────────────────────────────────
const WS_BASE_DELAY = 1000; // 1 s
const WS_MAX_DELAY = 5000; // 5 s
let reconnectTimer = null;
let reconnectAttempts = 0;
let wsCountdownTimer = null;
// ────────────────────────────────────────────────────────────────────

// ── WebSocket lifecycle ──────────────────────────────────────────────

function connectWebSocket() {
  cancelReconnectTimer();
  teardownSocket();
  ws = new WebSocket(wsPath);
  ws.onopen = onWsOpen;
  ws.onmessage = onWsMessage;
  ws.onclose = onWsClose;
  ws.onerror = onWsError;
}

function teardownSocket() {
  if (!ws) return;
  ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
  ws.close();
  ws = null;
}

function cancelReconnectTimer() {
  if (!reconnectTimer) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

// ── WebSocket handlers ───────────────────────────────────────────────

function onWsOpen() {
  reconnectAttempts = 0;
  hideReconnectBanner();
  resetPingCalibration();
  sendToServer(MSG_PING, { clientTime: Date.now() });
}

function onWsMessage(event) {
  const data = JSON.parse(event.data);
  const delay = Math.max(0, data.t - getServerTime());
  delay === 0 ? parseMessage(data) : setTimeout(parseMessage, delay, data);
}

function onWsClose() {
  scheduleReconnect();
}

function onWsError() {
  // always followed by onclose — let onclose drive reconnection
}

// ── Reconnect logic ──────────────────────────────────────────────────

function onVisibilityChange() {
  if (document.visibilityState !== "visible") return;
  if (ws?.readyState === WebSocket.OPEN) {
    // Socket survived sleep but timers may have been throttled —
    // re-request current state to fix any stale display.
    sendToServer(MSG_NEED_DISPLAY);
  } else {
    // Socket is gone or frozen — bypass the backoff timer and reconnect now.
    reconnectAttempts = 0;
    connectWebSocket();
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = Math.min(WS_BASE_DELAY * 2 ** reconnectAttempts, WS_MAX_DELAY);
  reconnectAttempts++;
  showReconnectBanner(delay);
  console.log(
    `WebSocket closed. Reconnecting in ${delay / 1000}s (attempt ${reconnectAttempts})…`,
  );
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWebSocket();
  }, delay);
}

function resetPingCalibration() {
  pingCountToReady = 3;
  timeStampRate = 1.0;
  isReady = false;
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}

// ── Reconnect banner ─────────────────────────────────────────────────

function showReconnectBanner(delayMs) {
  const el = document.getElementById("ws-reconnect-indicator");
  if (!el) return;

  clearReconnectBannerCountdown();

  let secsLeft = Math.round(delayMs / 1000);
  const tick = () => {
    el.textContent =
      secsLeft > 0 ? `reconnecting in ${secsLeft}s…` : "reconnecting…";
  };

  tick();
  el.style.display = "block";
  wsCountdownTimer = setInterval(() => {
    secsLeft--;
    tick();
    if (secsLeft <= 0) clearReconnectBannerCountdown();
  }, 1000);
}

function hideReconnectBanner() {
  const el = document.getElementById("ws-reconnect-indicator");
  if (el) el.style.display = "none";
  clearReconnectBannerCountdown();
}

function clearReconnectBannerCountdown() {
  if (!wsCountdownTimer) return;
  clearInterval(wsCountdownTimer);
  wsCountdownTimer = null;
}

// ── Time sync ────────────────────────────────────────────────────────

function getServerTime() {
  return Math.round(Date.now() + timeStampOffset);
}

function sendToServer(message, payload) {
  if (ws.readyState !== ws.OPEN) {
    return;
  }

  ws.send(
    JSON.stringify({
      sig: window.staffCode,
      cid: window.currentIndex,
      sid: window.sessionId,
      msg: message,
      ...payload,
    }),
  );
}

function pingCallback() {
  sendToServer(MSG_PING, { clientTime: Date.now() });
}
