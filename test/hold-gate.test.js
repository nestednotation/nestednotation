/**
 * The landing hold has ONE gate, and it reads the FRAME.
 *
 * `landingHoldSeconds` made the graph the authority for how long a landing is
 * held. The gate deciding whether it is held at all stayed on
 * `session.holdDuration` — the room's default, which is 0 unless an operator
 * sets one — so a frame authored `holding="12"` was ignored outright on the
 * ordinary voted and grouped advance while every other landing in the §7.1
 * census played it. Same frame, different route, different behaviour, which is
 * the split `landingHoldSeconds` exists to close. It is not only a timing
 * difference: a landing with no hold is registered `done` on arrival, so a
 * `hold-until` there whose targets were already met releases in the same tick,
 * freeing the line the moment its device was told to show the frame.
 *
 * So `session.holdDuration` is the DEFAULT VALUE and nothing else: every gate
 * goes through `holdsAtLanding`. The middle cases land real lines through the
 * production handlers (test/www-harness.js) and read the hold each landing got.
 * The remaining source checks are single-statement rules the handlers cannot
 * expose on their own: that no other read of the default exists, and that the
 * sub-end rule is stated rather than inherited from the hold flag.
 */

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { loadWww, removeBuildOutputs } = require("./www-harness");
const { buildSessionLinesFixture } = require("./session-lines-fixture");
const { MESSAGES: M } = require("../constants");

const RUNTIME = path.join(__dirname, "..", "bin", "www");

/** The runtime's lines with `//` comments and JSDoc stripped, 1-indexed. */
function codeLines() {
  const src = fs.readFileSync(RUNTIME, "utf8");
  let inBlock = false;
  return src.split(/\r?\n/).map((line, i) => {
    let text = line;
    if (inBlock) {
      const end = text.indexOf("*/");
      if (end < 0) return { n: i + 1, text: "" };
      text = text.slice(end + 2);
      inBlock = false;
    }
    const block = text.indexOf("/*");
    if (block >= 0) {
      inBlock = text.indexOf("*/", block) < 0;
      text = text.slice(0, block);
    }
    const slash = text.indexOf("//");
    if (slash >= 0) text = text.slice(0, slash);
    return { n: i + 1, text };
  });
}

