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
  splitRewindPlan,
  splitRewindOptions,
  rewindSplitStructure,
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

// A minimal stand-in for BMLine for transport-driven tests.
function fakeLine(session, id) {
  return {
    id,
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

  // ── revival fast-forward (decision #13 revision, 2026-07-18) ────────────
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
    assert.ok(result.descendants.every((line) => line.status === "retired"));
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
    const options = splitRewindOptions({
      splitEvents: session.splitEvents,
      lines: session.lines,
    });
    assert.strictEqual(
      options.find((entry) => entry.eventId === "S2").reason,
      "mixed-merge",
    );
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

  "groupArrivalState keeps waiting while a co-occupant is still holding (2026-07-20)": () => {
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

  "groupArrivalState releases once every occupant's hold has ended (2026-07-20)": () => {
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

  "groupArrivalState: a lone holding occupant never self-parks (2026-07-20)": () => {
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

  "groupArrivalState: a line that already PASSED the group is never incoming (2026-07-19)": () => {
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

  "groupStragglerIds: the incoming lines the group is waiting on (2026-08-16)": () => {
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

  "groupStragglerIds: a parked incoming line is NOT a straggler (2026-08-16)": () => {
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

  "groupStragglerIds: a blocked OCCUPANT is never a straggler (2026-08-16)": () => {
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

  "holdUntilStragglerTargets: who a hold-until is waiting on, and where they'd go (2026-08-28)": () => {
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

  "holdUntilStragglerTargets: pairs each line with the FIRST target it can reach (2026-08-28)": () => {
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

  "holdUntilStragglerTargets: a sub-score target IS a landing when the score has a way in (2026-08-30)": () => {
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

  "holdUntilStragglerTargets: a target with NO landing leaves the straggler listed (2026-08-28)": () => {
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

  "holdUntilStragglerTargets: a satisfied barrier is waiting on nobody (2026-08-28)": () => {
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

  "revivalLandingFrame doubles as the forced-advance landing (2026-08-16)": () => {
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

  "groupArrivalState: hasPassed omitted keeps the pre-2026-07-19 behavior": () => {
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
};
