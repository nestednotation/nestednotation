/**
 * Chunk H–L tests — orchestration logic (pure) + transport-driven ops.
 *
 * The pure decision functions are exercised directly; applySplit / applyRecombine
 * are driven through a FAKE transport that records emitted messages, so the
 * runtime orchestration is verified without booting express/ws.
 */

const assert = require("node:assert");

const {
  planSplitPartition,
  parseVoteTargetIndex,
  holdUntilSatisfied,
  barrierCoveredTargets,
  rejoinSatisfied,
  planRecombine,
  groupOfFrame,
  groupFramesLower,
  linesOnGroupFrames,
  resolveGroupStay,
  groupLinkWinner,
  subReturnIndex,
  createOrchestrator,
} = require("../lib/session-lines/orchestrator");

const { MESSAGES } = require("../constants");

// A minimal stand-in for BMLine for transport-driven tests.
function fakeLine(session, id) {
  return {
    id,
    status: "active",
    currentIndex: 0,
    history: [],
    historyIndex: 0,
    trackGroup: null,
    setCurrIdxTo(index) {
      this.currentIndex = index;
      this.history.push(session.listFiles[index]);
      this.historyIndex = this.history.length - 1;
    },
  };
}

function fakeSession() {
  return {
    id: "s1",
    nextLineId: 1,
    deviceRegistry: {},
    preloadDuration: 0,
    listFiles: ["START.svg", "Left.svg", "Right.svg", "Barrier.svg", "DONE.svg"],
    lines: [],
  };
}

// Records every send so tests can assert on the emitted protocol.
function fakeTransport() {
  const sent = [];
  return {
    sent,
    MESSAGES,
    now: () => 1000,
    createLine: fakeLine,
    send: (session, lineId, time, payload) =>
      sent.push({ lineId, time, ...payload }),
    sendAdmins: (session, lineId, time, payload) =>
      sent.push({ admin: true, lineId, time, ...payload }),
  };
}

