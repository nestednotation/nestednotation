/** Compact structural map transport and terminal-history persistence. */

const assert = require("node:assert");

const {
  compactPersistedEvents,
  structuralEventSummaries,
  structuralProjectionKey,
  structuralProjectionVersion,
} = require("../lib/session-lines/map-payload");


function largeProjection(count) {
  const trail = Array.from({ length: 80 }, (_, i) => `frame-${i}.svg`);
  return {
    splitRewinds: Array.from({ length: count }, (_, i) => ({
      eventId: `S${i + 1}`,
      frame: `split-${i}.svg`,
      available: true,
      descendantLineIds: ["L0", "L1", "L2"],
      cascade: Array.from({ length: count - i }, (_, j) => ({
        kind: "merge",
        eventId: `M${j + i}`,
        frame: `merge-${j + i}.svg`,
      })),
      trail,
    })),
    mergeRewinds: Array.from({ length: count }, (_, i) => ({
      eventId: `M${i + 1}`,
      frame: `merge-${i}.svg`,
      available: true,
      restoredLineIds: ["L0", "L1", "L2"],
      cascade: Array.from({ length: count - i }, (_, j) => ({
        kind: "split",
        eventId: `S${j + i}`,
        frame: `split-${j + i}.svg`,
      })),
      survivorTrail: trail,
      landings: trail.map((frame, j) => ({ lineId: `L${j}`, frame })),
    })),
    absorbedLines: Array.from({ length: count }, (_, i) => ({
      id: `L${i}`,
      trail,
    })),
  };
}

module.exports = {
  "structural versions change with topology, not line movement": () => {
    const session = {
      contentHash: "score-a",
      listFiles: ["A.svg"],
      splitEvents: [{ id: "S1", status: "active" }],
      mergeEvents: [],
      lines: [{ id: "L0", uid: "U0", status: "active", currentIndex: 1 }],
    };
    const firstKey = structuralProjectionKey(session);
    const first = structuralProjectionVersion(firstKey);
    session.lines[0].currentIndex = 9;
    assert.strictEqual(
      structuralProjectionVersion(structuralProjectionKey(session)),
      first,
    );
    session.splitEvents[0].status = "undone";
    assert.notStrictEqual(
      structuralProjectionVersion(structuralProjectionKey(session)),
      first,
    );
  },

  // Sizes only, of the summary step alone. The real snapshot path (projection,
  // latecomers, trails, serialization, fan-out) is measured by
  // bin/bench-map-payload.js and bounded by the handler cases in
  // map-snapshot.test.js; a wall-clock budget here measured the host.
  "structural event summaries stay compact at 100, 200 and 500 events": () => {
    for (const count of [100, 200, 500]) {
      const projection = largeProjection(count);
      const summaries = structuralEventSummaries(projection);
      const compactBytes = Buffer.byteLength(JSON.stringify(summaries));
      const fullBytes = Buffer.byteLength(JSON.stringify(projection));
      assert.strictEqual(summaries.length, count * 2);
      assert.ok(
        compactBytes < count * 300,
        `${count} events produced ${compactBytes} summary bytes`,
      );
      assert.ok(
        compactBytes * 10 < fullBytes,
        `${count} events did not materially reduce the broadcast`,
      );
      assert.ok(summaries.every((entry) => entry.cascade === undefined));
    }
  },

  "persisted terminal events retain evidence without dead rewind snapshots": () => {
    const undone = {
      id: "M1",
      status: "undone",
      participants: [{ history: ["A"] }],
    };
    const expired = {
      id: "M2",
      seq: 2,
      status: "expired",
      frame: "MERGE.svg",
      survivorLineId: "L0",
      participants: [
        {
          lineId: "L1",
          lineUid: "U1",
          history: ["A.svg", "B.svg"],
          visitedSubFrames: ["Sub/X.svg"],
          deviceIds: ["large-dead-registry-entry"],
          pendingHoldUntil: ["unused"],
        },
      ],
      oversizedUnusedField: "x".repeat(1000),
    };
    const compact = compactPersistedEvents([undone, expired], "merge");
    assert.strictEqual(compact.length, 1);
    assert.deepStrictEqual(compact[0].participants[0].history, [
      "A.svg",
      "B.svg",
    ]);
    assert.deepStrictEqual(compact[0].participants[0].visitedSubFrames, [
      "Sub/X.svg",
    ]);
    assert.strictEqual(compact[0].participants[0].deviceIds, undefined);
    assert.strictEqual(compact[0].oversizedUnusedField, undefined);
  },

  "the map page refuses anyone without the admin password": () => {
    const router = require("../routes/session.js");
    const handler = router.stack.find(
      (l) => l.route && l.route.path === "/:sessionId/map",
    ).route.stack[0].handle;
    const session = {
      id: "S1",
      folder: "Score",
      adminPassword: "admin-pw",
      playerPassword: "player-pw",
    };
    const request = (query, found = session) => {
      const out = { status: 200, rendered: null, body: null };
      const res = {
        status(code) {
          out.status = code;
          return this;
        },
        type() {
          return this;
        },
        send(body) {
          out.body = body;
        },
        render(view, locals) {
          out.rendered = { view, locals };
        },
      };
      handler(
        {
          params: { sessionId: "S1" },
          query,
          app: { get: () => ({ sessionTable: { getById: () => found } }) },
        },
        res,
      );
      return out;
    };

    for (const query of [{}, { p: "" }, { p: "player-pw" }, { p: "ADMIN-PW" }]) {
      const out = request(query);
      assert.strictEqual(out.status, 403, JSON.stringify(query));
      assert.strictEqual(out.rendered, null, "a refused request rendered the map");
      assert.match(out.body, /Admin password invalid or expired/);
    }
    assert.strictEqual(request({ p: "admin-pw" }, null).status, 404);

    const ok = request({ p: "admin-pw" });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.rendered.view, "session-map");
    assert.strictEqual(ok.rendered.locals.sessionId, "S1");
  },

  "persisted structural events are compacted by the real toJSON": () => {
    const { BMSession } = require("../database.js");
    const session = new BMSession();
    const heavy = {
      id: 1,
      status: "undone",
      frame: "J.svg",
      participants: [{ lineId: "L1", history: ["A.svg"], deviceIds: ["d1"] }],
      oversizedUnusedField: "x".repeat(1000),
    };
    session.splitEvents = [{ ...heavy }];
    session.mergeEvents = [{ ...heavy }];
    const saved = JSON.parse(JSON.stringify(session.toJSON()));
    assert.deepStrictEqual(
      saved.splitEvents,
      JSON.parse(JSON.stringify(compactPersistedEvents([heavy], "split"))),
    );
    assert.deepStrictEqual(
      saved.mergeEvents,
      JSON.parse(JSON.stringify(compactPersistedEvents([heavy], "merge"))),
    );
    assert.ok(!JSON.stringify(saved).includes("x".repeat(100)), "a dead field was persisted");
  },
};
