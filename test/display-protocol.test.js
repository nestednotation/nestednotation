/**
 * M2–M4 — the client display protocol, executed.
 *
 * Runs the REAL `public/javascripts/session.js` and `ws-client.js` in a V8
 * context with a small DOM/fetch/timer harness, and drives them with the
 * messages the server actually sends. These are behavioural: they fail if the
 * generation token, the display revision or the delivery cancellation is
 * removed, and they do not look at the source text.
 *
 * What is covered:
 *   M2  a slow sub-score fetch that finishes after the line has moved on
 *       renders nothing; a failed fetch leaves a recoverable state.
 *   M3  one snapshot restores context, frame, pause, phases and the waiting
 *       banner — including the states that are OFF.
 *   M4  a message held for the preload window is cancelled with its socket,
 *       and one superseded by a later revision on the SAME socket is dropped.
 */

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const JS_DIR = path.join(__dirname, "..", "public", "javascripts");
const { MESSAGES } = require("../constants");

const { harness, SUB } = require("./client-harness");

module.exports = {
  // ── M2 ────────────────────────────────────────────────────────────────────
  "a sub-score fetch that lands after the line left renders nothing": async () => {
    const h = harness();
    // Dive: the fetch is in flight and the page is still on the main flow.
    h.sandbox.parseMessage({ m: MESSAGES.MSG_SUB_ENTER, sub: "Tetra", showIdx: 0, dr: 1 });
    assert.strictEqual(h.fetchCalls.length, 1);
    assert.strictEqual(h.sandbox.frameContext.type, "main");
    assert.strictEqual(h.subLoad().dataset.state, "loading");

    // …and while it is in flight the server ejects the line back to the main
    // flow, which is a newer transition.
    h.sandbox.parseMessage({ m: MESSAGES.MSG_SUB_EXIT, showIdx: 2, dr: 2 });
    assert.strictEqual(h.sandbox.frameContext.type, "main");
    assert.strictEqual(h.shown[h.shown.length - 1], 2);

    // The fetch finally lands. It must NOT pull the page back into the sub.
    await h.releaseSub("Tetra", SUB);
    assert.strictEqual(
      h.sandbox.frameContext.type,
      "main",
      "an obsolete fetch switched the frame context",
    );
    assert.strictEqual(
      h.shown[h.shown.length - 1],
      2,
      "an obsolete fetch repainted the display",
    );
    assert.strictEqual(h.sandbox.currentIndex, 2);
  },

  "a second entry into the same sub does not start a second fetch": async () => {
    const h = harness();
    h.sandbox.parseMessage({ m: MESSAGES.MSG_SUB_ENTER, sub: "Tetra", showIdx: 0, dr: 1 });
    // A reconnect's snapshot re-asserts the same dive before the first landed.
    h.sandbox.parseMessage({
      m: MESSAGES.MSG_SHOW,
      snapshot: true,
      dr: 2,
      lineId: "L0",
      sub: "Tetra",
      showIdx: 1,
      isPause: false,
      isHold: false,
      holding: null,
      voting: null,
      waiting: null,
    });
    assert.strictEqual(h.fetchCalls.length, 1, "the sub was fetched twice");

    await h.releaseSub("Tetra", SUB);
    // The NEWEST transition owns the display.
    assert.strictEqual(h.sandbox.frameContext.name, "Tetra");
    assert.strictEqual(h.shown[h.shown.length - 1], 1);
  },

  "a failed sub fetch leaves a recoverable state, and retrying resyncs": async () => {
    const h = harness();
    h.sandbox.parseMessage({ m: MESSAGES.MSG_SUB_ENTER, sub: "Tetra", showIdx: 0, dr: 1 });
    await h.failSub("Tetra");

    const indicator = h.subLoad();
    assert.strictEqual(indicator.dataset.state, "error");
    assert.ok(indicator.textContent.length > 0, "the failure must be legible");
    assert.strictEqual(
      h.sandbox.frameContext.type,
      "main",
      "a failed dive must not present an empty sub",
    );

    // The affordance asks the server what this device should be showing.
    indicator.listeners.click();
    assert.deepStrictEqual(
      h.sent[h.sent.length - 1],
      { msg: MESSAGES.MSG_NEED_DISPLAY },
    );

    // …and nothing was cached, so the next dive really retries.
    h.sandbox.parseMessage({ m: MESSAGES.MSG_SUB_ENTER, sub: "Tetra", showIdx: 0, dr: 2 });
    assert.strictEqual(h.fetchCalls.length, 2);
  },

  // ── M3 ────────────────────────────────────────────────────────────────────
  "a snapshot takes a reconnecting page out of a sub it has left": async () => {
    const h = harness();
    h.sandbox.parseMessage({ m: MESSAGES.MSG_SUB_ENTER, sub: "Tetra", showIdx: 0, dr: 1 });
    await h.releaseSub("Tetra", SUB);
    assert.strictEqual(h.sandbox.frameContext.type, "sub");
    assert.deepStrictEqual(h.sandbox.listFiles, SUB.frameList);

    // Reconnect: the line is back on the main flow. A bare SHOW would change
    // the index while leaving the SUB's frame list in place.
    h.sandbox.parseMessage({
      m: MESSAGES.MSG_SHOW,
      snapshot: true,
      dr: 2,
      lineId: "L0",
      sub: null,
      showIdx: 2,
      isPause: false,
      isHold: false,
      holding: null,
      voting: null,
      waiting: null,
    });
    assert.strictEqual(h.sandbox.frameContext.type, "main");
    assert.deepStrictEqual(h.sandbox.listFiles, ["A.svg", "B.svg", "C.svg"]);
    assert.strictEqual(h.sandbox.currentIndex, 2);
  },

  "a snapshet with no waiting state clears a stale banner": async () => {
    const h = harness();
    h.sandbox.parseMessage({
      m: MESSAGES.MSG_BARRIER_WAITING,
      frame: "Barrier.svg",
    });
    assert.strictEqual(h.banner().dataset.role, "parked");

    // The release happened while this device was away; the snapshot says so by
    // reporting the waiting state as null rather than by staying silent.
    h.sandbox.parseMessage({
      m: MESSAGES.MSG_SHOW,
      snapshot: true,
      dr: 1,
      lineId: "L0",
      sub: null,
      showIdx: 1,
      isPause: false,
      isHold: false,
      holding: null,
      voting: null,
      waiting: null,
    });
    assert.strictEqual(h.banner().dataset.role, undefined);
  },

  "a paused snapshot carries the sub context and the line's real index": async () => {
    const h = harness();
    // A page loaded into a PAUSED room, on a line that is mid-dive: the old
    // answer sent no context-bearing message at all while paused.
    h.sandbox.parseMessage({
      m: MESSAGES.MSG_SHOW,
      snapshot: true,
      dr: 1,
      lineId: "L0",
      sub: "Tetra",
      showIdx: 1,
      isPause: true,
      isHold: false,
      holding: null,
      voting: null,
      waiting: null,
    });
    assert.strictEqual(h.elements.get("pause").checked, true);
    await h.releaseSub("Tetra", SUB);
    assert.strictEqual(h.sandbox.frameContext.name, "Tetra");
    // The placeholder is shown, but the position the page reports to the
    // server (its `cid`) is still the frame the line is standing on.
    assert.strictEqual(h.shown[h.shown.length - 1], -1);
    assert.strictEqual(h.sandbox.currentIndex, 1);
  },

  "a snapshot restores a running hold and clears a finished vote": async () => {
    const h = harness();
    h.sandbox.parseMessage({ m: MESSAGES.MSG_BEGIN_VOTING, endTime: 9000, duration: 5 });
    assert.strictEqual(h.elements.get("cooldown-icon").classList.contains("active"), true);

    h.sandbox.parseMessage({
      m: MESSAGES.MSG_SHOW,
      snapshot: true,
      dr: 1,
      lineId: "L0",
      sub: null,
      showIdx: 1,
      isPause: false,
      isHold: true,
      holding: { endTime: 9000, duration: 5 },
      voting: null,
      waiting: null,
    });
    assert.strictEqual(
      h.elements.get("cooldown-icon").classList.contains("active"),
      false,
      "a snapshot with no vote must clear the voting indicator",
    );
    assert.strictEqual(
      h.elements.get("hold-icon").classList.contains("active"),
      true,
    );
    assert.strictEqual(h.elements.get("hold").checked, true);
  },

  // ── M4 ────────────────────────────────────────────────────────────────────
  "a display message superseded on the same socket is dropped": () => {
    const h = harness();
    // The rewind lands first (the server sent it for "now"), the preloaded
    // SHOW it overtook fires afterwards.
    h.sandbox.parseMessage({ m: MESSAGES.MSG_SHOW, showIdx: 2, dr: 7 });
    assert.strictEqual(h.shown[h.shown.length - 1], 2);
    h.sandbox.parseMessage({ m: MESSAGES.MSG_SHOW, showIdx: 0, dr: 6 });
    assert.strictEqual(
      h.shown[h.shown.length - 1],
      2,
      "a stale revision repainted the display",
    );
    assert.strictEqual(h.sandbox.currentIndex, 2);
    // A revision-less message (a vanilla score) is applied as before.
    h.sandbox.parseMessage({ m: MESSAGES.MSG_SHOW, showIdx: 1 });
    assert.strictEqual(h.shown[h.shown.length - 1], 1);
  },

  "a reconnect resets the display epoch so a restarted server is believed": () => {
    const h = harness();
    h.sandbox.parseMessage({ m: MESSAGES.MSG_SHOW, showIdx: 2, dr: 40 });
    // The server restarted: its revisions count from 1 again.
    h.sandbox.resetDisplayEpoch();
    h.sandbox.parseMessage({ m: MESSAGES.MSG_SHOW, showIdx: 0, dr: 1 });
    assert.strictEqual(h.shown[h.shown.length - 1], 0);
  },
};

