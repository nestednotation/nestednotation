/**
 * Runs the REAL `bin/www` message handlers in-process, with the transport and
 * the clock under the test's control.
 *
 * `bin/www` is a script, not a module: loading it starts two HTTP listeners,
 * a WebSocket server and a database that reads every saved room. So the source
 * is compiled as a function body with its `require` answered here — HTTP,
 * WebSocket, Express and the database are replaced by inert stand-ins, and
 * everything the handlers actually decide with (constants, routing,
 * orchestrator, BMLine, and the BMSession objects the test builds) is the real
 * code. Nothing listens, nothing is read from `server_state`.
 *
 * What the test gets back:
 *   - `connect(opts)` — a fake socket registered with the server, recording
 *     every message addressed to it (`conn.sent`, parsed).
 *   - `send(conn, msg, payload)` — one inbound message through the production
 *     `messageHandle`, on the room's real mutation lane.
 *   - `advance(ms)` — moves a virtual clock and fires the server's own
 *     setTimeout/setInterval callbacks in time order (voting ticks, holding
 *     periods, attrition grace), letting each settle before the next. The
 *     same clock is `Date` for bin/www AND for the modules it imports, so a
 *     deadline the server computes and the policy that later checks it read
 *     one timeline (`now()`).
 *   - `dispose()` — puts the real clock and timers back.
 *   - `www` — the handful of internal functions a test needs to reach
 *     directly (see EXPORTS below).
 */

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Module = require("node:module");

const WWW = path.join(__dirname, "..", "bin", "www");

// The internals a test may call or inspect. Everything else stays private.
const EXPORTS = [
  "messageHandle",
  "wsServer",
  "handleConnectionClose",
  "orch",
  "tryReleaseBarriers",
  "updateNumberOfConnectionForSession",
  "pushConnectionSnapshot",
];

