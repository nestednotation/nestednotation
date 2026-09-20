let lblVotingTime = null;
let divMainContent = null;

window.currentIndex = 0;

let cooldownTimer = null;
let cooldownDuration = 11;
let cooldownEndTime = 0;
let cooldownStartTime = 0;
let isCooldowning = false;

let holdingTimer = null;
let holdingDuration = 11;
let holdingEndTime = 0;
let holdingStartTime = 0;
window.isHolding = false;

let votingDataTimeStamp = 0;

document.addEventListener("DOMContentLoaded", onDOMContentLoaded, false);

function onDOMContentLoaded() {
  lblVotingTime = document.getElementById("VotingTime");
  divMainContent = document.getElementById("MainContent");

  const searchParams = new URLSearchParams(window.location.search);
  const isAdmin = searchParams.get("t");
  window.isAdminView = isAdmin === "1";
  if (isAdmin === "1") {
    console.log("This is Admin");
    const divhold = document.getElementById("divhold");
    divhold.style.display = "block";

    const divpause = document.getElementById("divpause");
    divpause.style.display = "block";

    const divhistory = document.getElementById("divhistory");
    divhistory.style.display = "block";

    const tablefooter = document.getElementById("tablefooter");
    tablefooter.style.display = "flex";

    // Live score-map page (works for any score; vanilla shows as one line).
    // Created dynamically so the shared session HTML stays untouched.
    const mapLink = document.createElement("a");
    mapLink.className = "score-map-link";
    mapLink.target = "_blank";
    mapLink.href = `/session/${window.sessionId}/map?p=${encodeURIComponent(
      window.staffCode || "",
    )}`;
    mapLink.textContent = "map ↗";
    tablefooter.appendChild(mapLink);
  }

  connectWebSocket();
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("pageshow", onPageShow);
}

function viewDidLoad() {
  timeStampRate = 0.1;
  isReady = true;
  //start ping timer every 60s
  pingTimer = setInterval(pingCallback, 1000 * 60);
  //request window.currentIndex
  sendToServer(MSG_NEED_DISPLAY);
}