// ── ws-client.js: the delivery timers themselves ────────────────────────────
// Loaded on its own, with `parseMessage` recorded rather than executed, so the
// scheduling and cancellation can be observed directly.
function wsHarness() {
  const timers = new Map();
  let nextTimer = 1;
  const delivered = [];
  const sandbox = {
    console: { log() {}, error() {}, warn() {} },
    Date,
    Math,
    JSON,
    Number,
    Uint8Array,
    parseMessage: (data) => delivered.push(data),
    getServerTime: () => 0,
    setTimeout(fn, delay, ...args) {
      const id = nextTimer++;
      timers.set(id, { fn, args });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    setInterval: () => 0,
    clearInterval() {},
    document: {
      getElementById: () => null,
      addEventListener() {},
    },
    sessionStorage: {
      getItem: () => null,
      setItem() {},
    },
    crypto: undefined,
    wsPath: "ws://test",
    WebSocket: function WebSocket() {
      this.readyState = 1;
      this.send = () => {};
      this.close = () => {};
    },
    MSG_PING: MESSAGES.MSG_PING,
    MSG_SHOW: MESSAGES.MSG_SHOW,
    MSG_NEED_DISPLAY: MESSAGES.MSG_NEED_DISPLAY,
  };
  sandbox.WebSocket.OPEN = 1;
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(path.join(JS_DIR, "ws-client.js"), "utf8"),
    sandbox,
  );
  return {
    sandbox,
    delivered,
    fire: () => {
      for (const [id, t] of [...timers]) {
        timers.delete(id);
        t.fn(...(t.args || []));
      }
    },
    pending: () => timers.size,
  };
}

