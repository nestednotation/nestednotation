/**
 * The score map's rewind requests and receipts, executed (review T3).
 *
 * Runs the real public/javascripts/session-map.js in a V8 sandbox with a
 * permissive stand-in DOM and captures what it actually sends. This replaces
 * source-proximity checks ("`operationId` appears near each send") that passed
 * with the id set to undefined: here the payload itself is inspected, and the
 * receipts are fed through the page's real `parseMessage`.
 *
 * Also the startup path (review F10/F11): the graph fetch and `start` run
 * against a stubbed fetch and a manually advanced clock.
 */

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { MESSAGES } = require("../constants");

const SOURCE_PATH = path.join(
  __dirname,
  "..",
  "public",
  "javascripts",
  "session-map.js",
);

// An element that answers every DOM call session-map.js makes on its receipt
// and dialog paths: children are created on first lookup, by id or selector.
function makeElement(tag = "div") {
  const classes = new Set();
  const attrs = {};
  const bySelector = new Map();
  const el = {
    tagName: tag.toUpperCase(),
    style: {},
    dataset: {},
    hidden: false,
    disabled: false,
    textContent: "",
    innerHTML: "",
    children: [],
    isConnected: true,
    offsetParent: {},
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      toggle: (c, on) =>
        (on === undefined ? !classes.has(c) : on)
          ? classes.add(c)
          : classes.delete(c),
      contains: (c) => classes.has(c),
    },
    addEventListener() {},
    removeEventListener() {},
    appendChild(child) {
      el.children.push(child);
      return child;
    },
    remove() {},
    focus() {},
    contains: () => false,
    closest: () => null,
    getBoundingClientRect: () => ({ top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 }),
    setAttribute: (n, v) => {
      attrs[n] = String(v);
    },
    getAttribute: (n) => (n in attrs ? attrs[n] : null),
    hasAttribute: (n) => n in attrs,
    removeAttribute: (n) => {
      delete attrs[n];
    },
    querySelector(sel) {
      if (!bySelector.has(sel)) bySelector.set(sel, makeElement());
      return bySelector.get(sel);
    },
    querySelectorAll: () => [],
  };
  return el;
}

function loadMap(overrides = {}) {
  const elements = new Map();
  const byId = (id) => {
    if (!elements.has(id)) elements.set(id, makeElement());
    return elements.get(id);
  };
  const sent = [];
  const body = makeElement("body");
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    // Timers never fire: nothing here waits on one, and a real 16 s toast
    // timer would hold the test process open.
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    requestAnimationFrame: () => 0,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: {
      body,
      activeElement: body,
      addEventListener() {},
      removeEventListener() {},
      getElementById: byId,
      createElement: (tag) => makeElement(tag),
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    location: { search: "", reload() {} },
    sendToServer: (m, payload) => sent.push({ m, ...payload }),
    __SESSION_MAP_TEST__: {},
    sessionId: "room",
    staffCode: "admin",
    ...MESSAGES,
    ...overrides,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SOURCE_PATH, "utf8"), sandbox, {
    filename: SOURCE_PATH,
  });
  const hooks = sandbox.__SESSION_MAP_TEST__.hooks;
  assert.ok(hooks, "session-map.js did not expose its test hooks");
  return {
    hooks,
    sent,
    receive: (data) => sandbox.parseMessage(data),
    toastText: () => byId("session-map-toast").querySelector("span").textContent,
    element: byId,
  };
}

// A clock the startup tests drive: timers fire only when advanced, in due
// order, with promise jobs flushed between them.
function manualClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  const flush = () => new Promise((r) => setImmediate(r));
  return {
    setTimeout: (fn, ms = 0) => {
      const id = nextId++;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    pending: () => timers.size,
    flush,
    async advance(ms) {
      const end = now + ms;
      await flush();
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await flush();
      }
      now = end;
      await flush();
    },
  };
}