function parseMessage(data) {
  const msg = data.m;
  if (msg === MSG_PING) {
    const { serverTime, clientTime } = data;
    const timeBeginPing = clientTime;
    const timeEndPing = Date.now();
    const timeServer = serverTime;
    const ping = timeEndPing - timeBeginPing;
    timeStampOffset +=
      (timeServer + ping / 2.0 - timeEndPing - timeStampOffset) * timeStampRate;

    if (pingCountToReady > 0) {
      pingCountToReady--;
      sendToServer(MSG_PING, { clientTime: Date.now() });
      return;
    }

    if (pingCountToReady === 0) {
      pingCountToReady--;
      viewDidLoad();
    }
    return;
  }

  if (msg === MSG_SHOW) {
    if (!displayRevOk(data)) return;
    // Session Lines: the whole display, in one message and one revision — the
    // answer to MSG_NEED_DISPLAY. Every field is present, so everything it
    // does not report is explicitly CLEARED rather than left as this page
    // happened to find it. Absent on an ordinary SHOW, and on vanilla scores.
    if (data.snapshot) {
      applyDisplayState(data);
      return;
    }
    const { showIdx } = data;
    window.currentIndex = showIdx;
    console.log("received show image at index " + window.currentIndex);
    if (window.currentIndex === -1) {
      console.log(data);
    } else {
      // In whatever score the server last put this line in: a SHOW inside a
      // sub carries a SUB-relative index, and the context is not part of the
      // message.
      renderDisplay(desiredSub, showIdx, { ctx: data.ctx });
    }

    //reset all
    window.winningVoteId = null;
    window.currVoteId = null;
    window.splitDestinationVoteId = null;
    clearVotingIndicator();
    window.countDic = null;

    return;
  }

  if (msg === MSG_CHANGE_FOLDER) {
    console.log("receive change folder");
    window.location.reload();

    return;
  }

  if (msg === MSG_UPDATE_VOTING) {
    const { countDic, timestamp, splitDestinationVoteId } = data;
    if (timestamp <= votingDataTimeStamp) {
      return;
    }

    // Session Lines: on a `session-split` frame the server sends no shared
    // winner (the line divides) — it addresses THIS device its own destination
    // instead. Absent on every other frame, which keeps the winner behavior.
    window.splitDestinationVoteId = splitDestinationVoteId || null;
    showVotingIndicator(countDic);
    window.countDic = countDic;
    votingDataTimeStamp = timestamp;
    return;
  }

  if (msg === MSG_BEGIN_VOTING) {
    const { endTime, duration } = data;
    cooldownEndTime = endTime;
    cooldownDuration = duration;
    cooldownStartTime = cooldownEndTime - cooldownDuration * 1000;
    const serverTime = getServerTime();
    setIndicatorCooldown(true);

    if (serverTime < cooldownEndTime) {
      if (cooldownTimer != null) {
        clearInterval(cooldownTimer);
        cooldownTimer = null;
      }

      cooldownTimer = setInterval(cooldownCallback, 100);
      isCooldowning = true;
    } else {
      // nothing we can do here. just wait for next signal
      hideAllCooldownCircles();
      setIndicatorCooldown(false);
    }
    return;
  }

  if (msg === MSG_BEGIN_HOLDING) {
    const { endTime, duration } = data;
    holdingEndTime = endTime;
    holdingDuration = duration;
    holdingStartTime = holdingEndTime - holdingDuration * 1000;

    const serverTime = getServerTime();
    setIndicatorHold(true);

    if (serverTime < holdingEndTime) {
      if (holdingTimer != null) {
        clearInterval(holdingTimer);
        holdingTimer = null;
      }

      holdingTimer = setInterval(holdingCallback, 100);
      window.isHolding = true;
    } else {
      // nothing we can do here. just wait for next signal
      if (holdingEndTime == 0) {
        if (holdingTimer != null) {
          setIndicatorHold(false);
          clearInterval(holdingTimer);
          holdingTimer = null;
          window.isHolding = false;
        }

        hideAllCooldownCircles();
        setIndicatorHold(holdingDuration !== 0);
      } else {
        hideAllCooldownCircles();
        setIndicatorHold(false);
      }
    }
    return;
  }

  if (msg === MSG_CHECK_HOLD) {
    const { isHold } = data;
    setCheckHold(isHold);
    setIndicatorHold(isHold);
    return;
  }

  if (msg === MSG_PAUSE) {
    // Revisioned: an advance's SHOW queued for the preload deadline is older
    // than a pause issued before that deadline, and must not repaint the
    // frame over the placeholder when it fires.
    if (!displayRevOk(data)) return;
    const { isPause, showIdx } = data;
    setCheckPause(isPause);
    // The pause placeholder is not a position: `window.currentIndex` is what
    // outgoing taps send as `cid`, and the server checks it against the line,
    // so it must go on naming the frame the line is really on.
    renderDisplay(desiredSub, isPause ? -1 : showIdx, {
      placeholder: isPause,
      ctx: data.ctx,
    });
    // `showIdx` IS that frame (the server sends the line's own index). The
    // SHOW that would otherwise have told this page is the one the pause just
    // superseded, so the snapshot's rule applies here too.
    if (isPause && showIdx != null) {
      window.currentIndex = showIdx;
    }
    return;
  }

  if (msg === MSG_FINISH) {
    window.location.href = "/finish";
    return;
  }

  if (msg === MSG_SELECT_HISTORY) {
    const { history, selectedIdx, available } = data;
    updateSelectHistory(history, selectedIdx, available);
    return;
  }

  if (msg === MSG_SHOW_NUMBER_CONNECTION) {
    const { playerCount, riderCount, lines } = data;
    updateNumberOfConnection(playerCount, riderCount, lines);
    return;
  }

  if (msg === MSG_CHANGE_VOLUME) {
    const { volume } = data;
    window.defaultVolume = volume;
    window.sessionInstance.updateDefaultVolume();
    return;
  }

  if (msg === MSG_GLOBAL_REFRESH) {
    window.location.reload();
    return;
  }

  // Session Lines: this device was (re)assigned to a line on split/merge. The
  // frame it should show still arrives via MSG_SHOW (line-scoped) — we just
  // remember our line id for any line-aware UI.
  if (msg === MSG_LINE_ASSIGNED) {
    assignLine(data);
    console.log("assigned to line " + window.lineId);
    return;
  }

  if (msg === MSG_BEGIN_SPLIT) {
    assignLine(data);
    return;
  }

  // Session Lines: a barrier message for this line — either it is parked and
  // waiting for the others (default), or a track group is waiting for IT
  // (`data.straggler`). The admin-flagged variant (data.admin) carries the full
  // set of waiting barriers and the valves that resolve them. That belongs to
  // the score map's barrier strip alone: the operator had the same panel in
  // two places, and this page is the cramped one — so it is ignored here.
  if (msg === MSG_BARRIER_WAITING) {
    if (!data.admin) {
      showBarrierWaiting(data.straggler ? "straggler" : "parked");
    }
    return;
  }

  if (msg === MSG_BARRIER_RELEASED) {
    showBarrierWaiting(null);
    return;
  }

  // Session Lines: this line dived into a sub-score. Fetch + inject its frames
  // (cached per sub), swap the active frame list, then show the sub frame.
  if (msg === MSG_SUB_ENTER) {
    if (!displayRevOk(data)) return;
    const { sub, showIdx } = data;
    resetCountdownsForSubTransition();
    // showIdx now indexes the SUB frame list. Keep window.currentIndex in sync
    // (as MSG_SHOW does) — outgoing taps send it as `cid`, and the server
    // rejects a tap whose cid !== line.currentIndex. Skipping this leaves cid on
    // the stale main-flow index, so every tap inside the sub is dropped.
    renderDisplay(sub, showIdx, { ctx: data.ctx });
    return;
  }

  // Session Lines: the sub ended — pop back to the main flow landing frame.
  if (msg === MSG_SUB_EXIT) {
    if (!displayRevOk(data)) return;
    const { showIdx } = data;
    resetCountdownsForSubTransition();
    // Back on the main frame list — resync window.currentIndex (see MSG_SUB_ENTER).
    renderDisplay(null, showIdx, { ctx: data.ctx });
    return;
  }
}