module.exports = {
  "session.holdDuration is a default value, never a hold gate": () => {
    const uses = codeLines().filter((l) => l.text.includes("holdDuration"));
    assert.ok(uses.length > 0, "expected bin/www to read session.holdDuration");
    // The one legitimate read: the default `parseCustomDur` falls back to when
    // a frame authors no `holding` of its own.
    const stray = uses.filter(
      (l) => !/^\s*return parseCustomDur\(session\.holdDuration, authored\);$/.test(l.text),
    );
    assert.deepStrictEqual(
      stray.map((l) => `${l.n}: ${l.text.trim()}`),
      [],
      "a hold decision is reading session.holdDuration directly — it must ask " +
        "holdsAtLanding, of the frame the line has landed on",
    );
  },

  // The neighbourhood check this replaces looked for `holds` within six lines
  // above each hold start — true of a gate asked BEFORE the move just as much
  // as after it, and false after a harmless reflow. These land real lines
  // through the production handlers and read the hold they got.

  "a landing holds for its own frame's value, asked after the move": () =>
    withDemoRoom("__hold_gate_after_move__", async (h, session) => {
      session.holdDuration = 0;
      const player = await join(h, session, "p1");
      const line = session.lines[0];

      // Left authors nothing and the room default is 0: no hold.
      await walk(h, session, player, "START.svg", "Left.svg");
      await h.advance(3000);
      assert.strictEqual(line.isHolding, false, "Left.svg held with nothing authored");
      assert.strictEqual(line.holdingTimer, null);

      // Barrier authors 19. A gate asked before the move would read Left's 0.
      await walk(h, session, player, "Left.svg", "Barrier.svg");
      const hold = await holdStarted(h, line);
      assert.strictEqual(hold.seconds, 19);
      assert.strictEqual(hold.endMinusBegin, 19000);
    }),

  "the room default applies only where the frame is silent": () =>
    withDemoRoom("__hold_gate_default__", async (h, session) => {
      session.holdDuration = 4;
      const player = await join(h, session, "p1");
      const line = session.lines[0];

      await walk(h, session, player, "START.svg", "Left.svg");
      const atLeft = await holdStarted(h, line);
      assert.strictEqual(atLeft.seconds, 4, "Left.svg is silent: the default holds");
      await h.advance(4000 + 100);
      assert.strictEqual(line.isHolding, false);

      await walk(h, session, player, "Left.svg", "Barrier.svg");
      const atBarrier = await holdStarted(h, line);
      assert.strictEqual(atBarrier.seconds, 19, "an authored value beats the default");
    }),

  "a sub-score frame holds by its own value too": () =>
    withDemoRoom("__hold_gate_sub__", async (h, session) => {
      session.holdDuration = 4;
      const player = await join(h, session, "p1");

      await walk(h, session, player, "START.svg", "Right.svg");
      const line = lineOf(session, player);
      await h.advance(4000 + 3000);
      // Right's one link dives into Tetra, whose START authors 7.
      await tapNext(h, session, player, "Right.svg", "Barrier.svg");
      for (let i = 0; i < 160 && line.subStack.length === 0; i++) {
        await h.advance(250);
      }
      assert.strictEqual(line.subStack.length, 1, "the line never dived");
      const inSub = await holdStarted(h, line);
      assert.strictEqual(inSub.seconds, 7);
    }),

  "a sub-end never completes on arrival": () => {
    // The companion rule, and the one that made moving the gate dangerous.
    // `recordArrival` decides `arrived` vs `done` from whether the landing is
    // still holding — which for a sub-end used to be true by accident, because
    // the ordinary advance set `isHolding` on any non-zero session default
    // whatever the frame said. Reading the FRAME instead, a sub-end authored
    // `holding="false"` (the honest value for a marker no device displays)
    // started completing on arrival, releasing a `hold-until` waiting on it
    // while the line was still inside the sub. `test/sub-session.test.js` pins
    // the behaviour against the real fixture; this pins that bin/www still
    // states the rule rather than inheriting it from the hold flag.
    const src = fs.readFileSync(RUNTIME, "utf8");
    assert.match(
      src,
      /const passingThrough =\s*line\.isHolding \|\| isSubEndFrame\(session, line\);/,
      "recordArrival must treat a sub-end as passing through, not resting",
    );
    assert.match(
      src,
      /markReached\(session\.reachedTargets, ref, !passingThrough\)/,
      "…and complete the ref on that answer, not on isHolding alone",
    );
  },

  "the gate and the duration read the same frame": () => {
    const src = fs.readFileSync(RUNTIME, "utf8");
    assert.match(
      src,
      /function holdsAtLanding\(session, line\) \{\s*return landingHoldSeconds\(session, line\) > 0;\s*\}/,
      "holdsAtLanding must be landingHoldSeconds' own answer, not a second rule",
    );
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
    // The link's position on the frame is part of its id.
    selectedId: `${idx(to)}#${from}#${session.graph.byFrame[from].hrefs.indexOf(to)}`,
    ctx: "",
  });
}

// The line this device is on now — a split can move it to a new one.
function lineOf(session, conn) {
  return session.lines.find((l) => l.id === conn.lineId);
}

async function walk(h, session, conn, from, to) {
  await tapNext(h, session, conn, from, to);
  for (
    let i = 0;
    i < 160 && session.listFiles[lineOf(session, conn).currentIndex] !== to;
    i++
  ) {
    await h.advance(250);
  }
  assert.strictEqual(session.listFiles[lineOf(session, conn).currentIndex], to);
}

// Wait out the standby gap until the landing's hold begins; report it.
async function holdStarted(h, line) {
  for (let i = 0; i < 80 && line.holdingTimer == null; i++) {
    await h.advance(50);
  }
  assert.ok(line.holdingTimer != null, "the landing never began holding");
  return {
    seconds: line.currentHoldingDuration,
    endMinusBegin: line.currentEndHoldTimeStamp - line.currentBeginHoldTimeStamp,
  };
}