// Answers any call or property with itself: enough of a cytoscape instance
// for render() to run without a canvas.
function anything() {
  const target = function () {};
  const proxy = new Proxy(target, {
    get: (t, key) => (key === Symbol.toPrimitive ? () => 0 : proxy),
    apply: () => proxy,
  });
  return proxy;
}

// The page as the startup path sees it: the graph route answered by `serve`,
// the drawing library already present, the socket counted instead of opened.
function loadStartup(serve) {
  const clock = manualClock();
  const counts = { fetches: 0, aborts: 0, sockets: 0, draws: 0 };
  const cy = anything();
  const map = loadMap({
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    fetch: (url, init = {}) => {
      counts.fetches++;
      if (init.signal) {
        init.signal.addEventListener("abort", () => counts.aborts++);
      }
      return serve(counts.fetches, url);
    },
    AbortController: class {
      constructor() {
        const listeners = [];
        this.signal = {
          addEventListener: (type, fn) => listeners.push(fn),
        };
        this.abort = () => listeners.forEach((fn) => fn());
      }
    },
    cytoscape: () => {
      counts.draws++;
      return cy;
    },
    dagre: {},
    cytoscapeDagre: () => {},
    connectWebSocket: () => {
      counts.sockets++;
    },
    // ws-client.js globals the page wires once the socket is open.
    onVisibilityChange() {},
    onPageHide() {},
    onPageShow() {},
    addEventListener() {},
    removeEventListener() {},
  });
  return { ...map, clock, counts };
}

const GRAPH = {
  main: {
    hasSessionLines: false,
    frames: ["START.svg", "B.svg"],
    byFrame: { "START.svg": { hrefs: ["B.svg"] }, "B.svg": { hrefs: [] } },
    frameNameByLower: { "start.svg": "START.svg", "b.svg": "B.svg" },
  },
  subs: {},
};
const answer = (status, json) =>
  Promise.resolve({ ok: status >= 200 && status < 300, status, json });
const graphAnswer = () => answer(200, () => Promise.resolve(GRAPH));

const done = (operationId, over = {}) => ({
  m: MESSAGES.MSG_REWIND_DONE,
  kind: "line",
  frame: "B.svg",
  operationId,
  rewindEntry: { kind: "line", frame: "B.svg", at: 1 },
  ...over,
});