// ── Display transitions (Session Lines) ──────────────────────────────────────
//
// Two things make a display message unsafe to apply on arrival.
//
// It may be STALE. The server schedules frames for the near future (`t`, the
// preload window) and this page holds them in a timer; a rewind, a dive or a
// reconnect in between makes the held message a description of a display the
// server has already replaced. Every display-driving message therefore carries
// `dr`, a server-wide number that only goes up, and one older than the last
// applied is dropped. A line change raises that floor (`assignLine`), which
// retires what the previous line had queued for this device. A socket generation cannot do this — a rewind and the
// stale SHOW it overtakes live on the same socket.
//
// And it may be SUPERSEDED WHILE IT IS BEING APPLIED. Entering a sub-score
// fetches and injects that score's frames, and the room does not stop while
// that is in flight: the line can be ejected, rewound, or advanced by another
// performer. The fetch used to switch the page into the sub whenever it
// happened to land, so a slow dive could pull a performer back into a
// sub-score the server had already left. Each transition takes a generation
// number and checks it once its assets are ready; a transition that is no
// longer the newest renders nothing at all.
let appliedDisplayRev = -1;
let displayGeneration = 0;
// Which score the server last put this line in: null is the main flow. Held
// separately from `window.frameContext`, which describes what is on SCREEN and
// only catches up once the sub's frames are in the page.
let desiredSub = null;
// The dive context (`ctx`) the server attached to that score, and the one the
// page is actually SHOWING. Every tap reports the latter, and the server
// refuses a tap whose context is not its line's: a main score and its sub can
// both open on START.svg at index 0, so the frame name and index a tap carries
// do not say which of the two the performer was looking at. It changes only
// when a frame of the new context is on screen — while a sub is still loading,
// the page is showing the old one, and a tap on it is a tap on the old one.
let desiredCtx = "";
window.displayContext = "";

// A new socket is a new display epoch: the revisions restart (a server
// restart), and the snapshot that answers our MSG_NEED_DISPLAY is the first
// thing to apply. Called by ws-client.js on every connect.
//
// A sub-score load the old socket started is retired with it: it describes a
// display the snapshot is about to restate, and presenting it while that
// snapshot is on its way would show a passage the server may have left.
function resetDisplayEpoch() {
  appliedDisplayRev = -1;
  displayGeneration++;
}
window.resetDisplayEpoch = resetDisplayEpoch;

