/**
 * M7 — a merge that happened INSIDE a sub-score must come apart inside it.
 *
 * One line per node holds in sub-scores too, so lines merge there — but
 * `preMergeLanding` returned null for every snapshot carrying a `subStack`,
 * which is the same answer as "this line is already back where it came from".
 * Both participants were therefore restored standing ON the merge node, and
 * the one-line-per-node settlement that follows every undo merged them again
 * on the spot: the operator's gesture reported a separation it had already
 * undone, and stacked a fresh rejoin behind the one it claimed to remove.
 *
 * Driven through the production undo (`applyRecombine` → `rewindMergeStructure`)
 * over REAL `BMLine` objects, with a sub-score whose frame names deliberately
 * collide with the main flow's — because resolving a sub trail against the main
 * frame list is the other half of the same defect.
 */

const assert = require("node:assert");

const { BMLine } = require("../lib/session-lines/line");
const {
  createOrchestrator,
  preMergeLanding,
  frameIndexResolver,
  mergeConvergenceEvents,
  mergeRewindOptions,
} = require("../lib/session-lines/orchestrator");
const { MESSAGES } = require("../constants");

// A main flow that shares TWO names with the sub-score below ("A.svg" and
// "JOIN.svg"), at different indexes. A sub trail resolved against this list
// lands on a frame the line never visited.
const MAIN = ["Top.svg", "JOIN.svg", "A.svg", "End.svg"];
const SUB = ["A.svg", "B.svg", "JOIN.svg", "SubEnd.svg"];

function fixture() {
  const session = {
    id: "s1",
    nextLineId: 2,
    nextMergeEventId: 1,
    nextStructuralSeq: 1,
    splitEvents: [],
    mergeEvents: [],
    deviceRegistry: {},
    preloadDuration: 0,
    listFiles: MAIN.slice(),
    listFilesInLowerCase: MAIN.map((f) => f.toLowerCase()),
    subFrames: {
      Tetra1: {
        frameList: SUB.slice(),
        graph: { frameLinks: {} },
      },
    },
    lines: [],
  };

  const orch = createOrchestrator({
    MESSAGES,
    now: () => 1000,
    createLine: (s, id) => new BMLine(s, id),
    send: () => {},
    sendAdmins: () => {},
  });

  return { session, orch };
}

// Walk a line into the sub and along the trail given, through the real
// playhead API (`enterSub` saves the main trail and starts the sub's own).
function dive(line, trail, returnHref = "End.svg") {
  line.enterSub("Tetra1", returnHref);
  for (const name of trail) {
    line.setCurrIdxTo(SUB.indexOf(name));
  }
}

