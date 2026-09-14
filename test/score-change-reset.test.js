/** Score changes invalidate every score-relative piece of live state. */

const assert = require("node:assert");

const { BMSession } = require("../database.js");
const { BMLine } = require("../lib/session-lines/line");

function activeStructuralSession() {
  const session = new BMSession();
  session.id = "__score_change_reset__";
  session.folder = "old-score";
  session.listFiles = ["START.svg", "OLD.svg"];
  session.listFilesInLowerCase = ["start.svg", "old.svg"];
  session.contentHash = "old-content";
  session.lines[0].setCurrIdxTo(1);

  const second = new BMLine(session, "L1");
  second.setCurrIdxTo(1);
  session.lines.push(second);
  session.splitEvents = [{ id: 7, status: "active" }];
  session.nextSplitEventId = 8;
  session.nextSplitGestureId = 5;
  session.mergeEvents = [{ id: 9, status: "active" }];
  session.nextMergeEventId = 10;
  session.nextStructuralSeq = 17;
  session.deviceRegistry = { deviceA: "L0", deviceB: "L1" };
  session.reachedTargets = { "old.svg": "done" };
  session.reachedGeneration = 4;
  session.reachedGranted = ["OLD.svg"];
  session.latestGroupArrival = { frame: "OLD.svg", at: 123 };
  session.recordRewind({ kind: "split", frame: "OLD.svg" });
  session._barrier = { byFrame: { "OLD.svg": {} } };
  session._barrierRehydrated = true;
  session.__structuralProjection = { key: "old", value: {} };
  session.__displayHold = { lines: ["L1"] };
  return session;
}

function assertFreshScoreState(session) {
  assert.strictEqual(session.lines.length, 1);
  assert.strictEqual(session.lines[0].id, "L0");
  assert.strictEqual(session.lines[0].currentIndex, 0);
  assert.deepStrictEqual(session.lines[0].history, ["START.svg"]);
  assert.deepStrictEqual(session.splitEvents, []);
  assert.strictEqual(session.nextSplitEventId, 1);
  assert.strictEqual(session.nextSplitGestureId, 1);
  assert.deepStrictEqual(session.mergeEvents, []);
  assert.strictEqual(session.nextMergeEventId, 1);
  assert.strictEqual(session.nextStructuralSeq, 1);
  assert.deepStrictEqual(session.deviceRegistry, {});
  assert.deepStrictEqual(session.reachedTargets, {});
  assert.strictEqual(session.reachedGeneration, 0);
  assert.deepStrictEqual(session.reachedGranted, []);
  assert.strictEqual(session.latestGroupArrival, null);
  // The audit goes with the score it describes: every entry names a frame of
  // the replaced one, so keeping it leaves the map listing rewinds at frames
  // that no longer exist.
  assert.deepStrictEqual(session.rewindLog, []);
  assert.strictEqual(session._barrier, undefined);
  assert.strictEqual(session._barrierRehydrated, false);
  assert.strictEqual(session.__structuralProjection, undefined);
  assert.strictEqual(session.__displayHold, null);
}

module.exports = {
  "folder replacement clears active split and merge state": async () => {
    const session = activeStructuralSession();
    session.buildSVGContent = async () => {
      session.listFiles = ["START.svg", "NEW.svg"];
      session.listFilesInLowerCase = ["start.svg", "new.svg"];
      session.contentHash = "replacement-content";
    };

    await session.reloadScore("new-score");

    assert.strictEqual(session.folder, "new-score");
    assert.strictEqual(session.toJSON().contentHash, "replacement-content");
    assertFreshScoreState(session);
  },

  "same-folder content rebuild clears score-relative state": async () => {
    const session = activeStructuralSession();
    session.buildSVGContent = async () => {
      session.listFiles = ["START.svg", "INSERTED.svg", "OLD.svg"];
      session.listFilesInLowerCase = [
        "start.svg",
        "inserted.svg",
        "old.svg",
      ];
      session.contentHash = "edited-content";
    };

    assert.strictEqual(await session.rebuildScore(), true);
    assertFreshScoreState(session);
  },

  "parameter-only rebuild preserves the live room": async () => {
    const session = activeStructuralSession();
    const originalLines = session.lines;
    session.buildSVGContent = async () => {};

    assert.strictEqual(await session.rebuildScore(), false);
    assert.strictEqual(session.lines, originalLines);
    assert.strictEqual(session.splitEvents.length, 1);
    assert.strictEqual(session.mergeEvents.length, 1);
    assert.strictEqual(session.rewindLog.length, 1);
  },
};