// This device now belongs to `data.lineId`. When that is a DIFFERENT line, the
// assignment's revision becomes the floor: whatever the previous line had
// queued for this device (a SHOW waiting out its preload window) was issued
// before the assignment, so it is below the floor and dropped when it fires.
// Told the line it is already on — a merge survivor — nothing is retired, and
// its own line's queued frame still lands.
//
// The same goes for a transition still being APPLIED: a sub-score the previous
// line dove into may still be loading, and its completion would present that
// line's passage on a device that now follows another. A line change retires
// it; the new line's own display message is what renders next.
function assignLine(data) {
  if (data.lineId !== window.lineId) {
    if (data.dr != null && data.dr > appliedDisplayRev) {
      appliedDisplayRev = data.dr;
    }
    displayGeneration++;
  }
  window.lineId = data.lineId;
}

function displayRevOk(data) {
  // No revision ⇒ a vanilla score, whose single playhead has none of this to
  // race. Applied exactly as before.
  if (data.dr == null) {
    return true;
  }
  if (data.dr < appliedDisplayRev) {
    console.log(
      `ignoring superseded display rev ${data.dr} < ${appliedDisplayRev}`,
    );
    return false;
  }
  appliedDisplayRev = data.dr;
  return true;
}

/**
 * Present frame `showIdx` of score `sub` (null = the main flow), fetching the
 * sub's assets first if they are not in the page yet.
 *
 * `opts.placeholder` renders without claiming the index as this device's
 * position — the pause placeholder, which is a picture and not a frame the
 * line is standing on (`window.currentIndex` is sent as every tap's `cid`).
 */
function renderDisplay(sub, showIdx, opts = {}) {
  const gen = ++displayGeneration;
  desiredSub = sub || null;
  // Absent on vanilla scores, which never dive: the context stays "".
  if (opts.ctx != null) {
    desiredCtx = opts.ctx;
  }
  const ctx = desiredCtx;
  if (!opts.placeholder) {
    window.currentIndex = showIdx;
  }

  const shown = window.frameContext || { type: "main" };
  if (!desiredSub) {
    // Only when there is something to leave: a vanilla score never enters a
    // sub, and its ordinary SHOW must not start touching the containers.
    if (shown.type === "sub") {
      exitSubSessionView();
    }
    showSubLoadState(null);
    window.displayContext = ctx;
    showImageAtIndex(showIdx);
    return;
  }

  const ready = window.__subCache[desiredSub];
  if (ready) {
    if (shown.type !== "sub" || shown.name !== desiredSub) {
      presentSubView(desiredSub, ready);
    }
    showSubLoadState(null);
    window.displayContext = ctx;
    showImageAtIndex(showIdx);
    return;
  }

  showSubLoadState("loading");
  loadSubScore(desiredSub)
    .then((data) => {
      // Someone moved this line while the score was loading. The newest
      // transition owns the display; this one is over.
      if (gen !== displayGeneration) return;
      presentSubView(desiredSub, data);
      showSubLoadState(null);
      window.displayContext = ctx;
      showImageAtIndex(showIdx);
    })
    .catch((e) => {
      if (gen !== displayGeneration) return;
      // A failed dive used to go to the console and nowhere else, leaving the
      // performer on the frame they dove from with no way to say so. The
      // server's state is the authority, so recovery is one ask for it.
      console.error("sub-enter failed", e);
      showSubLoadState("error");
    });
}

/**
 * Apply one authoritative snapshot — the `snapshot: true` MSG_SHOW that
 * answers MSG_NEED_DISPLAY — in one step.
 *
 * The order matters: the phases and the banner are settled BEFORE the frame is
 * rendered, so a device never shows the new frame carrying the old frame's
 * countdown. Rendering itself may be asynchronous (a sub whose assets are not
 * in the page yet), and `renderDisplay` owns that.
 */
function applyDisplayState(data) {
  window.lineId = data.lineId;

  // Phases, cleared when the snapshot says there is none. This is the half the
  // old piecemeal answer could not express: a message was sent only when a
  // phase was RUNNING, so "no voting" and "no holding" were said by silence,
  // and silence leaves a reconnecting page showing whatever it had.
  resetCountdownsForSubTransition();
  if (data.voting) {
    parseMessage({
      m: MSG_BEGIN_VOTING,
      endTime: data.voting.endTime,
      duration: data.voting.duration,
    });
  } else {
    window.winningVoteId = null;
    window.currVoteId = null;
    window.splitDestinationVoteId = null;
    clearVotingIndicator();
    window.countDic = null;
  }
  if (data.holding) {
    parseMessage({
      m: MSG_BEGIN_HOLDING,
      endTime: data.holding.endTime,
      duration: data.holding.duration,
    });
  }

  // The SM hold switch and the pause switch, which are room state rather than
  // this line's phase.
  setCheckHold(!!data.isHold);
  if (!data.holding) {
    setIndicatorHold(!!data.isHold);
  }
  setCheckPause(!!data.isPause);

  // A barrier release is a message, and a device that was away when it was
  // sent had no way to learn it had happened — so its "waiting for other
  // lines…" banner survived the reconnect. `null` says so explicitly.
  showBarrierWaiting(data.waiting ? data.waiting.role : null);

  // …and finally the frame, in the score the server says this line is in.
  // Paused rooms render the placeholder without claiming a position.
  renderDisplay(data.sub, data.isPause ? -1 : data.showIdx, {
    placeholder: !!data.isPause,
    ctx: data.ctx,
  });
  if (data.isPause) {
    window.currentIndex = data.showIdx;
  }
}