module.exports = {
  "preMergeLanding steps a dived snapshot back inside its own sub": () => {
    const { session } = fixture();
    const snapshot = {
      history: ["A.svg", "JOIN.svg"],
      historyIndex: 1,
      currentIndex: SUB.indexOf("JOIN.svg"),
      subStack: [{ score: "Tetra1", returnHref: "End.svg" }],
    };
    const stepBack = preMergeLanding({
      snapshot,
      mergeFrame: "JOIN.svg",
      frameIndexOf: frameIndexResolver(session),
    });
    assert.ok(stepBack, "a dived snapshot must still step back");
    assert.strictEqual(
      stepBack.index,
      SUB.indexOf("A.svg"),
      "the predecessor was resolved against the main frame list",
    );
    assert.deepStrictEqual(stepBack.history, ["A.svg"]);
    assert.strictEqual(stepBack.historyIndex, 0);
    // The main flow has an "A.svg" too, at a different index — proof the
    // resolver picked the score the line was actually walking.
    assert.notStrictEqual(SUB.indexOf("A.svg"), MAIN.indexOf("A.svg"));
  },

  "two lines that merged inside a sub come back on their own predecessors": () => {
    const { session, orch } = fixture();
    const l0 = new BMLine(session, "L0");
    const l1 = new BMLine(session, "L1");
    session.lines.push(l0, l1);
    dive(l0, ["A.svg", "JOIN.svg"]);
    dive(l1, ["B.svg", "JOIN.svg"]);
    assert.strictEqual(l0.currentIndex, SUB.indexOf("JOIN.svg"));
    assert.strictEqual(l1.currentIndex, SUB.indexOf("JOIN.svg"));

    const connections = [
      { sessionId: "s1", lineId: "L0", deviceId: "dA", isStaff: true },
      { sessionId: "s1", lineId: "L1", deviceId: "dB", isStaff: true },
    ];
    session.deviceRegistry = { dA: "L0", dB: "L1" };

    const { survivor } = orch.applyRecombine({
      session,
      lineIds: ["L0", "L1"],
      connections,
      frame: "JOIN.svg",
    });
    assert.strictEqual(survivor.id, "L0");
    const event = session.mergeEvents[0];
    assert.strictEqual(
      event.sub,
      "Tetra1",
      "the rejoin must record the score it happened in",
    );
    assert.strictEqual(connections[1].lineId, "L0");

    // …and undone.
    const result = orch.rewindMergeStructure({
      session,
      eventId: event.id,
      expectedFrame: "JOIN.svg",
      connections,
    });
    assert.strictEqual(result.available, true);

    const restored = session.lines.filter((l) => l.status !== "retired");
    assert.strictEqual(restored.length, 2);
    const byUid = new Map(restored.map((l) => [l.uid, l]));
    const backL0 = byUid.get(l0.uid);
    const backL1 = byUid.get(l1.uid);
    assert.ok(backL0 && backL1, "both routes must come back");

    // The whole point: distinct predecessor landings, inside the sub.
    assert.strictEqual(backL0.currentIndex, SUB.indexOf("A.svg"));
    assert.strictEqual(backL1.currentIndex, SUB.indexOf("B.svg"));
    assert.notStrictEqual(
      backL0.currentIndex,
      backL1.currentIndex,
      "restored on the merge node, so the settlement merges them again",
    );
    assert.deepStrictEqual(backL0.history, ["A.svg"]);
    assert.deepStrictEqual(backL1.history, ["B.svg"]);

    // Each keeps its return context, so the dive can still end properly.
    for (const line of [backL0, backL1]) {
      assert.deepStrictEqual(line.subStack, [
        { score: "Tetra1", returnHref: "End.svg" },
      ]);
      assert.strictEqual(line.savedHistories.length, 1);
      assert.strictEqual(line.status, "active");
    }

    // Device ownership follows the route it belonged to.
    const connA = connections.find((c) => c.deviceId === "dA");
    const connB = connections.find((c) => c.deviceId === "dB");
    assert.strictEqual(connA.lineId, backL0.id);
    assert.strictEqual(connB.lineId, backL1.id);
    assert.strictEqual(session.deviceRegistry.dA, backL0.id);
    assert.strictEqual(session.deviceRegistry.dB, backL1.id);

    // The event is undone and stays undone.
    assert.strictEqual(event.status, "undone");
    assert.deepStrictEqual(
      mergeRewindOptions({
        mergeEvents: session.mergeEvents,
        splitEvents: session.splitEvents,
        lines: session.lines,
      }),
      [],
      "an undone rejoin must not still be offered",
    );
  },

  // The convergence grouping folds "the same survivor, the same frame" into one
  // passage. Frame names are unique within a score and not across them, so a
  // main-flow rejoin and a sub rejoin sharing a name are two passages.
  "a sub rejoin is not folded into a main-flow rejoin of the same name": () => {
    const { session, orch } = fixture();
    const l0 = new BMLine(session, "L0");
    const l1 = new BMLine(session, "L1");
    const l2 = new BMLine(session, "L2");
    session.lines.push(l0, l1, l2);

    // First, a MAIN-flow rejoin at JOIN.svg.
    l0.setCurrIdxTo(MAIN.indexOf("Top.svg"));
    l0.setCurrIdxTo(MAIN.indexOf("JOIN.svg"));
    l1.setCurrIdxTo(MAIN.indexOf("A.svg"));
    l1.setCurrIdxTo(MAIN.indexOf("JOIN.svg"));
    orch.applyRecombine({
      session,
      lineIds: ["L0", "L1"],
      connections: [],
      frame: "JOIN.svg",
    });
    const mainEvent = session.mergeEvents[0];
    assert.strictEqual(mainEvent.sub, null);

    // Then the same survivor dives and rejoins on a SUB frame of that name.
    dive(l0, ["A.svg", "JOIN.svg"]);
    dive(l2, ["B.svg", "JOIN.svg"]);
    orch.applyRecombine({
      session,
      lineIds: ["L0", "L2"],
      connections: [],
      frame: "JOIN.svg",
    });
    const subEvent = session.mergeEvents[1];
    assert.strictEqual(subEvent.sub, "Tetra1");

    assert.deepStrictEqual(
      mergeConvergenceEvents({
        mergeEvents: session.mergeEvents,
        eventId: subEvent.id,
      }).map((e) => e.id),
      [subEvent.id],
      "two rejoins in different scores were folded into one passage",
    );
  },

  // F5 — a convergence is one DIVE, not one sub name. Sub histories restart on
  // every entry, so two visits to the same sub leave identical sub trails and
  // the passage test alone cannot tell them apart.
  "two visits to one sub that return to different frames are two passages": () => {
    const { session, orch } = fixture();
    const [l0, l1, l2] = ["L0", "L1", "L2"].map((id) => new BMLine(session, id));
    session.lines.push(l0, l1, l2);
    const convergence = (event) =>
      mergeConvergenceEvents({ mergeEvents: session.mergeEvents, eventId: event.id })
        .map((e) => e.id);

    // Visit 1 returns to A.svg.
    dive(l0, ["A.svg", "JOIN.svg"], "A.svg");
    dive(l1, ["B.svg", "JOIN.svg"], "A.svg");
    orch.applyRecombine({ session, lineIds: ["L0", "L1"], connections: [], frame: "JOIN.svg" });
    const first = session.mergeEvents[0];

    // Back out, and visit 2 returns to End.svg — same sub, same trail inside.
    l0.exitSub();
    l0.setCurrIdxTo(MAIN.indexOf("A.svg"));
    dive(l0, ["A.svg", "JOIN.svg"], "End.svg");
    dive(l2, ["B.svg", "JOIN.svg"], "End.svg");
    orch.applyRecombine({ session, lineIds: ["L0", "L2"], connections: [], frame: "JOIN.svg" });
    const second = session.mergeEvents[1];

    assert.deepStrictEqual(convergence(second), [second.id]);
    assert.deepStrictEqual(convergence(first), [first.id]);
  },

  "two visits to one sub with the same return landing are two passages": () => {
    const { session, orch } = fixture();
    const [l0, l1, l2] = ["L0", "L1", "L2"].map((id) => new BMLine(session, id));
    session.lines.push(l0, l1, l2);
    l0.setCurrIdxTo(MAIN.indexOf("Top.svg"));

    dive(l0, ["A.svg", "JOIN.svg"]);
    dive(l1, ["B.svg", "JOIN.svg"]);
    orch.applyRecombine({ session, lineIds: ["L0", "L1"], connections: [], frame: "JOIN.svg" });

    // The survivor comes out on End.svg and, looping, dives the same way
    // again: identical dive stack, but the main trail it saves has grown.
    l0.exitSub();
    l0.setCurrIdxTo(MAIN.indexOf("End.svg"));
    dive(l0, ["A.svg", "JOIN.svg"]);
    dive(l2, ["B.svg", "JOIN.svg"]);
    orch.applyRecombine({ session, lineIds: ["L0", "L2"], connections: [], frame: "JOIN.svg" });
    const second = session.mergeEvents[1];

    assert.deepStrictEqual(
      mergeConvergenceEvents({ mergeEvents: session.mergeEvents, eventId: second.id })
        .map((e) => e.id),
      [second.id],
      "an earlier, separate passage was folded into this undo",
    );
  },

  "arrivals within one dive still group as one convergence": () => {
    const { session, orch } = fixture();
    const [l0, l1, l2] = ["L0", "L1", "L2"].map((id) => new BMLine(session, id));
    session.lines.push(l0, l1, l2);

    dive(l0, ["A.svg", "JOIN.svg"]);
    dive(l1, ["B.svg", "JOIN.svg"]);
    orch.applyRecombine({ session, lineIds: ["L0", "L1"], connections: [], frame: "JOIN.svg" });
    // A third line arrives later on the same dive's JOIN.svg.
    dive(l2, ["B.svg", "JOIN.svg"]);
    orch.applyRecombine({ session, lineIds: ["L0", "L2"], connections: [], frame: "JOIN.svg" });
    const [first, second] = session.mergeEvents;

    assert.deepStrictEqual(
      mergeConvergenceEvents({ mergeEvents: session.mergeEvents, eventId: second.id })
        .map((e) => e.id),
      [second.id, first.id],
    );
  },
};
