/**
 * A hold-until releases only once the line that completed it has JOINED it.
 *
 * `tryReleaseBarriers` keeps a satisfied wait shut while any parked line is
 * still holding (`parkedLines.some(holdPendingAtFrame)`) — a barrier EXTENDS
 * the frame's own hold and must never cut it short. "Parked" is the set
 * `enterBarrier` fills, and `afterLineArrivedInner` used to run the release
 * BEFORE that: a line arriving at a barrier frame and completing that
 * barrier's last target in the same breath was not in the set yet, so the wait
 * opened for everyone already parked and the line that completed it was left
 * behind to serve out its own holding period alone, told to wait for a target it
 * was standing on. (It cost more when a release still auto-advanced: the parked
 * lines were moved off and merged without it — see `releaseBarrier`.)
 *
 * Browser-verified on a fixture shaped like the demo's:
 *
 *   START (split 2) -> P (dive Tetra1, returns to R) | Q -> R
 *   R  holding="12"  hold-until="Tetra1/End.svg"  rejoin-at="Z.svg"
 *   Tetra1: START -> End   (sub-end, holding="false")
 *
 * Before: the parked line left R at 3.2s, the instant the diving line
 * surfaced, one holding period ahead of it. After: it held R for the full 12s
 * and both were freed together — they then walk to Z and merge there, since a
 * rejoin announcement never moves anybody (`rejoin-announcement.test.js`).
 *
 * Coming out of a sub-score is where it bites hardest — the wait names a frame
 * inside the sub and the line that completes it is the one the sub returns to
 * the barrier — but nothing about it is particular to sub-scores.
 */

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const {
  markReached,
  registryCoveredTargets,
  holdUntilSatisfied,
} = require("../lib/session-lines/orchestrator");

// The production gate, imported. This file used to define its own
// `!!line.isHolding || line.standbyTimer != null`, which production stopped
// being the moment the gate moved to the elapsed-hold clock: a line flagged
// holding with a spent deadline and no timer reads PENDING to that copy and
// COMPLETED to the runtime. The inputs here never told the two apart, so the
// disagreement sat undetected — the boundary cases below now cover it.
const { holdPendingAtFrame } = require("../lib/session-lines/line");

const RUNTIME = path.join(__dirname, "..", "bin", "www");

// A line standing on a frame, with every phase field the clock reads present —
// so a fixture can never accidentally mean "not holding" by omission.
const standing = (id, over = {}) => ({
  id,
  status: "active",
  isHolding: false,
  isStandby: false,
  standbyTimer: null,
  holdingTimer: null,
  currentEndHoldTimeStamp: 0,
  ...over,
});

module.exports = {
  "a satisfied wait still holds for a line that has joined it": () => {
    // The wait, its one target, and the line that has been parked a while.
    const targets = ["Tetra1/End.svg"];
    const reg = {};
    const parkedLine = standing("L1");

    // Nothing has completed the target yet.
    let covered = registryCoveredTargets(reg, targets);
    assert.strictEqual(holdUntilSatisfied(targets, covered), false);

    // The diving line comes out of the sub onto the barrier frame: its
    // departure completes the target, and its own landing hold starts.
    const arriving = standing("L0", {
      isHolding: true,
      holdingTimer: 1,
      currentEndHoldTimeStamp: Date.now() + 12_000,
    });
    markReached(reg, "Tetra1/End.svg", true);
    covered = registryCoveredTargets(reg, targets);
    assert.strictEqual(holdUntilSatisfied(targets, covered), true);

    // Released against the parked set as it stood BEFORE the join — the defect:
    // the wait is satisfied and nobody in it is holding, so it opens and the
    // arriving line is left behind.
    assert.strictEqual([parkedLine].some(holdPendingAtFrame), false);

    // Released after the join, which is the order the runtime keeps now: the
    // arriving line's own holding period is what the wait extends.
    assert.strictEqual([parkedLine, arriving].some(holdPendingAtFrame), true);

    // …and when that hold ends, the wait opens with BOTH lines in it, which is
    // what sends them on toward the rejoin frame together.
    arriving.isHolding = false;
    arriving.holdingTimer = null;
    assert.strictEqual([parkedLine, arriving].some(holdPendingAtFrame), false);
  },

  // The boundary the old local copy got wrong, both sides of it.
  "an elapsed hold with no timer left does not keep a wait shut": () => {
    const now = Date.now();
    // Flagged holding, no timer behind it (the SM hold toggle, or a state file
    // restored mid-hold), and the frame's own period already spent. Nothing
    // will ever clear the flag, so reading it would wedge the room.
    assert.strictEqual(
      holdPendingAtFrame(
        standing("L0", { isHolding: true, currentEndHoldTimeStamp: now - 1 }),
      ),
      false,
    );
    // The same line one millisecond earlier is still playing its frame.
    assert.strictEqual(
      holdPendingAtFrame(
        standing("L0", {
          isHolding: true,
          currentEndHoldTimeStamp: now + 60_000,
        }),
      ),
      true,
    );
    // The 1 s standby gap sits AHEAD of the hold: it has not begun.
    assert.strictEqual(
      holdPendingAtFrame(standing("L0", { standbyTimer: 1 })),
      true,
    );
    assert.strictEqual(
      holdPendingAtFrame(standing("L0", { isStandby: true })),
      true,
    );
    // A live timer will end the period itself.
    assert.strictEqual(
      holdPendingAtFrame(
        standing("L0", {
          isHolding: true,
          holdingTimer: 1,
          currentEndHoldTimeStamp: now + 5_000,
        }),
      ),
      true,
    );
    // Nothing holding it at all (an operator advance lands phase-free).
    assert.strictEqual(holdPendingAtFrame(standing("L0")), false);
  },

  "the runtime defers the arrival release until after the barrier join": () => {
    // Source-level, because `afterLineArrivedInner` lives in bin/www — a server
    // entry point, not a module — so the ordering cannot be asserted by calling
    // it. Same reason `orchestrator-surface.test.js` reads the file.
    const src = fs.readFileSync(RUNTIME, "utf8");
    const fn = src.slice(
      src.indexOf("async function afterLineArrivedInner("),
      src.indexOf("async function handleSubTransitions("),
    );
    assert.ok(fn.length > 500, "could not isolate afterLineArrivedInner");

    // The arrival is RECORDED into a flag, never released on the spot.
    assert.match(
      fn,
      /const becameDone = recordArrival\(session, line\);/,
      "afterLineArrivedInner must record the arrival without releasing",
    );
    assert.doesNotMatch(
      fn,
      /if \(recordArrival\(session, line\)\) \{\s*await tryReleaseBarriers/,
      "releasing straight off recordArrival opens the wait before the line joins it",
    );

    // And the release comes after `enterBarrier` has had its chance.
    const join = fn.indexOf("await enterBarrier(");
    const release = fn.indexOf("if (becameDone) {");
    assert.ok(join > 0, "afterLineArrivedInner must still join the barrier");
    assert.ok(
      release > join,
      "the deferred release must sit after the enterBarrier branch",
    );
  },
};