// ── Sub-session view (Session Lines) ─────────────────────────────────────────
window.__subCache = window.__subCache || {};

// Fetches in flight, one entry per sub-score. Several devices diving at once is
// ordinary, and so is one device being told to enter the same sub twice before
// the first fetch lands (a dive followed by a reconnect's snapshot) — without
// this each ask started its own fetch and its own injection, and the second
// could inject a second copy of every frame while the first was still running.
const subLoads = new Map();

function loadSubScore(subName) {
  const cached = window.__subCache[subName];
  if (cached) {
    return Promise.resolve(cached);
  }
  let pending = subLoads.get(subName);
  if (!pending) {
    pending = fetchSubScore(subName).finally(() => subLoads.delete(subName));
    subLoads.set(subName, pending);
  }
  return pending;
}

// Voting resolves on the server one second before its advertised client end
// time. Ordinary travel spends that second in standby, but a sub transition
// displays its landing and starts that frame's hold immediately. Retire the
// old frame's browser timers at the view boundary or its final voting tick and
// the new holding tick both repaint the shared countdown dots (the visible
// entry/exit flicker). The same cleanup covers an operator move or reconnect
// crossing the boundary while an old hold callback is still present.
function resetCountdownsForSubTransition() {
  if (cooldownTimer != null) {
    clearInterval(cooldownTimer);
    cooldownTimer = null;
  }
  isCooldowning = false;

  if (holdingTimer != null) {
    clearInterval(holdingTimer);
    holdingTimer = null;
  }
  window.isHolding = false;

  hideAllCooldownCircles();
  setIndicatorCooldown(false);
  setIndicatorHold(false);
}

// #SubSessionContent is a constant child of #MainContent (session.jade), hidden
// by the stylesheet. Shown as display:contents so injected sub frames lay out
// directly in #MainContent's box, same as the main frames.
function showSubContainer(show) {
  const wrap = document.getElementById("SubSessionContent");
  const mainSvg = document.getElementById("MainSVGContent");
  if (wrap) wrap.style.display = show ? "contents" : "none";
  if (mainSvg) mainSvg.style.display = show ? "none" : "block";
}

// Fetch one sub-score and inject its frames. ASSETS ONLY: it never touches the
// frame context or what is on screen, because by the time it resolves the
// server may have moved this line somewhere else entirely — that decision
// belongs to `renderDisplay`, which took a generation number before starting.
async function fetchSubScore(subName) {
  if (!window.parentListFiles) {
    window.parentListFiles = window.listFiles;
  }

  const res = await fetch(
    `/session/${window.sessionId}/sub/${encodeURIComponent(subName)}`,
  );
  if (!res.ok) throw new Error(`sub fetch ${res.status}`);
  const data = await res.json();

  const container = document.getElementById("SubSessionContent");
  if (!container.querySelector(`svg[id^="sub-${subName}-"]`)) {
    const wrapper = document.createElement("div");
    wrapper.innerHTML = data.framesHtml;
    while (wrapper.firstChild) {
      container.appendChild(wrapper.firstChild);
    }
    window.sessionInstance?.registerSubFrames(subName, data.soundList);
  }

  // Cache only once the frames are actually in the page. Caching first meant
  // a throw mid-injection left an empty sub cached forever: every later dive
  // took the cache hit, skipped injection, and showed a blank sub with no
  // error. Now a failed dive leaves nothing behind and the next one retries.
  window.__subCache[subName] = data;
  return data;
}