module.exports["a message held for the preload window dies with its socket"] =
  () => {
    const w = wsHarness();
    // The server addressed this frame to a moment in the near future — `t` is
    // a SERVER clock reading, which ws-client.js derives from its own.
    w.sandbox.onWsMessage({
      data: JSON.stringify({
        m: MESSAGES.MSG_SHOW,
        showIdx: 3,
        t: Date.now() + 500,
      }),
    });
    assert.strictEqual(w.pending(), 1, "the future message must be held");
    assert.strictEqual(w.delivered.length, 0);

    // …and the socket is replaced before it fires.
    w.sandbox.teardownSocket();
    w.fire();
    assert.strictEqual(
      w.delivered.length,
      0,
      "a message held across a teardown was still delivered",
    );
  };

module.exports["an immediate message is delivered without a timer"] = () => {
  const w = wsHarness();
  w.sandbox.onWsMessage({
    data: JSON.stringify({ m: MESSAGES.MSG_SHOW, showIdx: 1, t: 0 }),
  });
  assert.strictEqual(w.pending(), 0);
  assert.strictEqual(w.delivered.length, 1);
  assert.strictEqual(w.delivered[0].showIdx, 1);
};

// ── Revisions across a line change (F1) ─────────────────────────────────────
// The server numbers display messages from ONE sequence, and a device whose
// line changes takes the assignment's revision as its floor. These drive the
// page through the three reassignments a room produces — a split onto a fresh
// line, a merge into a survivor, and a structural undo back onto a restored
// line — with the previous line's preloaded SHOW still queued.

