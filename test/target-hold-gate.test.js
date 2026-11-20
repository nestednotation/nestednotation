/**
 * A `hold-until` waits for the TARGET FRAME's own holding period — read off the
 * frame and the clock, never off the line's general holding state.
 *
 * Owner: "hold-until should also wait for other lines to finish their intrinsic
 * hold period to unlock. Based on the target intrinsic holding period instead of
 * general holding state, to prevent holding block between hold-until notes."
 *
 * Two failures sit either side of that sentence.
 *
 * (1) **Unlocking early.** The latch only moves forward — `markReached` never
 * downgrades a `done` — so a frame played out in an earlier pass carries its
 * `done` for the rest of the session. Once corroboration (§7.4) lets a rewound
 * line restore that mark by stepping back onto the frame, the mark came back the
 * instant the line LANDED, not when it played the note: the barrier unlocked on a
 * rendezvous still in progress.
 *
 * (2) **Never unlocking.** A landing is `arrived` until an EVENT ends its holding
 * period (a timer firing, a departure). When no such event can come — the SM hold
 * toggle sets `isHolding` room-wide with no timer behind it, a state file saved
 * mid-hold restores the same way (§16), an operator advance lands the line
 * phase-free — the mark stays `arrived` for ever and every barrier naming that
 * frame waits on an edge that cannot happen. Between two frames that name each
 * other (`E` waits on `F`, `F` on `E`) that is a room-wide stall: a parked line's
 * hold is EXTENDED by its own barrier, so its holding STATE ends only when the
 * barrier releases, while the frame's authored period ends on its own clock.
 */

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const {
  markReached,
  registryCoveredTargets,
  registryClaimants,
  holdUntilSatisfied,
} = require("../lib/session-lines/orchestrator");

// The production rule itself, not a copy of it. This file used to mirror
// `landingHoldElapsed` locally because the runtime is not a module — so every
// behavioural case below could go on passing while the real clock changed
// underneath it. It lives in lib/session-lines/line.js now, and bin/www imports
// the same function.
const { landingHoldElapsed } = require("../lib/session-lines/line");

const RUNTIME = path.join(__dirname, "..", "bin", "www");

/** bin/www `holdRefStates`, mirrored: one line per frame here. */
function holdRefStates(lines) {
  const playedOut = new Set();
  const holdingNow = new Set();
  for (const l of lines) {
    if (l.status === "retired" || !l.ref) continue;
    const key = l.ref.toLowerCase();
    if (landingHoldElapsed(l)) playedOut.add(key);
    else if (l.status === "active") holdingNow.add(key);
  }
  for (const key of holdingNow) playedOut.delete(key);
  return { playedOut, holdingNow };
}

const standing = (ref, over = {}) => ({
  status: "active",
  ref,
  isHolding: false,
  isStandby: false,
  standbyTimer: null,
  holdingTimer: null,
  currentEndHoldTimeStamp: 0,
  ...over,
});

