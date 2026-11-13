/** Structural rewinds and live performer mutations share one session lane. */

const assert = require("node:assert");

const { BMSession } = require("../database.js");
const {
  loadWww,
  removeBuildOutputs,
  settle,
} = require("./www-harness");
const { buildSessionLinesFixture } = require("./session-lines-fixture");
const { MESSAGES: M } = require("../constants");

module.exports = {
  "a performer move and disconnect wait for an in-flight rewind": async () => {
    const session = new BMSession();
    const order = [];
    let releaseRewind;
    const rewindGate = new Promise((resolve) => {
      releaseRewind = resolve;
    });

    const rewind = session.runExclusively(async () => {
      order.push("rewind:start");
      await rewindGate;
      order.push("rewind:end");
    });
    const tap = session.runExclusively(async () => {
      order.push("tap");
    });
    const disconnect = session.runExclusively(async () => {
      order.push("disconnect");
    });

    await Promise.resolve();
    assert.deepStrictEqual(order, ["rewind:start"]);
    releaseRewind();
    await Promise.all([rewind, tap, disconnect]);
    assert.deepStrictEqual(order, [
      "rewind:start",
      "rewind:end",
      "tap",
      "disconnect",
    ]);
  },

  "a failed mutation does not poison the session lane": async () => {
    const session = new BMSession();
    await assert.rejects(
      session.runExclusively(async () => {
        throw new Error("expected");
      }),
      /expected/,
    );

    let ran = false;
    await session.runExclusively(async () => {
      ran = true;
    });
    assert.strictEqual(ran, true);
  },

  // ── Through the production handlers (review T3) ───────────────────────────
  //
  // These used to be source checks: a regex for the message dispatcher, and a
  // 220-character window after every setTimeout/setInterval that had to
  // contain `.runExclusively(`. Both passed broken wiring (a lane entered
  // after the state was already touched) and failed harmless reformatting.
  // Here a real mutation holds the lane open while taps arrive and the
  // server's own timers come due; nothing may change until it lets go.

  "a tap arriving during an in-flight mutation waits for it": () =>
    withDemoRoom("__lane_tap__", async (h, session) => {
      const player = await join(h, session, "p1");
      const line = session.lines[0];
      const before = lineState(line);
      const sentBefore = player.sent.length;

      const lane = holdLane(session);
      const tapping = tapNext(h, session, player, "START.svg", "Left.svg");
      await settle();
      assert.strictEqual(lineState(line), before, "the tap changed the line mid-mutation");
      assert.strictEqual(player.sent.length, sentBefore, "the tap was answered mid-mutation");

      lane.release();
      await tapping;
      assert.notStrictEqual(lineState(line), before, "the tap never applied");
    }),

  "voting and standby timers wait for an in-flight mutation": () =>
    withDemoRoom("__lane_voting__", async (h, session) => {
      const player = await join(h, session, "p1");
      const line = session.lines[0];
      await tapNext(h, session, player, "START.svg", "Left.svg");
      assert.ok(line.isVoting, "the tap did not open a voting window");
      const before = lineState(line);

      const lane = holdLane(session);
      // Well past the voting window and the standby gap after it.
      await h.advance(60000);
      assert.strictEqual(lineState(line), before, "a timer moved the line mid-mutation");

      lane.release();
      await settle();
      for (let i = 0; i < 160 && session.listFiles[line.currentIndex] !== "Left.svg"; i++) {
        await h.advance(250);
      }
      assert.strictEqual(session.listFiles[line.currentIndex], "Left.svg");
    }),

  "the holding timer waits for an in-flight mutation": () =>
    withDemoRoom("__lane_holding__", async (h, session) => {
      const player = await join(h, session, "p1");
      const line = session.lines[0];
      await walk(h, session, player, "START.svg", "Left.svg");
      await h.advance(2000);
      await walk(h, session, player, "Left.svg", "Barrier.svg");
      for (let i = 0; i < 40 && line.holdingTimer == null; i++) {
        await h.advance(50);
      }
      assert.ok(line.holdingTimer != null, "Barrier.svg never began holding");

      const lane = holdLane(session);
      await h.advance(25000); // Barrier.svg holds for 19 s
      assert.strictEqual(line.isHolding, true, "the hold ended mid-mutation");

      lane.release();
      await settle();
      assert.strictEqual(line.isHolding, false, "the hold never ended");
    }),

  "the attrition grace timer waits for an in-flight mutation": () =>
    withDemoRoom("__lane_attrition__", async (h, session) => {
      const player = await join(h, session, "p1");
      await join(h, session, "p2");
      // Split so each performer has a line of their own.
      await walk(h, session, player, "START.svg", "Left.svg");
      const own = session.lines.find(
        (l) => l.status === "active" && l.id === player.lineId,
      );
      assert.ok(own, "the performer has no line of their own");
      const others = session.lines.filter((l) => l.status === "active" && l !== own);
      assert.ok(
        others.every((l) => !h.www.wsServer.connections.some((c) => c !== player && c.lineId === own.id)),
        "the line is shared",
      );

      h.disconnect(player);
      await session.runExclusively(() => h.www.handleConnectionClose(session, player));
      await settle();
      assert.ok(own._attritionTimer != null, "no attrition grace started");
      const status = own.status;

      const lane = holdLane(session);
      await h.advance(60000);
      assert.strictEqual(own.status, status, "attrition finalized mid-mutation");

      lane.release();
      await settle();
      assert.notStrictEqual(own.status, status, "attrition never finalized");
    }),

  "a same-folder score rebuild runs on the session lane": async () => {
    const router = require("../routes/sm.js");
    const handler = router.stack.find((l) => l.route && l.route.path === "/")
      .route.stack.find((s) => s.method === "get").handle;

    const events = [];
    let inLane = false;
    const session = {
      id: "S1",
      folder: "Score",
      defaultVolume: 80,
      runExclusively: async (work) => {
        events.push("lane:enter");
        inLane = true;
        try {
          return await work();
        } finally {
          inLane = false;
          events.push("lane:exit");
        }
      },
      patchState: async () => {
        events.push(`patch${inLane ? "@lane" : ""}`);
      },
      rebuildScore: async () => {
        events.push(`rebuild${inLane ? "@lane" : ""}`);
        return false;
      },
    };
    const db = {
      admin: { getByName: () => ({ id: "1", password: "pw" }) },
      sessionTable: { getById: () => session },
      getListScore: () => ["Score"],
    };
    const req = {
      url: "/?c=update-session",
      cookies: { root: "2", un: "admin", upw: "pw" },
      query: {
        i: "S1",
        n: "name",
        f: "Score",
        hd: "0",
        vd: "10",
        c: "update-session",
        sp: "admin",
        pp: "player",
        defaultVolume: "80",
      },
      app: { get: (key) => (key === "Database" ? db : () => {}) },
    };
    let redirected = null;
    const res = {
      status() {
        return this;
      },
      redirect(to) {
        redirected = to;
      },
    };

    await handler(req, res);
    assert.deepStrictEqual(events, ["lane:enter", "patch@lane", "rebuild@lane", "lane:exit"]);
    assert.strictEqual(redirected, "/sm");
  },
};