const show = (showIdx, dr) => ({ m: MESSAGES.MSG_SHOW, showIdx, dr });
const assigned = (lineId, dr) => ({ m: MESSAGES.MSG_LINE_ASSIGNED, lineId, dr });
const last = (h) => h.shown[h.shown.length - 1];

module.exports["a device split onto a new line applies that line's frames"] =
  () => {
    const h = harness();
    h.sandbox.parseMessage(assigned("L0", 18));
    h.sandbox.parseMessage(show(1, 20));
    // The split: a new line whose messages were numbered AFTER everything L0
    // sent this device. Under per-line counters its first frame was rev 1 and
    // was rejected until L1 had sent twenty messages.
    h.sandbox.parseMessage({ m: MESSAGES.MSG_BEGIN_SPLIT, lineId: "L1", dr: 25 });
    h.sandbox.parseMessage(assigned("L1", 26));
    h.sandbox.parseMessage(show(2, 27));
    assert.strictEqual(last(h), 2);
    assert.strictEqual(h.sandbox.lineId, "L1");
  };

module.exports["the previous line's queued frame is dropped after a line change"] =
  () => {
    const h = harness();
    h.sandbox.parseMessage(assigned("L0", 1));
    h.sandbox.parseMessage(show(0, 2));
    // L0 advanced: its SHOW is held for the preload window (revision 5)…
    const queued = show(1, 5);
    // …and before it fires, this device is split onto L1, whose own frame is
    // itself preloaded and not applied yet either.
    h.sandbox.parseMessage(assigned("L1", 7));
    h.sandbox.parseMessage(queued);
    assert.strictEqual(
      last(h),
      0,
      "a frame queued by the line this device left was applied",
    );
    h.sandbox.parseMessage(show(2, 8));
    assert.strictEqual(last(h), 2);
  };

module.exports["a merge survivor keeps its own line's queued frame"] = () => {
  const h = harness();
  h.sandbox.parseMessage(assigned("L0", 1));
  h.sandbox.parseMessage(show(0, 2));
  const queued = show(1, 5);
  // Another line merged INTO L0: this device is told the id it already has,
  // which retires nothing.
  h.sandbox.parseMessage(assigned("L0", 6));
  h.sandbox.parseMessage(queued);
  assert.strictEqual(last(h), 1);
};

module.exports["a restored line does not revive a frame queued before it was left"] =
  () => {
    const h = harness();
    h.sandbox.parseMessage(assigned("L0", 1));
    h.sandbox.parseMessage(show(0, 2));
    const queued = show(1, 5);
    // Split away and undone straight back onto L0 before the frame fires: the
    // line id matches again, the revision still does not.
    h.sandbox.parseMessage(assigned("L1", 6));
    h.sandbox.parseMessage(assigned("L0", 9));
    h.sandbox.parseMessage(queued);
    assert.strictEqual(last(h), 0);
    // …and the snapshot the device asks for next is believed.
    h.sandbox.parseMessage({
      m: MESSAGES.MSG_SHOW,
      snapshot: true,
      dr: 10,
      ctx: "",
      lineId: "L0",
      sub: null,
      showIdx: 2,
      isPause: false,
      isHold: false,
      holding: null,
      voting: null,
      waiting: null,
    });
    assert.strictEqual(last(h), 2);
  };

// ── Pause supersedes a queued SHOW (F4) ─────────────────────────────────────
module.exports["a pause is not overwritten by the SHOW queued before it"] = () => {
  const h = harness();
  h.sandbox.parseMessage(assigned("L0", 1));
  h.sandbox.parseMessage(show(0, 2));
  // An advance queued its frame for the preload deadline…
  const queued = show(1, 3);
  // …and the operator paused before it.
  h.sandbox.parseMessage({ m: MESSAGES.MSG_PAUSE, isPause: true, showIdx: 1, dr: 4 });
  assert.strictEqual(last(h), -1);
  h.sandbox.parseMessage(queued);
  assert.strictEqual(last(h), -1, "the queued SHOW replaced the pause placeholder");
  assert.strictEqual(h.sandbox.currentIndex, 1, "the tap position still names the line's frame");
  // Resume shows the line's frame.
  h.sandbox.parseMessage({ m: MESSAGES.MSG_PAUSE, isPause: false, showIdx: 1, dr: 5 });
  assert.strictEqual(last(h), 1);
};

