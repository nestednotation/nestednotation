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
    const { showIdx } = data;
    window.currentIndex = showIdx;
    console.log("received show image at index " + window.currentIndex);
    if (window.currentIndex === -1) {
      console.log(data);
    } else {
      showImageAtIndex(window.currentIndex);
    }

    //reset all
    window.winningVoteId = null;
    window.currVoteId = null;
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
    const { countDic, timestamp } = data;
    if (timestamp <= votingDataTimeStamp) {
      return;
    }

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
    const { isPause, showIdx } = data;
    setCheckPause(isPause);
    showImageAtIndex(isPause ? -1 : showIdx);
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
    window.lineId = data.lineId;
    console.log("assigned to line " + window.lineId);
    return;
  }

  if (msg === MSG_BEGIN_SPLIT) {
    window.lineId = data.lineId;
    return;
  }

  // Session Lines: this line is parked at a hold-until barrier, waiting for the
  // other lines to converge. The admin-flagged variant (data.admin) carries the
  // full set of waiting barriers so the operator can force-release a stuck one.
  if (msg === MSG_BARRIER_WAITING) {
    if (data.admin) {
      renderAdminBarrierPanel(data.barriers || []);
    } else {
      showBarrierWaiting(true);
    }
    return;
  }

  if (msg === MSG_BARRIER_RELEASED) {
    showBarrierWaiting(false);
    return;
  }

  // Session Lines: this line dived into a sub-score. Fetch + inject its frames
  // (cached per sub), swap the active frame list, then show the sub frame.
  if (msg === MSG_SUB_ENTER) {
    const { sub, showIdx } = data;
    // showIdx now indexes the SUB frame list. Keep window.currentIndex in sync
    // (as MSG_SHOW does) — outgoing taps send it as `cid`, and the server
    // rejects a tap whose cid !== line.currentIndex. Skipping this leaves cid on
    // the stale main-flow index, so every tap inside the sub is dropped.
    window.currentIndex = showIdx;
    enterSubSessionView(sub)
      .then(() => showImageAtIndex(showIdx))
      .catch((e) => console.error("sub-enter failed", e));
    return;
  }

  // Session Lines: the sub ended — pop back to the main flow landing frame.
  if (msg === MSG_SUB_EXIT) {
    const { showIdx } = data;
    // Back on the main frame list — resync window.currentIndex (see MSG_SUB_ENTER).
    window.currentIndex = showIdx;
    exitSubSessionView();
    showImageAtIndex(showIdx);
    return;
  }
}

// ── Sub-session view (Session Lines) ─────────────────────────────────────────
window.__subCache = window.__subCache || {};

// #SubSessionContent is a constant child of #MainContent (session.jade), hidden
// by the stylesheet. Shown as display:contents so injected sub frames lay out
// directly in #MainContent's box, same as the main frames.
function showSubContainer(show) {
  const wrap = document.getElementById("SubSessionContent");
  const mainSvg = document.getElementById("MainSVGContent");
  if (wrap) wrap.style.display = show ? "contents" : "none";
  if (mainSvg) mainSvg.style.display = show ? "none" : "block";
}

async function enterSubSessionView(subName) {
  if (!window.parentListFiles) {
    window.parentListFiles = window.listFiles;
  }

  let data = window.__subCache[subName];
  if (!data) {
    const res = await fetch(
      `/session/${window.sessionId}/sub/${encodeURIComponent(subName)}`,
    );
    if (!res.ok) throw new Error(`sub fetch ${res.status}`);
    data = await res.json();

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
  }

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

// The barrier banner is created on demand so it never appears in the shared,
// apicache-cached HTML (vanilla scores stay byte-identical).
function showBarrierWaiting(show) {
  let el = document.getElementById("barrier-waiting-indicator");
  if (!el) {
    el = document.createElement("div");
    el.id = "barrier-waiting-indicator";
    el.textContent = "waiting for other lines…";
    el.style.display = "none";
    document.body.appendChild(el);
  }
  el.style.display = show ? "block" : "none";
  document.body.classList.toggle("barrier-waiting", show);
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

  // Session Lines: the implicit bound-line rewind is retired (2026-07-19) —
  // the server always sends available:false, so the dropdown is a read-only
  // display of this line's trail; rewinding (the whole room by track-group
  // checkpoint, or one targeted line) happens from the score map. `undefined`
  // (vanilla scores / no session lines) leaves it enabled, exactly as today.
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

function renderLineDistribution(lines) {
  if (!window.isAdminView || !Array.isArray(lines)) {
    return;
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
    if (l.inSub) flags.push("sub");
    const flagStr = flags.length ? ` (${flags.join(",")})` : "";
    const stalled = l.status === "dormant" || l.waiting;
    html +=
      `<span class="line-info${stalled ? " line-stalled" : ""}">` +
      `${l.id}: ${l.devices} dev @ ${l.frame || "?"}${flagStr}</span>`;
  }
  panel.innerHTML = html;
}

// Barrier force-release panel — the defensive valve for a stuck / rider-only
// barrier (decision #12).
function ensureBarrierPanel() {
  let panel = document.getElementById("admin-barrier-panel");
  if (!panel) {
    panel = document.createElement("div");
    panel.id = "admin-barrier-panel";
    panel.className = "session-status-container admin-barrier-panel";
    panel.style.display = "none";
    document.body.appendChild(panel);
  }
  return panel;
}

function renderAdminBarrierPanel(barriers) {
  if (!window.isAdminView) {
    return;
  }
  const panel = ensureBarrierPanel();
  if (!barriers || barriers.length === 0) {
    panel.style.display = "none";
    panel.innerHTML = "";
    return;
  }
  panel.style.display = "flex";
  panel.innerHTML = "";

  const heading = document.createElement("span");
  heading.textContent = "Barriers waiting:";
  panel.appendChild(heading);

  // Built as elements with attached handlers rather than an assembled
  // onclick="…('<frame>')" string: a frame named `Don't Stop.svg` closed the
  // quoted argument early and left that one button inert (release all still
  // worked). Any filename is safe here.
  for (const b of barriers) {
    const parked = (b.parked || []).join(",") || "none";

    const info = document.createElement("span");
    info.className = "barrier-info";
    info.textContent = `${b.frame} [parked: ${parked}] `;

    const release = document.createElement("button");
    release.type = "button";
    release.textContent = "release";
    release.addEventListener("click", () => sendForceReleaseBarrier(b.frame));
    info.appendChild(release);

    panel.appendChild(info);
  }

  const releaseAll = document.createElement("button");
  releaseAll.type = "button";
  releaseAll.textContent = "release all";
  releaseAll.addEventListener("click", () => sendForceReleaseBarrier());
  panel.appendChild(releaseAll);
}

// Ask the server to force-release a chosen barrier (by frame) or all waiting
// barriers (no argument). Reuses the MSG_BARRIER_RELEASED constant as an inbound
// admin command (server → Chunk J release path).
function sendForceReleaseBarrier(frame) {
  sendToServer(MSG_BARRIER_RELEASED, frame ? { frame } : {});
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
