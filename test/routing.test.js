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
  populationLineConnections,
  smallestLineId,
  spectatorLandingLineId,
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

  // ── Spectators (owner, 2026-09-04) ────────────────────────────────────────
  // A rider (a session page opened with no password, isStaff === false) is
  // audience: it can never affect the session, and it only ever watches an
  // ACTIVE line.

  "populationLineConnections drops riders as well as map tabs": () => {
    const c = [
      { sessionId: "s1", lineId: "L0", isStaff: true }, // player
      { sessionId: "s1", lineId: "L0", isStaff: true, isAdmin: true }, // admin = player (L3)
      { sessionId: "s1", lineId: "L0", isStaff: false }, // rider
      { sessionId: "s1", lineId: "L0", isMapView: true }, // /map tab
    ];
    assert.strictEqual(lineConnections(c, "s1", "L0").length, 4);
    // The display view keeps the rider (the operator counts the audience)…
    assert.strictEqual(performerLineConnections(c, "s1", "L0").length, 3);
    // …while every decision the room makes runs over population only.
    const population = populationLineConnections(c, "s1", "L0");
    assert.strictEqual(population.length, 2);
    assert.ok(population.every((x) => x.isStaff === true));
  },

  "a connection with no isStaff field is still population": () => {
    // Only an explicit false marks a rider: the live server sets isStaff at
    // MSG_PING, before a connection can carry a lineId, so an undefined field
    // is a pre-ping socket or a fixture — never a spectator.
    const c = [{ sessionId: "s1", lineId: "L0" }];
    assert.strictEqual(populationLineConnections(c, "s1", "L0").length, 1);
  },

  "smallestLineId does not let riders occupy a line": () => {
    const lines = [
      { id: "L0", status: "active" },
      { id: "L1", status: "active" },
    ];
    // L1 carries three riders and no players: it is still the emptiest line,
    // because an audience cannot play the route.
    const c = [
      { sessionId: "s1", lineId: "L0", isStaff: true },
      { sessionId: "s1", lineId: "L1", isStaff: false },
      { sessionId: "s1", lineId: "L1", isStaff: false },
      { sessionId: "s1", lineId: "L1", isStaff: false },
    ];
    assert.strictEqual(smallestLineId(lines, c, "s1"), "L1");
  },

  "spectatorLandingLineId never lands on a dormant or retired line": () => {
    const lines = [
      { id: "L0", status: "dormant" },
      { id: "L1", status: "retired" },
      { id: "L2", status: "active" },
    ];
    // smallestLineId would revive L0 (0 devices ⇒ smallest); a spectator must
    // not — it cannot tap, so the dead path would never wake under it.
    const c = [{ sessionId: "s1", lineId: "L2", isStaff: true }];
    assert.strictEqual(smallestLineId(lines, c, "s1"), "L0");
    assert.strictEqual(spectatorLandingLineId(lines, c, "s1"), "L2");
  },

  "spectatorLandingLineId prefers a line that has players": () => {
    const lines = [
      { id: "L0", status: "active" }, // empty split child — nothing to watch
      { id: "L1", status: "active" },
    ];
    const c = [{ sessionId: "s1", lineId: "L1", isStaff: true }];
    assert.strictEqual(spectatorLandingLineId(lines, c, "s1"), "L1");
  },

  "spectatorLandingLineId spreads spectators across the played lines": () => {
    const lines = [
      { id: "L0", status: "active" },
      { id: "L1", status: "active" },
    ];
    const c = [
      { sessionId: "s1", lineId: "L0", isStaff: true },
      { sessionId: "s1", lineId: "L1", isStaff: true },
      { sessionId: "s1", lineId: "L0", isStaff: false }, // rider already on L0
    ];
    assert.strictEqual(spectatorLandingLineId(lines, c, "s1"), "L1");
  },

  "spectatorLandingLineId falls back to any active line, then to null": () => {
    const empty = [
      { id: "L0", status: "active" },
      { id: "L1", status: "active" },
    ];
    // Nobody is playing anywhere: any active line is as good as another.
    assert.strictEqual(spectatorLandingLineId(empty, [], "s1"), "L0");
    // Nothing active at all — the caller falls back to its ordinary policy.
    const dead = [
      { id: "L0", status: "dormant" },
      { id: "L1", status: "retired" },
    ];
    assert.strictEqual(spectatorLandingLineId(dead, [], "s1"), null);
  },

  "spectatorLandingLineId ignores map tabs entirely": () => {
    const lines = [
      { id: "L0", status: "active" },
      { id: "L1", status: "active" },
    ];
    // A /map tab on L0 makes it look neither played nor crowded.
    const c = [
      { sessionId: "s1", lineId: "L0", isMapView: true },
      { sessionId: "s1", lineId: "L1", isStaff: true },
    ];
    assert.strictEqual(spectatorLandingLineId(lines, c, "s1"), "L1");
  },
};
