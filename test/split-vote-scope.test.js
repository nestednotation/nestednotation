/**
 * M6 — a split must not erase votes on unrelated lines.
 *
 * Voting windows on independent lines overlap routinely: `resolveSplit` used to
 * finish by clearing `currentVoteTo` on EVERY connection in the session, so a
 * split on L0 wiped the choices of everyone voting on L2 mid-window. The cached
 * tally hid it for a tick, then a later vote recalculated from the cleared
 * connections and another split's partition read them directly — performers
 * received destinations they had not chosen.
 *
 * Driven through the real pieces bin/www uses: the production connection filter
 * (`lineConnections`), the real `applySplit`, and real `BMLine` objects on the
 * real fixture score. The ORDER matters as much as the scope — the population
 * has to be captured before `applySplit` rebinds it to the children, which is
 * the last moment `line.id` still names the set that voted.
 */

const assert = require("node:assert");

const { buildSessionLinesFixture } = require("./session-lines-fixture");
const { BMLine } = require("../lib/session-lines/line");
const {
  createOrchestrator,
  parseVoteTargetIndex,
} = require("../lib/session-lines/orchestrator");
const { lineConnections } = require("../lib/session-lines/routing");
const { MESSAGES } = require("../constants");

const splitMembers = (conns, childFrameIndices) =>
  conns.map((conn) => {
    const votedIdx = parseVoteTargetIndex(conn.currentVoteTo, -1);
    const slot = childFrameIndices.indexOf(votedIdx);
    return { conn, key: conn.deviceId, choice: slot >= 0 ? slot : null };
  });

// bin/www's `countVoteForLine`, reduced to what this asserts: the tally is
// computed from the live connections' `currentVoteTo`, so a cleared vote really
// does change the answer.
const tally = (conns, sessionId, lineId) => {
  const counts = {};
  for (const conn of lineConnections(conns, sessionId, lineId)) {
    if (conn.currentVoteTo === -1 || conn.currentVoteTo == null) continue;
    counts[conn.currentVoteTo] = (counts[conn.currentVoteTo] || 0) + 1;
  }
  return counts;
};

