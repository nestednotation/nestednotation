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
  outgoingVoteIds,
  defaultOutgoingVoteId,
  holdUntilSatisfied,
  holdUntilReachabilityState,
  markReached,
  registryCoveredTargets,
  beginReachedGeneration,
  unparkLine,
  rejoinSatisfied,
  planRecombine,
  groupOfFrame,
  groupFramesLower,
  linesOnGroupFrames,
  resolveGroupStay,
  groupLinkWinner,
  canReachFrames,
  groupArrivalState,
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

  // ── no-vote fallback ───────────────────────────────────────────────────
  "voting fallback: normal no-vote line advances to first outgoing link": () => {
    const frames = ["A.svg", "B.svg"];
    const voteId = defaultOutgoingVoteId(
      { "A.svg": [1] },
      frames,
      "A.svg",
      () => 0.9,
    );
    assert.strictEqual(voteId, "1#A.svg#0");
    assert.strictEqual(parseVoteTargetIndex(voteId, 0), 1);
  },

  "voting fallback: normal no-vote line with no outgoing links stays": () => {
    const frames = ["A.svg"];
    const currentIndex = 0;
    const voteId = defaultOutgoingVoteId(
      { "A.svg": [] },
      frames,
      "A.svg",
      () => 0,
    );
    const targetIdx = voteId
      ? parseVoteTargetIndex(voteId, currentIndex)
      : currentIndex;
    assert.strictEqual(voteId, null);
    assert.strictEqual(targetIdx, currentIndex);
  },

  "voting fallback: invalid link votes do not mask default outgoing link": () => {
    const frames = ["A.svg", "B.svg"];
    const frameLinks = { "A.svg": [-1, 1] };
    const validIds = outgoingVoteIds(frameLinks, frames, "A.svg");
    const currentVotes = ["-1#A.svg#0", "99#A.svg#2", "-1"];
    const validVotes = currentVotes.filter((vote) => validIds.includes(vote));
    assert.deepStrictEqual(validIds, ["1#A.svg#1"]);
    assert.deepStrictEqual(validVotes, []);
    assert.strictEqual(
      defaultOutgoingVoteId(frameLinks, frames, "A.svg", () => 0),
      "1#A.svg#1",
    );
  },

  "voting fallback: track-group no local link votes auto-advances without global stay": () => {
    const frames = ["G1.svg", "G1Next.svg", "G2.svg", "G2Next.svg"];
    const defaultId = defaultOutgoingVoteId(
      { "G1.svg": [1] },
      frames,
      "G1.svg",
      () => 0,
    );
    const tallies = [
      { lineId: "L1", counts: { stay: 1 } },
      { lineId: "L2", counts: { "3#G2.svg#0": 2 } },
    ];
    assert.strictEqual(resolveGroupStay(tallies, () => 0).isStay, false);
    const linkWinner = groupLinkWinner(
      { stay: 1, winningVoteId: "stay" },
      () => 0,
    );
    assert.strictEqual(linkWinner || defaultId, "1#G1.svg#0");
  },

  "voting fallback: explicit stay still stays": () => {
    const frames = ["A.svg", "B.svg"];
    const currentIndex = 0;
    const defaultId = defaultOutgoingVoteId(
      { "A.svg": [1] },
      frames,
      "A.svg",
      () => 0,
    );
    const counts = { stay: 3, winningVoteId: "stay" };
    const winningId = counts.winningVoteId || defaultId;
    const targetIdx =
      winningId === "stay"
        ? currentIndex
        : parseVoteTargetIndex(winningId, currentIndex);
    assert.strictEqual(winningId, "stay");
    assert.strictEqual(targetIdx, currentIndex);
  },

  "voting fallback: split non-choosers still balance across children": () => {
    const { assignment, counts } = planSplitPartition(
      [{ choice: 0 }, {}, {}, {}],
      2,
    );
    assert.deepStrictEqual(assignment, [0, 1, 0, 1]);
    assert.deepStrictEqual(counts, [2, 2]);
  },

  // ── holdUntilSatisfied / markReached / registryCoveredTargets ───────────
  "holdUntilSatisfied requires all targets (case-insensitive)": () => {
    assert.strictEqual(holdUntilSatisfied(["A.svg", "B.svg"], ["a.svg"]), false);
    assert.strictEqual(
      holdUntilSatisfied(["A.svg", "B.svg"], ["a.svg", "b.svg"]),
      true,
    );
    assert.strictEqual(holdUntilSatisfied([], []), true);
  },

  "holdUntilReachabilityState requires a route for each missing target": () => {
    const targets = ["A.svg", "B.svg", "C.svg"];
    const covered = new Set(["a.svg"]);
    const lines = [{ id: "L1" }, { id: "L2" }];

    let state = holdUntilReachabilityState(
      targets,
      covered,
      lines,
      (line, target) =>
        (line.id === "L1" && target === "B.svg") ||
        (line.id === "L2" && target === "C.svg"),
    );
    assert.deepStrictEqual(state.missingTargets, ["B.svg", "C.svg"]);
    assert.deepStrictEqual(state.unreachableTargets, []);
    assert.strictEqual(state.reachable, true);

    state = holdUntilReachabilityState(
      targets,
      covered,
      lines,
      (line, target) => line.id === "L1" && target === "B.svg",
    );
    assert.deepStrictEqual(state.unreachableTargets, ["C.svg"]);
    assert.strictEqual(state.reachable, false);
  },

  "markReached phases forward only; done-edge reported once": () => {
    const reg = {};
    assert.strictEqual(markReached(reg, "E.svg"), false); // arrived
    assert.strictEqual(reg["e.svg"], "arrived");
    assert.strictEqual(markReached(reg, "e.SVG", true), true); // done edge
    assert.strictEqual(markReached(reg, "E.svg", true), false); // idempotent
    assert.strictEqual(markReached(reg, "E.svg"), false); // never downgrades
    assert.strictEqual(reg["e.svg"], "done");
  },

  "registryCoveredTargets counts only done targets (case-insensitive)": () => {
    const reg = {};
    markReached(reg, "Left.svg", true);
    markReached(reg, "Right.svg"); // arrived, hold not ended
    let covered = registryCoveredTargets(reg, ["Left.svg", "Right.svg"]);
    assert.deepStrictEqual([...covered], ["Left.svg"]);
    markReached(reg, "RIGHT.svg", true);
    covered = registryCoveredTargets(reg, ["Left.svg", "Right.svg"]);
    assert.strictEqual(
      holdUntilSatisfied(["Left.svg", "Right.svg"], covered),
      true,
    );
  },

  // ── rendezvous: the FigJam mutual barrier (E⇄F⇄G) must not deadlock ─────
  "mutual hold-until barriers all satisfy from the shared registry": () => {
    // E holds-until F,G; F holds-until E,G; G holds-until E,F. Each line
    // parks at its OWN landing; the registry (not convergence) releases all.
    const reg = {};
    for (const f of ["E.svg", "F.svg", "G.svg"]) {
      markReached(reg, f); // three lines land on their landings
    }
    assert.strictEqual(
      holdUntilSatisfied(["F.svg", "G.svg"], registryCoveredTargets(reg, ["F.svg", "G.svg"])),
      false,
      "arrival alone must not release (holds still running)",
    );
    for (const f of ["E.svg", "F.svg", "G.svg"]) {
      markReached(reg, f, true); // each landing's hold ends
    }
    for (const targets of [
      ["F.svg", "G.svg"],
      ["E.svg", "G.svg"],
      ["E.svg", "F.svg"],
    ]) {
      assert.strictEqual(
        holdUntilSatisfied(targets, registryCoveredTargets(reg, targets)),
        true,
      );
    }
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

  "groupLinkWinner falls back to a retained window winner": () => {
    assert.strictEqual(
      groupLinkWinner({ winningVoteId: "2#x#0" }, () => 0),
      "2#x#0",
    );
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
  "hybrid: barrier holds until all 3 branches done, then recombines": () => {
    // Three lines fan out over M1/M2/M3 and reconverge on B1
    // (hold-until="M1,M2,M3"). The registry accumulates as each branch's
    // frame completes its hold — wherever its line currently is.
    const reg = {};
    const targets = ["M1.svg", "M2.svg", "M3.svg"];

    markReached(reg, "M1.svg", true);
    markReached(reg, "M2.svg", true);
    // Only 2 of 3 branches done → not satisfied.
    assert.strictEqual(
      holdUntilSatisfied(targets, registryCoveredTargets(reg, targets)),
      false,
    );

    // Third branch completes → satisfied → recombine to lowest id.
    markReached(reg, "M3.svg", true);
    assert.strictEqual(
      holdUntilSatisfied(targets, registryCoveredTargets(reg, targets)),
      true,
    );

    const { survivorId, absorbedIds } = planRecombine(["L1", "L2", "L3"]);
    assert.strictEqual(survivorId, "L1");
    assert.deepStrictEqual(absorbedIds, ["L2", "L3"]);
  },

  // ── applySplit: offline deviceRegistry sweep (decision #13) ──────────────
  "applySplit sweeps offline registry entries off the retired parent": () => {
    const session = fakeSession();
    const parent = fakeLine(session, "L0");
    session.lines.push(parent);
    // dOff was on the parent but is OFFLINE during the split (no connection).
    session.deviceRegistry = { dA: "L0", dB: "L0", dOff: "L0" };
    const members = [
      { conn: { lineId: "L0" }, key: "dA", choice: 0 },
      { conn: { lineId: "L0" }, key: "dB", choice: 0 },
    ];

    const o = createOrchestrator(fakeTransport());
    const { children } = o.applySplit({
      session,
      parentLine: parent,
      childFrameIndices: [1, 2],
      members,
    });

    assert.strictEqual(parent.status, "retired");
    // The offline device must NOT stay registered to the retired parent…
    assert.notStrictEqual(session.deviceRegistry.dOff, "L0");
    // …and lands on the smallest child (both choosers went to child 0).
    assert.strictEqual(session.deviceRegistry.dOff, children[1].id);
  },

  // ── SM jump rewind semantics (S2 option (b) + R4, decided 2026-07-07) ─────
  "beginReachedGeneration restarts the registry, pre-satisfying only the landing barrier": () => {
    const session = {
      reachedTargets: {},
      reachedGeneration: 0,
    };
    markReached(session.reachedTargets, "Left.svg", true);
    markReached(session.reachedTargets, "Right.svg", true);

    // Jump lands on a barrier frame waiting on M1/M2: the rewind-point barrier
    // stays unlocked, everything else gates again like a first pass.
    beginReachedGeneration(session, ["M1.svg", "M2.svg"]);

    assert.strictEqual(session.reachedGeneration, 1);
    const covered = registryCoveredTargets(session.reachedTargets, [
      "Left.svg",
      "Right.svg",
      "M1.svg",
      "M2.svg",
    ]);
    assert.deepStrictEqual([...covered].sort(), ["M1.svg", "M2.svg"]);

    // A non-barrier landing restarts the registry to empty.
    beginReachedGeneration(session, undefined);
    assert.strictEqual(session.reachedGeneration, 2);
    assert.deepStrictEqual(session.reachedTargets, {});
  },

  "unparkLine clears barrier state and deletes emptied entries": () => {
    const line = {
      id: "L1",
      isBarrierWaiting: true,
      pendingHoldUntil: ["Left.svg"],
    };
    const session = {
      _barrier: {
        byFrame: {
          "Barrier.svg": {
            frame: "Barrier.svg",
            parked: new Set(["L1"]),
          },
          "Other.svg": {
            frame: "Other.svg",
            parked: new Set(["L2"]),
          },
        },
      },
    };

    assert.strictEqual(unparkLine(session, line), true);
    assert.strictEqual(line.isBarrierWaiting, false);
    assert.deepStrictEqual(line.pendingHoldUntil, []);
    // L1's emptied entry is gone; the unrelated entry is untouched.
    assert.strictEqual(session._barrier.byFrame["Barrier.svg"], undefined);
    assert.ok(session._barrier.byFrame["Other.svg"].parked.has("L2"));

    // Un-parked already → nothing changes, and that is reported.
    assert.strictEqual(unparkLine(session, line), false);
  },

  // ── registry: qualified sub refs ─────────────────────────────────────────
  "registry covers qualified sub refs, never bare↔qualified cross-matches": () => {
    const targets = ["Left.svg", "Tetra/Echo.svg"];
    const reg = {};
    markReached(reg, "Left.svg", true);
    // A line inside sub Tetra reaches Echo (recorded qualified, lowercased).
    markReached(reg, "tetra/echo.svg", true);

    const covered = registryCoveredTargets(reg, targets);
    assert.ok(covered.has("Left.svg"));
    assert.ok(covered.has("Tetra/Echo.svg"), "sub ref must be covered");
    assert.strictEqual(holdUntilSatisfied(targets, covered), true);

    // A bare main-flow visit never satisfies a qualified sub ref.
    const uncovered = registryCoveredTargets(
      { "echo.svg": "done" },
      ["Tetra/Echo.svg"],
    );
    assert.strictEqual(uncovered.size, 0);
  },

  // ── track-group ARRIVAL barrier (decided 2026-07-16) ─────────────────────
  "canReachFrames walks links transitively (case-insensitive)": () => {
    // START → A → B → C; frameLinks carry indices into listFiles.
    const listFiles = ["START.svg", "A.svg", "B.svg", "C.svg"];
    const frameLinks = {
      "START.svg": [1],
      "A.svg": [2],
      "B.svg": [3],
      "C.svg": [],
    };
    assert.strictEqual(
      canReachFrames(frameLinks, listFiles, "START.svg", ["c.svg"]),
      true,
    );
    assert.strictEqual(
      canReachFrames(frameLinks, listFiles, "B.svg", ["C.svg"]),
      true,
    );
    // No path backwards.
    assert.strictEqual(
      canReachFrames(frameLinks, listFiles, "C.svg", ["A.svg"]),
      false,
    );
    // Standing on a target counts as reaching it.
    assert.strictEqual(
      canReachFrames(frameLinks, listFiles, "B.svg", ["B.svg"]),
      true,
    );
  },

  "canReachFrames survives cycles and skips unresolved links": () => {
    const listFiles = ["A.svg", "B.svg", "C.svg"];
    const frameLinks = {
      "A.svg": [1, -1], // -1 = href that didn't resolve
      "B.svg": [0], // A ↔ B cycle
      "C.svg": [],
    };
    assert.strictEqual(
      canReachFrames(frameLinks, listFiles, "A.svg", ["C.svg"]),
      false,
    );
    assert.strictEqual(
      canReachFrames(frameLinks, listFiles, "B.svg", ["A.svg"]),
      true,
    );
    assert.strictEqual(canReachFrames(frameLinks, listFiles, "A.svg", []), false);
    assert.strictEqual(canReachFrames({}, listFiles, null, ["C.svg"]), false);
  },

  "groupArrivalState waits on populated lines that can still reach": () => {
    const lines = [
      { id: "L1", status: "active" }, // parked on a group frame
      { id: "L2", status: "active" }, // still traveling, can reach
      { id: "L3", status: "active" }, // traveling, path leads away
      { id: "L4", status: "dormant" }, // never counted
      { id: "L5", status: "active" }, // empty — excluded (owner rule)
    ];
    const frames = { L1: "B.svg", L2: "A.svg", L3: "X.svg", L5: "A.svg" };
    const state = groupArrivalState(lines, ["B.svg", "C.svg"], {
      frameNameForLine: (l) => frames[l.id] || null,
      deviceCount: (l) => (l.id === "L5" ? 0 : 1),
      canReach: (l) => l.id === "L2",
    });
    assert.strictEqual(state.waiting, true);
    assert.deepStrictEqual(state.incomingIds, ["L2"]);
    assert.deepStrictEqual(state.blockedIds, []);
  },

  "groupArrivalState releases when every incoming line has arrived": () => {
    const lines = [
      { id: "L1", status: "active" },
      { id: "L2", status: "active" },
    ];
    const frames = { L1: "B.svg", L2: "c.svg" }; // both on group frames
    const state = groupArrivalState(lines, ["B.svg", "C.svg"], {
      frameNameForLine: (l) => frames[l.id],
      deviceCount: () => 1,
      canReach: () => true, // irrelevant — both are occupants
    });
    assert.strictEqual(state.waiting, false);
    assert.deepStrictEqual(state.incomingIds, []);
  },

  "groupArrivalState keeps waiting on a hold-until-blocked occupant": () => {
    // L1 sits on a group frame but its own (out-of-group) hold-until barrier
    // has not released — the group must keep waiting for it (composition).
    const lines = [
      { id: "L1", status: "active", isBarrierWaiting: true },
      { id: "L2", status: "active" },
    ];
    const frames = { L1: "B.svg", L2: "C.svg" };
    const state = groupArrivalState(lines, ["B.svg", "C.svg"], {
      frameNameForLine: (l) => frames[l.id],
      deviceCount: () => 1,
      isBlocked: (l) => !!l.isBarrierWaiting,
      canReach: () => false,
    });
    assert.strictEqual(state.waiting, true);
    assert.deepStrictEqual(state.blockedIds, ["L1"]);
  },

  "groupArrivalState treats a sub line as incoming via canReach": () => {
    // L2 is inside a sub — even if the sub frame's NAME collides with a group
    // frame, it is not an occupant; reachability (from its return landing)
    // decides whether it is incoming.
    const lines = [
      { id: "L1", status: "active" },
      { id: "L2", status: "active", inSub: true },
    ];
    const frames = { L1: "B.svg", L2: "C.svg" };
    const state = groupArrivalState(lines, ["B.svg", "C.svg"], {
      frameNameForLine: (l) => frames[l.id],
      deviceCount: () => 1,
      inSub: (l) => !!l.inSub,
      canReach: (l) => !!l.inSub,
    });
    assert.strictEqual(state.waiting, true);
    assert.deepStrictEqual(state.incomingIds, ["L2"]);
  },
};