// Put the page INTO a loaded sub's view. Separate from the fetch above so the
// two can be ordered by the caller: assets first, presentation only if the
// transition that asked for them is still the newest.
function presentSubView(subName, data) {
  window.listFiles = data.frameList;
  window.frameContext = { type: "sub", name: subName };
  showSubContainer(true);
}

function exitSubSessionView() {
  if (window.parentListFiles) {
    window.listFiles = window.parentListFiles;
  }
  window.frameContext = { type: "main" };
  showSubContainer(false);
}

// While a sub-score's frames are being fetched the performer is looking at the
// frame they dove from, with no indication that anything is happening — and if
// the fetch FAILS they are looking at it permanently, because nothing else on
// this page will ever try again. State is either "loading", "error", or null
// for neither; the error carries the one action that fixes it, which is to ask
// the server what this device should be showing (MSG_NEED_DISPLAY answers with
// the whole picture, so it recovers the context, the frame and the phases at
// once).
//
// Created on demand, like the barrier banner, so a vanilla score that never
// dives keeps its built HTML byte-identical.
function showSubLoadState(state) {
  let el = document.getElementById("sub-load-indicator");
  if (!el && !state) {
    return;
  }
  if (!el) {
    el = document.createElement("div");
    el.id = "sub-load-indicator";
    el.addEventListener("click", () => {
      if (el.dataset.state !== "error") return;
      showSubLoadState("loading");
      sendToServer(MSG_NEED_DISPLAY);
    });
    document.body.appendChild(el);
  }
  if (!state) {
    delete el.dataset.state;
    el.textContent = "";
    return;
  }
  el.dataset.state = state;
  el.textContent =
    state === "error"
      ? "couldn't load this passage — tap to retry"
      : "loading passage…";
}

// The two sides of a track-group wait, sharing one banner and one clear signal
// (MSG_BARRIER_RELEASED):
//   parked    — this line is held (hold-until barrier, or a group's arrival
//               barrier) until the others converge;
// straggler — the opposite seat: a group is held open waiting for THIS line,
// which was told nothing at all until this banner.
const BARRIER_BANNER_TEXT = {
  parked: "waiting for other lines…",
  straggler: "Your move, proceed when ready…",
};

// Both banners are GUIDE-MODE ONLY (owner): they are navigation messages, and
// in play mode they only sat over the frame the performer was sounding.
// Visibility is left entirely to the stylesheet (`.guide-mode
// #barrier-waiting-indicator[data-role]`) rather than an inline display —
// switching modes never comes back through here, so a JS test would go stale
// the moment the performer guided their device.
//
// The element is also created on demand, so a vanilla score that never receives
// a barrier message keeps its shared, apicache-cached HTML byte-identical.
function showBarrierWaiting(role) {
  let el = document.getElementById("barrier-waiting-indicator");
  if (!el) {
    el = document.createElement("div");
    el.id = "barrier-waiting-indicator";
    document.body.appendChild(el);
  }
  if (role) {
    el.textContent = BARRIER_BANNER_TEXT[role] || BARRIER_BANNER_TEXT.parked;
    el.dataset.role = role;
  } else {
    delete el.dataset.role;
  }
  document.body.classList.toggle("barrier-waiting", !!role);
}

function updateNumberOfConnection(numPlayer, numRider, lines) {
  const player = document.getElementById("spanplayer");
  const rider = document.getElementById("spanrider");
  player.innerHTML = `${numPlayer}`;
  rider.innerHTML = `${numRider}`;
  // Session Lines (Chunk M): render the per-line device distribution when the
  // server includes it (admins on a session-lines score only).
  renderLineDistribution(lines);
}

function updateSelectHistory(historyData, selectedIdx, available) {
  const select = document.getElementById("history");
  let content = "";
  for (let i = 0; i < historyData.length; i++) {
    content += `<option value="${i}">${historyData[i]}</option>`;
  }
  select.innerHTML = content;
  select.selectedIndex = selectedIdx;

  // Session Lines: the implicit bound-line rewind is retired — the server
  // always sends available:false, so the dropdown is a read-only display of
  // this line's trail; rewinding (the whole room by track-group checkpoint, or
  // one targeted line) happens from the score map. `undefined` (vanilla scores
  // / no session lines) leaves it enabled, exactly as today.
  const disabled = available === false;
  select.disabled = disabled;
  const wrap = document.getElementById("divhistory");
  if (wrap) {
    wrap.classList.toggle("history-unavailable", disabled);
    wrap.title = disabled
      ? "read-only — rewind (room or a single line) from the score map"
      : "";
  }
}

