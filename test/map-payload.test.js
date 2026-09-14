/** Compact structural map transport and terminal-history persistence. */

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const {
  compactPersistedEvents,
  structuralEventSummaries,
  structuralProjectionKey,
  structuralProjectionVersion,
} = require("../lib/session-lines/map-payload");

const ROOT = path.join(__dirname, "..");

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

  "100, 200 and 500 event broadcasts stay compact": () => {
    for (const count of [100, 200, 500]) {
      const projection = largeProjection(count);
      const started = process.hrtime.bigint();
      const summaries = structuralEventSummaries(projection);
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
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
      assert.ok(
        elapsedMs < 250,
        `${count} events took ${elapsedMs.toFixed(1)} ms to summarize`,
      );
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

  "runtime separates map details and rejects unauthorized map pages": () => {
    const runtime = fs.readFileSync(path.join(ROOT, "bin", "www"), "utf8");
    const client = fs.readFileSync(
      path.join(ROOT, "public", "javascripts", "session-map.js"),
      "utf8",
    );
    const route = fs.readFileSync(
      path.join(ROOT, "routes", "session.js"),
      "utf8",
    );
    const database = fs.readFileSync(
      path.join(ROOT, "database.js"),
      "utf8",
    );

    assert.match(runtime, /ordinaryAdmins[\s\S]*mapAdmins/);
    assert.match(runtime, /structuralDetails:\s*true/);
    assert.match(
      client,
      /requestStructuralDetails[\s\S]*structuralDetails:\s*true/,
    );
    assert.match(route, /req\.query\.p !== session\.adminPassword/);
    assert.match(route, /status\(403\)[\s\S]*Admin password invalid or expired/);
    assert.match(database, /splitEvents:\s*compactPersistedEvents/);
    assert.match(database, /mergeEvents:\s*compactPersistedEvents/);
  },
};
