/**
 * Chunk F tests — connection routing (pure).
 *
 * The critical invariant: with a single line, line-scoped selection reduces to
 * exactly today's session-scoped selection.
 */

const assert = require("node:assert");

const {
  sessionConnections,
  lineConnections,
  performerLineConnections,
  smallestLineId,
} = require("../lib/session-lines/routing");

function conns() {
  return [
    { sessionId: "s1", lineId: "L0" },
    { sessionId: "s1", lineId: "L0" },
    { sessionId: "s2", lineId: "L0" }, // other session
    { sessionId: "s1", lineId: "L1" },
  ];
}

module.exports = {
  "single line: lineConnections == sessionConnections": () => {
    const single = [
      { sessionId: "s1", lineId: "L0" },
      { sessionId: "s1", lineId: "L0" },
      { sessionId: "s2", lineId: "L0" },
    ];
    assert.deepStrictEqual(
      lineConnections(single, "s1", "L0"),
      sessionConnections(single, "s1"),
    );
  },

  "lineConnections filters by both session and line": () => {
    const c = conns();
    assert.strictEqual(lineConnections(c, "s1", "L0").length, 2);
    assert.strictEqual(lineConnections(c, "s1", "L1").length, 1);
    assert.strictEqual(lineConnections(c, "s2", "L0").length, 1);
    assert.strictEqual(lineConnections(c, "s1", "L9").length, 0);
  },

  "performerLineConnections drops map-view tabs, keeps admins": () => {
    const c = [
      { sessionId: "s1", lineId: "L0" },
      { sessionId: "s1", lineId: "L0", isMapView: true }, // /map page tab
      { sessionId: "s1", lineId: "L0", isAdmin: true }, // session-page admin
    ];
    assert.strictEqual(lineConnections(c, "s1", "L0").length, 3);
    const performers = performerLineConnections(c, "s1", "L0");
    assert.strictEqual(performers.length, 2);
    assert.ok(performers.every((x) => !x.isMapView));
  },

  "smallestLineId returns the only line when single": () => {
    const lines = [{ id: "L0", status: "active" }];
    assert.strictEqual(smallestLineId(lines, conns(), "s1"), "L0");
  },

  "smallestLineId balances to the least-populated line": () => {
    const lines = [
      { id: "L0", status: "active" },
      { id: "L1", status: "active" },
    ];
    // s1 has 2 on L0, 1 on L1 → newcomer should join L1.
    assert.strictEqual(smallestLineId(lines, conns(), "s1"), "L1");
  },

  "smallestLineId breaks ties by earliest id": () => {
    const lines = [
      { id: "L0", status: "active" },
      { id: "L1", status: "active" },
      { id: "L2", status: "active" },
    ];
    // No connections → all tied at 0 → earliest id wins.
    assert.strictEqual(smallestLineId(lines, [], "s1"), "L0");
  },

  "smallestLineId revives a dormant (0-device) line first": () => {
    const lines = [
      { id: "L0", status: "active" },
      { id: "L1", status: "dormant" },
    ];
    const populated = [
      { sessionId: "s1", lineId: "L0" },
      { sessionId: "s1", lineId: "L0" },
    ];
    assert.strictEqual(smallestLineId(lines, populated, "s1"), "L1");
  },

  "smallestLineId skips hard-retired lines": () => {
    const lines = [
      { id: "L0", status: "retired" },
      { id: "L1", status: "active" },
    ];
    assert.strictEqual(smallestLineId(lines, [], "s1"), "L1");
  },

  "smallestLineId counts performers only, not map-view observers": () => {
    const lines = [
      { id: "L0", status: "active" },
      { id: "L1", status: "dormant" },
    ];
    // L1 is dormant with nobody performing on it — only a /map tab bound to it
    // for addressing. It must still read as 0 population and win the newcomer,
    // otherwise an observer silently costs a dead path its revival.
    const c = [
      { sessionId: "s1", lineId: "L0" },
      { sessionId: "s1", lineId: "L1", isMapView: true },
    ];
    assert.strictEqual(smallestLineId(lines, c, "s1"), "L1");

    // And an admin on the SESSION page is still population (L3), so a line
    // carrying one is not the emptiest.
    const withAdmin = [
      { sessionId: "s1", lineId: "L1", isAdmin: true },
      { sessionId: "s1", lineId: "L0", isMapView: true },
    ];
    assert.strictEqual(smallestLineId(lines, withAdmin, "s1"), "L0");
  },
};