// ── SM controls across lines (Chunk M) ───────────────────────────────────────
// All of the following admin UI is created dynamically (never added to
// session.jade), so vanilla built HTML stays byte-identical. The server only
// addresses these messages to admins on a session-lines score, so a vanilla
// score never renders them.

// Per-line device distribution — lets the operator see the room's split and spot
// stalled (dormant / barrier-waiting) lines.
function ensureLinePanel() {
  let panel = document.getElementById("line-distribution");
  if (!panel) {
    panel = document.createElement("div");
    panel.id = "line-distribution";
    panel.className = "session-status-container line-distribution";
    const footer = document.getElementById("tablefooter");
    if (footer && footer.parentNode) {
      footer.parentNode.insertBefore(panel, footer.nextSibling);
    } else {
      document.body.appendChild(panel);
    }
  }
  return panel;
}

// A device that has stopped sending its 60s MSG_PING while its socket stays
// open is the one shape of trouble the server's transport keepalive cannot
// see. Flag it only well past that interval: a backgrounded phone throttles
// its timers too, so a couple of quiet minutes is ordinary. This is a label
// for the operator, never grounds for dropping anyone.
const QUIET_THRESHOLD_MS = 180000;

function quietLabel(quietSince) {
  if (!quietSince) {
    return null;
  }
  const age = getServerTime() - quietSince;
  if (age < QUIET_THRESHOLD_MS) {
    return null;
  }
  return `quiet ${Math.floor(age / 60000)}m`;
}

// The panel shows an AGE, so it has to keep ticking between server pushes —
// a room that is stuck sends none, which is exactly when it is being read.
let lastLinesSnapshot = null;
let quietTickTimer = null;

function renderLineDistribution(lines) {
  if (!window.isAdminView || !Array.isArray(lines)) {
    return;
  }
  lastLinesSnapshot = lines;
  if (!quietTickTimer) {
    quietTickTimer = setInterval(() => {
      if (lastLinesSnapshot) renderLineDistribution(lastLinesSnapshot);
    }, 15000);
  }
  const panel = ensureLinePanel();
  if (lines.length === 0) {
    panel.style.display = "none";
    return;
  }
  panel.style.display = "flex";
  let html = `<span>Lines:</span>`;
  for (const l of lines) {
    const flags = [];
    if (l.status === "dormant") flags.push("dormant");
    if (l.waiting) flags.push("waiting");
    if (l.straggler) flags.push("straggler");
    if (l.inSub) flags.push("sub");
    const quiet = quietLabel(l.quietSince);
    if (quiet) flags.push(quiet);
    const flagStr = flags.length ? ` (${flags.join(",")})` : "";
    // A straggler is the reason the room is stalled, so it highlights too — and
    // so does a quiet line, which is where a phantom device would show up.
    const stalled =
      l.status === "dormant" || l.waiting || l.straggler || Boolean(quiet);
    html +=
      `<span class="line-info${stalled ? " line-stalled" : ""}">` +
      // Performers only (`players`/`riders`), never the raw `devices` total: a
      // /map tab is an observation tool and must leave no footprint in the
      // room's numbers. Same reading as the map's own `L0·2p+1r` badge.
      `${l.id}: ${l.players}p+${l.riders}r @ ${l.frame || "?"}${flagStr}</span>`;
  }
  panel.innerHTML = html;
}

function setCheckHold(value) {
  const check = document.getElementById("hold");
  check.checked = value;
}

function setCheckPause(value) {
  const check = document.getElementById("pause");
  check.checked = value;
}

function sendPause(check) {
  sendToServer(MSG_PAUSE, { isPause: check.checked });
}

function sendHold(check) {
  sendToServer(MSG_CHECK_HOLD, { isHold: check.checked });
}

function sendHistory(select) {
  sendToServer(MSG_SELECT_HISTORY, { selectedIdx: select.selectedIndex });
}

function sendGlobalRefresh() {
  const r = confirm("Reload all clients in this session?");
  if (!r) {
    return;
  }

  sendToServer(MSG_GLOBAL_REFRESH);
}

