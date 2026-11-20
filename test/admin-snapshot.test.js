/**
 * The operator snapshot rules, without a server (lib/session-lines/admin-snapshot.js).
 * The same payloads through the production handlers: map-snapshot.test.js.
 */

const assert = require("node:assert");

const { buildAdminSnapshots } = require("../lib/session-lines/admin-snapshot");

const room = {
  messageType: "COUNT",
  structuralProjection: () => ({ version: "v1", mergeRewinds: [] }),
  roomCheckpointOptions: () => ["g1"],
  structuralEventSummaries: () => [{ kind: "split", eventId: "S1", available: true }],
  mergeLatecomerCount: () => ({ total: 0, live: 0 }),
  mainHistoryStateForLine: (line) => ({ history: line.history, historyIndex: line.historyIndex }),
  frameNameForLine: (_session, line) => line.history[line.historyIndex],
  mainFlowFrameForLine: () => null,
  subOriginFrameForLine: () => null,
  lineIdNum: (id) => Number(String(id).slice(1)),
};

const line = (id, history, extra = {}) => ({
  id,
  uid: `u-${id}`,
  status: "active",
  subStack: [],
  history,
  historyIndex: history.length - 1,
  ...extra,
});

function room2() {
  const session = {
    id: "S",
    hasSessionLines: true,
    rewindLog: [{ kind: "line", frame: "A.svg", at: 1 }],
    lines: [line("L1", ["START.svg", "B.svg"]), line("L0", ["START.svg", "A.svg"]), line("L2", ["X.svg"], { status: "retired" })],
  };
  const conns = [
    { sessionId: "S", lineId: "L0", isStaff: true, lastSeen: 5 },
    { sessionId: "S", lineId: "L0", isStaff: false },
    { sessionId: "S", lineId: "L1", isStaff: true, isAdmin: true, lastSeen: 9 },
    { sessionId: "S", lineId: "L1", isStaff: true, isAdmin: true, isMapView: true },
    { sessionId: "other", lineId: "L0", isStaff: true, isAdmin: true, isMapView: true },
  ];
  return { session, conns };
}

module.exports = {
  "counts exclude map tabs and other rooms; lines are sorted by number": () => {
    const { session, conns } = room2();
    const sends = buildAdminSnapshots(session, conns, room);
    const [ordinary, map] = sends;
    assert.deepStrictEqual(ordinary.connections, [conns[2]]);
    assert.deepStrictEqual(map.connections, [conns[3]]);
    for (const { payload } of sends) {
      assert.strictEqual(payload.m, "COUNT");
      assert.strictEqual(payload.playerCount, 2);
      assert.strictEqual(payload.riderCount, 1);
      assert.deepStrictEqual(payload.lines.map((l) => l.id), ["L0", "L1"], "retired lines and order");
    }
    const l0 = map.payload.lines[0];
    assert.strictEqual(l0.players, 1);
    assert.strictEqual(l0.riders, 1);
    assert.strictEqual(l0.quietSince, 5, "a rider is never the quiet one");
  },

  "only map tabs get trails, checkpoints, summaries and the log": () => {
    const { session, conns } = room2();
    const [ordinary, map] = buildAdminSnapshots(session, conns, room);
    assert.strictEqual(ordinary.payload.rewindLog, undefined);
    assert.strictEqual(ordinary.payload.structuralEvents, undefined);
    for (const l of ordinary.payload.lines) {
      assert.deepStrictEqual(Object.keys(l).filter((k) => /trail|uid|checkpoint/i.test(k)), []);
    }
    assert.deepStrictEqual(map.payload.rewindLog, session.rewindLog);
    assert.deepStrictEqual(map.payload.roomCheckpoints, ["g1"]);
    assert.strictEqual(map.payload.structuralVersion, "v1");
    assert.deepStrictEqual(map.payload.lines[0].trail, ["START.svg", "A.svg"]);
  },

  "a map tab's second push keeps unchanged trails and resends changed ones": () => {
    const { session, conns } = room2();
    buildAdminSnapshots(session, conns, room);
    session.lines[0].history.push("C.svg");
    session.lines[0].historyIndex += 1;
    const [, map] = buildAdminSnapshots(session, conns, room);
    const [l0, l1] = map.payload.lines;
    assert.strictEqual(l0.trailKept, true);
    assert.strictEqual(l0.trail, undefined);
    assert.deepStrictEqual(l1.trail, ["START.svg", "B.svg", "C.svg"]);
    assert.strictEqual(l1.trailKept, undefined);
  },

  "a vanilla room sends counts only": () => {
    const { session, conns } = room2();
    session.hasSessionLines = false;
    const [ordinary, map] = buildAdminSnapshots(session, conns, room);
    assert.strictEqual(ordinary.payload.lines, undefined);
    assert.strictEqual(map.payload.lines, undefined);
    assert.deepStrictEqual(map.payload.rewindLog, session.rewindLog);
  },

  "a map tab gets the room's walked frames, then only when they change": () => {
    const { session, conns } = room2();
    let walked = new Set(["start.svg", "a.svg"]);
    const withWalked = { ...room, walkedRefs: () => walked };
    const [ordinary, first] = buildAdminSnapshots(session, conns, withWalked);
    assert.strictEqual(ordinary.payload.walked, undefined, "session tabs never get it");
    assert.deepStrictEqual(first.payload.walked, ["a.svg", "start.svg"]);

    const [, same] = buildAdminSnapshots(session, conns, withWalked);
    assert.strictEqual(same.payload.walked, undefined, "unchanged: the page keeps its set");

    walked = new Set(["start.svg", "a.svg", "b.svg"]);
    const [, moved] = buildAdminSnapshots(session, conns, withWalked);
    assert.deepStrictEqual(moved.payload.walked, ["a.svg", "b.svg", "start.svg"]);
  },
};