module.exports = {
  "landingHoldElapsed asks the frame's period, not the flag": () => {
    const future = Date.now() + 60_000;
    const past = Date.now() - 60_000;

    // Not begun: the 1 s standby gap sits ahead of the hold.
    assert.strictEqual(landingHoldElapsed(standing("F.svg", { isStandby: true })), false);
    assert.strictEqual(landingHoldElapsed(standing("F.svg", { standbyTimer: 1 })), false);
    // Running: the timer will end it.
    assert.strictEqual(
      landingHoldElapsed(standing("F.svg", { isHolding: true, holdingTimer: 1, currentEndHoldTimeStamp: future })),
      false,
    );
    // Flagged with the period still to run, no timer (SM toggle mid-hold).
    assert.strictEqual(
      landingHoldElapsed(standing("F.svg", { isHolding: true, currentEndHoldTimeStamp: future })),
      false,
    );
    // Flagged, no timer, period spent — the wedge: nothing will ever clear it.
    assert.strictEqual(
      landingHoldElapsed(standing("F.svg", { isHolding: true, currentEndHoldTimeStamp: past })),
      true,
    );
    // Nothing holding it at all (an operator advance lands phase-free).
    assert.strictEqual(landingHoldElapsed(standing("F.svg")), true);
  },

  "a stale done does NOT count while the line is replaying the frame": () => {
    // E waits on F+G. Both were played out in an earlier pass, so the latch
    // carries `done` for the rest of the session.
    const reachedTargets = {};
    markReached(reachedTargets, "F.svg", true);
    markReached(reachedTargets, "G.svg", true);
    const targets = ["F.svg", "G.svg"];

    // L1 has just landed back on F and is playing it; L2 is standing on G with
    // its period spent.
    const lines = [
      standing("F.svg", { isHolding: true, holdingTimer: 1, currentEndHoldTimeStamp: Date.now() + 9_000 }),
      standing("G.svg"),
    ];
    const session = {
      reachedTargets,
      reachedGranted: [],
      lines: [
        { status: "active", history: ["C.svg", "F.svg"], savedHistories: [], visitedSubFrames: [], subStack: [] },
        { status: "active", history: ["D.svg", "G.svg"], savedHistories: [], visitedSubFrames: [], subStack: [] },
      ],
      splitEvents: [],
      mergeEvents: [],
    };

    const covered = registryCoveredTargets(
      reachedTargets,
      targets,
      registryClaimants(session),
      holdRefStates(lines),
    );
    assert.deepStrictEqual([...covered], ["G.svg"], "F is being played right now");
    assert.strictEqual(holdUntilSatisfied(targets, covered), false);

    // Its holding period ends: now the wait is over.
    lines[0].isHolding = false;
    lines[0].holdingTimer = null;
    const after = registryCoveredTargets(
      reachedTargets,
      targets,
      registryClaimants(session),
      holdRefStates(lines),
    );
    assert.deepStrictEqual([...after].sort(), ["F.svg", "G.svg"]);
    assert.strictEqual(holdUntilSatisfied(targets, after), true);
  },

  "an arrived mark counts once nothing can ever complete it": () => {
    // L1 landed on F (arrived), then the operator toggled the room's hold: the
    // timer was cancelled and `isHolding` set with nothing behind it. The frame's
    // own period is spent, so the rendezvous is fulfilled.
    const reachedTargets = {};
    markReached(reachedTargets, "F.svg", false);
    assert.strictEqual(reachedTargets["f.svg"], "arrived");

    const wedged = [
      standing("F.svg", { isHolding: true, currentEndHoldTimeStamp: Date.now() - 1_000 }),
    ];
    const session = {
      reachedTargets,
      lines: [{ status: "active", history: ["C.svg", "F.svg"], savedHistories: [], visitedSubFrames: [], subStack: [] }],
      splitEvents: [],
      mergeEvents: [],
    };

    // The latch alone would wait for an edge that cannot come.
    assert.deepStrictEqual([...registryCoveredTargets(reachedTargets, ["F.svg"])], []);
    // The clock says the period is over.
    const covered = registryCoveredTargets(
      reachedTargets,
      ["F.svg"],
      registryClaimants(session),
      holdRefStates(wedged),
    );
    assert.deepStrictEqual([...covered], ["F.svg"]);
  },

  "two hold-until frames naming each other do not block": () => {
    // E waits on F, F waits on E. Both lines are PARKED on their own barrier, so
    // both have had their holds extended and neither will "stop holding" until
    // the other releases. Their frames' authored periods, though, are spent.
    const reachedTargets = {};
    markReached(reachedTargets, "E.svg", false);
    markReached(reachedTargets, "F.svg", false);
    const parkedAtE = standing("E.svg", { isBarrierWaiting: true });
    const parkedAtF = standing("F.svg", { isBarrierWaiting: true });
    const session = {
      reachedTargets,
      lines: [
        { status: "active", history: ["B.svg", "E.svg"], savedHistories: [], visitedSubFrames: [], subStack: [] },
        { status: "active", history: ["C.svg", "F.svg"], savedHistories: [], visitedSubFrames: [], subStack: [] },
      ],
      splitEvents: [],
      mergeEvents: [],
    };
    const holds = holdRefStates([parkedAtE, parkedAtF]);
    const claimants = registryClaimants(session);

    // Each sees the other's frame as played out, so both release.
    assert.deepStrictEqual(
      [...registryCoveredTargets(reachedTargets, ["F.svg"], claimants, holds)],
      ["F.svg"],
    );
    assert.deepStrictEqual(
      [...registryCoveredTargets(reachedTargets, ["E.svg"], claimants, holds)],
      ["E.svg"],
    );
  },

  "the LAST occupant's period is what ends the wait": () => {
    const reachedTargets = {};
    markReached(reachedTargets, "F.svg", true);
    const session = {
      reachedTargets,
      lines: [{ status: "active", history: ["C.svg", "F.svg"], savedHistories: [], visitedSubFrames: [], subStack: [] }],
      splitEvents: [],
      mergeEvents: [],
    };
    const two = [
      standing("F.svg"), // done playing
      standing("F.svg", { isHolding: true, holdingTimer: 1, currentEndHoldTimeStamp: Date.now() + 5_000 }),
    ];
    const holds = holdRefStates(two);
    assert.ok(holds.holdingNow.has("f.svg"));
    assert.ok(!holds.playedOut.has("f.svg"), "one occupant still playing it is enough");
    assert.deepStrictEqual(
      [...registryCoveredTargets(reachedTargets, ["F.svg"], registryClaimants(session), holds)],
      [],
    );
  },

  "a dormant line cannot hold a target open": () => {
    const reachedTargets = {};
    markReached(reachedTargets, "F.svg", true);
    const session = {
      reachedTargets,
      lines: [{ status: "dormant", history: ["C.svg", "F.svg"], savedHistories: [], visitedSubFrames: [], subStack: [] }],
      splitEvents: [],
      mergeEvents: [],
    };
    // Attrition clears a line's timers; the flag can outlive them (#11 releases
    // whatever was waiting on such a line, so it must not start a new wait).
    const dormant = [
      { ...standing("F.svg", { isHolding: true, currentEndHoldTimeStamp: Date.now() + 60_000 }), status: "dormant" },
    ];
    const holds = holdRefStates(dormant);
    assert.ok(!holds.holdingNow.has("f.svg"));
    assert.deepStrictEqual(
      [...registryCoveredTargets(reachedTargets, ["F.svg"], registryClaimants(session), holds)],
      ["F.svg"],
    );
  },

  // The rule itself is exercised above, against the imported function. What
  // source text can still usefully say is that the RUNTIME reaches for that
  // function rather than for the `isHolding` flag it used to read — an
  // architectural check, and named as one.
  "the runtime wires the barrier and the group to that same clock": () => {
    const src = fs.readFileSync(RUNTIME, "utf8");
    assert.match(
      src,
      /landingHoldElapsed,\s*\n\s*holdPendingAtFrame,\s*\n\} = require\("\.\.\/lib\/session-lines\/line"\);/,
      "the runtime must import the shared phase clock",
    );
    // …and so must the track group's hold sync, for the same reason.
    assert.match(src, /isHolding: \(l\) => !landingHoldElapsed\(l\),/);
    // Coverage is asked with both readings.
    assert.match(
      src,
      /orch\.registryClaimants\(session\),\s*holdRefStates\(session\),/,
      "coveredHoldTargets must pass the trails AND the clock",
    );
  },
};
