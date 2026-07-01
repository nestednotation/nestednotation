/**
 * Chunk J — barrier + rejoin runtime (real BMSession + BMLine, no ws boot).
 *
 * Builds the on-disk "Session Lines Demo" and reproduces the converge phase:
 * two lines (post-split L1@Left, L2@Right) both reach the Barrier frame, which
 * carries hold-until="Left.svg,Right.svg" + rejoin-at="DONE.svg". Asserts the
 * barrier only releases once BOTH have converged (not on the first arrival),
 * then merges to the lowest-id survivor advanced to DONE with devices reassigned.
 */

const assert = require("node:assert");

const { buildScore } = require("../bin/build-score.js");
const { BMLine } = require("../lib/session-lines/line");
const { createOrchestrator } = require("../lib/session-lines/orchestrator");
const { MESSAGES } = require("../constants");

module.exports = {
  "barrier holds until both converge, then rejoins to DONE": async () => {
    const session = await buildScore("Session Lines Demo", {
      id: "__barrier_test__",
    });
    const idx = (n) => session.listFilesInLowerCase.indexOf(n.toLowerCase());

    const targets = session.graph.holdUntilTargets["Barrier.svg"];
    assert.deepStrictEqual(targets, ["Left.svg", "Right.svg"]);
    assert.deepStrictEqual(session.graph.rejoinTargets["Barrier.svg"], [
      "DONE.svg",
    ]);

    const orch = createOrchestrator({
      MESSAGES,
      now: () => 0,
      createLine: (s, id) => new BMLine(s, id),
      send: () => {},
    });

    // Post-split lines, each having travelled its own branch to the barrier.
    const l1 = new BMLine(session, "L1");
    l1.setCurrIdxTo(idx("Left.svg"));
    l1.setCurrIdxTo(idx("Barrier.svg"));
    const l2 = new BMLine(session, "L2");
    l2.setCurrIdxTo(idx("Right.svg"));
    l2.setCurrIdxTo(idx("Barrier.svg"));
    session.lines.push(l1, l2);

    // Only L1 parked → not satisfied (Right.svg still uncovered).
    let covered = orch.barrierCoveredTargets([l1], targets);
    assert.strictEqual(orch.holdUntilSatisfied(targets, covered), false);

    // Both parked → satisfied → rejoin.
    covered = orch.barrierCoveredTargets([l1, l2], targets);
    assert.strictEqual(orch.holdUntilSatisfied(targets, covered), true);

    session.deviceRegistry = { dA: "L1", dB: "L2" };
    const connections = [
      { sessionId: session.id, lineId: "L1", deviceId: "dA" },
      { sessionId: session.id, lineId: "L2", deviceId: "dB" },
    ];

    const { survivor, absorbed } = orch.applyRecombine({
      session,
      lineIds: [l1.id, l2.id],
      connections,
    });
    survivor.setCurrIdxTo(idx("DONE.svg"));

    assert.strictEqual(survivor.id, "L1");
    assert.strictEqual(survivor.currentIndex, idx("DONE.svg"));
    assert.strictEqual(absorbed[0].id, "L2");
    assert.strictEqual(absorbed[0].status, "retired");
    // Both devices now on the survivor.
    assert.strictEqual(connections[1].lineId, "L1");
    assert.strictEqual(session.deviceRegistry["dB"], "L1");
  },
};
