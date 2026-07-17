/**
 * Chunk I — split runtime (real BMSession + BMLine, no ws boot).
 *
 * Builds the on-disk "Session Lines Demo" score offline, then drives the same
 * applySplit path bin/www uses (members derived from connection votes via the
 * gated frameLinks) against REAL BMLine objects. This is the headless stand-in
 * for the multi-tab split walkthrough: the START split frame divides L0 into two
 * child lines seeded at Left/Right, choosers land on their pick, the straggler
 * balances, and the parent is hard-retired.
 */

const assert = require("node:assert");

const { buildScore } = require("../bin/build-score.js");
const { BMLine } = require("../lib/session-lines/line");
const {
  createOrchestrator,
  parseVoteTargetIndex,
  groupOfFrame,
  resolveGroupStay,
  groupLinkWinner,
} = require("../lib/session-lines/orchestrator");
const { MESSAGES } = require("../constants");

module.exports = {
  "split: START divides L0 into Left/Right child lines, parent retired": async () => {
    const session = await buildScore("Session Lines Demo", {
      id: "__split_test__",
    });

    assert.ok(session.hasSessionLines, "demo must be flagged hasSessionLines");

    const idx = (name) =>
      session.listFilesInLowerCase.indexOf(name.toLowerCase());
    const leftIdx = idx("Left.svg");
    const rightIdx = idx("Right.svg");
    const startIdx = idx("START.svg");

    // frameLinks for the split frame resolve to [Left, Right] indices, in order.
    assert.deepStrictEqual(session.graph.frameLinks["START.svg"], [
      leftIdx,
      rightIdx,
    ]);

    // L0 starts on the split frame.
    const parent = session.lines[0];
    assert.strictEqual(parent.currentIndex, startIdx);

    const childFrameIndices = session.graph.frameLinks["START.svg"];

    // Three connections: chose Left, chose Right, straggler (no vote).
    const conns = [
      { sessionId: session.id, lineId: parent.id, deviceId: "dA", currentVoteTo: `${leftIdx}#START.svg#0` },
      { sessionId: session.id, lineId: parent.id, deviceId: "dB", currentVoteTo: `${rightIdx}#START.svg#1` },
      { sessionId: session.id, lineId: parent.id, deviceId: "dC", currentVoteTo: -1 },
    ];
    const members = conns.map((conn) => {
      const votedIdx = parseVoteTargetIndex(conn.currentVoteTo, -1);
      const slot = childFrameIndices.indexOf(votedIdx);
      return { conn, key: conn.deviceId, choice: slot >= 0 ? slot : null };
    });

    const sent = [];
    const orch = createOrchestrator({
      MESSAGES,
      now: () => 0,
      createLine: (s, id) => new BMLine(s, id),
      send: (s, lineId, time, payload) => sent.push({ lineId, ...payload }),
    });

    const { children, counts } = orch.applySplit({
      session,
      parentLine: parent,
      childFrameIndices,
      members,
    });

    // Two children, seeded on the chosen frames, with seeded history.
    assert.strictEqual(children.length, 2);
    assert.strictEqual(children[0].currentIndex, leftIdx);
    assert.strictEqual(children[1].currentIndex, rightIdx);
    assert.strictEqual(
      children[0].history[children[0].history.length - 1],
      "Left.svg",
    );
    assert.strictEqual(
      children[1].history[children[1].history.length - 1],
      "Right.svg",
    );

    // Choosers landed on their pick; straggler balanced (ties → child0).
    assert.strictEqual(conns[0].lineId, children[0].id);
    assert.strictEqual(conns[1].lineId, children[1].id);
    assert.deepStrictEqual(counts, [2, 1]);

    // deviceRegistry follows.
    assert.strictEqual(session.deviceRegistry["dA"], children[0].id);
    assert.strictEqual(session.deviceRegistry["dB"], children[1].id);
    assert.ok([children[0].id, children[1].id].includes(session.deviceRegistry["dC"]));

    // Parent hard-retired (structural), children active and in lines[].
    assert.strictEqual(parent.status, "retired");
    assert.ok(session.lines.includes(children[0]));
    assert.ok(session.lines.includes(children[1]));
    assert.strictEqual(children[0].status, "active");

    // Each child was told its new line (display is handled by the runtime).
    assert.ok(
      sent.some((s) => s.lineId === children[0].id && s.m === MESSAGES.MSG_LINE_ASSIGNED),
    );
    assert.ok(
      sent.some((s) => s.lineId === children[1].id && s.m === MESSAGES.MSG_BEGIN_SPLIT),
    );
  },

  // Decided 2026-07-17: a SPLIT frame inside a track group still divides its
  // line when the group's synchronized window closes — resolveGroupVoting
  // delegates it to the split path (balanced children) instead of moving the
  // whole line to one default link. This drives the same decision sequence on
  // the on-disk "-test- Session lines 2" score: G (1 voter → I) and H
  // (session-split="2" → J/K, 2 players, nobody voted).
  "grouped split: group close divides the no-vote split line balanced across J/K": async () => {
    const session = await buildScore("-test- Session lines 2", {
      id: "__group_split_test__",
    });
    assert.ok(session.hasSessionLines, "score must be flagged hasSessionLines");

    const idx = (name) =>
      session.listFilesInLowerCase.indexOf(name.toLowerCase());
    const jIdx = idx("J.svg");
    const kIdx = idx("K.svg");

    // H is BOTH track-grouped (GH) and a split frame with children [J, K].
    const group = groupOfFrame(session.graph, "H.svg");
    assert.strictEqual(String(group).toLowerCase(), "gh");
    assert.ok(session.graph.splits["H.svg"], "H must be a split frame");
    assert.deepStrictEqual(session.graph.frameLinks["H.svg"], [jIdx, kIdx]);

    // Group-close decision, as resolveGroupVoting computes it: G's lone voter
    // picked I; H's players never voted, and a split line's empty tally stays
    // empty (countVoteForLine's split guard — no synthesized default). The
    // global max is G's link vote → the group advances, no global stay.
    const gVote = `${idx("I.svg")}#G.svg#0`;
    const decision = resolveGroupStay(
      [
        { lineId: "L0", counts: { [gVote]: 1 } },
        { lineId: "L1", counts: {} },
      ],
      () => 0,
    );
    assert.strictEqual(decision.isStay, false);

    // ...and the split line has NO link winner to advance whole on — the group
    // resolution must hand it to the split path, never a whole-line default.
    assert.strictEqual(groupLinkWinner({}, () => 0), null);

    // The delegated split: H's line holds two connections, neither voted →
    // both are stragglers, balanced 1 to J and 1 to K; parent hard-retired.
    const parent = new BMLine(session, "L1");
    parent.status = "active";
    parent.setCurrIdxTo(idx("H.svg"));
    session.lines.push(parent);

    const childFrameIndices = session.graph.frameLinks["H.svg"];
    const conns = [
      { sessionId: session.id, lineId: parent.id, deviceId: "d1", currentVoteTo: -1 },
      { sessionId: session.id, lineId: parent.id, deviceId: "d2", currentVoteTo: -1 },
    ];
    const members = conns.map((conn) => {
      const votedIdx = parseVoteTargetIndex(conn.currentVoteTo, -1);
      const slot = childFrameIndices.indexOf(votedIdx);
      return { conn, key: conn.deviceId, choice: slot >= 0 ? slot : null };
    });

    const orch = createOrchestrator({
      MESSAGES,
      now: () => 0,
      createLine: (s, id) => new BMLine(s, id),
      send: () => {},
    });
    const { children, counts } = orch.applySplit({
      session,
      parentLine: parent,
      childFrameIndices,
      members,
    });

    assert.strictEqual(children.length, 2);
    assert.strictEqual(children[0].currentIndex, jIdx);
    assert.strictEqual(children[1].currentIndex, kIdx);
    assert.deepStrictEqual(counts, [1, 1]);
    assert.notStrictEqual(conns[0].lineId, conns[1].lineId);
    assert.strictEqual(parent.status, "retired");
  },
};
