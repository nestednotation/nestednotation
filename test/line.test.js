/**
 * Chunk E / N tests — BMLine extraction + versioned persistence.
 *
 * Covers: BMLine toJSON/fromJSON round-trip, v1(flat)→v2(lines:[one]) migration,
 * BMSession playhead-helper delegation + versioned toJSON, and clearAllTimer
 * clearing every line's timers. (The BMSession per-line prototype shim was
 * removed in Chunk N once bin/www read/wrote the line objects directly — the
 * "no shim" case asserts the session no longer exposes per-line fields.)
 */

const assert = require("node:assert");

const {
  BMLine,
  migrateState,
  DEFAULT_LINE_ID,
} = require("../lib/session-lines/line");
const { BMSession } = require("../database.js");

module.exports = {
  "BMLine toJSON nulls timers + resets isVoting, fromJSON round-trips": () => {
    const session = {};
    const line = new BMLine(session, "L0");
    line.currentIndex = 3;
    line.history = ["x", "y", "z"];
    line.historyIndex = 2;
    line.isVoting = true;
    line.isHolding = true;
    line.currentHoldingDuration = 4;
    line.subStack = [{ score: "S", returnHref: "R.svg" }];
    line.splitAncestors = ["S1", "S2"];
    const votingTimer = setInterval(() => {}, 1e6);
    line.votingTimer = votingTimer;

    const json = line.toJSON();
    clearInterval(votingTimer);

    assert.strictEqual(json.isVoting, false, "isVoting must serialize false");
    assert.strictEqual(json.votingTimer, null, "votingTimer must serialize null");
    assert.strictEqual(json.holdingTimer, null);
    assert.strictEqual(json.standbyTimer, null);
    assert.strictEqual(json.currentIndex, 3);
    assert.deepStrictEqual(json.history, ["x", "y", "z"]);
    assert.deepStrictEqual(json.subStack, [{ score: "S", returnHref: "R.svg" }]);
    assert.deepStrictEqual(json.splitAncestors, ["S1", "S2"]);
    assert.strictEqual(json.id, "L0");
    assert.strictEqual(json.status, "active");

    const restored = BMLine.fromJSON(session, json);
    assert.strictEqual(restored.currentIndex, 3);
    assert.strictEqual(restored.isVoting, false);
    assert.strictEqual(restored.votingTimer, null);
    assert.deepStrictEqual(restored.history, ["x", "y", "z"]);
    assert.strictEqual(restored.id, "L0");
    assert.strictEqual(restored.currentHoldingDuration, 4);
    assert.deepStrictEqual(restored.splitAncestors, ["S1", "S2"]);
    // session back-ref restored + non-enumerable (never leaks to JSON).
    assert.strictEqual(restored.session, session);
    assert.ok(
      !Object.keys(restored).includes("session"),
      "session back-ref must be non-enumerable",
    );
  },

  "migrateState lifts v1 flat fields into a single v2 line": () => {
    const v1 = {
      id: "s1",
      sessionName: "name",
      folder: "folder",
      currentIndex: 7,
      history: ["A.svg", "B.svg"],
      historyIndex: 1,
      isVoting: true,
      isHolding: true,
      holdDuration: 5,
      votingDuration: 10,
      // re-derivable — must be dropped:
      listFiles: ["A.svg", "B.svg"],
      listFilesInLowerCase: ["a.svg", "b.svg"],
      graph: { x: 1 },
      hasSessionLines: true,
    };

    const v2 = migrateState(v1);

    assert.strictEqual(v2.version, 2);
    assert.strictEqual(v2.lines.length, 1);
    const line = v2.lines[0];
    assert.strictEqual(line.id, DEFAULT_LINE_ID);
    assert.strictEqual(line.status, "active");
    assert.strictEqual(line.currentIndex, 7);
    assert.deepStrictEqual(line.history, ["A.svg", "B.svg"]);
    assert.strictEqual(line.historyIndex, 1);
    // new coordination fields defaulted:
    assert.deepStrictEqual(line.subStack, []);
    assert.deepStrictEqual(line.pendingHoldUntil, []);
    assert.strictEqual(line.pendingRejoinAt, null);

    // global fields stay at top level:
    assert.strictEqual(v2.holdDuration, 5);
    assert.strictEqual(v2.votingDuration, 10);
    assert.deepStrictEqual(v2.deviceRegistry, {});
    assert.strictEqual(v2.nextLineId, 1);
    assert.deepStrictEqual(v2.splitEvents, []);
    assert.strictEqual(v2.nextSplitEventId, 1);

    // per-line + re-derivable fields removed from the top level:
    for (const k of [
      "currentIndex",
      "history",
      "historyIndex",
      "isVoting",
      "isHolding",
      "listFiles",
      "listFilesInLowerCase",
      "graph",
      "hasSessionLines",
    ]) {
      assert.ok(!(k in v2), `top-level "${k}" should be removed after migration`);
    }
  },

  "migrateState is idempotent for v2 state": () => {
    const v2 = {
      version: 2,
      id: "s1",
      lines: [{ id: "L0", currentIndex: 4, history: [] }],
      deviceRegistry: { "did-1": "L0" },
    };
    const again = migrateState(v2);
    assert.strictEqual(again, v2, "already-v2 state should pass through unchanged");
  },

  "BMSession has no per-line shim; playhead helpers + toJSON still work": () => {
    const session = new BMSession();
    assert.strictEqual(session.lines.length, 1, "fresh session has one line");

    // Chunk N removed the prototype shim: per-line fields are NOT exposed on the
    // session anymore — they live only on the line object.
    assert.strictEqual(
      session.currentIndex,
      undefined,
      "session must not expose per-line fields after the shim removal",
    );

    // The BMSession playhead helpers still delegate to lines[0].
    session.listFiles = ["PRE_a.svg", "B.svg", "C.svg"];
    session.setCurrIdxTo(1);
    const line0 = session.lines[0];
    assert.strictEqual(line0.currentIndex, 1);
    assert.strictEqual(line0.history[line0.history.length - 1], "B.svg");

    // toJSON is the versioned allowlist, with no top-level per-line fields.
    const json = session.toJSON();
    assert.strictEqual(json.version, 2);
    assert.strictEqual(json.lines.length, 1);
    assert.strictEqual(json.lines[0].currentIndex, 1);
    assert.ok(!("currentIndex" in json), "no flat per-line field in v2 toJSON");
    assert.ok("deviceRegistry" in json);
    assert.deepStrictEqual(json.splitEvents, []);
    assert.strictEqual(json.nextSplitEventId, 1);
  },

  "enterSub/exitSub preserve the main-flow history across the dive": () => {
    const session = {
      listFiles: ["START.svg", "Right.svg", "Barrier.svg"],
      subFrames: {
        Tetra: { frameList: ["Echo.svg", "START.svg"] },
      },
    };
    const line = new BMLine(session, "L1");
    line.setCurrIdxTo(0);
    line.setCurrIdxTo(1); // main history: START.svg, Right.svg

    line.enterSub("Tetra", "Barrier.svg");
    line.setCurrIdxTo(1); // sub START
    line.setCurrIdxTo(0); // sub Echo (sub-end)

    // Sub runs on its own fresh history + records qualified visits.
    assert.deepStrictEqual(line.history, ["START.svg", "Echo.svg"]);
    assert.deepStrictEqual(line.visitedSubFrames, [
      "tetra/start.svg",
      "tetra/echo.svg",
    ]);

    const popped = line.exitSub();
    assert.deepStrictEqual(popped, { score: "Tetra", returnHref: "Barrier.svg" });
    // Main history restored (NOT wiped) — barrier coverage + SM modal survive.
    assert.deepStrictEqual(line.history, ["START.svg", "Right.svg"]);
    line.setCurrIdxTo(2); // land on the return frame
    assert.deepStrictEqual(line.history, [
      "START.svg",
      "Right.svg",
      "Barrier.svg",
    ]);
    assert.strictEqual(line.historyIndex, 2);
    assert.strictEqual(line.savedHistories.length, 0);
  },

  "setCurrIdxTo records no trail entry when landing on the current frame": () => {
    const session = { listFiles: ["A.svg", "B.svg", "C.svg"] };
    const line = new BMLine(session, "L2");
    line.setCurrIdxTo(2); // trail: [C.svg]

    // roomRewind lands EVERY line, including one already sitting at its
    // landing frame (historyIndex assignment mirrors the rewind call sites).
    line.historyIndex = 0;
    line.isVoting = true;
    line.setCurrIdxTo(2);

    assert.deepStrictEqual(
      line.history,
      ["C.svg"],
      "stay-in-place rewind must not append a duplicate trail entry",
    );
    assert.strictEqual(line.historyIndex, 0);
    assert.strictEqual(line.currentIndex, 2);
    assert.strictEqual(line.isVoting, false, "vote window still cleared");

    // Proceeding afterwards appends normally.
    line.setCurrIdxTo(1);
    assert.deepStrictEqual(line.history, ["C.svg", "B.svg"]);
    assert.strictEqual(line.historyIndex, 1);
  },

  "setCurrIdxTo rewind truncation keeps loop visits, collapses stale dups": () => {
    const session = { listFiles: ["A.svg", "B.svg", "C.svg"] };
    const line = new BMLine(session, "L2");
    line.setCurrIdxTo(0);
    line.setCurrIdxTo(1);
    line.setCurrIdxTo(0);
    line.setCurrIdxTo(1); // genuine loop: A, B, A, B

    // Rewind to the SECOND A: redo entries truncate, the earlier loop visit
    // survives as its own distinct entry.
    line.historyIndex = 2;
    line.setCurrIdxTo(0);
    assert.deepStrictEqual(line.history, ["A.svg", "B.svg", "A.svg"]);
    assert.strictEqual(line.historyIndex, 2);

    // A trail corrupted by the old double-push heals on rewind: landing on
    // "visit 2" of an adjacent duplicate collapses it.
    line.history = ["C.svg", "C.svg", "B.svg", "A.svg"];
    line.historyIndex = 1;
    line.setCurrIdxTo(2);
    assert.deepStrictEqual(line.history, ["C.svg"]);
    assert.strictEqual(line.historyIndex, 0);
  },

  "clearAllTimer clears every line's timers": () => {
    const session = new BMSession();
    const line2 = new BMLine(session, "L1");
    session.lines.push(line2);

    for (const line of session.lines) {
      line.votingTimer = setInterval(() => {}, 1e6);
      line.holdingTimer = setTimeout(() => {}, 1e6);
      line.standbyTimer = setTimeout(() => {}, 1e6);
    }

    session.clearAllTimer();

    for (const line of session.lines) {
      assert.strictEqual(line.votingTimer, null);
      assert.strictEqual(line.holdingTimer, null);
      assert.strictEqual(line.standbyTimer, null);
    }
  },
};
