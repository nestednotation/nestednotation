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

// Numeric value of a line id like "L0"/"L12" for "ties → earliest id" ordering.
function lineIdNum(id) {
  const m = /^L(\d+)$/.exec(String(id));
  return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
}

/**
 * Pick the line a newcomer (or unknown device) should join: the assignable line
 * with the fewest currently-connected devices, ties broken by earliest id.
 *
 * Assignable = not hard-retired (split parent / rejoin-absorbed). Dormant lines
 * ARE assignable and have 0 devices, so they are always smallest ⇒ newcomers
 * revive dead paths first, then balance across live lines (decisions #11/#13).
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
  for (const conn of connections || []) {
    if (conn && conn.sessionId === sessionId && counts[conn.lineId] !== undefined) {
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

module.exports = {
  sessionConnections,
  lineConnections,
  smallestLineId,
  lineIdNum,
};
