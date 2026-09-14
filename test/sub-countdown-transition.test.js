/**
 * Sub-score entry/exit is a hard display boundary for the shared countdown.
 *
 * The server closes voting one second before the timestamp shown by clients.
 * Ordinary navigation uses that second as standby, but a sub transition starts
 * the landing hold immediately. Unless the transition retires the old browser
 * interval, its final voting tick races the new holding tick and the ten shared
 * dots flicker between their two states.
 */

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const CLIENT = path.join(
  __dirname,
  "..",
  "public",
  "javascripts",
  "session.js",
);

function clientHarness() {
  const intervals = new Map();
  const cleared = [];
  let nextInterval = 1;

  const classList = () => ({
    add() {},
    remove() {},
    toggle() {},
  });
  const elements = new Map();
  for (let i = 1; i <= 10; i++) {
    elements.set(`circle_${i}`, {
      className: "circle",
      setAttribute(name, value) {
        if (name === "class") this.className = value;
      },
    });
  }
  for (const id of ["cooldown-icon", "hold-icon"]) {
    elements.set(id, { classList: classList() });
  }

  const sandbox = {
    console,
    URLSearchParams,
    Date,
    Promise,
    MSG_PING: 1,
    MSG_SHOW: 2,
    MSG_CHANGE_FOLDER: 3,
    MSG_UPDATE_VOTING: 4,
    MSG_BEGIN_VOTING: 5,
    MSG_BEGIN_HOLDING: 6,
    MSG_CHECK_HOLD: 7,
    MSG_PAUSE: 8,
    MSG_FINISH: 9,
    MSG_SELECT_HISTORY: 10,
    MSG_SHOW_NUMBER_CONNECTION: 11,
    MSG_CHANGE_VOLUME: 12,
    MSG_GLOBAL_REFRESH: 13,
    MSG_LINE_ASSIGNED: 14,
    MSG_BEGIN_SPLIT: 15,
    MSG_BARRIER_WAITING: 16,
    MSG_BARRIER_RELEASED: 17,
    MSG_SUB_ENTER: 18,
    MSG_SUB_EXIT: 19,
    getServerTime: () => 1_000,
    setInterval(fn) {
      const id = nextInterval++;
      intervals.set(id, fn);
      return id;
    },
    clearInterval(id) {
      cleared.push(id);
      intervals.delete(id);
    },
    clearTimeout() {},
    setTimeout() {},
    CustomEvent: function CustomEvent(type, options) {
      this.type = type;
      this.detail = options.detail;
    },
    document: {
      addEventListener() {},
      getElementById(id) {
        return elements.get(id) || null;
      },
      querySelectorAll() {
        return [];
      },
      body: { classList: classList() },
    },
  };
  sandbox.window = sandbox;
  sandbox.location = { search: "", href: "" };
  sandbox.addEventListener = () => {};
  sandbox.dispatchEvent = () => {};

  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(CLIENT, "utf8"), sandbox);
  return { sandbox, intervals, cleared, elements };
}

module.exports = {
  "both sub transitions reset the old frame countdown": () => {
    const src = fs.readFileSync(CLIENT, "utf8");
    for (const message of ["MSG_SUB_ENTER", "MSG_SUB_EXIT"]) {
      const start = src.indexOf(`if (msg === ${message})`);
      assert.ok(start >= 0, `missing ${message} handler`);
      const handler = src.slice(start, src.indexOf("\n  }", start) + 4);
      assert.match(
        handler,
        /resetCountdownsForSubTransition\(\);/,
        `${message} must retire the previous frame's timers`,
      );
    }
  },

  "sub exit cancels voting and holding intervals before they can repaint": () => {
    const { sandbox, intervals, cleared, elements } = clientHarness();

    sandbox.parseMessage({
      m: sandbox.MSG_BEGIN_VOTING,
      endTime: 5_000,
      duration: 4,
    });
    assert.strictEqual(intervals.size, 1, "voting interval should be running");
    const votingInterval = [...intervals.keys()][0];

    sandbox.parseMessage({ m: sandbox.MSG_SUB_EXIT, showIdx: 0 });
    assert.ok(
      cleared.includes(votingInterval),
      "sub exit left the voting interval alive",
    );
    assert.ok(!intervals.has(votingInterval));

    sandbox.parseMessage({
      m: sandbox.MSG_BEGIN_HOLDING,
      endTime: 5_000,
      duration: 4,
    });
    assert.strictEqual(intervals.size, 1, "holding interval should be running");
    const holdingInterval = [...intervals.keys()][0];

    sandbox.parseMessage({ m: sandbox.MSG_SUB_EXIT, showIdx: 0 });
    assert.ok(
      cleared.includes(holdingInterval),
      "sub exit left the holding interval alive",
    );
    assert.strictEqual(
      intervals.size,
      0,
      "a prior-frame callback can still repaint the dots",
    );
    for (let i = 1; i <= 10; i++) {
      assert.strictEqual(elements.get(`circle_${i}`).className, "circle");
    }
  },
};
