let ws;
let pingTimer;

let isReady = false;
let pingCountToReady = 3;
let timeStampOffset = 0;
let timeStampRate = 1.0;

// ── Device identity (Session Lines) ──────────────────────────────────────────
// A stable per-TAB UUID, persisted in sessionStorage as "did", so a refreshed
// or reconnected tab rejoins ITS line. Generated client-side (never baked
// into the shared, apicache-cached ${id}.html). sessionStorage is per-tab —
// unlike localStorage, which collapses every tab of one browser into a single
// line — and survives refresh and mobile tab-eviction restore; a closed tab
// mints a new did and falls back to smallest-line assignment (dormant revived
// first). If storage is blocked we keep an in-memory id for the page's life.
// http LAN deploys aren't a secure context (so crypto.randomUUID may be
// absent) — fall back to getRandomValues, then Math.
let inMemoryDeviceId = null;

function bytesToUuid(buf) {
  const h = [];
  for (let i = 0; i < 16; i++) {
    h.push((buf[i] + 0x100).toString(16).slice(1));
  }
  return (
    h[0] + h[1] + h[2] + h[3] + "-" +
    h[4] + h[5] + "-" +
    h[6] + h[7] + "-" +
    h[8] + h[9] + "-" +
    h[10] + h[11] + h[12] + h[13] + h[14] + h[15]
  );
}

function generateUuid() {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    if (typeof crypto !== "undefined" && crypto.getRandomValues) {
      const buf = new Uint8Array(16);
      crypto.getRandomValues(buf);
      buf[6] = (buf[6] & 0x0f) | 0x40; // version 4
      buf[8] = (buf[8] & 0x3f) | 0x80; // variant 10x
      return bytesToUuid(buf);
    }
  } catch (e) {
    // fall through to Math.random
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function ensureDeviceId() {
  if (window.deviceId) {
    return window.deviceId;
  }
  let id = null;
  try {
    id = sessionStorage.getItem("did");
    if (!id) {
      id = generateUuid();
      sessionStorage.setItem("did", id);
    }
  } catch (e) {
    id = inMemoryDeviceId || (inMemoryDeviceId = generateUuid());
  }
  window.deviceId = id;
  return id;
}

// ── WebSocket reconnect ─────────────────────────────────────────────
const WS_BASE_DELAY = 1000; // 1 s
const WS_MAX_DELAY = 5000; // 5 s
let reconnectTimer = null;
let reconnectAttempts = 0;
let wsCountdownTimer = null;
// ────────────────────────────────────────────────────────────────────

// ── WebSocket lifecycle ──────────────────────────────────────────────

function connectWebSocket() {
  ensureDeviceId();
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
  if (data.m === MSG_SHOW && delay > 0 && data.showIdx !== -1) {
    window.sessionInstance?.preloadFrameAudio(data.showIdx);
  }
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

// A tab that navigates away is not necessarily gone: the browser can freeze the
// leaving document into the back/forward cache with its WebSocket still OPEN,
// and the server counts live connections — so it goes on counting that frozen
// document as a device. An operator round-tripping between the session page
// and /sm adds one phantom player per trip (the Back button is the only way
// back, and bfcache is exactly where Back leaves the page): it inflates the
// footer counts and, worse, a line's population — a phantom never taps, so it
// can hold a group wait open. Closing here costs a real unload nothing, and
// pageshow brings a restored page back.
function onPageHide() {
  cancelReconnectTimer();
  teardownSocket();
}

// Only a bfcache restore needs a fresh socket. The initial load fires pageshow
// too (persisted false) — connecting there would race the page's own
// connectWebSocket() call.
function onPageShow(event) {
  if (!event.persisted) return;
  reconnectAttempts = 0;
  connectWebSocket();
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
  if (!ws || ws.readyState !== ws.OPEN) {
    return;
  }

  ws.send(
    JSON.stringify({
      sig: window.staffCode,
      cid: window.currentIndex,
      sid: window.sessionId,
      msg: message,
      did: window.deviceId,
      // Set only by the standalone map page — its connection is an observation
      // tool, never population. undefined elsewhere ⇒ key dropped by stringify.
      mapView: window.wsMapView,
      ...payload,
    }),
  );
}

function pingCallback() {
  sendToServer(MSG_PING, { clientTime: Date.now() });
}
