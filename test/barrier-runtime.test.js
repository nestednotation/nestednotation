/**
 * Chunk J — barrier + rejoin runtime (real BMSession + BMLine, no ws boot).
 *
 * Builds the on-disk "Session Lines Demo" and reproduces the converge phase
 * under RENDEZVOUS semantics (#6, decided 2026-07-04): the Barrier frame
 * carries hold-until="Left.svg,Tetra/Echo.svg" + rejoin-at="DONE.svg", and it
 * releases once both targets are "done" in the session-global reached
 * registry — including the qualified sub-end ref — without the reaching line
 * having to converge on the barrier. Then the co-present lines merge to the
 * lowest-id survivor at DONE.
 */

const assert = require("node:assert");

const { buildScore } = require("../bin/build-score.js");
const { BMLine } = require("../lib/session-lines/line");
const { createOrchestrator } = require("../lib/session-lines/orchestrator");
const { MESSAGES } = require("../constants");

module.exports = {
  "barrier releases on rendezvous (targets done anywhere), then rejoins": async () => {
    const session = await buildScore("Session Lines Demo", {
      id: "__barrier_test__",
    });
    const idx = (n) => session.listFilesInLowerCase.indexOf(n.toLowerCase());

    // Barrier gates on the OTHER branch's true completion: Left (the plain
    // path) and the sub-score's end frame (qualified sub ref).
    const targets = session.graph.holdUntilTargets["Barrier.svg"];
    assert.deepStrictEqual(targets, ["Left.svg", "Tetra/Echo.svg"]);
    assert.deepStrictEqual(session.graph.rejoinTargets["Barrier.svg"], [
      "DONE.svg",
    ]);

    const orch = createOrchestrator({
      MESSAGES,
      now: () => 0,
      createLine: (s, id) => new BMLine(s, id),
      send: () => {},
    });

    // Post-split lines. L1 travels Left → Barrier; the registry records each
    // frame on landing and marks it done when its holding period ends.
    session.reachedTargets = {};
    const l1 = new BMLine(session, "L1");
    l1.setCurrIdxTo(idx("Left.svg"));
    orch.markReached(session.reachedTargets, "Left.svg", true); // hold ended
    l1.setCurrIdxTo(idx("Barrier.svg"));
    orch.markReached(session.reachedTargets, "Barrier.svg");
    const l2 = new BMLine(session, "L2");
    session.lines.push(l1, l2);

    // L1 parked at Barrier, the sub not yet traversed → not satisfied.
    let covered = orch.registryCoveredTargets(session.reachedTargets, targets);
    assert.strictEqual(orch.holdUntilSatisfied(targets, covered), false);

    // L2 dives through Right into sub Tetra and REACHES Echo (the sub-end).
    // In-sub landings are recorded as qualified lowercased refs.
    l2.setCurrIdxTo(idx("Right.svg"));
    orch.markReached(session.reachedTargets, "Right.svg", true);
    orch.markReached(session.reachedTargets, "tetra/start.svg", true);
    orch.markReached(session.reachedTargets, "tetra/echo.svg");
    covered = orch.registryCoveredTargets(session.reachedTargets, targets);
    assert.strictEqual(
      orch.holdUntilSatisfied(targets, covered),
      false,
      "arrival at the sub-end alone (hold still running) must not release",
    );

    // Popping out of the sub completes Echo → satisfied WHILE L2 has not yet
    // parked at Barrier — the rendezvous point: no convergence required.
    orch.markReached(session.reachedTargets, "tetra/echo.svg", true);
    covered = orch.registryCoveredTargets(session.reachedTargets, targets);
    assert.strictEqual(orch.holdUntilSatisfied(targets, covered), true);

    // Both eventually co-present at DONE → merge to the lowest-id survivor.
    l2.setCurrIdxTo(idx("Barrier.svg"));
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
