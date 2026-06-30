/**
 * Chunk E tests — BMLine extraction + shim + versioned persistence.
 *
 * Covers: BMLine toJSON/fromJSON round-trip, v1(flat)→v2(lines:[one]) migration,
 * the BMSession prototype shim delegating per-line field access to lines[0], and
 * clearAllTimer clearing every line's timers.
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
    assert.strictEqual(json.id, "L0");
    assert.strictEqual(json.status, "active");

    const restored = BMLine.fromJSON(session, json);
    assert.strictEqual(restored.currentIndex, 3);
    assert.strictEqual(restored.isVoting, false);
    assert.strictEqual(restored.votingTimer, null);
    assert.deepStrictEqual(restored.history, ["x", "y", "z"]);
    assert.strictEqual(restored.id, "L0");
    assert.strictEqual(restored.currentHoldingDuration, 4);
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

  "BMSession shim delegates per-line field read/write to lines[0]": () => {
    const session = new BMSession();
    assert.strictEqual(session.lines.length, 1, "fresh session has one line");

    session.currentIndex = 42;
    assert.strictEqual(session.lines[0].currentIndex, 42, "write delegates");
    assert.ok(
      !Object.prototype.hasOwnProperty.call(session, "currentIndex"),
      "shim must not create an own data property",
    );

    session.lines[0].historyIndex = 9;
    assert.strictEqual(session.historyIndex, 9, "read delegates");

    session.isVoting = true;
    assert.strictEqual(session.lines[0].isVoting, true);

    // delegating methods write through to lines[0]:
    session.listFiles = ["PRE_a.svg", "B.svg", "C.svg"];
    session.setCurrIdxTo(1);
    assert.strictEqual(session.currentIndex, 1);
    assert.strictEqual(session.lines[0].currentIndex, 1);
    assert.strictEqual(session.history[session.history.length - 1], "B.svg");

    // toJSON is the versioned allowlist, with no top-level per-line fields.
    const json = session.toJSON();
    assert.strictEqual(json.version, 2);
    assert.strictEqual(json.lines.length, 1);
    assert.strictEqual(json.lines[0].currentIndex, 1);
    assert.ok(!("currentIndex" in json), "no flat per-line field in v2 toJSON");
    assert.ok("deviceRegistry" in json);
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