// Let every promise the handlers chained settle.
async function settle() {
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// The instant a harness's clock starts at. An epoch reading, not zero: the
// server compares `Date.now()` against deadlines it computed from
// `Date.now()`, and a clock that started at zero next to epoch deadlines made
// every "still pending" check pass by construction.
const EPOCH = Date.UTC(2026, 0, 1);

const REAL = {
  Date,
  setTimeout,
  setInterval,
  clearTimeout,
  clearInterval,
};
let installed = null;

function loadWww() {
  const sessions = new Map();
  const errors = [];

  // ── Virtual clock ─────────────────────────────────────────────────────────
  // ONE clock for everything the server decides with. bin/www reads it, and so
  // do the modules it imports: the line phase clock (`landingHoldElapsed`),
  // the orchestrator's timestamps, and the timers BMLine/BMSession CANCEL
  // (`clearAllTimer`, the attrition grace) — a timer bin/www started on the
  // virtual scheduler and a lib module cleared with the real `clearTimeout`
  // would never be cancelled at all. Those modules are loaded once and shared
  // with the test's own BMSession objects, so the clock is installed on the
  // global object for the life of the harness and put back by `dispose()`.
  let clock = EPOCH;
  let nextId = 1;
  const timers = new Map();
  const schedule = (fn, delay, args, every) => {
    const id = nextId++;
    const d = Math.max(0, Number(delay) || 0);
    timers.set(id, { fn, args, at: clock + d, every: every ? d || 1 : 0 });
    return id;
  };
  const cancel = (id) => {
    timers.delete(id);
  };
  const fakeTimers = {
    setTimeout: (fn, delay, ...args) => schedule(fn, delay, args, false),
    setInterval: (fn, delay, ...args) => schedule(fn, delay, args, true),
    clearTimeout: cancel,
    clearInterval: cancel,
  };
  class VirtualDate extends REAL.Date {
    constructor(...args) {
      if (args.length === 0) {
        super(clock);
      } else {
        super(...args);
      }
    }
    static now() {
      return clock;
    }
  }

  if (installed) {
    throw new Error("www-harness: the previous harness was not disposed");
  }
  installed = { ...fakeTimers, Date: VirtualDate };
  Object.assign(globalThis, installed);
  const dispose = () => {
    if (!installed) return;
    Object.assign(globalThis, REAL);
    installed = null;
    timers.clear();
  };

  // ── Stand-ins for what bin/www would start at load time ──────────────────
  class FakeWebSocketServer {
    constructor() {
      this.connections = [];
    }
    on() {}
  }
  class FakeDatabase {
    constructor() {
      this.sessionTable = {
        getById: (id) => sessions.get(id) || null,
        forceSessionStop: async () => {},
      };
      this.admin = { add() {}, dumpToFile() {} };
    }
    dumpToFile() {}
  }
  const inertServer = () => ({ listen() {}, on() {} });
  const stubs = {
    "../app": { set() {}, get() {} },
    debug: () => () => {},
    http: { createServer: inertServer },
    websocket: { server: FakeWebSocketServer },
    "../database.js": FakeDatabase,
    dotenv: { config() {} },
  };
  const realRequire = Module.createRequire(WWW);
  const requireForWww = (id) =>
    Object.prototype.hasOwnProperty.call(stubs, id)
      ? stubs[id]
      : realRequire(id);

  const quiet = {
    log() {},
    info() {},
    warn() {},
    debug() {},
    error: (...args) => errors.push(args.map(String).join(" ")),
  };

  const source = fs
    .readFileSync(WWW, "utf8")
    .replace(/^#!.*\r?\n/, "")
    .concat(`\nreturn { ${EXPORTS.join(", ")} };\n`);
  const params = [
    "require",
    "module",
    "exports",
    "__filename",
    "__dirname",
    "console",
    "setTimeout",
    "setInterval",
    "clearTimeout",
    "clearInterval",
    "Date",
  ];
  let www;
  try {
    const fn = vm.compileFunction(source, params, { filename: WWW });
    www = fn(
      requireForWww,
      { exports: {} },
      {},
      WWW,
      path.dirname(WWW),
      quiet,
      fakeTimers.setTimeout,
      fakeTimers.setInterval,
      fakeTimers.clearTimeout,
      fakeTimers.clearInterval,
      VirtualDate,
    );
  } catch (e) {
    dispose();
    throw e;
  }

  let connSeq = 0;

  return {
    www,
    errors,
    /** The clock the server, its timers and the imported policies all read. */
    now: () => clock,
    /** Put the real clock and timers back. Always call it (see withRoom). */
    dispose,

    /** Serve this room. Its state file is never written. */
    addSession(session) {
      session.saveSessionStateToFile = async () => {};
      sessions.set(session.id, session);
      return session;
    },

    /** A socket the server can address; nothing is sent until the test does. */
    connect(over = {}) {
      connSeq += 1;
      const conn = {
        label: over.label || `c${connSeq}`,
        sent: [],
        sendUTF(text) {
          this.sent.push(JSON.parse(text));
        },
        on() {},
        close() {},
        ...over,
      };
      www.wsServer.connections.push(conn);
      return conn;
    },

    disconnect(conn) {
      const list = www.wsServer.connections;
      const at = list.indexOf(conn);
      if (at >= 0) list.splice(at, 1);
    },

    /** One inbound message through the production handler. */
    async send(conn, msg, payload = {}) {
      await www.messageHandle(conn, {
        type: "utf8",
        utf8Data: JSON.stringify({ msg, ...payload }),
      });
      await settle();
    },

    /**
     * Move the clock forward, firing every timer that comes due on the way —
     * in time order, each one allowed to settle before the next.
     */
    async advance(ms) {
      const until = clock + ms;
      for (;;) {
        let due = null;
        for (const [id, t] of timers) {
          if (t.at <= until && (!due || t.at < due[1].at)) due = [id, t];
        }
        if (!due) break;
        const [id, t] = due;
        clock = Math.max(clock, t.at);
        if (t.every) {
          t.at += t.every;
        } else {
          timers.delete(id);
        }
        t.fn(...(t.args || []));
        await settle();
      }
      clock = until;
      await settle();
    },

    pendingTimers: () => timers.size,
  };
}

/** Messages of type `m` a connection has received, oldest first. */
function received(conn, m) {
  return conn.sent.filter((payload) => payload.m === m);
}

/** Remove what building a fixture score wrote into server_state. */
function removeBuildOutputs(id) {
  const { SERVER_STATE_DIR } = require("../database.js");
  // The state file, and every baked file of every revision
  // (`${id}.rev-<revision>.html` and so on; database.js bundleFile).
  const baked = /^(?:rev-[0-9a-z]+\.)?(?:html|content\.svg|about\.svg|subs\.json)$/;
  for (const name of fs.readdirSync(SERVER_STATE_DIR)) {
    if (!name.startsWith(`${id}.`)) continue;
    const rest = name.slice(id.length + 1);
    if (rest !== "json" && !baked.test(rest)) continue;
    try {
      fs.unlinkSync(path.join(SERVER_STATE_DIR, name));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
}

module.exports = { loadWww, received, removeBuildOutputs, settle };