// ── Helpers for the handler cases ────────────────────────────────────────────

async function withDemoRoom(id, fn) {
  const session = await buildSessionLinesFixture({ id });
  let h = null;
  try {
    h = loadWww();
    h.addSession(session);
    await fn(h, session);
  } finally {
    if (h) h.dispose();
    removeBuildOutputs(session.id);
  }
}

async function join(h, session, did) {
  const conn = h.connect({ label: did });
  await h.send(conn, M.MSG_PING, { sid: session.id, sig: "player", did, clientTime: 0 });
  await h.send(conn, M.MSG_NEED_DISPLAY, { sid: session.id, sig: "player", did });
  return conn;
}

function tapNext(h, session, conn, from, to) {
  const idx = (n) => session.listFilesInLowerCase.indexOf(n.toLowerCase());
  return h.send(conn, M.MSG_TAP, {
    sid: session.id,
    sig: "player",
    did: conn.label,
    cid: idx(from),
    selectedId: `${idx(to)}#${from}#0`,
    ctx: "",
  });
}

async function walk(h, session, conn, from, to) {
  await tapNext(h, session, conn, from, to);
  const line = () => session.lines.find((l) => l.id === conn.lineId);
  for (let i = 0; i < 160 && session.listFiles[line().currentIndex] !== to; i++) {
    await h.advance(250);
  }
  assert.strictEqual(session.listFiles[line().currentIndex], to);
}

// A mutation that holds the session lane until the test lets go.
function holdLane(session) {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const done = session.runExclusively(() => gate);
  return {
    release: () => {
      release();
      return done;
    },
  };
}

function lineState(line) {
  return JSON.stringify({
    currentIndex: line.currentIndex,
    history: line.history,
    isVoting: line.isVoting,
    isStandby: line.isStandby,
    isHolding: line.isHolding,
    status: line.status,
  });
}
