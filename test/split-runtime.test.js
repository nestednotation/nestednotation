/**
 * Chunk I — split runtime (real BMSession + BMLine, no ws boot).
 *
 * Builds the test-only session-lines fixture, then drives the same
 * applySplit path bin/www uses (members derived from connection votes via the
 * gated frameLinks) against REAL BMLine objects. This is the headless stand-in
 * for the multi-tab split walkthrough: the START split frame divides L0 into two
 * child lines seeded at Left/Right, choosers land on their pick, the straggler
 * balances, and the parent is hard-retired.
 */

const assert = require("node:assert");
const fs = require("node:fs");

const { buildScore, SERVER_STATE_DIR } = require("../bin/build-score.js");
const { buildSessionLinesFixture } = require("./session-lines-fixture");
const { BMLine } = require("../lib/session-lines/line");
const {
  createOrchestrator,
  parseVoteTargetIndex,
  planSplitPartition,
  splitDestinationVoteIds,
  groupOfFrame,
  resolveGroupStay,
  groupLinkWinner,
  splitRewindOptions,
  rewindSplitStructure,
} = require("../lib/session-lines/orchestrator");
const { MESSAGES } = require("../constants");

// The members bin/www's splitPlanForLine builds from a line's connections.
const splitMembers = (conns, childFrameIndices) =>
  conns.map((conn) => {
    const votedIdx = parseVoteTargetIndex(conn.currentVoteTo, -1);
    const slot = childFrameIndices.indexOf(votedIdx);
    return { conn, key: conn.deviceId, choice: slot >= 0 ? slot : null };
  });