module.exports = {
  "resolving one split leaves an unrelated line's votes standing": async () => {
    const session = await buildSessionLinesFixture({ id: "__split_scope__" });
    const idx = (n) => session.listFilesInLowerCase.indexOf(n.toLowerCase());

    // L0 stands on the split frame; L2 is an independent line with a choice
    // window of its own open on Left.svg.
    const splitting = session.lines[0];
    const unrelated = new BMLine(session, "L2");
    unrelated.setCurrIdxTo(idx("Left.svg"));
    session.lines.push(unrelated);

    const childFrameIndices = session.graph.frameLinks["START.svg"];
    const leftVote = `${idx("Left.svg")}#START.svg#0`;
    const rightVote = `${idx("Right.svg")}#START.svg#1`;
    const unrelatedVote = `${idx("Barrier.svg")}#Left.svg#0`;

    const onSplit = [
      { sessionId: session.id, lineId: "L0", deviceId: "dA", currentVoteTo: leftVote },
      { sessionId: session.id, lineId: "L0", deviceId: "dB", currentVoteTo: rightVote },
    ];
    const elsewhere = [
      { sessionId: session.id, lineId: "L2", deviceId: "dC", currentVoteTo: unrelatedVote },
      { sessionId: session.id, lineId: "L2", deviceId: "dD", currentVoteTo: unrelatedVote },
    ];
    // Another room, on a line with the same number, voting too.
    const otherRoom = {
      sessionId: "another-room",
      lineId: "L0",
      deviceId: "dX",
      currentVoteTo: leftVote,
    };
    const conns = [...onSplit, ...elsewhere, otherRoom];

    const before = tally(conns, session.id, "L2");
    assert.deepStrictEqual(before, { [unrelatedVote]: 2 });

    // ── resolveSplit's sequence ────────────────────────────────────────────
    // 1. capture the population whose window just closed, while `L0` still
    //    names it;
    const votingPopulation = lineConnections(conns, session.id, splitting.id);
    assert.strictEqual(votingPopulation.length, 2);

    // 2. divide the line for real;
    const sent = [];
    const orch = createOrchestrator({
      MESSAGES,
      now: () => 0,
      createLine: (s, id) => new BMLine(s, id),
      send: (s, lineId, time, payload) => sent.push({ lineId, ...payload }),
      sendAdmins: () => {},
    });
    const { children } = orch.applySplit({
      session,
      parentLine: splitting,
      childFrameIndices,
      members: splitMembers(onSplit, childFrameIndices),
    });
    assert.strictEqual(children.length, 2);
    // The split really did rebind its own members…
    assert.notStrictEqual(onSplit[0].lineId, onSplit[1].lineId);

    // 3. and only that captured set has its votes reset.
    for (const conn of votingPopulation) conn.currentVoteTo = -1;

    // ── the assertion the defect fails ────────────────────────────────────
    assert.deepStrictEqual(
      tally(conns, session.id, "L2"),
      before,
      "an unrelated line lost its votes to another line's split",
    );
    for (const conn of elsewhere) {
      assert.strictEqual(conn.currentVoteTo, unrelatedVote);
      assert.strictEqual(conn.lineId, "L2");
    }
    // …and another room's overlapping window is untouched too.
    assert.strictEqual(otherRoom.currentVoteTo, leftVote);
    assert.strictEqual(otherRoom.lineId, "L0");
    // The split's own members were cleared, which is the point of the reset.
    for (const conn of onSplit) assert.strictEqual(conn.currentVoteTo, -1);
  },

  // The second half of M6: a partition reads `currentVoteTo` DIRECTLY, so a
  // cleared vote does not merely vanish from a tally — it re-routes a performer.
  "a later split on the unrelated line still honours its choices": async () => {
    const session = await buildSessionLinesFixture({ id: "__split_scope2__" });
    const idx = (n) => session.listFilesInLowerCase.indexOf(n.toLowerCase());
    const childFrameIndices = session.graph.frameLinks["START.svg"];
    const leftIdx = idx("Left.svg");
    const rightIdx = idx("Right.svg");

    // Two lines on the same split frame, each with its own window: the second
    // is what a first resolution must not touch.
    const first = session.lines[0];
    const second = new BMLine(session, "L1");
    second.setCurrIdxTo(idx("START.svg"));
    session.lines.push(second);

    const secondConns = [
      {
        sessionId: session.id,
        lineId: "L1",
        deviceId: "dC",
        currentVoteTo: `${rightIdx}#START.svg#1`,
      },
      {
        sessionId: session.id,
        lineId: "L1",
        deviceId: "dD",
        currentVoteTo: `${rightIdx}#START.svg#1`,
      },
    ];
    const firstConns = [
      {
        sessionId: session.id,
        lineId: "L0",
        deviceId: "dA",
        currentVoteTo: `${leftIdx}#START.svg#0`,
      },
    ];
    const conns = [...firstConns, ...secondConns];

    const orch = createOrchestrator({
      MESSAGES,
      now: () => 0,
      createLine: (s, id) => new BMLine(s, id),
      send: () => {},
      sendAdmins: () => {},
    });

    const captured = lineConnections(conns, session.id, first.id);
    orch.applySplit({
      session,
      parentLine: first,
      childFrameIndices,
      members: splitMembers(firstConns, childFrameIndices),
    });
    for (const conn of captured) conn.currentVoteTo = -1;

    // Now the second line's window closes. Both of its devices chose Right, so
    // both must land on Right — with the votes cleared they would have been
    // balanced across the two branches instead.
    const secondMembers = splitMembers(secondConns, childFrameIndices);
    assert.deepStrictEqual(
      secondMembers.map((m) => m.choice),
      [1, 1],
      "the unrelated line's devices lost their recorded choice",
    );
    const { children, assignment } = orch.applySplit({
      session,
      parentLine: second,
      childFrameIndices,
      members: secondMembers,
    });
    assert.deepStrictEqual(assignment, [1, 1]);
    assert.strictEqual(children[1].currentIndex, rightIdx);
    for (const conn of secondConns) {
      assert.strictEqual(conn.lineId, children[1].id);
    }
  },
};
