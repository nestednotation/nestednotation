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
    assert.ok(
      session.subFrames.Tetra.graph.frameLinks,
      "sub-score graph must expose frameLinks for hold-until reachability",
    );
    assert.strictEqual(
      orch.canReachFrames(
        session.subFrames.Tetra.graph.frameLinks,
        session.subFrames.Tetra.frameList,
        "START.svg",
        ["Echo.svg"],
      ),
      true,
    );

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

  "track-group arrival barrier waits for incoming lines (real score graph)": async () => {
    // Decided 2026-07-16: grouped frames wait for each other. Over the demo's
    // real graph (group "converge" = Left + Right, START splits into both),
    // the first line to land parks until every populated line that can still
    // REACH a group frame has arrived — reachability computed over the built
    // frameLinks, empty lines excluded.
    const session = await buildScore("Session Lines Demo", {
      id: "__group_arrival_test__",
    });
    const idx = (n) => session.listFilesInLowerCase.indexOf(n.toLowerCase());

    const orch = createOrchestrator({
      MESSAGES,
      now: () => 0,
      createLine: (s, id) => new BMLine(s, id),
      send: () => {},
    });

    const group = orch.groupOfFrame(session.graph, "Left.svg");
    assert.strictEqual(group, "converge");
    const groupFrames = orch.groupFramesLower(session.graph, group);

    // The built session's initial L0 is the split parent — hard-retired.
    for (const l of session.lines) {
      l.status = "retired";
    }
    // L1 landed on Left; L2 still sits on START (its links lead to the group).
    const l1 = new BMLine(session, "L1");
    l1.setCurrIdxTo(idx("Left.svg"));
    const l2 = new BMLine(session, "L2");
    l2.setCurrIdxTo(idx("START.svg"));
    session.lines.push(l1, l2);

    const frameFor = (l) => session.listFiles[l.currentIndex];
    const opts = {
      frameNameForLine: frameFor,
      deviceCount: () => 1,
      inSub: (l) => l.subStack.length > 0,
      isBlocked: (l) => !!l.isBarrierWaiting,
      canReach: (l) =>
        orch.canReachFrames(
          session.graph.frameLinks,
          session.listFiles,
          frameFor(l),
          groupFrames,
        ),
    };

    let state = orch.groupArrivalState(session.lines, groupFrames, opts);
    assert.strictEqual(state.waiting, true, "L2 can still reach the group");
    assert.deepStrictEqual(state.incomingIds, ["L2"]);

    // L2 arrives on Right → every incoming line has arrived → the group opens.
    l2.setCurrIdxTo(idx("Right.svg"));
    state = orch.groupArrivalState(session.lines, groupFrames, opts);
    assert.strictEqual(state.waiting, false);

    // A line PAST the group (Barrier has no path back) is not incoming; an
    // empty line anywhere never holds the group open.
    const l3 = new BMLine(session, "L3");
    l3.setCurrIdxTo(idx("Barrier.svg"));
    const l4 = new BMLine(session, "L4");
    l4.setCurrIdxTo(idx("START.svg"));
    session.lines.push(l3, l4);
    state = orch.groupArrivalState(session.lines, groupFrames, {
      ...opts,
      deviceCount: (l) => (l.id === "L4" ? 0 : 1),
    });
    assert.strictEqual(state.waiting, false);
  },
};