module.exports = {
  "a graph body that stalls after its headers is cut off and retried": async () => {
    const map = loadStartup((n) =>
      n === 1 ? answer(200, () => new Promise(() => {})) : graphAnswer(),
    );
    const result = map.hooks.fetchGraph();
    await map.clock.flush();
    // Headers are in; the body never comes. The deadline is still running.
    assert.strictEqual(map.clock.pending(), 1, "no deadline left on the body read");
    await map.clock.advance(10000);
    assert.strictEqual(map.counts.aborts, 1);
    assert.match(map.element("session-map-status").textContent, /did not answer in time/);
    await map.clock.advance(2000);
    assert.deepStrictEqual(await result, GRAPH);
    assert.strictEqual(map.counts.fetches, 2);
    assert.strictEqual(map.clock.pending(), 0, "a deadline outlived its attempt");
  },

  "a graph body that fails to read is retried like any other failed attempt": async () => {
    const unreadable = () => {
      const e = new Error("Unexpected end of JSON input");
      e.name = "SyntaxError";
      return Promise.reject(e);
    };
    const map = loadStartup((n) => (n === 1 ? answer(200, unreadable) : graphAnswer()));
    const result = map.hooks.fetchGraph();
    await map.clock.advance(0);
    assert.match(map.element("session-map-status").textContent, /unreadable graph/);
    await map.clock.advance(2000);
    assert.deepStrictEqual(await result, GRAPH);
    assert.strictEqual(map.clock.pending(), 0);
  },

  "a score still building when the attempts run out offers retry, and retry starts the map": async () => {
    let built = false;
    const map = loadStartup(() => (built ? graphAnswer() : answer(404, () => Promise.resolve({}))));
    const container = map.element("session-map");
    const started = map.hooks.start(container);
    // 15 attempts, 2 s apart, every one a 404.
    await map.clock.advance(15 * 2000);
    await started;
    assert.strictEqual(map.counts.fetches, 15);
    const status = map.element("session-map-status");
    assert.match(status.textContent, /may still be building/);
    assert.ok(status.classList.contains("startup-error"));
    const retry = map.element("session-map-retry");
    assert.strictEqual(retry.hidden, false, "no retry offered");
    assert.strictEqual(map.counts.sockets, 0);
    assert.strictEqual(map.counts.draws, 0);

    // The server finishes building; retry in the same tab.
    built = true;
    retry.onclick();
    await map.clock.advance(0);
    assert.strictEqual(map.counts.draws, 1, "the map was not drawn");
    assert.strictEqual(map.counts.sockets, 1, "the socket was not opened");
    assert.strictEqual(retry.hidden, true);
    assert.ok(!status.classList.contains("startup-error"));
    assert.strictEqual(status.textContent, "connecting…");
  },

  "every rewind the map sends carries the id of the gesture it carries out": () => {
    const map = loadMap();

    map.hooks.rememberRewind("line", "B.svg", "Rewound L0 to ⟨B⟩");
    const first = map.hooks.pendingRewind().operationId;
    map.hooks.commitRewind({ lineId: "L0", selectedIdx: 1, frame: "B.svg" });

    map.hooks.rememberRewind("line", "C.svg", "Rewound L1 to ⟨C⟩");
    const second = map.hooks.pendingRewind().operationId;
    map.hooks.commitRewind({ lineId: "L1", selectedIdx: 2, frame: "C.svg" });

    assert.deepStrictEqual(map.sent, [
      { m: MESSAGES.MSG_SELECT_HISTORY, lineId: "L0", selectedIdx: 1, frame: "B.svg", operationId: first },
      { m: MESSAGES.MSG_SELECT_HISTORY, lineId: "L1", selectedIdx: 2, frame: "C.svg", operationId: second },
    ]);
    assert.strictEqual(typeof first, "string");
    assert.ok(first.length > 0 && first.length <= 128, "the server accepts ids up to 128 chars");
    assert.notStrictEqual(first, second);
  },

  "a rewind with no receipt of its own still gets a fresh id each time": () => {
    const map = loadMap();
    map.hooks.commitRewind({ selectedIdx: 3 });
    map.hooks.commitRewind({ selectedIdx: 3 });
    const [a, b] = map.sent.map((p) => p.operationId);
    assert.ok(typeof a === "string" && a.length > 0);
    assert.notStrictEqual(a, b);
  },

  "only this tab's own receipt shows its promised sentence and clears it": () => {
    const map = loadMap();
    map.hooks.rememberRewind("line", "B.svg", "Rewound L0 to ⟨B⟩");
    const mine = map.hooks.commitRewind({ lineId: "L0", selectedIdx: 1, frame: "B.svg" }).operationId;

    // Another operator's rewind at the same frame, same kind.
    map.receive(done("someone-else"));
    assert.strictEqual(map.toastText(), "Another operator rewound a line to ⟨B⟩.");
    assert.ok(map.hooks.pendingRewind(), "another tab's receipt must not clear ours");

    map.receive(done(mine));
    assert.strictEqual(map.toastText(), "Rewound L0 to ⟨B⟩.");
    assert.strictEqual(map.hooks.pendingRewind(), null);
  },

  "a refusal clears the pending sentence only when it answers this tab": () => {
    const map = loadMap();
    map.hooks.rememberRewind("merge", "J.svg", "Undid the merge at ⟨J⟩");
    const mine = map.hooks.commitRewind({ mergeEventId: 4, frame: "J.svg", cascade: [] }).operationId;

    map.receive({ m: MESSAGES.MSG_REWIND_REFUSED, kind: "merge", reason: "stale-cascade", frame: "J.svg", operationId: "someone-else" });
    assert.strictEqual(map.hooks.pendingRewind().operationId, mine);

    map.receive({ m: MESSAGES.MSG_REWIND_REFUSED, kind: "merge", reason: "stale-cascade", frame: "J.svg", operationId: mine });
    assert.strictEqual(map.hooks.pendingRewind(), null);
  },

  "the rewind log is rebuilt from the persisted log a push carries": () => {
    const map = loadMap();
    map.receive({
      m: MESSAGES.MSG_SHOW_NUMBER_CONNECTION,
      playerCount: 0,
      riderCount: 0,
      rewindLog: [
        { kind: "merge", frame: "J.svg", at: 2 },
        { kind: "line", frame: "B.svg", lineId: "L1", at: 1 },
      ],
    });
    const log = map.element("session-map-log").innerHTML;
    assert.match(log, /J/);
    assert.match(log, /L1/);
    assert.ok(log.indexOf("J") < log.indexOf("L1"), "newest first, as persisted");

    // A receipt's entry joins the same log.
    map.hooks.rememberRewind("room", "G", "Rewound the room to checkpoint ⟨G⟩");
    const id = map.hooks.commitRewind({ group: "G", cascade: [] }).operationId;
    map.receive(done(id, { kind: "room", frame: "G", rewindEntry: { kind: "room", frame: "G", at: 3 } }));
    const after = map.element("session-map-log").innerHTML;
    assert.ok(after.indexOf("G") < after.indexOf("J"), after);
  },

  "a line whose trails were kept is drawn with the ones already received": () => {
    const map = loadMap();
    const push = (lines) =>
      map.receive({ m: MESSAGES.MSG_SHOW_NUMBER_CONNECTION, playerCount: 1, riderCount: 0, lines });
    push([
      { id: "L0", uid: "u0", frame: "B.svg", trail: ["A.svg", "B.svg"], mainTrail: ["A.svg", "B.svg"] },
      { id: "L1", uid: "u1", frame: "C.svg", trail: ["A.svg", "C.svg"], mainTrail: ["A.svg", "C.svg"] },
    ]);
    push([
      { id: "L0", uid: "u0", frame: "B.svg", trailKept: true },
      { id: "L1", uid: "u1", frame: "D.svg", trail: ["A.svg", "C.svg", "D.svg"], mainTrail: ["A.svg", "C.svg", "D.svg"] },
    ]);
    const lines = map.hooks.latestLines();
    assert.deepStrictEqual(lines[0].trail, ["A.svg", "B.svg"]);
    assert.deepStrictEqual(lines[0].mainTrail, ["A.svg", "B.svg"]);
    assert.deepStrictEqual(lines[1].trail, ["A.svg", "C.svg", "D.svg"]);

    // A line the room no longer carries is forgotten: kept trails for a
    // number that comes back as a different route are never reused.
    push([{ id: "L0", uid: "u0", frame: "B.svg", trailKept: true }]);
    push([{ id: "L1", uid: "u1", frame: "D.svg", trailKept: true }]);
    assert.strictEqual(map.hooks.latestLines()[0].trail, undefined);
  },

  // The one architectural check left: the gesture above is only a guarantee
  // if no entry point can reach the server another way.
  "the map sends MSG_SELECT_HISTORY from one place only": () => {
    const source = fs.readFileSync(SOURCE_PATH, "utf8");
    const direct = source.match(/sendToServer\(\s*MSG_SELECT_HISTORY\b/g) || [];
    assert.strictEqual(direct.length, 1, "a rewind bypasses commitRewind");
    assert.match(source, /function commitRewind\(payload\) \{[\s\S]*?sendToServer\(MSG_SELECT_HISTORY, message\)/);
  },
};
