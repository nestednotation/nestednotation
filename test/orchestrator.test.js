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
  revivalLandingFrame,
  commonCheckpoints,
  roomRewindPlan,
  ancestorGroupOccurrence,
  splitRewindPlan,
  splitRewindOptions,
  rewindSplitStructure,
  mergeRewindPlan,
  structuralRewindChain,
  compareStructural,
  splitStepState,
  mergeRewindOptions,
  mergeConvergenceEvents,
  splitGestureEvents,
  chainMergesCanUndo,
  mergesBehindLine,
  mergesBehindRoomRewind,
  preMergeLanding,
  spreadMergeLatecomers,
  rewindMergeStructure,
  resolveGroupStay,
  groupLinkWinner,
  canReachFrames,
  groupArrivalState,
  groupStragglerIds,
  holdUntilStragglerTargets,
  subReturnIndex,
  createOrchestrator,
} = require("../lib/session-lines/orchestrator");

const { MESSAGES } = require("../constants");

let fakeUid = 0;

// A minimal stand-in for BMLine for transport-driven tests.
function fakeLine(session, id) {
  return {
    id,
    // Durable route identity: numbers recycle, this does not.
    uid: `u${(fakeUid += 1)}`,
    status: "active",
    currentIndex: 0,
    history: [],
    historyIndex: 0,
    trackGroup: null,
    splitAncestors: [],
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
    nextSplitEventId: 1,
    splitEvents: [],
    deviceRegistry: {},
    preloadDuration: 0,
    listFiles: ["START.svg", "Left.svg", "Right.svg", "Barrier.svg", "DONE.svg"],
    lines: [],
  };
}

