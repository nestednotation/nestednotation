/**
 * `session-rejoin-at` is an ANNOUNCEMENT, not a command (owner: "rejoin-at
 * should be an announcement that that note will be merged with another note or
 * line in the next step — it should not automatically merge anything").
 *
 * A hold-until release used to read the frame's paired `rejoin-at`: a SINGLE
 * target auto-advanced the released lines there and merged them (the
 * Barrier→DONE pattern). That made the barrier frame a place the room passed
 * THROUGH — the performers watched their landing for one holding period and the
 * server then took the step for them — and it is the last route by which the
 * long-running "ending a sub-score skips its return landing" report (§9) was
 * still true: on `-test- Session lines` a line coming out of `Tetra1` landed on
 * `E` (hold-until F,G + rejoin-at H), held its 3s, and was then moved to `H`
 * without anybody tapping. The earlier fixes had only bought that landing its
 * holding period; they never stopped the advance at the end of it.
 *
 * Now every rejoin is a co-presence rejoin: the released line stays on its
 * frame, its next window votes its own route, and the merge happens when lines
 * walk onto the frame the announcement named (`afterLineArrivedInner`).
 *
 * Source-level, because `releaseBarrier` lives in bin/www — a server entry
 * point, not a module — so the same reason `arrival-release-order.test.js` and
 * `orchestrator-surface.test.js` read the file.
 */

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const RUNTIME = path.join(__dirname, "..", "bin", "www");

/** The body of a top-level `async function <name>(` in bin/www. */
function runtimeFunction(src, name, nextName) {
  const from = src.indexOf(`async function ${name}(`);
  const to = src.indexOf(`async function ${nextName}(`);
  assert.ok(from > 0 && to > from, `could not isolate ${name}`);
  return src.slice(from, to);
}

module.exports = {
  "a barrier release frees the parked lines and moves none of them": () => {
    const src = fs.readFileSync(RUNTIME, "utf8");
    const fn = runtimeFunction(src, "releaseBarrier", "settleCoLocatedLines");

    // It un-parks and tells the devices so…
    assert.match(fn, /l\.isBarrierWaiting = false;/);
    assert.match(fn, /MESSAGES\.MSG_BARRIER_RELEASED/);

    // …and that is all it does to the playhead: no merge, no travel.
    assert.doesNotMatch(
      fn,
      /runRejoin\(/,
      "a release must not merge the lines it frees — rejoin-at is an announcement",
    );
    assert.doesNotMatch(
      fn,
      /setCurrIdxTo\(/,
      "a release must not move the lines it frees",
    );

    // The frame's own rejoin announcement is not even consulted here.
    assert.doesNotMatch(
      fn,
      /rejoinAt|rejoinAll|rejoinTargets/,
      "the release path must not read the rejoin announcement",
    );

    // What it does do: re-check the composed track-group wait (an out-of-group
    // hold-until on a grouped frame stacks with the group's arrival barrier).
    assert.match(fn, /maybeParkAtGroup\(session, l, entry\.frame\)/);
    assert.match(fn, /tryReleaseGroupWaits\(session\)/);
  },

  "the barrier entry no longer carries a rejoin target at all": () => {
    const src = fs.readFileSync(RUNTIME, "utf8");
    const enter = runtimeFunction(src, "enterBarrier", "tryReleaseBarriers");
    assert.match(enter, /targets: targets\.slice\(\),/);
    assert.doesNotMatch(
      enter,
      /rejoinAt|rejoinAll/,
      "enterBarrier must not copy the announcement onto the barrier entry",
    );
  },

  "co-presence is the only thing that merges lines — on EVERY node": () => {
    // One line per node (owner): two lines standing on the same node merge,
    // whether or not a rejoin-at announced that frame. Exactly two callers —
    // the arrival itself, and the settle pass for the landings that do not
    // arrive (rewinds, operator valves, a revival).
    const src = fs.readFileSync(RUNTIME, "utf8");
    const calls = src.match(/await runRejoin\(/g) || [];
    assert.strictEqual(calls.length, 2, "runRejoin: arrival + settle only");

    const arrival = runtimeFunction(
      src,
      "afterLineArrivedInner",
      "handleSubTransitions",
    );
    assert.match(arrival, /const coLocated = coLocatedLines\(session, line\);/);
    assert.match(
      arrival,
      /await runRejoin\(session, \[line, \.\.\.coLocated\], frameName, \{ inPlace: true \}\)/,
    );
    // …checked before the barrier and the track group, and never gated on the
    // frame being somebody's rejoin target.
    assert.ok(
      arrival.indexOf("coLocatedLines(") < arrival.indexOf("enterBarrier("),
    );
    assert.doesNotMatch(arrival, /rejoinTarget/);

    const settle = runtimeFunction(src, "settleCoLocatedLines", "runRejoin");
    assert.match(settle, /arrive: false/, "a settle never re-runs an arrival");
  },
};