// ── The dive context a tap reports (F3) ──────────────────────────────────────
module.exports["the reported dive context follows what is on screen"] = async () => {
  const h = harness();
  assert.strictEqual(h.sandbox.displayContext, "");
  h.sandbox.parseMessage({
    m: MESSAGES.MSG_SUB_ENTER,
    sub: "Tetra",
    showIdx: 0,
    dr: 1,
    ctx: "Tetra>barrier.svg",
  });
  // Still loading: the performer is looking at the main-flow frame, and a tap
  // on it must say so.
  assert.strictEqual(h.sandbox.displayContext, "");
  await h.releaseSub("Tetra", SUB);
  assert.strictEqual(h.sandbox.displayContext, "Tetra>barrier.svg");

  h.sandbox.parseMessage({ m: MESSAGES.MSG_SUB_EXIT, showIdx: 2, dr: 2, ctx: "" });
  assert.strictEqual(h.sandbox.displayContext, "");
};

// ── A load still in flight when the device's line or socket changes (F7) ────
// The generation token retires a load overtaken by a newer RENDER. A line
// change and a new socket are also newer than the load, but they render
// nothing themselves — the new line's frame, or the reconnect's snapshot, is
// still on its way — so they retire it on their own.

const subEnter = (dr) => ({ m: MESSAGES.MSG_SUB_ENTER, sub: "Tetra", showIdx: 0, dr });

module.exports["a sub load from the line this device left presents nothing"] =
  async () => {
    const h = harness();
    h.sandbox.parseMessage(assigned("L0", 1));
    h.sandbox.parseMessage(subEnter(2));
    assert.strictEqual(h.fetchCalls.length, 1);
    // Split onto L1 before the load lands; L1's frame is still preloading.
    h.sandbox.parseMessage(assigned("L1", 3));
    await h.releaseSub("Tetra", SUB);
    assert.strictEqual(
      h.sandbox.frameContext.type,
      "main",
      "L0's dive was presented on a device that follows L1",
    );
    assert.deepStrictEqual(h.shown, [], "L0's passage was rendered");
    // L1's own frame then renders normally…
    h.sandbox.parseMessage(show(2, 4));
    assert.strictEqual(last(h), 2);
    assert.strictEqual(h.subLoad().dataset.state, undefined);
    // …and the assets the retired load fetched are kept: a later dive into the
    // same sub does not fetch again.
    h.sandbox.parseMessage(subEnter(5));
    assert.strictEqual(h.fetchCalls.length, 1);
    assert.strictEqual(h.sandbox.frameContext.name, "Tetra");
    assert.strictEqual(last(h), 0);
  };

module.exports["a sub load from the previous socket presents nothing"] = async () => {
  const h = harness();
  h.sandbox.parseMessage(assigned("L0", 1));
  h.sandbox.parseMessage(subEnter(2));
  // Reconnect: the snapshot answering MSG_NEED_DISPLAY has not arrived yet.
  h.sandbox.resetDisplayEpoch();
  await h.releaseSub("Tetra", SUB);
  assert.strictEqual(h.sandbox.frameContext.type, "main");
  assert.deepStrictEqual(h.shown, [], "the old socket's dive was rendered");
  // The snapshot is authoritative, and renders from the cached assets.
  h.sandbox.parseMessage({
    m: MESSAGES.MSG_SHOW,
    snapshot: true,
    dr: 1,
    ctx: "Tetra>barrier.svg",
    lineId: "L0",
    sub: "Tetra",
    showIdx: 1,
    isPause: false,
    isHold: false,
    holding: null,
    voting: null,
    waiting: null,
  });
  assert.strictEqual(h.fetchCalls.length, 1);
  assert.strictEqual(h.sandbox.frameContext.name, "Tetra");
  assert.strictEqual(last(h), 1);
  assert.strictEqual(h.sandbox.displayContext, "Tetra>barrier.svg");
};

module.exports["a merge survivor's sub load still presents"] = async () => {
  const h = harness();
  h.sandbox.parseMessage(assigned("L0", 1));
  h.sandbox.parseMessage(subEnter(2));
  // Another line merged into L0 while the load was in flight: the device is
  // told the line it already follows, and its dive is still the display.
  h.sandbox.parseMessage(assigned("L0", 3));
  await h.releaseSub("Tetra", SUB);
  assert.strictEqual(h.sandbox.frameContext.name, "Tetra");
  assert.strictEqual(last(h), 0);
};