module.exports = {
  "split: START divides L0 into Left/Right child lines, parent retired": async () => {
    const session = await buildSessionLinesFixture({
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
    const members = splitMembers(conns, childFrameIndices);

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
    assert.strictEqual(session.splitEvents.length, 1);
    assert.strictEqual(session.splitEvents[0].frame, "START.svg");
    assert.deepStrictEqual(
      session.splitEvents[0].childLineIds,
      children.map((l) => l.id),
    );
    assert.deepStrictEqual(children[0].splitAncestors, [session.splitEvents[0].id]);
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

    // Branch 0 IS the parent line, carrying on under its own number; the
    // extra branch takes the lowest free one. Both active and in lines[].
    assert.strictEqual(children[0], parent);
    assert.strictEqual(children[0].id, "L0");
    assert.strictEqual(children[1].id, "L1");
    assert.strictEqual(parent.status, "active");
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

  // A split frame has no shared winning vote — the line divides — so every
  // device is shown its OWN destination instead. Two things must hold for that
  // marker to be usable: the id has to address a real link element in the page,
  // and the destination shown while the window is open has to be the one the
  // device actually gets when it closes.
  "split destinations: ids address the split frame's own link elements": async () => {
    const session = await buildSessionLinesFixture({
      id: "__split_dest_ids_test__",
    });
    const childFrameIndices = session.graph.frameLinks["START.svg"];

    // Three non-voters — the state a play-mode room is in for the whole window.
    const conns = ["dA", "dB", "dC"].map((deviceId) => ({
      sessionId: session.id,
      lineId: session.lines[0].id,
      deviceId,
      currentVoteTo: -1,
    }));
    const members = splitMembers(conns, childFrameIndices);
    const { assignment } = planSplitPartition(members, childFrameIndices.length);
    const destinations = splitDestinationVoteIds(
      "START.svg",
      childFrameIndices,
      assignment,
    );

    // Nobody is left without a destination, and they spread over both children.
    assert.strictEqual(destinations.length, 3);
    assert.ok(destinations.every((id) => id != null));
    assert.strictEqual(new Set(destinations).size, 2);

    // Every destination id is the id of an <a> on the split frame in the built
    // page — this is what the client's getElementById(voteId) resolves.
    const built = fs.readFileSync(
      `${SERVER_STATE_DIR}/${session.id}.content.svg`,
      "utf8",
    );
    for (const id of new Set(destinations)) {
      assert.ok(
        built.includes(`<a id="${id}"`),
        `destination ${id} has no link element on the split frame`,
      );
    }
  },

  "split destinations: the preview equals the assignment the split executes": async () => {
    const session = await buildSessionLinesFixture({
      id: "__split_dest_match_test__",
    });
    const idx = (name) =>
      session.listFilesInLowerCase.indexOf(name.toLowerCase());
    const childFrameIndices = session.graph.frameLinks["START.svg"];
    const parent = session.lines[0];

    // Mid-window state: one guide-mode device has tapped Right, the rest have
    // not chosen. This is the tally the last preview tick would be built from.
    const conns = [
      { sessionId: session.id, lineId: parent.id, deviceId: "dA", currentVoteTo: -1 },
      { sessionId: session.id, lineId: parent.id, deviceId: "dB", currentVoteTo: `${idx("Right.svg")}#START.svg#1` },
      { sessionId: session.id, lineId: parent.id, deviceId: "dC", currentVoteTo: -1 },
      { sessionId: session.id, lineId: parent.id, deviceId: "dD", currentVoteTo: -1 },
    ];
    const members = splitMembers(conns, childFrameIndices);
    const preview = splitDestinationVoteIds(
      "START.svg",
      childFrameIndices,
      planSplitPartition(members, childFrameIndices.length).assignment,
    );

    // The window closes on that same state: the split runs and the devices land.
    const orch = createOrchestrator({
      MESSAGES,
      now: () => 0,
      createLine: (s, id) => new BMLine(s, id),
      send: () => {},
    });
    const { children, assignment } = orch.applySplit({
      session,
      parentLine: parent,
      childFrameIndices,
      members,
    });
    const settled = splitDestinationVoteIds(
      "START.svg",
      childFrameIndices,
      assignment,
    );

    // What each device was shown is what each device got.
    assert.deepStrictEqual(preview, settled);

    // …and the destination really names the child line's frame: the id's target
    // index is the frame the device's new line now sits on.
    conns.forEach((conn, i) => {
      const child = children.find((l) => l.id === conn.lineId);
      assert.strictEqual(
        Number(preview[i].split("#")[0]),
        child.currentIndex,
        `${conn.deviceId} was shown a destination it did not land on`,
      );
    });

    // The tapper landed on its own choice — from that point its destination is
    // just its vote, which is why the client hands the marker back to the
    // ordinary current-vote feedback in guide mode.
    assert.strictEqual(preview[1], conns[1].currentVoteTo);
  },

  "Session lines 2: F/H structurally rewind through split back to A": async () => {
    const session = await buildScore("-test- Session lines 2", {
      id: "__split_rewind_a_test__",
    });
    const idx = (name) =>
      session.listFilesInLowerCase.indexOf(name.toLowerCase());
    const parent = session.lines[0];
    parent.setCurrIdxTo(idx("A.svg"));
    const conns = [
      { sessionId: session.id, lineId: parent.id, deviceId: "d1" },
      { sessionId: session.id, lineId: parent.id, deviceId: "d2" },
    ];
    session.deviceRegistry = { d1: parent.id, d2: parent.id };
    const orch = createOrchestrator({
      MESSAGES,
      now: () => 10,
      createLine: (s, id) => new BMLine(s, id),
      send: () => {},
    });
    const { children } = orch.applySplit({
      session,
      parentLine: parent,
      childFrameIndices: [idx("B.svg"), idx("C.svg")],
      members: [
        { conn: conns[0], key: "d1", choice: 0 },
        { conn: conns[1], key: "d2", choice: 1 },
      ],
    });
    children[0].setCurrIdxTo(idx("D.svg"));
    children[0].setCurrIdxTo(idx("F.svg"));
    children[1].setCurrIdxTo(idx("E.svg"));
    children[1].setCurrIdxTo(idx("H.svg"));

    const option = splitRewindOptions({
      splitEvents: session.splitEvents,
      lines: session.lines,
    }).find((entry) => entry.frame === "A.svg");
    assert.strictEqual(option.available, true);
    assert.deepStrictEqual(
      option.descendantLineIds.sort(),
      children.map((l) => l.id).sort(),
    );

    const result = rewindSplitStructure({
      session,
      eventId: option.eventId,
      expectedFrame: "A.svg",
      connections: conns,
      now: () => 20,
    });
    assert.strictEqual(result.available, true);
    assert.strictEqual(parent.status, "active");
    assert.strictEqual(parent.currentIndex, idx("A.svg"));
    assert.deepStrictEqual(parent.history, ["START.svg", "A.svg"]);
    assert.ok(conns.every((conn) => conn.lineId === parent.id));
    assert.deepStrictEqual(session.deviceRegistry, {
      d1: parent.id,
      d2: parent.id,
    });
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
    assert.strictEqual(children[0], parent);
    assert.strictEqual(parent.status, "active");
  },
};
