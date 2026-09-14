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

const RUNTIME = path.join(__dirname, "..", "bin", "www");

/** bin/www `holdPendingAtFrame`. */
const holdPending = (line) => !!line.isHolding || line.standbyTimer != null;

module.exports = {
  "a satisfied wait still holds for a line that has joined it": () => {
    // The wait, its one target, and the line that has been parked a while.
    const targets = ["Tetra1/End.svg"];
    const reg = {};
    const parkedLine = { id: "L1", isHolding: false, standbyTimer: null };

    // Nothing has completed the target yet.
    let covered = registryCoveredTargets(reg, targets);
    assert.strictEqual(holdUntilSatisfied(targets, covered), false);

    // The diving line comes out of the sub onto the barrier frame: its
    // departure completes the target, and its own landing hold starts.
    const arriving = { id: "L0", isHolding: true, standbyTimer: null };
    markReached(reg, "Tetra1/End.svg", true);
    covered = registryCoveredTargets(reg, targets);
    assert.strictEqual(holdUntilSatisfied(targets, covered), true);

    // Released against the parked set as it stood BEFORE the join — the defect:
    // the wait is satisfied and nobody in it is holding, so it opens and the
    // arriving line is left behind.
    assert.strictEqual([parkedLine].some(holdPending), false);

    // Released after the join, which is the order the runtime keeps now: the
    // arriving line's own holding period is what the wait extends.
    assert.strictEqual([parkedLine, arriving].some(holdPending), true);

    // …and when that hold ends, the wait opens with BOTH lines in it, which is
    // what sends them on toward the rejoin frame together.
    arriving.isHolding = false;
    assert.strictEqual([parkedLine, arriving].some(holdPending), false);
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