module.exports = {
  // ── planSplitPartition ──────────────────────────────────────────────────
  "planSplitPartition honours choosers": () => {
    const { assignment } = planSplitPartition(
      [{ choice: 0 }, { choice: 1 }, { choice: 1 }],
      2,
    );
    assert.deepStrictEqual(assignment, [0, 1, 1]);
  },

  "planSplitPartition balances non-choosers into smallest bucket": () => {
    // One chooser to child 0; three non-choosers spread to balance.
    const { assignment, counts } = planSplitPartition(
      [{ choice: 0 }, {}, {}, {}],
      2,
    );
    assert.strictEqual(counts[0] + counts[1], 4);
    // Balanced: child0 had a head start (1), so non-choosers fill child1 first.
    assert.deepStrictEqual(counts, [2, 2]);
    assert.strictEqual(assignment[0], 0);
  },

  "planSplitPartition fills empty lines first (no empties)": () => {
    const { counts } = planSplitPartition([{}, {}, {}], 3);
    assert.deepStrictEqual(counts, [1, 1, 1]);
  },

  "planSplitPartition treats out-of-range choice as non-chooser": () => {
    const { assignment } = planSplitPartition([{ choice: 5 }, { choice: -1 }], 2);
    // Both balanced (one each), order: smallest bucket → 0 then 1.
    assert.deepStrictEqual(assignment, [0, 1]);
  },

  // ── parseVoteTargetIndex ────────────────────────────────────────────────
  "parseVoteTargetIndex pulls leading index": () => {
    assert.strictEqual(parseVoteTargetIndex("3#Left.svg#0", -1), 3);
  },
  "parseVoteTargetIndex maps stay/invalid to fallback": () => {
    assert.strictEqual(parseVoteTargetIndex("stay", 7), 7);
    assert.strictEqual(parseVoteTargetIndex(null, 7), 7);
    assert.strictEqual(parseVoteTargetIndex(undefined, 7), 7);
    assert.strictEqual(parseVoteTargetIndex("nope#x", 7), 7);
  },

  // ── holdUntilSatisfied / barrierCoveredTargets ──────────────────────────
  "holdUntilSatisfied requires all targets (case-insensitive)": () => {
    assert.strictEqual(holdUntilSatisfied(["A.svg", "B.svg"], ["a.svg"]), false);
    assert.strictEqual(
      holdUntilSatisfied(["A.svg", "B.svg"], ["a.svg", "b.svg"]),
      true,
    );
    assert.strictEqual(holdUntilSatisfied([], []), true);
  },

  "barrierCoveredTargets covers only frames in parked lines' histories": () => {
    const parked = [{ history: ["START.svg", "Left.svg"] }];
    let covered = barrierCoveredTargets(parked, ["Left.svg", "Right.svg"]);
    assert.deepStrictEqual([...covered], ["Left.svg"]);
    // Only once BOTH lines (Left + Right travellers) park is it satisfied.
    parked.push({ history: ["START.svg", "Right.svg"] });
    covered = barrierCoveredTargets(parked, ["Left.svg", "Right.svg"]);
    assert.strictEqual(
      holdUntilSatisfied(["Left.svg", "Right.svg"], covered),
      true,
    );
  },

  // ── rejoin / recombine ──────────────────────────────────────────────────
  "rejoinSatisfied true only when all expected arrived": () => {
    assert.strictEqual(rejoinSatisfied(["L1", "L2"], ["L1"]), false);
    assert.strictEqual(rejoinSatisfied(["L1", "L2"], ["L2", "L1"]), true);
    assert.strictEqual(rejoinSatisfied([], ["L1"]), false);
  },

  "planRecombine keeps the lowest id as survivor": () => {
    const r = planRecombine(["L3", "L1", "L2"]);
    assert.strictEqual(r.survivorId, "L1");
    assert.deepStrictEqual(r.absorbedIds, ["L2", "L3"]);
  },

  // ── track-group helpers ─────────────────────────────────────────────────
  "groupOfFrame + groupFramesLower": () => {
    const graph = {
      byFrame: { "Left.svg": { trackGroup: "converge" } },
      groups: { converge: ["Left.svg", "Right.svg"] },
    };
    assert.strictEqual(groupOfFrame(graph, "Left.svg"), "converge");
    assert.strictEqual(groupOfFrame(graph, "Right.svg"), "converge");
    assert.deepStrictEqual(groupFramesLower(graph, "converge"), [
      "left.svg",
      "right.svg",
    ]);
  },

  "linesOnGroupFrames excludes dormant/retired": () => {
    const frameName = (l) => l.frame;
    const lines = [
      { id: "L1", status: "active", frame: "Left.svg" },
      { id: "L2", status: "dormant", frame: "Right.svg" },
      { id: "L3", status: "active", frame: "Elsewhere.svg" },
    ];
    const got = linesOnGroupFrames(lines, frameName, ["left.svg", "right.svg"]);
    assert.deepStrictEqual(
      got.map((l) => l.id),
      ["L1"],
    );
  },

  // ── resolveGroupStay (global STAY rule) ─────────────────────────────────
  "resolveGroupStay: a global-max stay brakes the whole group": () => {
    const tallies = [
      { lineId: "L1", counts: { "2#x#0": 1, stay: 3 } },
      { lineId: "L2", counts: { "4#y#0": 2 } },
    ];
    const r = resolveGroupStay(tallies, () => 0);
    assert.strictEqual(r.isStay, true);
    assert.strictEqual(r.globalMax, 3);
  },

  "resolveGroupStay: no stay leader → each resolves its own": () => {
    const tallies = [
      { lineId: "L1", counts: { "2#x#0": 1, stay: 1 } },
      { lineId: "L2", counts: { "4#y#0": 2 } },
    ];
    const r = resolveGroupStay(tallies, () => 0);
    assert.strictEqual(r.isStay, false);
    assert.strictEqual(r.globalMax, 2);
    assert.strictEqual(r.leader.voteId, "4#y#0");
  },

  "groupLinkWinner ignores stay + winningVoteId, picks top link": () => {
    const counts = { "2#x#0": 3, "5#y#0": 1, stay: 9, winningVoteId: "stay" };
    assert.strictEqual(groupLinkWinner(counts, () => 0), "2#x#0");
  },

  "groupLinkWinner returns null when only stay votes": () => {
    assert.strictEqual(groupLinkWinner({ stay: 4 }, () => 0), null);
  },

  // Full L scenario: NOT a global stay → each line takes its OWN link winner even
  // if its local tally leaned stay; a global-max stay would brake all.
  "track-group: global link max → per-line link winners (no group stay)": () => {
    const tallies = [
      { lineId: "L1", counts: { "2#a#0": 1, stay: 2 } }, // locally leans stay
      { lineId: "L2", counts: { "7#b#0": 5 } }, // global max (a link)
    ];
    const decision = resolveGroupStay(tallies, () => 0);
    assert.strictEqual(decision.isStay, false);
    // L1, despite a local stay lead, proceeds to its own link winner:
    assert.strictEqual(groupLinkWinner(tallies[0].counts, () => 0), "2#a#0");
  },

  "track-group: a stay as the GLOBAL max brakes every line": () => {
    const tallies = [
      { lineId: "L1", counts: { "2#a#0": 1, stay: 6 } }, // global max stay
      { lineId: "L2", counts: { "7#b#0": 4 } },
    ];
    const decision = resolveGroupStay(tallies, () => 0);
    assert.strictEqual(decision.isStay, true);
  },

  // ── subReturnIndex ──────────────────────────────────────────────────────
  "subReturnIndex resolves into main list": () => {
    const list = ["start.svg", "barrier.svg", "done.svg"];
    assert.strictEqual(subReturnIndex("Barrier.svg", list), 1);
    assert.strictEqual(subReturnIndex("nope.svg", list), -1);
    assert.strictEqual(subReturnIndex(null, list), -1);
  },

  // ── applySplit (fake transport) ─────────────────────────────────────────
  "applySplit spawns children, balances, retires parent, emits": () => {
    const session = fakeSession();
    const parent = fakeLine(session, "L0");
    parent.setCurrIdxTo(0); // START.svg (the split frame)
    session.lines.push(parent);

    const tp = fakeTransport();
    const o = createOrchestrator(tp);

    // children frames: Left.svg(1), Right.svg(2)
    const members = [
      { conn: { lineId: "L0" }, key: "dA", choice: 0 }, // chose Left
      { conn: { lineId: "L0" }, key: "dB", choice: 1 }, // chose Right
      { conn: { lineId: "L0" }, key: "dC", choice: null }, // straggler
    ];

    const { children, counts } = o.applySplit({
      session,
      parentLine: parent,
      childFrameIndices: [1, 2],
      members,
    });

    assert.strictEqual(children.length, 2);
    assert.strictEqual(parent.status, "retired");
    // straggler balances the smaller child (both had 1 → ties → child0).
    assert.deepStrictEqual(counts, [2, 1]);
    assert.strictEqual(children[0].currentIndex, 1);
    assert.strictEqual(children[1].currentIndex, 2);

    // conns + registry reassigned
    assert.strictEqual(members[0].conn.lineId, children[0].id);
    assert.strictEqual(members[1].conn.lineId, children[1].id);
    assert.strictEqual(session.deviceRegistry["dA"], children[0].id);
    assert.strictEqual(session.deviceRegistry["dB"], children[1].id);

    // each child got BEGIN_SPLIT + LINE_ASSIGNED (display is the runtime's job)
    for (const child of children) {
      const forChild = tp.sent.filter((s) => s.lineId === child.id);
      assert.ok(forChild.some((s) => s.m === MESSAGES.MSG_BEGIN_SPLIT));
      assert.ok(
        forChild.some(
          (s) => s.m === MESSAGES.MSG_LINE_ASSIGNED && s.lineId === child.id,
        ),
      );
      assert.ok(
        !forChild.some((s) => s.m === MESSAGES.MSG_SHOW),
        "applySplit must not emit SHOW (runtime decides display)",
      );
    }
  },

  // ── applyRecombine (fake transport) ─────────────────────────────────────
  "applyRecombine merges to lowest id + reassigns devices": () => {
    const session = fakeSession();
    const l1 = fakeLine(session, "L1");
    const l2 = fakeLine(session, "L2");
    session.lines.push(l1, l2);
    session.deviceRegistry = { dA: "L1", dB: "L2" };
    const connections = [
      { lineId: "L1", deviceId: "dA" },
      { lineId: "L2", deviceId: "dB" },
    ];

    const o = createOrchestrator(fakeTransport());
    const { survivor, absorbed } = o.applyRecombine({
      session,
      lineIds: ["L2", "L1"],
      connections,
    });

    assert.strictEqual(survivor.id, "L1");
    assert.strictEqual(absorbed.length, 1);
    assert.strictEqual(absorbed[0].id, "L2");
    assert.strictEqual(absorbed[0].status, "retired");
    assert.strictEqual(connections[1].lineId, "L1");
    assert.strictEqual(session.deviceRegistry["dB"], "L1");
  },

  // ── full hybrid barrier→rejoin (split→3→barrier→rejoin) ─────────────────
  "hybrid: barrier holds until 3 parked, then recombines to survivor": () => {
    // Three lines parked at a barrier, each having travelled a distinct frame.
    const parked = [
      { id: "L1", history: ["M0.svg", "M1.svg", "B1.svg"] },
      { id: "L2", history: ["M0.svg", "M2.svg", "B1.svg"] },
    ];
    const targets = ["M1.svg", "M2.svg", "M3.svg"];

    // Only 2 of 3 parked → not satisfied.
    let covered = barrierCoveredTargets(parked, targets);
    assert.strictEqual(holdUntilSatisfied(targets, covered), false);

    // Third arrives → satisfied → recombine to lowest id.
    parked.push({ id: "L3", history: ["M0.svg", "M3.svg", "B1.svg"] });
    covered = barrierCoveredTargets(parked, targets);
    assert.strictEqual(holdUntilSatisfied(targets, covered), true);

    const { survivorId, absorbedIds } = planRecombine(parked.map((l) => l.id));
    assert.strictEqual(survivorId, "L1");
    assert.deepStrictEqual(absorbedIds, ["L2", "L3"]);
  },
};
