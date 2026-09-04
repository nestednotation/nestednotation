/**
 * Session Lines — connection routing (pure).
 *
 * Helpers for selecting/assigning the connections that belong to a session or a
 * line, plus the late-join / revival assignment policy (decision #13). No
 * express/ws imports — the WebSocket connection list is passed in, so this is
 * fully unit-testable. A connection is any object carrying `sessionId` and
 * `lineId` (set server-side on MSG_PING / MSG_NEED_DISPLAY).
 *
 * Single-line invariant: with one line `L0`, `lineConnections(conns, sid, "L0")`
 * equals `sessionConnections(conns, sid)` and `smallestLineId` returns `"L0"` —
 * so vote tallies / sends reduce to exactly today's behavior.
 */

function sessionConnections(connections, sessionId) {
  return (connections || []).filter((c) => c && c.sessionId === sessionId);
}

function lineConnections(connections, sessionId, lineId) {
  return (connections || []).filter(
    (c) => c && c.sessionId === sessionId && c.lineId === lineId,
  );
}

// The line's PERFORMERS: its connections minus map-view tabs. The standalone
// /map page's connection (conn.isMapView, marked by the client at MSG_PING) is
// an observation tool with no way to tap or vote — it keeps a line binding so
// the server can address it, but it is never population: player/rider counts,
// group/barrier waits, attrition, revival and split membership all count
// performers only. Admin SESSION-page connections remain population (L3: an
// admin is a player with extra tools).
function performerLineConnections(connections, sessionId, lineId) {
  return lineConnections(connections, sessionId, lineId).filter(
    (c) => !c.isMapView,
  );
}

// A SPECTATOR is a connection that cannot act on the room, and therefore must
// not shape it (owner, 2026-09-04: "a rider is a spectator, and a spectator
// can't affect the session in any way, and should only be able to view active
// lines/nodes"). Two kinds:
//   - the standalone /map tab (`isMapView`), an observation tool; and
//   - a RIDER: a session page opened with no password (`isStaff === false`),
//     whose client refuses every tap (`handleSelectLink` returns on
//     `!window.staffCode`) and whose operator UI is never rendered.
// Spectators are excluded from POPULATION — vote tallies, group/hold-until
// waits, attrition, revival, split membership and line balancing — while still
// appearing in the display counts the operator reads (`riders`), which is what
// `performerLineConnections` above is for.
//
// `isStaff` is assigned on every connection at MSG_PING, before it can carry a
// `lineId` to be counted under, so only an explicit `false` marks a rider: an
// undefined field (a pre-ping socket, a test fixture) still counts as
// population, exactly as it did before this rule existed.
function isSpectatorConn(conn) {
  return !!conn && (!!conn.isMapView || conn.isStaff === false);
}

// The line's POPULATION: the connections that can act on it. This is the count
// every orchestration decision must use; `performerLineConnections` (which
// keeps riders) is for what the operator is SHOWN.
function populationLineConnections(connections, sessionId, lineId) {
  return lineConnections(connections, sessionId, lineId).filter(
    (c) => !isSpectatorConn(c),
  );
}

// Numeric value of a line id like "L0"/"L12" for "ties → earliest id" ordering.
function lineIdNum(id) {
  const m = /^L(\d+)$/.exec(String(id));
  return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
}

/**
 * Pick the line a newcomer (or unknown device) should join: the assignable line
 * with the fewest currently-connected PERFORMERS (map-view tabs excluded, as
 * everywhere else), ties broken by earliest id.
 *
 * Assignable = not hard-retired (rejoin-absorbed, or a split parent kept for a
 * structural undo). Dormant lines ARE assignable and have 0 devices, so they
 * are always smallest ⇒ newcomers revive dead paths first, then balance
 * across live lines (decisions #11/#13).
 *
 * @param {Array<{id:string,status?:string}>} lines
 * @param {Array<{sessionId:string,lineId:string}>} connections
 * @param {string} sessionId
 * @returns {string|null} the chosen line id, or null if there is none.
 */
function smallestLineId(lines, connections, sessionId) {
  const assignable = (lines || []).filter((l) => l && l.status !== "retired");
  if (assignable.length === 0) {
    return null;
  }

  const counts = {};
  for (const line of assignable) {
    counts[line.id] = 0;
  }
  // Population only, per isSpectatorConn above: a /map tab or a rider watching
  // a dormant line must not make it look populated and cost it its turn at
  // revival. Filtered inline rather than via the helper to keep this one pass.
  for (const conn of connections || []) {
    if (
      conn &&
      !isSpectatorConn(conn) &&
      conn.sessionId === sessionId &&
      counts[conn.lineId] !== undefined
    ) {
      counts[conn.lineId]++;
    }
  }

  let best = null;
  for (const line of assignable) {
    const candidate = { id: line.id, count: counts[line.id], num: lineIdNum(line.id) };
    if (
      best === null ||
      candidate.count < best.count ||
      (candidate.count === best.count && candidate.num < best.num)
    ) {
      best = candidate;
    }
  }
  return best ? best.id : null;
}

/**
 * Where a SPECTATOR should watch from (owner, 2026-09-04). Unlike a performer,
 * a rider is never assigned to an inactive line: it cannot tap, so a dormant
 * line it landed on would never wake, and a retired one shows nothing at all —
 * "a spectator should only be able to view active lines/nodes".
 *
 * Among the ACTIVE lines it prefers the ones that actually have players on
 * them (watching an empty split child is watching nothing happen), and spreads
 * spectators across those by rider count so a crowd does not all sit on one
 * route. Ties → earliest id, as everywhere else.
 *
 * Returns null when the room has no active line at all; the caller then falls
 * back to its ordinary assignment (there is nothing live left to watch).
 *
 * @param {Array<{id:string,status?:string}>} lines
 * @param {Array<{sessionId:string,lineId:string,isStaff?:boolean,isMapView?:boolean}>} connections
 * @param {string} sessionId
 * @returns {string|null}
 */
function spectatorLandingLineId(lines, connections, sessionId) {
  const active = (lines || []).filter(
    (l) => l && (l.status || "active") === "active",
  );
  if (active.length === 0) {
    return null;
  }

  const players = {};
  const riders = {};
  for (const line of active) {
    players[line.id] = 0;
    riders[line.id] = 0;
  }
  for (const conn of connections || []) {
    if (!conn || conn.sessionId !== sessionId || conn.isMapView) continue;
    if (players[conn.lineId] === undefined) continue;
    if (conn.isStaff === false) {
      riders[conn.lineId]++;
    } else {
      players[conn.lineId]++;
    }
  }

  const populated = active.filter((l) => players[l.id] > 0);
  const pool = populated.length > 0 ? populated : active;

  let best = null;
  for (const line of pool) {
    const candidate = { id: line.id, count: riders[line.id], num: lineIdNum(line.id) };
    if (
      best === null ||
      candidate.count < best.count ||
      (candidate.count === best.count && candidate.num < best.num)
    ) {
      best = candidate;
    }
  }
  return best ? best.id : null;
}

module.exports = {
  sessionConnections,
  lineConnections,
  performerLineConnections,
  populationLineConnections,
  isSpectatorConn,
  smallestLineId,
  spectatorLandingLineId,
  lineIdNum,
};