// Mark every recorded rejoin unundoable, the way loading a state file whose
// participants carry no `uid` does (`migrateStructuralIdentities`) — the only
// route to `expired` there is. A room checkpoint rewind used to be the other
// one; it undoes the rejoins it rewinds past instead, so it ends nothing
// (`mergesBehindRoomRewind`).
function expireMerges(session) {
  for (const event of session.mergeEvents || []) {
    if (event.status === "active") {
      event.status = "expired";
      event.expiredAt = 1000;
    }
  }
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

  "commonCheckpoints returns all shared groups newest-first": () => {
    const groups = {
      BC: ["B.svg", "C.svg"],
      EF: ["E.svg", "F.svg"],
      GH: ["G.svg", "H.svg"],
      IJK: ["I.svg", "J.svg", "K.svg"],
      LMO: ["L.svg", "M.svg", "O.svg"],
      RTU: ["R.svg", "T.svg", "U.svg"],
      VWY: ["V.svg", "W.svg", "Y.svg"],
    };
    const checkpoints = commonCheckpoints({
      groups,
      lines: [
        {
          id: "L1",
          trail: [
            "B.svg",
            "D.svg",
            "F.svg",
            "G.svg",
            "I.svg",
            "L.svg",
            "P.svg",
            "S.svg",
            "U.svg",
            "V.svg",
          ],
        },
        {
          id: "L2",
          trail: [
            "C.svg",
            "E.svg",
            "H.svg",
            "M.svg",
            "Q.svg",
            "T.svg",
            "W.svg",
          ],
        },
      ],
    });
    assert.deepStrictEqual(
      checkpoints.map((c) => c.group),
      ["VWY", "RTU", "LMO", "GH", "EF", "BC"],
    );
    assert.deepStrictEqual(checkpoints[1].byLine, {
      L1: "U.svg",
      L2: "T.svg",
    });
  },

  "commonCheckpoints uses latest occurrence when a trail loops": () => {
    const checkpoints = commonCheckpoints({
      groups: {
        BC: ["B.svg", "C.svg"],
        RTU: ["R.svg", "T.svg", "U.svg"],
      },
      lines: [
        { id: "L1", trail: ["B.svg", "U.svg", "B.svg"] },
        { id: "L2", trail: ["C.svg", "T.svg", "C.svg"] },
      ],
    });
    assert.deepStrictEqual(
      checkpoints.map((c) => c.group),
      ["BC", "RTU"],
    );
    assert.deepStrictEqual(checkpoints[0].byLine, {
      L1: "B.svg",
      L2: "C.svg",
    });
  },

  "roomRewindPlan fills non-checkpoint lines onto least-occupied group frames": () => {
    const groups = {
      RTU: ["R.svg", "T.svg", "U.svg"],
    };
    const plan = roomRewindPlan({
      group: "rtu",
      groups,
      checkpointLines: [
        { id: "L1", trail: ["A.svg", "U.svg"] },
        { id: "L2", trail: ["A.svg", "T.svg"] },
      ],
      lines: [
        { id: "L1", trail: ["A.svg", "U.svg"] },
        { id: "L2", trail: ["A.svg", "T.svg"] },
        { id: "L3", trail: ["A.svg"] },
      ],
    });
    assert.strictEqual(plan.group, "RTU");
    assert.deepStrictEqual(plan.lines, [
      { lineId: "L1", frame: "U.svg", source: "history", historyIndex: 1 },
      { lineId: "L2", frame: "T.svg", source: "history", historyIndex: 1 },
      { lineId: "L3", frame: "R.svg", source: "fill", historyIndex: -1 },
    ]);
  },

  // A split truncates the trails it forks from (§6), so a line born after the
  // checkpoint has no occurrence of it — and the fill was placing those lines by
  // the order they happened to sit in `session.lines`. The owner rewound a room
  // to `GH` and got both populated lines on `G` (4 players) with the empty one
  // alone on `H`, the frame one of those routes had actually come through. The
  // split records say where each route crossed the group; only a line with no
  // record either way is a guess now.
  // The menu and the landing now ask ONE question. A populated line whose trail
  // a fork truncated used to block every group the room crossed before that
  // fork — so checkpoints disappeared from the map exactly as the room split
  // and merged, which is when an operator reaches for one.
  "commonCheckpoints reads a forked line's route through its parent": () => {
    const groups = { GH: ["G.svg", "H.svg"], BC: ["B.svg", "C.svg"] };
    const splitEvents = [
      { id: "S1", parentHistory: ["START.svg", "A.svg"], parentHistoryIndex: 1 },
      {
        id: "S3",
        parentHistory: ["C.svg", "E.svg", "H.svg"],
        parentHistoryIndex: 2,
      },
    ];
    const lines = [
      { id: "L0", trail: ["B.svg", "D.svg", "F.svg", "G.svg"], splitAncestors: ["S1"] },
      { id: "L1", trail: ["J.svg", "M.svg"], splitAncestors: ["S1", "S3"] },
    ];
    // L1's own trail starts at the branch frame it took, so on trails alone the
    // room has no checkpoints at all — not even the group it is standing in.
    assert.deepStrictEqual(commonCheckpoints({ lines, groups }), []);
    assert.deepStrictEqual(
      commonCheckpoints({ lines, groups, splitEvents }),
      [
        { group: "GH", byLine: { L0: "G.svg", L1: "H.svg" } },
        { group: "BC", byLine: { L0: "B.svg", L1: "C.svg" } },
      ],
    );
  },

  // …and what the menu offers, the walk has to be willing to take apart: an
  // ancestry landing is BEFORE the line's own trail, so every rejoin in it
  // happened after the checkpoint.
  "mergesBehindRoomRewind undoes the rejoins behind an ancestry landing": () => {
    const lines = [{ id: "L1", uid: "u1" }];
    const mergeEvents = [
      {
        id: "M1",
        status: "active",
        frame: "Z.svg",
        survivorLineId: "L1",
        participants: [
          {
            lineId: "L1",
            lineUid: "u1",
            history: ["J.svg", "M.svg", "Z.svg"],
            historyIndex: 2,
          },
        ],
      },
    ];
    const behind = (source) =>
      mergesBehindRoomRewind({
        mergeEvents,
        lines,
        plan: {
          lines: [{ lineId: "L1", frame: "H.svg", source, historyIndex: -1 }],
        },
      }).map((event) => event.id);
    assert.deepStrictEqual(behind("ancestor"), ["M1"]);
    // A fill is a guess about a line the checkpoint never consulted; it takes
    // nothing off the room.
    assert.deepStrictEqual(behind("fill"), []);
  },

  "roomRewindPlan places a forked line by the route its split recorded": () => {
    const groups = { GH: ["G.svg", "H.svg"] };
    // One fork at A (L0 keeps the number and walks B…G), one at H, whose two
    // children start their own trails at the branch frames J and K.
    const splitEvents = [
      {
        id: "S1",
        parentHistory: ["START.svg", "A.svg"],
        parentHistoryIndex: 1,
      },
      {
        id: "S3",
        parentHistory: ["C.svg", "E.svg", "H.svg"],
        parentHistoryIndex: 2,
      },
    ];
    const lines = [
      { id: "L0", trail: ["B.svg", "D.svg", "F.svg", "G.svg"], splitAncestors: ["S1"] },
      { id: "L2", trail: ["K.svg"], splitAncestors: ["S1", "S3"] },
      { id: "L1", trail: ["J.svg", "M.svg"], splitAncestors: ["S1", "S3"] },
    ];
    const plan = roomRewindPlan({
      group: "GH",
      groups,
      // The room was one merged line when the menu offered this checkpoint;
      // the others come back from the undos the rewind runs on the way.
      checkpointLines: [lines[0]],
      lines,
      splitEvents,
    });
    assert.deepStrictEqual(plan.lines, [
      { lineId: "L0", frame: "G.svg", source: "history", historyIndex: 3 },
      { lineId: "L2", frame: "H.svg", source: "ancestor", historyIndex: -1 },
      { lineId: "L1", frame: "H.svg", source: "ancestor", historyIndex: -1 },
    ]);

    // Without the records it is the old guess: whoever the array reaches first
    // takes the free frame, so the room's population lands wherever it lands.
    const guessed = roomRewindPlan({
      group: "GH",
      groups,
      checkpointLines: [lines[0]],
      lines,
    });
    assert.deepStrictEqual(
      guessed.lines.map((entry) => [entry.lineId, entry.frame, entry.source]),
      [
        ["L0", "G.svg", "history"],
        ["L2", "H.svg", "fill"],
        ["L1", "G.svg", "fill"],
      ],
    );
  },

  // The newest fork wins: it is the most recent point of the route, and each
  // older ancestor is a step further back along the same one.
  "ancestorGroupOccurrence walks the forks newest-first": () => {
    const splitEvents = [
      { id: "S1", parentHistory: ["START.svg", "G.svg"], parentHistoryIndex: 1 },
      { id: "S2", parentHistory: ["E.svg", "H.svg"], parentHistoryIndex: 1 },
    ];
    const frames = ["G.svg", "H.svg"];
    assert.deepStrictEqual(
      ancestorGroupOccurrence({
        line: { splitAncestors: ["S1", "S2"] },
        splitEvents,
        frames,
      }),
      { frame: "H.svg", eventId: "S2", index: -1 },
    );
    // …and how far back it had to walk, so an ancestry hit orders against an
    // own-trail index the way the route does: one step before the newest fork
    // is -1, and the same frame two forks back is older still.
    assert.deepStrictEqual(
      ancestorGroupOccurrence({
        line: { splitAncestors: ["S1", "S2"] },
        splitEvents: [
          { id: "S1", parentHistory: ["START.svg", "G.svg"], parentHistoryIndex: 1 },
          { id: "S2", parentHistory: ["E.svg", "J.svg"], parentHistoryIndex: 1 },
        ],
        frames,
      }),
      { frame: "G.svg", eventId: "S1", index: -3 },
    );
    // Past the parent's own pointer is not route it walked.
    assert.strictEqual(
      ancestorGroupOccurrence({
        line: { splitAncestors: ["S2"] },
        splitEvents: [
          { id: "S2", parentHistory: ["E.svg", "H.svg"], parentHistoryIndex: 0 },
        ],
        frames,
      }),
      null,
    );
    // A line with no forks behind it has nothing to read.
    assert.strictEqual(
      ancestorGroupOccurrence({ line: {}, splitEvents, frames }),
      null,
    );
  },

  // ── revival fast-forward (decision #13 revision) ────────────
  "revivalLandingFrame: no recorded grouped landing → revive in place": () => {
    const graph = { byFrame: {}, groups: {} };
    const line = { currentIndex: 0, subStack: [] };
    assert.strictEqual(
      revivalLandingFrame({
        graph,
        listFiles: ["A.svg"],
        latestGroupFrame: null,
        line,
        occupancy: () => 0,
      }),
      null,
    );
    // Recorded frame no longer grouped (score reloaded without the markup).
    assert.strictEqual(
      revivalLandingFrame({
        graph,
        listFiles: ["A.svg"],
        latestGroupFrame: "Gone.svg",
        line,
        occupancy: () => 0,
      }),
      null,
    );
  },

  "revivalLandingFrame: lands on the group's least-occupied frame": () => {
    const graph = {
      byFrame: { "G1.svg": { trackGroup: "band" } },
      groups: { band: ["G1.svg", "G2.svg", "G3.svg"] },
    };
    const listFiles = ["A.svg", "G1.svg", "G2.svg", "G3.svg"];
    const occupancy = (f) => ({ "G1.svg": 2, "G2.svg": 1, "G3.svg": 0 })[f];
    const got = revivalLandingFrame({
      graph,
      listFiles,
      latestGroupFrame: "G1.svg",
      line: { currentIndex: 0, subStack: [] }, // frozen at A.svg (behind)
      occupancy,
    });
    assert.strictEqual(got, "G3.svg");
  },

  "revivalLandingFrame: occupancy tie prefers the recorded frame": () => {
    const graph = {
      byFrame: { "G2.svg": { trackGroup: "band" } },
      groups: { band: ["G1.svg", "G2.svg"] },
    };
    const got = revivalLandingFrame({
      graph,
      listFiles: ["A.svg", "G1.svg", "G2.svg"],
      latestGroupFrame: "G2.svg",
      line: { currentIndex: 0, subStack: [] },
      occupancy: () => 0,
    });
    assert.strictEqual(got, "G2.svg");
  },

  "revivalLandingFrame: line frozen inside the latest group keeps its slot": () => {
    const graph = {
      byFrame: { "G1.svg": { trackGroup: "band" } },
      groups: { band: ["G1.svg", "G2.svg"] },
    };
    const got = revivalLandingFrame({
      graph,
      listFiles: ["A.svg", "G1.svg", "G2.svg"],
      latestGroupFrame: "G1.svg",
      line: { currentIndex: 2, subStack: [] }, // frozen at G2.svg — a group slot
      occupancy: () => 0,
    });
    assert.strictEqual(got, null);
  },

  "revivalLandingFrame: a line frozen mid-sub still fast-forwards": () => {
    const graph = {
      byFrame: { "G1.svg": { trackGroup: "band" } },
      groups: { band: ["G1.svg"] },
    };
    const got = revivalLandingFrame({
      graph,
      listFiles: ["A.svg", "G1.svg"],
      latestGroupFrame: "G1.svg",
      line: { currentIndex: 0, subStack: [{ score: "Tetra" }] },
      occupancy: () => 0,
    });
    assert.strictEqual(got, "G1.svg");
  },

  "revivalLandingFrame: group frames missing from the frame list → in place": () => {
    const graph = {
      byFrame: { "G1.svg": { trackGroup: "band" } },
      groups: { band: ["G1.svg", "G2.svg"] },
    };
    const got = revivalLandingFrame({
      graph,
      listFiles: ["A.svg"], // reloaded score dropped the group frames
      latestGroupFrame: "G1.svg",
      line: { currentIndex: 0, subStack: [] },
      occupancy: () => 0,
    });
    assert.strictEqual(got, null);
  },

  "beginReachedGeneration clears the revival fast-forward record": () => {
    const session = {
      reachedGeneration: 0,
      reachedTargets: { "old.svg": "done" },
      latestGroupArrival: { frame: "G1.svg", at: 123 },
    };
    beginReachedGeneration(session);
    assert.strictEqual(session.latestGroupArrival, null);
    assert.deepStrictEqual(session.reachedTargets, {});
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

  // ── one release, one undo (splitGestureEvents) ──────────────────────────
  "splitGestureEvents folds the forks of one release, newest first": () => {
    const splitEvents = [
      { id: "S1", status: "active", gestureId: null, frame: "A.svg" },
      { id: "S2", status: "active", gestureId: "G1", frame: "B.svg" },
      { id: "S3", status: "active", gestureId: "G1", frame: "C.svg" },
      { id: "S4", status: "active", gestureId: "G2", frame: "D.svg" },
    ];
    // Reached from EITHER member — an operator clicks the node in front of
    // them, and both nodes keep their button.
    for (const eventId of ["S2", "S3"]) {
      assert.deepStrictEqual(
        splitGestureEvents({ splitEvents, eventId }).map((e) => e.id),
        ["S3", "S2"],
        `${eventId} must undo the whole release, newest first`,
      );
    }
    // A lone choice window closing is one fork and one gesture already.
    assert.deepStrictEqual(
      splitGestureEvents({ splitEvents, eventId: "S1" }).map((e) => e.id),
      ["S1"],
    );
    assert.deepStrictEqual(
      splitGestureEvents({ splitEvents, eventId: "S4" }).map((e) => e.id),
      ["S4"],
    );
    // An event already off the record offers nothing.
    splitEvents[2].status = "undone";
    assert.deepStrictEqual(
      splitGestureEvents({ splitEvents, eventId: "S2" }).map((e) => e.id),
      ["S2"],
    );
  },

  "splitRewindOptions: each fork of a release names the others": () => {
    const session = fakeSession();
    const parent = fakeLine(session, "L0");
    parent.setCurrIdxTo(0);
    const other = fakeLine(session, "L2");
    other.setCurrIdxTo(0);
    session.lines.push(parent, other);
    const o = createOrchestrator(fakeTransport());

    const gestureId = o.allocSplitGestureId(session);
    o.applySplit({
      session,
      parentLine: parent,
      childFrameIndices: [1, 2],
      members: [{ conn: { lineId: "L0" }, key: "dA", choice: 0 }],
      gestureId,
    });
    o.applySplit({
      session,
      parentLine: other,
      childFrameIndices: [1, 2],
      members: [{ conn: { lineId: "L2" }, key: "dB", choice: 0 }],
      gestureId,
    });

    assert.deepStrictEqual(
      session.splitEvents.map((e) => e.gestureId),
      [gestureId, gestureId],
      "one release stamps every fork it makes",
    );

    const entries = splitRewindOptions({
      splitEvents: session.splitEvents,
      mergeEvents: [],
      lines: session.lines,
    });
    assert.strictEqual(entries.length, 2);
    for (const entry of entries) {
      assert.strictEqual(entry.available, true);
      // Both nodes keep a button — an operator looks at the node the fork
      // happened on — and each one undoes the whole release.
      assert.deepStrictEqual(
        (entry.gesture || []).map((f) => f.eventId),
        session.splitEvents
          .filter((e) => e.id !== entry.eventId)
          .map((e) => e.id),
        "each entry must name the other forks of its release",
      );
      assert.strictEqual(
        entry.descendantLineIds.length,
        4,
        "the click collapses every line the release made",
      );
    }
  },

  "splitRewindOptions: a release is all of it or none of it": () => {
    const session = fakeSession();
    const parent = fakeLine(session, "L0");
    parent.setCurrIdxTo(0);
    const other = fakeLine(session, "L2");
    other.setCurrIdxTo(0);
    session.lines.push(parent, other);
    const o = createOrchestrator(fakeTransport());
    const gestureId = o.allocSplitGestureId(session);
    o.applySplit({
      session,
      parentLine: parent,
      childFrameIndices: [1, 2],
      members: [{ conn: { lineId: "L0" }, key: "dA", choice: 0 }],
      gestureId,
    });
    o.applySplit({
      session,
      parentLine: other,
      childFrameIndices: [1, 2],
      members: [{ conn: { lineId: "L2" }, key: "dB", choice: 0 }],
      gestureId,
    });

    // One member is beyond reach. Half a release undone is a room no single
    // gesture ever produced, so NEITHER node may offer the button.
    session.splitEvents[1].blockedByMerge = true;
    const mergeEvents = [
      {
        id: "M1",
        status: "expired",
        frame: "Barrier.svg",
        blockedSplitEventIds: [session.splitEvents[1].id],
        participants: [{ lineId: "L2" }, { lineId: "L3" }],
      },
    ];
    const entries = splitRewindOptions({
      splitEvents: session.splitEvents,
      mergeEvents,
      lines: session.lines,
    });
    assert.deepStrictEqual(
      entries.map((e) => e.available),
      [false, false],
      "one unreachable fork takes the whole release off the menu",
    );
    // The node the operator is looking at reports its OWN answer where it has
    // one; the healthy fork borrows its sibling's.
    assert.strictEqual(entries[1].reason, "mixed-merge");
    assert.strictEqual(entries[0].reason, "mixed-merge");
  },

  "splitRewindOptions: an EXPIRED fork is a note, not an empty menu": () => {
    // The counterpart of the merge menu's expired entry. Nothing expires a
    // fork at runtime; `migrateStructuralIdentities` does, on load, when a
    // saved room's records cannot be tied back to its lines — and that node
    // used to render nothing at all.
    const entries = splitRewindOptions({
      splitEvents: [
        {
          id: "S1",
          status: "expired",
          frame: "START.svg",
          parentLineId: "L0",
          childLineIds: ["L0", "L1"],
        },
      ],
      mergeEvents: [],
      lines: [],
    });
    assert.deepStrictEqual(entries, [
      {
        eventId: "S1",
        parentLineId: "L0",
        frame: "START.svg",
        available: false,
        reason: "expired",
      },
    ]);
  },

  "chainMergesCanUndo refuses a step with nothing to separate": () => {
    const good = {
      kind: "merge",
      event: { id: "M1", participants: [{ lineId: "L0" }, { lineId: "L1" }] },
    };
    const bad = { kind: "merge", event: { id: "M2", participants: [{ lineId: "L0" }] } };
    const split = { kind: "split", event: { id: "S1" } };
    assert.strictEqual(chainMergesCanUndo({ chain: [good, split] }), true);
    assert.strictEqual(chainMergesCanUndo({ chain: [] }), true);
    assert.strictEqual(
      chainMergesCanUndo({ chain: [good, bad] }),
      false,
      "a walk cannot repair a record with fewer than two participants",
    );
  },

  // ── applySplit (fake transport) ─────────────────────────────────────────
  "applySplit: a branch nobody took is born DORMANT": () => {
    const session = fakeSession();
    const parent = fakeLine(session, "L0");
    parent.setCurrIdxTo(0);
    session.lines.push(parent);
    const o = createOrchestrator(fakeTransport());

    // TWO devices over THREE branches — the third gets nobody.
    const members = [
      { conn: { lineId: "L0" }, key: "dA", choice: 0 },
      { conn: { lineId: "L0" }, key: "dB", choice: 1 },
    ];
    const { children, counts } = o.applySplit({
      session,
      parentLine: parent,
      childFrameIndices: [1, 2, 3],
      members,
    });

    assert.deepStrictEqual(counts, [1, 1, 0]);
    assert.strictEqual(children[0].status, "active");
    assert.strictEqual(children[1].status, "active");
    // Born `active`, this line was immortal: dormancy is driven by a device
    // LEAVING (#11) and it never had one, so nothing demoted it — and
    // `activeLines` kept handing it to the grouped-window split, which divided
    // nobody into two more of the same on every release.
    assert.strictEqual(
      children[2].status,
      "dormant",
      "a branch with no population must not come back active",
    );
  },

  "applySplit: an OFFLINE registered device still populates its branch": () => {
    const session = fakeSession();
    const parent = fakeLine(session, "L0");
    parent.setCurrIdxTo(0);
    session.lines.push(parent);
    // Registered to the parent, not connected right now — decision #13 sweeps
    // it onto the smallest branch, so that branch is NOT empty.
    session.deviceRegistry["away"] = "L0";
    const o = createOrchestrator(fakeTransport());

    const { children } = o.applySplit({
      session,
      parentLine: parent,
      childFrameIndices: [1, 2],
      members: [{ conn: { lineId: "L0" }, key: "dA", choice: 0 }],
    });

    assert.strictEqual(session.deviceRegistry["away"], children[1].id);
    assert.strictEqual(
      children[1].status,
      "active",
      "a branch holding an absent performer is populated, not dormant",
    );
  },

  "applySplit: an unpopulated split makes no active lines at all": () => {
    // The runtime refuses to divide a line with nobody on it
    // (`lineHasPopulation`), but if one ever reaches here the children must
    // not read as a live room: this is the doubling that took one room to 16
    // lines with two performers in it.
    const session = fakeSession();
    const parent = fakeLine(session, "L0");
    parent.setCurrIdxTo(0);
    session.lines.push(parent);
    const o = createOrchestrator(fakeTransport());

    const { children } = o.applySplit({
      session,
      parentLine: parent,
      childFrameIndices: [1, 2],
      members: [],
    });

    assert.deepStrictEqual(
      children.map((c) => c.status),
      ["dormant", "dormant"],
    );
  },

  "applySplit continues the parent down branch 0, balances, emits": () => {
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
    // Branch 0 IS the parent line carrying on: it keeps L0 (same object), and
    // only the extra branch spends a number.
    assert.strictEqual(children[0], parent);
    assert.strictEqual(children[0].id, "L0");
    assert.strictEqual(children[1].id, "L1");
    assert.strictEqual(parent.status, "active");
    // straggler balances the smaller child (both had 1 → ties → child0).
    assert.deepStrictEqual(counts, [2, 1]);
    assert.strictEqual(children[0].currentIndex, 1);
    assert.strictEqual(children[1].currentIndex, 2);
    assert.strictEqual(session.splitEvents.length, 1);
    assert.strictEqual(session.splitEvents[0].parentLineId, "L0");
    assert.strictEqual(session.splitEvents[0].frame, "START.svg");
    assert.deepStrictEqual(children[0].splitAncestors, ["S1"]);
    assert.deepStrictEqual(children[1].splitAncestors, ["S1"]);

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

  "line numbers recycle: split → merge → split spends the same ids": () => {
    const session = fakeSession();
    const root = fakeLine(session, "L0");
    root.setCurrIdxTo(0);
    session.lines.push(root);
    const o = createOrchestrator(fakeTransport());

    const first = o.applySplit({
      session,
      parentLine: root,
      childFrameIndices: [1, 2],
      members: [],
    });
    assert.deepStrictEqual(
      first.children.map((line) => line.id),
      ["L0", "L1"],
    );

    // They rejoin. The absorbed line is unaddressable, so it goes entirely —
    // its number is back in the pool at once. The merge undo does not need the
    // object: it re-creates the line from the snapshot.
    const { survivor } = o.applyRecombine({
      session,
      lineIds: ["L0", "L1"],
      connections: [],
    });
    assert.strictEqual(survivor.id, "L0");
    assert.deepStrictEqual(
      session.lines.map((line) => line.id),
      ["L0"],
    );

    // …so the same fork reads the same way the second time round, instead of
    // climbing to L2/L3.
    survivor.setCurrIdxTo(0);
    const second = o.applySplit({
      session,
      parentLine: survivor,
      childFrameIndices: [1, 2],
      members: [],
    });
    assert.deepStrictEqual(
      second.children.map((line) => line.id),
      ["L0", "L1"],
    );
    // …and the rejoin is STILL undoable behind that fork: nothing expired, the
    // split is simply what comes off first when the operator reaches back.
    assert.strictEqual(session.mergeEvents[0].status, "active");
    assert.deepStrictEqual(
      structuralRewindChain({ session, kind: "merge", eventId: "M1" }).chain.map(
        (entry) => entry.event.id,
      ),
      ["S2"],
    );
  },

  "a blocked split event holds no number hostage": () => {
    const session = fakeSession();
    const root = fakeLine(session, "L0");
    root.setCurrIdxTo(0);
    session.lines.push(root);
    const o = createOrchestrator(fakeTransport());

    // L0 → {L0, L1}; then L1 → {L1, L2}.
    o.applySplit({
      session,
      parentLine: root,
      childFrameIndices: [1, 2],
      members: [],
    });
    const l1 = session.lines.find((line) => line.id === "L1");
    l1.setCurrIdxTo(3);
    o.applySplit({
      session,
      parentLine: l1,
      childFrameIndices: [3, 4],
      members: [],
    });

    // L1 merges back into L0, which is outside S2's subtree: S2 can never be
    // undone again, so the retired L1 it names as parent is not worth keeping.
    o.applyRecombine({ session, lineIds: ["L0", "L1"], connections: [] });
    assert.strictEqual(session.splitEvents[1].blockedByMerge, true);
    // The absorbed L1 is gone with the rejoin, and the blocked S2 keeps
    // nothing back on its own, so the number is free for the next fork.
    assert.deepStrictEqual(
      session.lines.map((line) => line.id).sort(),
      ["L0", "L2"],
    );
    assert.strictEqual(o.allocLineId(session), "L1");
  },

  // ── structural merge undo ────────────────────────────────────────────────

  "merge undo restores each absorbed line, its frame and its devices": () => {
    const session = fakeSession();
    const l0 = fakeLine(session, "L0");
    const l1 = fakeLine(session, "L1");
    l0.setCurrIdxTo(1); // Left.svg — where L0 stood before the rejoin
    l1.setCurrIdxTo(2); // Right.svg
    session.lines.push(l0, l1);
    session.deviceRegistry = { dA: "L0", dB: "L1", dOff: "L1" };
    const connections = [
      { sessionId: "s1", lineId: "L0", deviceId: "dA" },
      { sessionId: "s1", lineId: "L1", deviceId: "dB" },
    ];
    const o = createOrchestrator(fakeTransport());

    o.applyRecombine({
      session,
      lineIds: ["L0", "L1"],
      connections,
      frame: "Barrier.svg",
    });
    // The merged line moves on, and a device that never saw the split joins it.
    l0.setCurrIdxTo(3);
    const latecomer = { sessionId: "s1", lineId: "L0", deviceId: "dNew" };
    connections.push(latecomer);
    session.deviceRegistry.dNew = "L0";

    const result = rewindMergeStructure({
      session,
      eventId: "M1",
      expectedFrame: "Barrier.svg",
      connections,
      createLine: fakeLine,
      now: () => 999,
    });
    assert.strictEqual(result.available, true);

    // Both lines are back where the merge found them — L1 REBUILT from the
    // snapshot, since the rejoin dissolved the object it used to be.
    const back = (id) => session.lines.find((line) => line.id === id);
    assert.strictEqual(l0.currentIndex, 1);
    assert.deepStrictEqual(l0.history, ["Left.svg"]);
    assert.strictEqual(back("L1").currentIndex, 2);
    assert.strictEqual(back("L1").status, "active");
    // Same route as before, whatever number it came back on.
    assert.strictEqual(back("L1").uid, l1.uid);
    assert.deepStrictEqual(
      session.lines.map((line) => line.id),
      ["L0", "L1"],
    );
    // …each device on the line it was on then, and the latecomer — which has no
    // pre-merge line — left with the survivor.
    assert.deepStrictEqual(
      connections.map((conn) => conn.lineId),
      ["L0", "L1", "L0"],
    );
    assert.deepStrictEqual(session.deviceRegistry, {
      dA: "L0",
      dB: "L1",
      dOff: "L1",
      dNew: "L0",
    });
    assert.strictEqual(session.mergeEvents[0].status, "undone");
    assert.strictEqual(session.mergeEvents[0].undoneAt, 999);
  },

  "a co-presence merge sends each line back to the node it came from": () => {
    const session = fakeSession();
    const l0 = fakeLine(session, "L0");
    const l1 = fakeLine(session, "L1");
    // Both lines WALK ONTO the rejoin frame and merge there, so the merge
    // catches each of them standing on it — the barrier path instead catches
    // them parked on their own frames (the test above).
    l0.setCurrIdxTo(1); // Left.svg
    l0.setCurrIdxTo(3); // Barrier.svg
    l1.setCurrIdxTo(2); // Right.svg
    l1.setCurrIdxTo(3); // Barrier.svg
    session.lines.push(l0, l1);
    const o = createOrchestrator(fakeTransport());
    o.applyRecombine({
      session,
      lineIds: ["L0", "L1"],
      connections: [],
      frame: "Barrier.svg",
    });

    const result = rewindMergeStructure({
      session,
      eventId: "M1",
      connections: [],
      createLine: fakeLine,
    });
    assert.strictEqual(result.available, true);
    // Back to V and W, not to the Z they merged on.
    const restored = session.lines.find((line) => line.id === "L1");
    assert.strictEqual(l0.currentIndex, 1);
    assert.deepStrictEqual(l0.history, ["Left.svg"]);
    assert.strictEqual(l0.historyIndex, 0);
    assert.strictEqual(restored.currentIndex, 2);
    assert.deepStrictEqual(restored.history, ["Right.svg"]);
  },

  "a line that has only ever stood on the rejoin frame stays there": () => {
    // Nothing to step back to (a line seeded on the frame by a split, say):
    // the undo separates the lines and leaves them where the merge found them.
    assert.strictEqual(
      preMergeLanding({
        snapshot: { history: ["Barrier.svg"], historyIndex: 0 },
        mergeFrame: "Barrier.svg",
        frameIndexOf: () => 3,
      }),
      null,
    );
    // A line parked elsewhere is already home.
    assert.strictEqual(
      preMergeLanding({
        snapshot: { history: ["Left.svg"], historyIndex: 0 },
        mergeFrame: "Barrier.svg",
        frameIndexOf: () => 1,
      }),
      null,
    );
    // A frame the score no longer has is not a landing.
    assert.strictEqual(
      preMergeLanding({
        snapshot: {
          history: ["Gone.svg", "Barrier.svg"],
          historyIndex: 1,
        },
        mergeFrame: "Barrier.svg",
        frameIndexOf: () => -1,
      }),
      null,
    );
  },

  "a restored line nobody came back to is dormant, not retired": () => {
    const session = fakeSession();
    const l0 = fakeLine(session, "L0");
    const l1 = fakeLine(session, "L1");
    l0.setCurrIdxTo(1);
    l1.setCurrIdxTo(2);
    session.lines.push(l0, l1);
    const o = createOrchestrator(fakeTransport());
    o.applyRecombine({
      session,
      lineIds: ["L0", "L1"],
      connections: [],
      frame: "Barrier.svg",
    });

    const result = rewindMergeStructure({
      session,
      eventId: "M1",
      connections: [],
      createLine: fakeLine,
    });
    assert.strictEqual(result.available, true);
    assert.strictEqual(l0.status, "dormant");
    assert.strictEqual(
      session.lines.find((line) => line.id === "L1").status,
      "dormant",
    );
  },

  "a merge undo is refused once the merged line has moved on": () => {
    const session = fakeSession();
    const l0 = fakeLine(session, "L0");
    const l1 = fakeLine(session, "L1");
    l0.setCurrIdxTo(1);
    l1.setCurrIdxTo(2);
    session.lines.push(l0, l1);
    const o = createOrchestrator(fakeTransport());
    o.applyRecombine({
      session,
      lineIds: ["L0", "L1"],
      connections: [],
      frame: "Barrier.svg",
    });

    // A stale menu naming another frame is refused outright…
    assert.deepStrictEqual(
      mergeRewindPlan({
        mergeEvents: session.mergeEvents,
        lines: session.lines,
        eventId: "M1",
        expectedFrame: "DONE.svg",
      }).reason,
      "stale-frame",
    );

    // …splitting the merged line no longer ends anything: the single STEP is
    // refused while the fork stands on it, and the fork is what the cascade
    // takes off first.
    const split = o.applySplit({
      session,
      parentLine: l0,
      childFrameIndices: [1, 2],
      members: [],
    });
    assert.deepStrictEqual(
      split.children.map((line) => line.id),
      ["L0", "L1"],
    );
    assert.strictEqual(session.mergeEvents[0].status, "active");
    const stepPlan = mergeRewindPlan({
      mergeEvents: session.mergeEvents,
      splitEvents: session.splitEvents,
      lines: session.lines,
      eventId: "M1",
    });
    assert.strictEqual(stepPlan.available, false);
    assert.strictEqual(stepPlan.reason, "superseded");
    assert.strictEqual(stepPlan.supersederKind, "split");
    // The map offers it all the same, naming what comes off on the way.
    const options = mergeRewindOptions({
      mergeEvents: session.mergeEvents,
      splitEvents: session.splitEvents,
      lines: session.lines,
    });
    assert.strictEqual(options[0].available, true);
    assert.deepStrictEqual(options[0].cascade, [
      {
        kind: "split",
        eventId: "S1",
        frame: "Left.svg",
        lineIds: ["L0", "L1"],
      },
    ]);

    // A state file the loader cannot corroborate is the one thing that still
    // ends it. The RECORD survives regardless (nothing is compacted away), even
    // though the map stops drawing a passage it can no longer undo.
    expireMerges(session);
    const expired = mergeRewindPlan({
      mergeEvents: session.mergeEvents,
      splitEvents: session.splitEvents,
      lines: session.lines,
      eventId: "M1",
    });
    assert.strictEqual(expired.available, false);
    assert.strictEqual(expired.reason, "expired");
    assert.deepStrictEqual(session.mergeEvents[0].participants[1].history, [
      "Right.svg",
    ]);
    const afterRoomRewind = mergeRewindOptions({
      mergeEvents: session.mergeEvents,
      splitEvents: session.splitEvents,
      lines: session.lines,
    });
    assert.strictEqual(afterRoomRewind[0].available, false);
    assert.strictEqual(afterRoomRewind[0].reason, "expired");
    // An expired entry is a NOTE on a node — a frame and a reason — and
    // carries nothing else: the map reads only those two, and every consumer
    // of the heavier fields (the cascade, the line list, the trail index)
    // filters expired events out on both sides. These are the entries that
    // accumulate for the life of a session, so they ship as little as they
    // are read.
    assert.deepStrictEqual(Object.keys(afterRoomRewind[0]).sort(), [
      "available",
      "eventId",
      "frame",
      "reason",
      "survivorLineId",
    ]);
    // …while the record it expired is untouched, so nothing about the passage
    // is lost (the snapshot assertion above).
    assert.strictEqual(session.mergeEvents[0].participants.length, 2);
  },

  "chained merges undo newest-first, one step at a time": () => {
    const session = fakeSession();
    const l0 = fakeLine(session, "L0");
    const l1 = fakeLine(session, "L1");
    const l2 = fakeLine(session, "L2");
    l0.setCurrIdxTo(1);
    l1.setCurrIdxTo(2);
    l2.setCurrIdxTo(3);
    session.lines.push(l0, l1, l2);
    const o = createOrchestrator(fakeTransport());

    // Three lines converge on one frame: the runtime merges them in PAIRS, so
    // one convergence is two events.
    o.applyRecombine({
      session,
      lineIds: ["L0", "L1"],
      connections: [],
      frame: "DONE.svg",
    });
    o.applyRecombine({
      session,
      lineIds: ["L0", "L2"],
      connections: [],
      frame: "DONE.svg",
    });

    // The older one waits its turn rather than fighting the newer snapshot…
    assert.strictEqual(
      mergeRewindPlan({
        mergeEvents: session.mergeEvents,
        splitEvents: session.splitEvents,
        lines: session.lines,
        eventId: "M1",
      }).reason,
      "superseded",
    );
    assert.strictEqual(
      rewindMergeStructure({
        session,
        eventId: "M2",
        connections: [],
        createLine: fakeLine,
      }).available,
      true,
    );
    assert.strictEqual(
      session.lines.find((line) => line.id === "L2").currentIndex,
      3,
    );

    // …and becomes available the moment the newer one is undone, so the whole
    // convergence can be walked back.
    const older = rewindMergeStructure({
      session,
      eventId: "M1",
      connections: [],
      createLine: fakeLine,
    });
    assert.strictEqual(older.available, true);
    assert.strictEqual(
      session.lines.find((line) => line.id === "L1").currentIndex,
      2,
    );
    assert.strictEqual(l0.currentIndex, 1);
    // Rebuilt in the order they were walked back — newest undo first.
    assert.deepStrictEqual(
      session.lines.map((line) => line.id).sort(),
      ["L0", "L1", "L2"],
    );
  },

  "the merges a per-line rewind reaches back through, newest first": () => {
    const session = fakeSession();
    const l0 = fakeLine(session, "L0");
    const l1 = fakeLine(session, "L1");
    const l2 = fakeLine(session, "L2");
    l0.setCurrIdxTo(1); // Left.svg      — trail index 0
    l1.setCurrIdxTo(2);
    l2.setCurrIdxTo(2);
    session.lines.push(l0, l1, l2);
    const o = createOrchestrator(fakeTransport());
    o.applyRecombine({
      session,
      lineIds: ["L0", "L1"],
      connections: [],
      frame: "Barrier.svg",
    });
    l0.setCurrIdxTo(3); // Barrier.svg   — trail index 1
    o.applyRecombine({
      session,
      lineIds: ["L0", "L2"],
      connections: [],
      frame: "DONE.svg",
    });

    const ids = (atIndex) =>
      mergesBehindLine({
        mergeEvents: session.mergeEvents,
        lineId: "L0",
        atIndex,
      }).map((event) => event.id);

    // Rewinding to the line's first frame reaches back through both — newest
    // first, the only order the undo allows.
    assert.deepStrictEqual(ids(0), ["M2", "M1"]);
    // …to the frame it merged with L2 on, through that one only…
    assert.deepStrictEqual(ids(1), ["M2"]);
    // …and a rewind that lands after every merge disturbs none of them.
    assert.deepStrictEqual(ids(2), []);
    // An expired merge is never undone on the way: nothing describes the
    // population it would put back.
    expireMerges(session);
    assert.deepStrictEqual(ids(0), []);
  },

  // The boundary, on the side the rejoin does NOT reach back past.
  //
  // Two lines that meet on a frame merge where they stand: `runRejoin` finds
  // the survivor already there and moves nothing, so that trail entry is the
  // MERGED line's own position — every participant walked to it. Rewinding the
  // line back onto it therefore asks nothing of the rejoin, and the node ended
  // up offering both "⏪⏪ undo the merge at ⟨B-prime⟩" and "⏪⏪ rewind L0 here —
  // out of the merge at ⟨B-prime⟩", with no way to buy the second without the
  // first (owner).
  "a rewind to the frame a rejoin happened ON leaves the rejoin standing": () => {
    const session = fakeSession();
    const l0 = fakeLine(session, "L0");
    const l1 = fakeLine(session, "L1");
    l0.setCurrIdxTo(1); // Left.svg     — trail index 0
    l0.setCurrIdxTo(3); // Barrier.svg  — trail index 1, where the two meet
    l1.setCurrIdxTo(2);
    l1.setCurrIdxTo(3);
    session.lines.push(l0, l1);
    const o = createOrchestrator(fakeTransport());
    o.applyRecombine({
      session,
      lineIds: ["L0", "L1"],
      connections: [],
      frame: "Barrier.svg",
    });
    l0.setCurrIdxTo(4); // DONE.svg     — trail index 2, the merged line walks on

    const ids = (atIndex) =>
      mergesBehindLine({
        mergeEvents: session.mergeEvents,
        lineId: "L0",
        lineUid: l0.uid,
        atIndex,
      }).map((event) => event.id);

    // Back onto the rejoin frame: the merged line stood there, so it goes
    // there whole and the rejoin is untouched.
    assert.deepStrictEqual(ids(1), []);
    // One frame further back is a moment the two were still separate.
    assert.deepStrictEqual(ids(0), ["M1"]);

    // …and the map is told the same, in the one number it compares against.
    const [entry] = mergeRewindOptions({
      mergeEvents: session.mergeEvents,
      splitEvents: session.splitEvents,
      lines: session.lines,
    });
    assert.strictEqual(entry.survivorRewindFloor, 1);
  },

  // The other shape, unchanged: a hold-until barrier release snapshots the
  // survivor still PARKED on its own frame and advances it to the rejoin frame
  // afterwards, so that entry is strictly pre-merge. Standing the merged line
  // back on it would put the swallowed line's devices on a frame their route
  // never touched — which is the whole of §8.2.
  "a rewind to where a barrier release found the survivor still undoes it":
    () => {
      const session = fakeSession();
      const l0 = fakeLine(session, "L0");
      const l1 = fakeLine(session, "L1");
      l0.setCurrIdxTo(1); // Left.svg    — parked here, trail index 0
      l1.setCurrIdxTo(2);
      session.lines.push(l0, l1);
      const o = createOrchestrator(fakeTransport());
      o.applyRecombine({
        session,
        lineIds: ["L0", "L1"],
        connections: [],
        frame: "Barrier.svg",
      });
      l0.setCurrIdxTo(3); // the release then advances it — trail index 1

      const ids = (atIndex) =>
        mergesBehindLine({
          mergeEvents: session.mergeEvents,
          lineId: "L0",
          lineUid: l0.uid,
          atIndex,
        }).map((event) => event.id);

      assert.deepStrictEqual(ids(0), ["M1"]);
      assert.deepStrictEqual(ids(1), []);

      const [entry] = mergeRewindOptions({
        mergeEvents: session.mergeEvents,
        splitEvents: session.splitEvents,
        lines: session.lines,
      });
      // One PAST the recorded index, unlike the co-presence shape above.
      assert.strictEqual(entry.survivorRewindFloor, 1);
    },

  // The same question asked of the whole room. Rewinding every line to a
  // checkpoint BEHIND a rejoin used to leave the rejoin standing, so the room
  // arrived at a barrier it had once crossed with three lines and only two
  // were there (owner) — the room-scale version of the walk `lineRewind`
  // refuses to make.
  "a room rewind names the rejoins made since its checkpoint, newest first":
    () => {
      const session = fakeSession();
      const l0 = fakeLine(session, "L0");
      const l1 = fakeLine(session, "L1");
      const l2 = fakeLine(session, "L2");
      l0.setCurrIdxTo(1); // Left.svg    — the survivor's trail index 0
      l1.setCurrIdxTo(2); // Right.svg
      l2.setCurrIdxTo(2);
      session.lines.push(l0, l1, l2);
      const o = createOrchestrator(fakeTransport());
      // Two rejoins on the way out of the group: L1 at Barrier, L2 at DONE.
      o.applyRecombine({
        session,
        lineIds: ["L0", "L1"],
        connections: [],
        frame: "Barrier.svg",
      });
      l0.setCurrIdxTo(3); // Barrier.svg — trail index 1
      o.applyRecombine({
        session,
        lineIds: ["L0", "L2"],
        connections: [],
        frame: "DONE.svg",
      });
      l0.setCurrIdxTo(4); // DONE.svg    — trail index 2

      const groups = { LR: ["Left.svg", "Right.svg"], TAIL: ["DONE.svg"] };
      const lines = session.lines.filter((line) => line.status !== "retired");
      const behind = (group) =>
        mergesBehindRoomRewind({
          mergeEvents: session.mergeEvents,
          lines,
          plan: roomRewindPlan({
            group,
            groups,
            lines: lines.map((line) => ({
              id: line.id,
              trail: line.history.slice(0, line.historyIndex + 1),
            })),
          }),
        }).map((event) => event.id);

      // Back to the group the room crossed while all three were separate: both
      // rejoins come off, newest first — the only order the undo allows.
      assert.deepStrictEqual(behind("LR"), ["M2", "M1"]);
      // …and a checkpoint the room only reached after them disturbs neither.
      assert.deepStrictEqual(behind("TAIL"), []);
    },

  // A fill landing is a guess, and a rejoin is too expensive to take off on
  // one: the line never visited the group at all, so its own trail cannot say
  // which side of the checkpoint its merges fall on.
  "a line the room rewind places by fill keeps its own rejoins": () => {
    const session = fakeSession();
    const l0 = fakeLine(session, "L0");
    const l1 = fakeLine(session, "L1");
    const l2 = fakeLine(session, "L2");
    l0.setCurrIdxTo(1); // Left.svg    — the only line that passes the group
    l1.setCurrIdxTo(3); // Barrier.svg
    l2.setCurrIdxTo(3);
    session.lines.push(l0, l1, l2);
    const o = createOrchestrator(fakeTransport());
    o.applyRecombine({
      session,
      lineIds: ["L1", "L2"],
      connections: [],
      frame: "DONE.svg",
    });
    l1.setCurrIdxTo(4);

    const groups = { LR: ["Left.svg", "Right.svg"] };
    const lines = session.lines.filter((line) => line.status !== "retired");
    const plan = roomRewindPlan({
      group: "LR",
      groups,
      // Only L0 is populated, so only L0's trail decides the checkpoint —
      // which is exactly how the room rewind asks the question.
      checkpointLines: [{ id: "L0", trail: ["Left.svg"] }],
      lines: lines.map((line) => ({
        id: line.id,
        trail: line.history.slice(0, line.historyIndex + 1),
      })),
    });
    assert.strictEqual(
      plan.lines.find((entry) => entry.lineId === "L1").source,
      "fill",
    );
    assert.deepStrictEqual(
      mergesBehindRoomRewind({
        mergeEvents: session.mergeEvents,
        lines,
        plan,
      }),
      [],
    );
    // Left alone rather than ended: the map still offers its undo afterwards.
    assert.strictEqual(session.mergeEvents[0].status, "active");
  },

  // The number is not the identity, in EITHER direction. A merge undo
  // re-creates an absorbed line on the lowest free number when a fork has
  // taken its own (`freeLineId`), so a line can walk on under a number no
  // event of its own has ever named.
  "the merges behind a line follow its route, not its number": () => {
    const session = fakeSession();
    const l0 = fakeLine(session, "L0");
    const l1 = fakeLine(session, "L1");
    l0.setCurrIdxTo(1); // Left.svg     — the survivor's trail index 0
    l1.setCurrIdxTo(2);
    session.lines.push(l0, l1);
    const o = createOrchestrator(fakeTransport());
    o.applyRecombine({
      session,
      lineIds: ["L0", "L1"],
      connections: [],
      frame: "Barrier.svg",
    });
    const route = l0.uid;

    // The room moves on: this route is swallowed and later restored, coming
    // back on another number because a fork is holding "L0" now.
    l0.id = "L2";
    const impostor = fakeLine(session, "L0");
    impostor.setCurrIdxTo(1);
    session.lines.push(impostor);

    const ids = (line) =>
      mergesBehindLine({
        mergeEvents: session.mergeEvents,
        lineId: line.id,
        lineUid: line.uid,
        atIndex: 0,
      }).map((event) => event.id);

    // Rewinding the ROUTE still reaches back through its own merge — keying on
    // the number missed it, and the rewind then walked the line back past a
    // rejoin it never undid, standing L1's devices on a frame L1 never took.
    assert.deepStrictEqual(ids(l0), ["M1"]);
    // …and the fork that merely inherited the number is untouched by it.
    assert.deepStrictEqual(ids(impostor), []);
  },

  // A spectator follows the route it was watching, but it is not population —
  // so it cannot hold a restored line ACTIVE on its own (decision #12).
  // Counting one did: the line read active with zero players, so #11 never
  // released the waits on it and #13 never fast-forwarded it, and the next
  // real joiner landed on a frozen position instead of the front of the room.
  "a rider does not keep a restored line out of dormancy": () => {
    const session = fakeSession();
    const l0 = fakeLine(session, "L0");
    const l1 = fakeLine(session, "L1");
    l0.setCurrIdxTo(1);
    l1.setCurrIdxTo(2);
    session.lines.push(l0, l1);
    session.deviceRegistry = { dA: "L0", r1: "L1" };
    const connections = [
      { sessionId: "s1", lineId: "L0", deviceId: "dA", isStaff: true },
      // The only device on L1 is a spectator.
      { sessionId: "s1", lineId: "L1", deviceId: "r1", isStaff: false },
    ];
    const o = createOrchestrator(fakeTransport());
    o.applyRecombine({
      session,
      lineIds: ["L0", "L1"],
      connections,
      frame: "Barrier.svg",
    });

    const result = rewindMergeStructure({
      session,
      eventId: "M1",
      connections,
      now: () => 7,
    });
    assert.strictEqual(result.available, true);
    const restored = (id) => session.lines.find((line) => line.id === id);
    assert.strictEqual(restored("L0").status, "active");
    // The rider went back to the route it was following…
    assert.strictEqual(
      connections.find((conn) => conn.deviceId === "r1").lineId,
      "L1",
    );
    // …and the line it is watching is still dormant, because nobody plays it.
    assert.strictEqual(restored("L1").status, "dormant");
  },

  // Same rule, the split side: the object that carries the parent on is found
  // by route too, or a cascading undo commits its chain and then refuses the
  // step it was for — leaving the room half-walked back.
  "a split undo finds its parent by route when the number moved on": () => {
    const session = fakeSession();
    const root = fakeLine(session, "L0");
    root.setCurrIdxTo(0);
    session.lines.push(root);
    const o = createOrchestrator(fakeTransport());
    const { children } = o.applySplit({
      session,
      parentLine: root,
      childFrameIndices: [1, 2],
      members: [],
    });
    const carriesOn = children[0]; // kept the parent's number, per §6

    // The continuing branch is swallowed by a later rejoin and restored on a
    // different number; an unrelated fork now holds "L0".
    carriesOn.id = "L3";
    const impostor = fakeLine(session, "L0");
    session.lines.push(impostor);

    const plan = splitRewindPlan({
      splitEvents: session.splitEvents,
      lines: session.lines,
      eventId: session.splitEvents[0].id,
    });
    assert.strictEqual(plan.available, true);
    // The route, not the number — and emphatically not the impostor, whose
    // restore would have overwritten a line the operator is watching.
    assert.strictEqual(plan.parent, carriesOn);
    assert.notStrictEqual(plan.parent, impostor);
  },

  // …but the operator undoes the CONVERGENCE, not the pairing (owner, three
  // lines meeting on one frame is one thing they watched happen, so one click
  // puts all three back.
  "a convergence groups its pair-merges, newest first": () => {
    const session = fakeSession();
    const l0 = fakeLine(session, "L0");
    const l1 = fakeLine(session, "L1");
    const l2 = fakeLine(session, "L2");
    l0.setCurrIdxTo(1); // Left.svg
    l1.setCurrIdxTo(2); // Right.svg
    l2.setCurrIdxTo(2);
    session.lines.push(l0, l1, l2);
    const o = createOrchestrator(fakeTransport());

    // Co-presence: the lines walk ONTO DONE.svg, two together and one late.
    l0.setCurrIdxTo(4);
    l1.setCurrIdxTo(4);
    o.applyRecombine({
      session,
      lineIds: ["L0", "L1"],
      connections: [],
      frame: "DONE.svg",
    });
    l2.setCurrIdxTo(4);
    o.applyRecombine({
      session,
      lineIds: ["L0", "L2"],
      connections: [],
      frame: "DONE.svg",
    });

    const ids = (eventId) =>
      mergeConvergenceEvents({
        mergeEvents: session.mergeEvents,
        eventId,
      }).map((event) => event.id);
    // Either event names the whole passage, in the order it undoes.
    assert.deepStrictEqual(ids("M2"), ["M2", "M1"]);
    assert.deepStrictEqual(ids("M1"), ["M2", "M1"]);

    // The map shows ONE entry for it: the newest, naming every line that comes
    // back out — the older is folded into it rather than offered again.
    const options = mergeRewindOptions({
      mergeEvents: session.mergeEvents,
      splitEvents: session.splitEvents,
      lines: session.lines,
    });
    const newest = options.find((entry) => entry.eventId === "M2");
    assert.strictEqual(newest.available, true);
    assert.strictEqual(newest.partOfConvergence, undefined);
    assert.deepStrictEqual(newest.restoredLineIds, ["L0", "L1", "L2"]);
    assert.deepStrictEqual(newest.cascade, []);
    const older = options.find((entry) => entry.eventId === "M1");
    // Reachable in its own right now — but folded into the entry above, so the
    // menu still shows the passage once, and its own `cascade` is empty
    // because the events it would walk off ARE the rest of the passage.
    assert.strictEqual(older.available, true);
    assert.strictEqual(older.partOfConvergence, true);
    assert.deepStrictEqual(older.cascade, []);

    // A LATER pass over the same frame is its own convergence: the survivor
    // left and came back, so the trail between the two says so.
    l0.setCurrIdxTo(1);
    l0.setCurrIdxTo(4);
    const l3 = fakeLine(session, "L3");
    l3.setCurrIdxTo(4);
    session.lines.push(l3);
    o.applyRecombine({
      session,
      lineIds: ["L0", "L3"],
      connections: [],
      frame: "DONE.svg",
    });
    assert.deepStrictEqual(ids("M3"), ["M3"]);
    assert.deepStrictEqual(ids("M2"), ["M2", "M1"]);
  },

  // Numbers recycle, so "same survivor" has to mean the same ROUTE. Two
  // passages over one frame whose survivors happen to share a number — and
  // whose trails `stayedAtRejoin` cannot tell apart, both being the rejoin
  // frame and nothing else — used to read as ONE convergence. The walk then
  // committed the newer event and refused the older with
  // `survivor-unavailable`, leaving the room half-separated.
  "a convergence is grouped by the survivor's uid, not its number": () => {
    const session = fakeSession();
    const l0 = fakeLine(session, "L0");
    const l1 = fakeLine(session, "L1");
    l0.setCurrIdxTo(4); // DONE.svg — trail is the rejoin frame and nothing else
    l1.setCurrIdxTo(4);
    session.lines.push(l0, l1);
    const o = createOrchestrator(fakeTransport());
    o.applyRecombine({
      session,
      lineIds: ["L0", "L1"],
      connections: [],
      frame: "DONE.svg",
    });

    // The number comes back into circulation on a different route (a fork
    // mints a fresh uid for the line that carries on), and that one merges on
    // the same frame with the same one-entry trail.
    session.lines = session.lines.filter((line) => line.id !== "L0");
    const reborn = fakeLine(session, "L0");
    const l2 = fakeLine(session, "L2");
    reborn.setCurrIdxTo(4);
    l2.setCurrIdxTo(4);
    session.lines.push(reborn, l2);
    o.applyRecombine({
      session,
      lineIds: ["L0", "L2"],
      connections: [],
      frame: "DONE.svg",
    });

    const ids = (eventId) =>
      mergeConvergenceEvents({
        mergeEvents: session.mergeEvents,
        eventId,
      }).map((event) => event.id);
    assert.notStrictEqual(
      session.mergeEvents[0].participants[0].lineUid,
      session.mergeEvents[1].participants[0].lineUid,
    );
    assert.deepStrictEqual(ids("M2"), ["M2"]);
    assert.deepStrictEqual(ids("M1"), ["M1"]);
  },

  // Two rejoins on DIFFERENT frames are two convergences, and the older one is
  // `superseded` — which is what the map's ghost routes are gated on, so this
  // pins the two answers apart. The ghosts read the OPTION, which says "one
  // click still brings these lines back, walking the newer rejoin off on the
  // way"; reading the PLAN instead drew no route at all for the line the older
  // rejoin swallowed, while the newer rejoin's routes were greyed as usual —
  // an operator who had watched three lines converge saw two.
  "an older rejoin is superseded but still offered": () => {
    const session = fakeSession();
    const l0 = fakeLine(session, "L0");
    const l1 = fakeLine(session, "L1");
    const l2 = fakeLine(session, "L2");
    l0.setCurrIdxTo(1); // Left.svg
    l1.setCurrIdxTo(2); // Right.svg
    l2.setCurrIdxTo(2);
    session.lines.push(l0, l1, l2);
    const o = createOrchestrator(fakeTransport());

    // L1 rejoins L0 at Barrier.svg…
    l0.setCurrIdxTo(3);
    l1.setCurrIdxTo(3);
    o.applyRecombine({
      session,
      lineIds: ["L0", "L1"],
      connections: [],
      frame: "Barrier.svg",
    });
    // …and L2 catches them up a frame later, which is its own convergence.
    l0.setCurrIdxTo(4);
    l2.setCurrIdxTo(4);
    o.applyRecombine({
      session,
      lineIds: ["L0", "L2"],
      connections: [],
      frame: "DONE.svg",
    });
    assert.deepStrictEqual(
      mergeConvergenceEvents({
        mergeEvents: session.mergeEvents,
        eventId: "M1",
      }).map((event) => event.id),
      ["M1"],
    );

    // On its own the older rejoin cannot come off: the newer one stands on it.
    const plan = mergeRewindPlan({
      mergeEvents: session.mergeEvents,
      splitEvents: session.splitEvents,
      lines: session.lines,
      eventId: "M1",
    });
    assert.strictEqual(plan.available, false);
    assert.strictEqual(plan.reason, "superseded");

    // The map still offers it, because the undo takes the newer rejoin off
    // first — and names the line it gives back, whose route the ghosts draw.
    const options = mergeRewindOptions({
      mergeEvents: session.mergeEvents,
      splitEvents: session.splitEvents,
      lines: session.lines,
    });
    const older = options.find((entry) => entry.eventId === "M1");
    assert.strictEqual(older.available, true);
    assert.strictEqual(older.partOfConvergence, undefined);
    assert.deepStrictEqual(older.restoredLineIds, ["L0", "L1"]);
    assert.deepStrictEqual(
      older.cascade.map((step) => step.eventId),
      ["M2"],
    );
    const newer = options.find((entry) => entry.eventId === "M2");
    assert.strictEqual(newer.available, true);
    assert.deepStrictEqual(newer.restoredLineIds, ["L0", "L2"]);
  },

  "a barrier release and a late arrival on the same frame are one convergence":
    () => {
      const session = fakeSession();
      const l0 = fakeLine(session, "L0");
      const l1 = fakeLine(session, "L1");
      const l2 = fakeLine(session, "L2");
      // The two barrier lines are still PARKED on their own frames when they
      // merge, and the survivor steps onto the rejoin frame afterwards; the
      // straggler then walks onto it and merges there. The survivor's trail
      // therefore grows by exactly the rejoin frame between the two events,
      // which is what says the meeting never broke up.
      l0.setCurrIdxTo(1);
      l0.setCurrIdxTo(3); // Barrier.svg
      l1.setCurrIdxTo(2);
      l1.setCurrIdxTo(3);
      l2.setCurrIdxTo(2);
      session.lines.push(l0, l1, l2);
      const o = createOrchestrator(fakeTransport());

      o.applyRecombine({
        session,
        lineIds: ["L0", "L1"],
        connections: [],
        frame: "DONE.svg",
      });
      l0.setCurrIdxTo(4);
      l2.setCurrIdxTo(4);
      o.applyRecombine({
        session,
        lineIds: ["L0", "L2"],
        connections: [],
        frame: "DONE.svg",
      });

      assert.deepStrictEqual(
        mergeConvergenceEvents({
          mergeEvents: session.mergeEvents,
          eventId: "M2",
        }).map((event) => event.id),
        ["M2", "M1"],
      );
      // And undoing it whole, newest-first, puts every line back on the node it
      // came into the meeting from.
      assert.strictEqual(
        rewindMergeStructure({
          session,
          eventId: "M2",
          connections: [],
          createLine: fakeLine,
        }).available,
        true,
      );
      assert.strictEqual(
        rewindMergeStructure({
          session,
          eventId: "M1",
          connections: [],
          createLine: fakeLine,
        }).available,
        true,
      );
      const at = (id) => session.lines.find((line) => line.id === id).currentIndex;
      assert.strictEqual(l0.currentIndex, 3); // Barrier.svg
      assert.strictEqual(at("L1"), 3);
      assert.strictEqual(at("L2"), 2); // Right.svg — it stepped back
    },

  // ── the cascade: an old merge point is still a place to go back to ───────
  "a merge stays undoable behind a later fork and a later rejoin":
    () => {
      const session = fakeSession();
      const l0 = fakeLine(session, "L0");
      const l1 = fakeLine(session, "L1");
      l0.setCurrIdxTo(1); // Left.svg
      l1.setCurrIdxTo(2); // Right.svg
      session.lines.push(l0, l1);
      const o = createOrchestrator(fakeTransport());

      // The shape the owner hit on "-test- Merge rewind": MERGE1, then a fork,
      // then MERGE2. The fork used to END MERGE1's undo, so an hour into an
      // evening the only reachable merge point was the newest one.
      o.applyRecombine({
        session,
        lineIds: ["L0", "L1"],
        connections: [],
        frame: "Barrier.svg",
      });
      l0.setCurrIdxTo(3);
      const forked = o.applySplit({
        session,
        parentLine: l0,
        childFrameIndices: [1, 2],
        members: [],
      });
      assert.deepStrictEqual(
        forked.children.map((line) => line.id),
        ["L0", "L1"],
      );
      forked.children[0].setCurrIdxTo(4);
      forked.children[1].setCurrIdxTo(4);
      o.applyRecombine({
        session,
        lineIds: ["L0", "L1"],
        connections: [],
        frame: "DONE.svg",
      });

      // Reaching back for MERGE1 names both later events, newest first.
      const chain = structuralRewindChain({
        session,
        kind: "merge",
        eventId: "M1",
      });
      assert.strictEqual(chain.available, true);
      assert.deepStrictEqual(
        chain.chain.map((entry) => `${entry.kind}:${entry.event.id}`),
        ["merge:M2", "split:S1"],
      );

      // Walking them off in that order leaves MERGE1 an ordinary single step…
      assert.strictEqual(
        rewindMergeStructure({
          session,
          eventId: "M2",
          connections: [],
          createLine: fakeLine,
        }).available,
        true,
      );
      assert.strictEqual(
        rewindSplitStructure({ session, eventId: "S1", connections: [] })
          .available,
        true,
      );
      const undone = rewindMergeStructure({
        session,
        eventId: "M1",
        connections: [],
        createLine: fakeLine,
      });
      assert.strictEqual(undone.available, true);

      // …and the room stands where it did before the first rejoin: each line
      // on the node it came into it from, carrying its own route.
      const back = (id) => session.lines.find((line) => line.id === id);
      assert.strictEqual(back("L0").currentIndex, 1);
      assert.deepStrictEqual(back("L0").history, ["Left.svg"]);
      assert.strictEqual(back("L1").currentIndex, 2);
      assert.deepStrictEqual(back("L1").history, ["Right.svg"]);
      // The same ROUTE came back, not just the same number.
      assert.strictEqual(back("L1").uid, l1.uid);
      assert.strictEqual(back("L0").uid, l0.uid);
    },

  "a recycled number does not drag an unrelated branch into the cascade": () => {
    const session = fakeSession();
    const root = fakeLine(session, "L0");
    root.setCurrIdxTo(0);
    session.lines.push(root);
    const o = createOrchestrator(fakeTransport());

    // L0 → {L0, L1}; L1 → {L1, L2}; L1 and L2 then rejoin, freeing L2.
    o.applySplit({
      session,
      parentLine: root,
      childFrameIndices: [1, 2],
      members: [],
    });
    const l1 = session.lines.find((line) => line.id === "L1");
    l1.setCurrIdxTo(3);
    o.applySplit({
      session,
      parentLine: l1,
      childFrameIndices: [3, 4],
      members: [],
    });
    o.applyRecombine({
      session,
      lineIds: ["L1", "L2"],
      connections: [],
      frame: "Barrier.svg",
    });
    assert.strictEqual(o.allocLineId(session), "L2");

    // …and an UNRELATED fork of L0 is handed that number.
    const l0 = session.lines.find((line) => line.id === "L0");
    l0.setCurrIdxTo(1);
    o.applySplit({
      session,
      parentLine: l0,
      childFrameIndices: [1, 2],
      members: [],
    });
    assert.deepStrictEqual(session.splitEvents[2].childLineIds, ["L0", "L2"]);

    // The merge undo is untouched by it: the L2 walking the canvas now is a
    // different route from the L2 it swallowed, so the cascade leaves that
    // branch alone instead of collapsing a fork the operator is watching.
    const chain = structuralRewindChain({
      session,
      kind: "merge",
      eventId: "M1",
    });
    assert.strictEqual(chain.available, true);
    assert.deepStrictEqual(chain.chain, []);
  },

  "the devices that joined after a merge are spread across the lines coming back":
    () => {
      const session = fakeSession();
      const l0 = fakeLine(session, "L0");
      const l1 = fakeLine(session, "L1");
      l0.setCurrIdxTo(1);
      l1.setCurrIdxTo(2);
      session.lines.push(l0, l1);
      session.deviceRegistry = { dA: "L0", dB: "L1" };
      const connections = [
        { sessionId: "s1", lineId: "L0", deviceId: "dA", isStaff: true },
        { sessionId: "s1", lineId: "L1", deviceId: "dB", isStaff: true },
      ];
      const o = createOrchestrator(fakeTransport());
      o.applyRecombine({
        session,
        lineIds: ["L0", "L1"],
        connections,
        frame: "Barrier.svg",
      });

      // Four performers, a spectator and an offline device join the merged
      // line — none of them has a pre-merge line of its own.
      for (const id of ["d1", "d2", "d3", "d4"]) {
        connections.push({
          sessionId: "s1",
          lineId: "L0",
          deviceId: id,
          isStaff: true,
        });
        session.deviceRegistry[id] = "L0";
      }
      connections.push({
        sessionId: "s1",
        lineId: "L0",
        deviceId: "r1",
        isStaff: false,
      });
      session.deviceRegistry.r1 = "L0";
      session.deviceRegistry.dOff = "L0";

      assert.strictEqual(
        rewindMergeStructure({
          session,
          eventId: "M1",
          connections,
          createLine: fakeLine,
        }).available,
        true,
      );

      // Balanced, not dumped on the survivor (owner).
      const on = (id) =>
        connections.filter((conn) => conn.lineId === id && conn.isStaff).length;
      assert.strictEqual(on("L0"), 3); // dA + two of the four
      assert.strictEqual(on("L1"), 3); // dB + two of the four
      // Each moved device's registry entry follows its connection.
      for (const conn of connections) {
        if (conn.isStaff) {
          assert.strictEqual(session.deviceRegistry[conn.deviceId], conn.lineId);
        }
      }
      // A spectator is never population (decision #12), so it stays put…
      assert.strictEqual(
        connections.find((conn) => conn.deviceId === "r1").lineId,
        "L0",
      );
      // …and an offline latecomer is swept like an absent performer at a split.
      assert.ok(["L0", "L1"].includes(session.deviceRegistry.dOff));
    },

  // A convergence undoes in PAIRS, so balancing inside each event in turn
  // spent the latecomers before the last line was back: three over three lines
  // came out 2/1/3 (browser-verified) while the confirm promised them "spread
  // evenly" — the first step could only see two of the three destinations. The
  // runtime re-runs the spread over the whole passage.
  "a convergence's latecomers are balanced over the whole passage": () => {
    const session = fakeSession();
    const l0 = fakeLine(session, "L0");
    const l1 = fakeLine(session, "L1");
    const l2 = fakeLine(session, "L2");
    session.lines.push(l0, l1, l2);
    // Where a pair-by-pair walk leaves the room: the three snapshot devices are
    // home, but the latecomers went 1 / 0 / 2 because L1 was not back yet when
    // the first step spent two of them.
    session.deviceRegistry = {
      dA: "L0",
      dB: "L1",
      dC: "L2",
      x1: "L0",
      x2: "L2",
      x3: "L2",
    };
    const connections = Object.entries(session.deviceRegistry).map(
      ([deviceId, lineId]) => ({
        sessionId: "s1",
        lineId,
        deviceId,
        isStaff: true,
      }),
    );

    const { moved } = spreadMergeLatecomers({
      session,
      lines: [l0, l1, l2],
      knownDeviceIds: new Set(["dA", "dB", "dC"]),
      connections,
    });

    const on = (id) => connections.filter((conn) => conn.lineId === id).length;
    assert.strictEqual(on("L0"), 2);
    assert.strictEqual(on("L1"), 2);
    assert.strictEqual(on("L2"), 2);
    // The devices a snapshot named are never moved — they are home already.
    for (const deviceId of ["dA", "dB", "dC"]) {
      assert.ok(!moved.some((entry) => entry.conn.deviceId === deviceId));
    }
    // Registry follows the connection, offline sweep included.
    for (const conn of connections) {
      assert.strictEqual(session.deviceRegistry[conn.deviceId], conn.lineId);
    }
    // Everyone landed on something, so nothing is dormant.
    for (const line of [l0, l1, l2]) {
      assert.strictEqual(line.status, "active");
    }
  },

  // The spread re-assigns every latecomer from scratch, so its answer is one
  // CANONICAL arrangement rather than "whatever is already even" — which is
  // what makes running it again over a whole convergence safe. Asked twice, the
  // second pass must move nobody: for a merge that was a single event, where
  // `rewindMergeStructure` has already produced that arrangement, the runtime's
  // repeat is exactly this second pass.
  "the latecomer spread settles: a second pass moves nobody": () => {
    const session = fakeSession();
    const l0 = fakeLine(session, "L0");
    const l1 = fakeLine(session, "L1");
    session.lines.push(l0, l1);
    session.deviceRegistry = { dA: "L0", dB: "L1", x1: "L0", x2: "L0" };
    const connections = Object.entries(session.deviceRegistry).map(
      ([deviceId, lineId]) => ({
        sessionId: "s1",
        lineId,
        deviceId,
        isStaff: true,
      }),
    );
    const args = {
      session,
      lines: [l0, l1],
      knownDeviceIds: new Set(["dA", "dB"]),
      connections,
    };

    const first = spreadMergeLatecomers(args);
    assert.ok(first.moved.length > 0); // x2 had to come off L0
    const settled = connections.map((conn) => conn.lineId);

    const second = spreadMergeLatecomers(args);
    assert.deepStrictEqual(second.moved, []);
    assert.deepStrictEqual(
      connections.map((conn) => conn.lineId),
      settled,
    );
  },

  // A spectator is never population (decision #12): it is not spread, and it
  // cannot hold a line active on its own.
  "the latecomer spread leaves riders where they are, and never counts them":
    () => {
      const session = fakeSession();
      const l0 = fakeLine(session, "L0");
      const l1 = fakeLine(session, "L1");
      session.lines.push(l0, l1);
      session.deviceRegistry = { dA: "L0", r1: "L0", r2: "L0" };
      const connections = [
        { sessionId: "s1", lineId: "L0", deviceId: "dA", isStaff: true },
        { sessionId: "s1", lineId: "L0", deviceId: "r1", isStaff: false },
        { sessionId: "s1", lineId: "L0", deviceId: "r2", isStaff: false },
      ];

      spreadMergeLatecomers({
        session,
        lines: [l0, l1],
        knownDeviceIds: new Set(["dA", "r1", "r2"]),
        connections,
      });

      for (const conn of connections) {
        assert.strictEqual(conn.lineId, "L0");
      }
      assert.strictEqual(l0.status, "active");
      // Nobody came back to L1 — riders could not have made it active anyway.
      assert.strictEqual(l1.status, "dormant");
    },

  "undoing a merge re-opens the split undo it blocked": () => {
    const session = fakeSession();
    const root = fakeLine(session, "L0");
    root.setCurrIdxTo(0);
    session.lines.push(root);
    const o = createOrchestrator(fakeTransport());
    const top = o.applySplit({
      session,
      parentLine: root,
      childFrameIndices: [1, 2],
      members: [],
    });
    const nestedParent = top.children[0];
    nestedParent.setCurrIdxTo(3);
    o.applySplit({
      session,
      parentLine: nestedParent,
      childFrameIndices: [3, 4],
      members: [],
    });

    // L1 (outside S2) merges with L0 (inside it): S2 is blocked while the two
    // populations are one line.
    o.applyRecombine({
      session,
      lineIds: ["L0", "L1"],
      connections: [],
      frame: "Barrier.svg",
    });
    assert.strictEqual(session.splitEvents[1].blockedByMerge, true);

    assert.strictEqual(
      rewindMergeStructure({
        session,
        eventId: "M1",
        connections: [],
        createLine: fakeLine,
      }).available,
      true,
    );
    // They are separable again, so the split undo comes back with them.
    assert.strictEqual(session.splitEvents[1].blockedByMerge, false);
    assert.strictEqual(
      splitRewindPlan({
        splitEvents: session.splitEvents,
        lines: session.lines,
        eventId: "S2",
      }).available,
      true,
    );
  },

  // The map has learnt that a button which always refuses is worse than a note
  // saying why there is none, and the split side had one left:
  // `splitRewindPlan` answers about this ONE step and never sees the chain, so
  // a split whose own collapse is fine but which has an expired event standing
  // on it was published `available` and bought `blocked-by-expired` on the
  // click. After a room checkpoint rewind that was the only affordance left on
  // the fork, so the operator's last apparent route back was a dead one.
  "a split with an expired merge standing on it is not offered": () => {
    const session = fakeSession();
    const root = fakeLine(session, "L0");
    root.setCurrIdxTo(0);
    session.lines.push(root);
    const o = createOrchestrator(fakeTransport());
    o.applySplit({
      session,
      parentLine: root,
      childFrameIndices: [1, 2],
      members: [],
    });
    // The children come back together, so the split's own collapse is fine…
    o.applyRecombine({
      session,
      lineIds: ["L0", "L1"],
      connections: [],
      frame: "Barrier.svg",
    });
    const beforeExpiry = splitRewindOptions({
      splitEvents: session.splitEvents,
      mergeEvents: session.mergeEvents,
      lines: session.lines,
    }).find((entry) => entry.eventId === "S1");
    assert.strictEqual(beforeExpiry.available, true);

    // …until the merge in between is expired, which no walk can take off. The
    // step is still plan-available on its own, so the chain is the only thing
    // that knows, and the reason has to come from it.
    expireMerges(session);
    const afterExpiry = splitRewindOptions({
      splitEvents: session.splitEvents,
      mergeEvents: session.mergeEvents,
      lines: session.lines,
    }).find((entry) => entry.eventId === "S1");
    assert.strictEqual(afterExpiry.available, false);
    assert.strictEqual(afterExpiry.reason, "blocked-by-expired");
    assert.deepStrictEqual(afterExpiry.cascade, []);
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

  "split rewind recursively collapses nested descendants and preserves room progress": () => {
    const session = fakeSession();
    session.reachedTargets = { "left.svg": "done" };
    session.latestGroupArrival = { frame: "Left.svg", at: 123 };
    const parent = fakeLine(session, "L0");
    parent.setCurrIdxTo(0);
    session.lines.push(parent);

    const connections = [
      { sessionId: session.id, lineId: "L0", deviceId: "dA" },
      { sessionId: session.id, lineId: "L0", deviceId: "dB" },
    ];
    session.deviceRegistry = { dA: "L0", dB: "L0", dOff: "L0" };
    const o = createOrchestrator(fakeTransport());
    const first = o.applySplit({
      session,
      parentLine: parent,
      childFrameIndices: [1, 2],
      members: [
        { conn: connections[0], key: "dA", choice: 0 },
        { conn: connections[1], key: "dB", choice: 1 },
      ],
    });

    // L1 later splits again. Its descendants still carry S1, so undoing S1
    // must collapse L2 + both nested children, not merely the direct children.
    const nestedParent = first.children[0];
    nestedParent.setCurrIdxTo(3);
    const second = o.applySplit({
      session,
      parentLine: nestedParent,
      childFrameIndices: [3, 4],
      members: [{ conn: connections[0], key: "dA", choice: 0 }],
    });
    assert.deepStrictEqual(second.children[0].splitAncestors, ["S1", "S2"]);

    const before = splitRewindPlan({
      splitEvents: session.splitEvents,
      lines: session.lines,
      eventId: "S1",
      expectedFrame: "START.svg",
    });
    assert.strictEqual(before.available, true);
    assert.deepStrictEqual(
      before.liveDescendants.map((line) => line.id).sort(),
      [first.children[1].id, ...second.children.map((line) => line.id)].sort(),
    );

    const result = rewindSplitStructure({
      session,
      eventId: "S1",
      expectedFrame: "START.svg",
      connections,
      now: () => 999,
    });
    assert.strictEqual(result.available, true);
    assert.strictEqual(parent.status, "active");
    assert.strictEqual(parent.currentIndex, 0);
    assert.deepStrictEqual(parent.history, ["START.svg"]);
    // Every descendant BUT the continuing parent collapsed into it…
    assert.ok(
      result.descendants
        .filter((line) => line.id !== parent.id)
        .every((line) => line.status === "retired"),
    );
    // …and their numbers went back in the pool with them.
    assert.deepStrictEqual(
      session.lines.map((line) => line.id),
      ["L0"],
    );
    assert.ok(connections.every((conn) => conn.lineId === "L0"));
    assert.deepStrictEqual(session.deviceRegistry, {
      dA: "L0",
      dB: "L0",
      dOff: "L0",
    });
    assert.ok(session.splitEvents.every((event) => event.status === "undone"));
    assert.deepStrictEqual(session.reachedTargets, { "left.svg": "done" });
    assert.deepStrictEqual(session.latestGroupArrival, {
      frame: "Left.svg",
      at: 123,
    });
  },

  "cross-subtree merge blocks only the split boundary it crossed": () => {
    const session = fakeSession();
    const root = fakeLine(session, "L0");
    root.setCurrIdxTo(0);
    session.lines.push(root);
    const o = createOrchestrator(fakeTransport());
    const top = o.applySplit({
      session,
      parentLine: root,
      childFrameIndices: [1, 2],
      members: [],
    });
    const nestedParent = top.children[0];
    nestedParent.setCurrIdxTo(3);
    const nested = o.applySplit({
      session,
      parentLine: nestedParent,
      childFrameIndices: [3, 4],
      members: [],
    });

    // L3 belongs to nested S2; L2 is its outside sibling but both remain
    // inside top-level S1. Their merge blocks S2 and keeps S1 rewindable.
    o.applyRecombine({
      session,
      lineIds: [nested.children[0].id, top.children[1].id],
      connections: [],
    });
    assert.strictEqual(session.splitEvents[0].blockedByMerge, false);
    assert.strictEqual(session.splitEvents[1].blockedByMerge, true);
    assert.strictEqual(
      splitRewindPlan({
        splitEvents: session.splitEvents,
        lines: session.lines,
        eventId: "S1",
      }).available,
      true,
    );
    assert.deepStrictEqual(
      splitRewindPlan({
        splitEvents: session.splitEvents,
        lines: session.lines,
        eventId: "S2",
      }),
      {
        available: false,
        reason: "mixed-merge",
        event: session.splitEvents[1],
      },
    );
    // The single-step plan still refuses it — but the MENU offers it again,
    // because the split undo cascades: the crossing merge comes off first and
    // takes the block with it (§8.3). The projection has to be handed the
    // merge events to see that.
    const options = splitRewindOptions({
      splitEvents: session.splitEvents,
      mergeEvents: session.mergeEvents,
      lines: session.lines,
    });
    const blocked = options.find((entry) => entry.eventId === "S2");
    assert.strictEqual(blocked.available, true);
    assert.strictEqual(blocked.reason, null);
    assert.deepStrictEqual(
      blocked.cascade.map((step) => [step.kind, step.eventId]),
      [["merge", "M1"]],
    );
    // …and it describes the topology the collapse will actually act on: the
    // children the cascade puts back, not the one merged line standing there
    // now.
    assert.deepStrictEqual(
      blocked.descendantLineIds,
      session.splitEvents[1].childLineIds,
    );

    // Expire the merge and the block is final: its undo can never run, so the
    // mixing it did cannot be taken back.
    expireMerges(session);
    const afterExpiry = splitRewindOptions({
      splitEvents: session.splitEvents,
      mergeEvents: session.mergeEvents,
      lines: session.lines,
    });
    assert.strictEqual(
      afterExpiry.find((entry) => entry.eventId === "S2").available,
      false,
    );
    assert.strictEqual(
      afterExpiry.find((entry) => entry.eventId === "S2").reason,
      "mixed-merge",
    );
  },

  "a merge option names the survivor's uid, not just its number": () => {
    const session = fakeSession();
    const l0 = fakeLine(session, "L0");
    const l1 = fakeLine(session, "L1");
    l0.setCurrIdxTo(4);
    l1.setCurrIdxTo(4);
    session.lines.push(l0, l1);
    const o = createOrchestrator(fakeTransport());
    o.applyRecombine({
      session,
      lineIds: ["L0", "L1"],
      connections: [],
      frame: "DONE.svg",
    });

    const entry = mergeRewindOptions({
      mergeEvents: session.mergeEvents,
      splitEvents: session.splitEvents,
      lines: session.lines,
    })[0];
    assert.strictEqual(entry.survivorLineId, "L0");
    // The map compares this against the live line's own uid before warning
    // that a per-line rewind reaches back through this rejoin — a later fork
    // re-mints L0's identity, and the number alone cannot tell them apart.
    assert.strictEqual(entry.survivorLineUid, l0.uid);
    assert.ok(entry.survivorLineUid);
  },

  // A cascade repairs `superseded` (it takes the newer events off) and the
  // `survivor-unavailable` that comes back with them — but not an event with
  // nothing to separate, which is a property of the RECORD. Offering that on
  // the strength of a cascade would commit the whole walk and then refuse the
  // step it was for, leaving the room half-walked.
  "a merge with nothing to separate is never offered, cascade or not": () => {
    const mergeEvents = [
      {
        id: "M1",
        seq: 1,
        status: "active",
        frame: "DONE.svg",
        survivorLineId: "L0",
        // One participant: whatever else happened, this cannot come apart.
        participants: [
          {
            lineId: "L0",
            lineUid: "uA",
            history: ["A.svg", "DONE.svg"],
            historyIndex: 1,
            deviceIds: [],
          },
        ],
      },
      {
        id: "M2",
        seq: 2,
        status: "active",
        frame: "LATER.svg",
        survivorLineId: "L0",
        participants: [
          { lineId: "L0", lineUid: "uA", history: [], historyIndex: 0 },
          { lineId: "L1", lineUid: "uB", history: [], historyIndex: 0 },
        ],
      },
    ];
    const lines = [{ id: "L0", uid: "uA", status: "active" }];
    const options = mergeRewindOptions({
      mergeEvents,
      splitEvents: [],
      lines,
    });
    const first = options.find((o) => o.eventId === "M1");
    // M2 stands on it, so the plan alone says "superseded" and a cascade
    // exists — the separability test is what keeps the button off the menu.
    assert.strictEqual(first.available, false);
    assert.strictEqual(first.reason, "nothing-to-separate");
    // The event that CAN come apart is unaffected.
    assert.strictEqual(options.find((o) => o.eventId === "M2").available, true);
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
  "applySplit sweeps offline registry entries off the parent's own id": () => {
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

    assert.strictEqual(parent.status, "active");
    // The offline device is balanced like any straggler rather than kept on
    // the continuing branch…
    assert.notStrictEqual(session.deviceRegistry.dOff, "L0");
    // …and lands on the smallest child (both choosers went to child 0).
    assert.strictEqual(session.deviceRegistry.dOff, children[1].id);
  },

  // ── SM jump rewind semantics (S2 option (b) + R4) ─────
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

  // ── track-group ARRIVAL barrier ─────────────────────
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

  "groupArrivalState keeps waiting while a co-occupant is still holding": () => {
    // Both arrived on group frames, but L1 is still in its holding period — the
    // group waits for the last node's hold to release so they leave together.
    const lines = [
      { id: "L1", status: "active", isHolding: true },
      { id: "L2", status: "active", isHolding: false },
    ];
    const frames = { L1: "B.svg", L2: "C.svg" };
    const state = groupArrivalState(lines, ["B.svg", "C.svg"], {
      frameNameForLine: (l) => frames[l.id],
      deviceCount: () => 1,
      isHolding: (l) => !!l.isHolding,
      canReach: () => false,
    });
    assert.strictEqual(state.waiting, true);
    assert.deepStrictEqual(state.incomingIds, []);
    assert.deepStrictEqual(state.holdingIds, ["L1"]);
  },

  "groupArrivalState releases once every occupant's hold has ended": () => {
    const lines = [
      { id: "L1", status: "active", isHolding: false },
      { id: "L2", status: "active", isHolding: false },
    ];
    const frames = { L1: "B.svg", L2: "C.svg" };
    const state = groupArrivalState(lines, ["B.svg", "C.svg"], {
      frameNameForLine: (l) => frames[l.id],
      deviceCount: () => 1,
      isHolding: (l) => !!l.isHolding,
      canReach: () => false,
    });
    assert.strictEqual(state.waiting, false);
    assert.deepStrictEqual(state.holdingIds, []);
  },

  "groupArrivalState: a lone holding occupant never self-parks": () => {
    // Only one populated line is on the group (the other is empty and excluded).
    // Hold sync needs 2+ occupants, so a solo held frame must NOT raise a wait
    // (which would flash a spurious "waiting for other lines" banner).
    const lines = [
      { id: "L1", status: "active", isHolding: true }, // lone occupant, holding
      { id: "L2", status: "active" }, // empty — excluded
    ];
    const frames = { L1: "B.svg", L2: "C.svg" };
    const state = groupArrivalState(lines, ["B.svg", "C.svg"], {
      frameNameForLine: (l) => frames[l.id],
      deviceCount: (l) => (l.id === "L2" ? 0 : 1),
      isHolding: (l) => !!l.isHolding,
      canReach: () => false,
    });
    assert.strictEqual(state.waiting, false);
    assert.deepStrictEqual(state.holdingIds, []);
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

  "groupArrivalState: a line that already PASSED the group is never incoming": () => {
    // Targeted-rewind rule: L1 was rewound behind the group and replays onto
    // it; L2 is ahead but its trail already went through the group — even on a
    // loopy score where L2 could technically reach it again (canReach true),
    // it counts as arrived forever, so L1 proceeds alone.
    const lines = [
      { id: "L1", status: "active", trail: ["A.svg", "B.svg"] }, // occupant
      { id: "L2", status: "active", trail: ["C.svg", "X.svg"] }, // ahead, passed C
    ];
    const frames = { L1: "B.svg", L2: "X.svg" };
    const state = groupArrivalState(lines, ["B.svg", "C.svg"], {
      frameNameForLine: (l) => frames[l.id],
      deviceCount: () => 1,
      canReach: () => true, // loop back exists
      hasPassed: (l) =>
        l.trail.some((f) => ["b.svg", "c.svg"].includes(f.toLowerCase())),
    });
    assert.strictEqual(state.waiting, false);
    assert.deepStrictEqual(state.incomingIds, []);
  },

  "groupStragglerIds: the incoming lines the group is waiting on": () => {
    // L1 occupies a group frame; L2 and L3 are still travelling. Both are what
    // the room is waiting for, so both are told "your move".
    const lines = [
      { id: "L1", status: "active" },
      { id: "L2", status: "active" },
      { id: "L3", status: "active" },
    ];
    const frames = { L1: "B.svg", L2: "A.svg", L3: "A.svg" };
    const state = groupArrivalState(lines, ["B.svg", "C.svg"], {
      frameNameForLine: (l) => frames[l.id],
      deviceCount: () => 1,
      canReach: (l) => l.id !== "L1",
    });
    assert.deepStrictEqual(state.incomingIds, ["L2", "L3"]);
    assert.deepStrictEqual(
      groupStragglerIds(state, { lines, isParked: () => false }),
      ["L2", "L3"],
    );
  },

  "groupStragglerIds: a parked incoming line is NOT a straggler": () => {
    // L2 can still reach the group but is held at its own hold-until barrier,
    // and L3 is parked at ANOTHER group's arrival barrier. The group keeps
    // waiting on both (incomingIds is unchanged — dropping them would release
    // it early), but neither can act, so neither is prompted to move.
    const lines = [
      { id: "L1", status: "active" },
      { id: "L2", status: "active", isBarrierWaiting: true },
      { id: "L3", status: "active", isGroupWaiting: true },
      { id: "L4", status: "active" },
    ];
    const frames = { L1: "B.svg", L2: "A.svg", L3: "Z.svg", L4: "A.svg" };
    const state = groupArrivalState(lines, ["B.svg", "C.svg"], {
      frameNameForLine: (l) => frames[l.id],
      deviceCount: () => 1,
      canReach: (l) => l.id !== "L1",
    });
    assert.strictEqual(state.waiting, true);
    assert.deepStrictEqual(state.incomingIds, ["L2", "L3", "L4"]);
    assert.deepStrictEqual(
      groupStragglerIds(state, {
        lines,
        isParked: (l) => !!(l.isBarrierWaiting || l.isGroupWaiting),
      }),
      ["L4"],
    );
  },

  "groupStragglerIds: a blocked OCCUPANT is never a straggler": () => {
    // L1 has arrived but its own hold-until has not released. The group waits
    // (blockedIds), yet there is nobody to prompt: nothing is travelling.
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
    assert.deepStrictEqual(
      groupStragglerIds(state, {
        lines,
        isParked: (l) => !!l.isBarrierWaiting,
      }),
      [],
    );
  },

  "holdUntilStragglerTargets: who a hold-until is waiting on, and where they'd go": () => {
    // The barrier waits on Left.svg and Right.svg; Left is already done, so the
    // wait is entirely on Right. L2 can still get there, L3 cannot — only L2 is
    // what the barrier is held open FOR, and Right is where an advance sends it.
    const state = holdUntilReachabilityState(
      ["Left.svg", "Right.svg"],
      ["Left.svg"],
      [{ id: "L2" }, { id: "L3" }],
      (line) => line.id === "L2",
    );
    assert.deepStrictEqual(state.missingTargets, ["Right.svg"]);
    assert.deepStrictEqual(
      holdUntilStragglerTargets(state, {
        lines: [{ id: "L2" }, { id: "L3" }],
        canReachTarget: (line) => line.id === "L2",
      }),
      [{ lineId: "L2", target: "Right.svg" }],
    );
  },

  "holdUntilStragglerTargets: pairs each line with the FIRST target it can reach": () => {
    // Author order decides, so two lines owing different halves of the same
    // barrier are each sent where they can actually go.
    const reach = { L2: "Right.svg", L3: "Left.svg" };
    const canReachTarget = (line, target) => reach[line.id] === target;
    const lines = [{ id: "L2" }, { id: "L3" }];
    const state = holdUntilReachabilityState(
      ["Left.svg", "Right.svg"],
      [],
      lines,
      canReachTarget,
    );
    assert.deepStrictEqual(
      holdUntilStragglerTargets(state, { lines, canReachTarget }),
      [
        { lineId: "L2", target: "Right.svg" },
        { lineId: "L3", target: "Left.svg" },
      ],
    );
  },

  "holdUntilStragglerTargets: a sub-score target IS a landing when the score has a way in": () => {
    // "Tetra/Echo.svg" names a frame inside a sub-score. The advance drops the
    // line into that sub (bin/www subAdvanceLanding resolves the dive it would
    // have taken), so the ref is a destination like any other — and canLandOn
    // is asked per LINE, because the way in has to be one this line could take.
    const lines = [{ id: "L2" }];
    const asked = [];
    const state = holdUntilReachabilityState(
      ["Tetra/Echo.svg"],
      [],
      lines,
      () => true,
    );
    assert.deepStrictEqual(
      holdUntilStragglerTargets(state, {
        lines,
        canReachTarget: () => true,
        canLandOn: (target, line) => {
          asked.push([target, line.id]);
          return true;
        },
      }),
      [{ lineId: "L2", target: "Tetra/Echo.svg" }],
    );
    assert.deepStrictEqual(asked, [["Tetra/Echo.svg", "L2"]]);
  },

  "holdUntilStragglerTargets: a target with NO landing leaves the straggler listed": () => {
    // Same shape, but the score offers no usable way in (unknown sub, unknown
    // frame, or no dive whose return landing survives). The barrier really is
    // waiting on L2 — it must be listed, or the panel would claim the wait is
    // on nobody — but there is nowhere to send it, so it carries no destination
    // and the UI offers no button.
    const lines = [{ id: "L2" }];
    const state = holdUntilReachabilityState(
      ["Tetra/Echo.svg"],
      [],
      lines,
      () => true,
    );
    assert.deepStrictEqual(
      holdUntilStragglerTargets(state, {
        lines,
        canReachTarget: () => true,
        canLandOn: (target) => !String(target).includes("/"),
      }),
      [{ lineId: "L2", target: null }],
    );
  },

  "holdUntilStragglerTargets: a satisfied barrier is waiting on nobody": () => {
    const lines = [{ id: "L2" }];
    const state = holdUntilReachabilityState(
      ["Left.svg"],
      ["Left.svg"],
      lines,
      () => true,
    );
    assert.deepStrictEqual(
      holdUntilStragglerTargets(state, { lines, canReachTarget: () => true }),
      [],
    );
  },

  "revivalLandingFrame doubles as the forced-advance landing": () => {
    // "Force advance stragglers" reuses the revival rule with the group's
    // CURRENT position as the anchor: the straggler lands on the group's
    // least-occupied frame, so a forced arrival fills the empty track slot.
    const graph = {
      groups: { g: ["B.svg", "C.svg"] },
      byFrame: { "B.svg": { trackGroup: "g" }, "C.svg": { trackGroup: "g" } },
    };
    const straggler = { currentIndex: 0, subStack: [] }; // sitting on A.svg
    const got = revivalLandingFrame({
      graph,
      listFiles: ["A.svg", "B.svg", "C.svg"],
      latestGroupFrame: "B.svg", // anchor: where a parked line already sits
      line: straggler,
      occupancy: (name) => (name === "B.svg" ? 1 : 0),
    });
    assert.strictEqual(got, "C.svg");
  },

  "groupArrivalState: a rewound line (truncated trail) must re-arrive": () => {
    // The excusal is revoked by trail truncation: L2's rewind dropped its
    // group entry, so while it can still reach the group it IS incoming again
    // and the occupant L1 waits for it.
    const lines = [
      { id: "L1", status: "active", trail: ["A.svg", "B.svg"] },
      { id: "L2", status: "active", trail: ["A.svg"] }, // rewound behind
    ];
    const frames = { L1: "B.svg", L2: "A.svg" };
    const state = groupArrivalState(lines, ["B.svg", "C.svg"], {
      frameNameForLine: (l) => frames[l.id],
      deviceCount: () => 1,
      canReach: (l) => l.id === "L2",
      hasPassed: (l) =>
        l.trail.some((f) => ["b.svg", "c.svg"].includes(f.toLowerCase())),
    });
    assert.strictEqual(state.waiting, true);
    assert.deepStrictEqual(state.incomingIds, ["L2"]);
  },

  "groupArrivalState: hasPassed omitted keeps the pre-rewind behavior": () => {
    const lines = [
      { id: "L1", status: "active" },
      { id: "L2", status: "active" },
    ];
    const frames = { L1: "B.svg", L2: "X.svg" };
    const state = groupArrivalState(lines, ["B.svg", "C.svg"], {
      frameNameForLine: (l) => frames[l.id],
      deviceCount: () => 1,
      canReach: (l) => l.id === "L2",
    });
    assert.strictEqual(state.waiting, true);
    assert.deepStrictEqual(state.incomingIds, ["L2"]);
  },

  // ── One ordering across both event kinds ─────────────────────────────────
  //
  // `roomRewind` used to sort its own list of forks and rejoins with a second
  // comparator, which mapped a missing `seq` onto a scaled `createdAt` so that
  // every legacy event sorted below every stamped one. It agreed with this one
  // only through the arithmetic of the scaling factor; both read the same
  // function now, and these pin what that function promises.

  "compareStructural: seq decides when both events carry one": () => {
    const a = { kind: "split", event: { seq: 2, createdAt: 9000 } };
    const b = { kind: "merge", event: { seq: 5, createdAt: 1000 } };
    assert.ok(compareStructural(a, b) < 0, "lower seq is older");
    assert.ok(compareStructural(b, a) > 0);
  },

  "compareStructural: a record written before seq falls back to createdAt": () => {
    // The upgrade path: `migrateStructuralIdentities` stamps uids but never
    // backfills `seq`, so a room mid-session across the deploy holds both
    // shapes. The legacy event really is the older one, and must read that way
    // whichever of the two it is compared against.
    const legacy = { kind: "split", event: { createdAt: 1000 } };
    const stamped = { kind: "merge", event: { seq: 1, createdAt: 2000 } };
    assert.ok(compareStructural(legacy, stamped) < 0);
    assert.ok(compareStructural(stamped, legacy) > 0);
  },

  "compareStructural: two legacy records order by createdAt, then by `at`": () => {
    const older = { kind: "split", event: { createdAt: 1000 }, at: 3 };
    const newer = { kind: "merge", event: { createdAt: 2000 }, at: 0 };
    assert.ok(compareStructural(older, newer) < 0);
    const tieA = { kind: "split", event: { createdAt: 7 }, at: 0 };
    const tieB = { kind: "merge", event: { createdAt: 7 }, at: 1 };
    assert.ok(compareStructural(tieA, tieB) < 0, "`at` breaks an exact tie");
    // A caller that omits `at` leaves ties to its own stable sort.
    assert.strictEqual(
      compareStructural(
        { event: { createdAt: 7 } },
        { event: { createdAt: 7 } },
      ),
      0,
    );
  },

  // ── A stale `blockedByMerge` mark is not a liftable one ──────────────────
  //
  // `splitRewindPlan` refuses `mixed-merge` on the MARK itself, so a menu that
  // answered "the cascade will lift it" when no merge is left holding it would
  // publish a button that always refuses — the one shape this menu has learnt
  // not to have. `rewindMergeStructure` clears the mark as it takes the last
  // holder off, so the state is unreachable in the runtime and only a migrated
  // or hand-edited file can produce it; the two callers used to disagree about
  // it, and this pins the stricter answer they now share.

  "splitStepState: a blockedByMerge mark no merge still holds does not lift": () => {
    const splitEvents = [
      {
        id: "S1",
        seq: 1,
        status: "active",
        frame: "FORK.svg",
        parentLineId: "L0",
        parentLineUid: "u-parent",
        childLineIds: ["L0", "L1"],
        childLineUids: ["u-parent", "u-child"],
        parentCurrentIndex: 0,
        parentHistory: ["FORK.svg"],
        parentHistoryIndex: 0,
        blockedByMerge: true,
        blockedAt: 1,
      },
    ];
    // Every merge that ever named S1 has been undone, so nothing holds the
    // mark — and nothing in a walk can take it off either.
    const mergeEvents = [
      {
        id: "M1",
        seq: 2,
        status: "undone",
        frame: "MERGE.svg",
        survivorLineId: "L0",
        blockedSplitEventIds: ["S1"],
        participants: [
          { lineId: "L0", lineUid: "u-parent", history: ["FORK.svg"] },
          { lineId: "L1", lineUid: "u-child", history: ["FORK.svg"] },
        ],
      },
    ];
    const lines = [
      { id: "L0", uid: "u-parent", status: "active", splitAncestors: ["S1"] },
      { id: "L1", uid: "u-child", status: "active", splitAncestors: ["S1"] },
    ];
    const state = splitStepState({
      event: splitEvents[0],
      splitEvents,
      mergeEvents,
      lines,
    });
    assert.strictEqual(state.available, false);
    assert.strictEqual(state.reason, "mixed-merge");
  },
};
