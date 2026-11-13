/**
 * The performer page (public/javascripts/session.js), executed in a V8 context
 * with a small DOM/fetch/timer harness — shared by the display-protocol tests
 * and by the handler tests that replay REAL server output into the page.
 */

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const JS_DIR = path.join(__dirname, "..", "public", "javascripts");
const { MESSAGES } = require("../constants");

// ── Harness ─────────────────────────────────────────────────────────────────
// Enough DOM for session.js, plus controllable timers and a controllable fetch.

function makeElement(id) {
  const classes = new Set();
  return {
    id,
    className: "",
    style: {},
    dataset: {},
    textContent: "",
    innerHTML: "",
    children: [],
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
      contains: (c) => classes.has(c),
    },
    listeners: {},
    addEventListener(type, fn) {
      this.listeners[type] = fn;
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    setAttribute(name, value) {
      if (name === "class") this.className = value;
      this[name] = value;
    },
    getAttribute(name) {
      return this[name];
    },
    remove() {},
  };
}

function harness() {
  const elements = new Map();
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id);
  };
  // Every id session.js reaches for unconditionally.
  for (const id of [
    "VotingTime",
    "MainContent",
    "MainSVGContent",
    "SubSessionContent",
    "cooldown-icon",
    "hold-icon",
    "hold",
    "pause",
    "history",
    "divhistory",
    "spanplayer",
    "spanrider",
    "stay",
    "votingContainer",
  ]) {
    get(id);
  }
  for (let i = 1; i <= 10; i++) get(`circle_${i}`);

  const timers = new Map();
  let nextTimer = 1;
  let clock = 0;

  const shown = []; // every showImageAtIndex the page performed
  const sent = []; // every message the page sent to the server

  // A fetch whose responses are released by the test, one sub-score at a time.
  const fetchCalls = [];
  const fetchGate = new Map();

  const sandbox = {
    console: { log() {}, error() {}, warn() {} },
    URLSearchParams,
    Date: {
      now: () => clock,
    },
    Promise,
    Map,
    Set,
    JSON,
    Number,
    String,
    Boolean,
    Object,
    Array,
    Math,
    encodeURIComponent,
    parseInt,

    ...Object.fromEntries(Object.entries(MESSAGES).map(([k, v]) => [k, v])),

    getServerTime: () => clock,
    setInterval(fn) {
      const id = nextTimer++;
      timers.set(id, { fn, kind: "interval" });
      return id;
    },
    clearInterval(id) {
      timers.delete(id);
    },
    setTimeout(fn, delay, ...args) {
      const id = nextTimer++;
      timers.set(id, { fn, args, kind: "timeout", at: clock + (delay || 0) });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    CustomEvent: function CustomEvent(type, options) {
      this.type = type;
      this.detail = options && options.detail;
    },
    document: {
      addEventListener() {},
      getElementById: (id) => (elements.has(id) ? elements.get(id) : null),
      createElement: (tag) => makeElement(`created-${tag}`),
      querySelectorAll: () => [],
      // session.js creates its banners on demand and then looks them up by id
      // on every later call — so an appended child has to become findable, or
      // each call would build a fresh one and the page would grow a banner per
      // transition.
      body: (() => {
        const body = makeElement("body");
        const append = body.appendChild.bind(body);
        body.appendChild = (child) => {
          if (child && child.id) elements.set(child.id, child);
          return append(child);
        };
        return body;
      })(),
    },
    fetch(url) {
      fetchCalls.push(url);
      const name = decodeURIComponent(String(url).split("/sub/")[1]);
      let release;
      let fail;
      const promise = new Promise((resolve, reject) => {
        release = (data) =>
          resolve({ ok: true, json: () => Promise.resolve(data) });
        fail = (err) => reject(err);
      });
      fetchGate.set(name, { release, fail });
      return promise;
    },
    WebSocket: function WebSocket() {
      this.readyState = 1;
      this.send = () => {};
      this.close = () => {};
    },
    wsPath: "ws://test",
  };
  sandbox.WebSocket.OPEN = 1;
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.location = { search: "", href: "", reload() {} };
  sandbox.addEventListener = () => {};
  sandbox.dispatchEvent = (e) => {
    if (e.type === "update-view") shown.push(e.detail.newIndex);
  };
  sandbox.sessionStorage = {
    store: {},
    getItem(k) {
      return this.store[k] || null;
    },
    setItem(k, v) {
      this.store[k] = v;
    },
  };
  sandbox.crypto = undefined;
  sandbox.sessionId = "s1";
  sandbox.staffCode = "player";
  sandbox.listFiles = ["A.svg", "B.svg", "C.svg"];
  sandbox.sendToServer = (msg, payload) => sent.push({ msg, ...payload });
  // voting.js lives in its own file; session.js only calls these two.
  sandbox.clearVotingIndicator = () => {};
  sandbox.showVotingIndicator = () => {};

  vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(path.join(JS_DIR, "session.js"), "utf8"),
    sandbox,
  );

  return {
    sandbox,
    shown,
    sent,
    fetchCalls,
    elements: { get },
    releaseSub(name, data) {
      const gate = fetchGate.get(name);
      assert.ok(gate, `no fetch in flight for ${name}`);
      gate.release(data);
      return flush();
    },
    failSub(name, err) {
      const gate = fetchGate.get(name);
      assert.ok(gate, `no fetch in flight for ${name}`);
      gate.fail(err || new Error("boom"));
      return flush();
    },
    fireTimeouts() {
      for (const [id, t] of [...timers]) {
        if (t.kind !== "timeout") continue;
        timers.delete(id);
        t.fn(...(t.args || []));
      }
    },
    pendingTimeouts: () =>
      [...timers.values()].filter((t) => t.kind === "timeout").length,
    banner: () => sandbox.document.getElementById("barrier-waiting-indicator"),
    subLoad: () => sandbox.document.getElementById("sub-load-indicator"),
    bannerCount: () =>
      sandbox.document.body.children.filter(
        (c) => c.id === "barrier-waiting-indicator",
      ).length,
  };
}

// Let queued promise callbacks run.
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

const SUB = {
  frameList: ["sStart.svg", "sEnd.svg"],
  framesHtml: "<svg id='sub-Tetra-0'></svg><svg id='sub-Tetra-1'></svg>",
  soundList: [],
};

module.exports = { harness, flush, SUB, JS_DIR };
