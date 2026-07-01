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
};