function holdingCallback() {
  const now = getServerTime();
  if (now <= holdingEndTime) {
    const elapsedTime = now - holdingStartTime;
    if ((elapsedTime >= 0) & (elapsedTime <= holdingDuration * 1000)) {
      const second = Math.floor(elapsedTime / 1000);
      setHoldingTimeTo(second);
    }
  } else {
    hideAllCooldownCircles();
    setIndicatorHold(false);
    clearInterval(holdingTimer);
    holdingTimer = null;
    window.isHolding = false;
  }
}

function cooldownCallback() {
  const now = getServerTime();
  if (now <= cooldownEndTime) {
    const elapsedTime = now - cooldownStartTime;
    if ((elapsedTime >= 0) & (elapsedTime <= cooldownDuration * 1000)) {
      const second = Math.floor(elapsedTime / 1000);
      setCooldownTimeTo(second);
    }
  } else {
    hideAllCooldownCircles();
    setIndicatorCooldown(false);
    clearInterval(cooldownTimer);
    cooldownTimer = null;
    isCooldowning = false;
  }
}

function hideAllCooldownCircles() {
  const list = getCoundownCircleList();
  for (let i = 0; i < 10; i++) {
    list[i].setAttribute("class", "circle");
  }
}

// Session Lines: which frame list / DOM is currently presented. On the main flow
// this is the inlined #MainSVGContent svgs; inside a sub-session it is the
// fetched #SubSessionContent svgs (ids "sub-<name>-<idx>").
window.frameContext = { type: "main" };

function showImageAtIndex(index) {
  const ctx = window.frameContext || { type: "main" };
  let frameDomId;

  if (ctx.type === "sub") {
    // Match on the FULL id (sub name + index): frames of another injected
    // sub-score share trailing indices and must stay hidden.
    frameDomId = `sub-${ctx.name}-${index}`;
    const listImg = document.querySelectorAll(
      '#SubSessionContent svg[id^="sub-"]',
    );
    for (const img of listImg) {
      img.setAttribute("class", img.id === frameDomId ? "" : "hidden");
    }
  } else {
    const listImg = getListSvg();
    for (let i = 0; i < listImg.length; i++) {
      const id = parseInt(listImg[i].id.substr(3));
      listImg[i].setAttribute("class", id === index ? "" : "hidden");
    }
    frameDomId = index === -1 ? "svg-1" : `svg${index}`;
  }

  const updateView = new CustomEvent("update-view", {
    detail: {
      newIndex: index,
      frameDomId,
    },
  });

  window.dispatchEvent(updateView);
}

function setCooldownTimeTo(second) {
  let secondLeft = cooldownDuration - second; //7, 6, 5, 4, 3, 2, 1
  if (secondLeft > 0) {
    const list = getCoundownCircleList();
    secondLeft =
      cooldownDuration > 10
        ? Math.ceil((secondLeft * 10) / cooldownDuration)
        : secondLeft;
    for (let i = 0; i < 10; i++) {
      list[i].setAttribute(
        "class",
        i + 1 <= secondLeft ? "circle active" : "circle active filled",
      );
      if (i + 1 > cooldownDuration) {
        list[i].setAttribute("class", "hidden");
      }
    }
  }
}

function setHoldingTimeTo(second) {
  let secondLeft = holdingDuration - second; //7, 6, 5, 4, 3, 2, 1
  if (secondLeft > 0) {
    const list = getCoundownCircleList();
    secondLeft =
      holdingDuration > 10
        ? Math.ceil((secondLeft * 10) / holdingDuration)
        : secondLeft;
    for (let i = 0; i < 10; i++) {
      list[i].setAttribute(
        "class",
        i + 1 <= secondLeft ? "circle active" : "circle active filled",
      );
      if (i + 1 > holdingDuration) {
        list[i].setAttribute("class", "hidden");
      }
    }
  }
}

function getListSvg() {
  return document.querySelectorAll("#MainContent svg[id]");
}

function getCoundownCircleList() {
  const listCircle = [];
  for (let i = 1; i < 11; i++) {
    listCircle.push(document.getElementById("circle_" + i));
  }
  return listCircle;
}

function setIndicatorCooldown(value) {
  const cooldownIconClass = document.getElementById("cooldown-icon").classList;
  if (value) {
    cooldownIconClass.add("active");
  } else {
    cooldownIconClass.remove("active");
  }
}

function setIndicatorHold(value) {
  const holdIconClass = document.getElementById("hold-icon").classList;
  if (value) {
    holdIconClass.add("active");
  } else {
    holdIconClass.remove("active");
  }

  document.body.classList.toggle("holding", value);
}
