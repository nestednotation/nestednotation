/**
 * Session Lines — what each operator tab is told about the room (pure).
 *
 * `buildAdminSnapshots` turns a session and its connections into the
 * MSG_SHOW_NUMBER_CONNECTION payloads bin/www sends: player/rider counts for
 * everyone, the compact line strip for ordinary admin session tabs, and for
 * each map tab the full picture (trails, checkpoints, structural summaries,
 * room checkpoints, the rewind log). It sends nothing itself: it returns
 * `[{connections, payload}]` in send order, and bin/www serializes them.
 *
 * The room-specific answers it needs (projections, frame lookups, line
 * numbering) come in as `room`, so this file imports nothing from bin/www
 * and the payload rules can be exercised without a server:
 *
 *   room = {
 *     messageType,                          // MESSAGES.MSG_SHOW_NUMBER_CONNECTION
 *     structuralProjection(session),        // memoized split/merge projection
 *     roomCheckpointOptions(session),
 *     structuralEventSummaries(projection),
 *     mergeLatecomerCount(session, entry),  // {total, live}
 *     walkedRefs(session),                  // Set of lowercased frame refs
 *     mainHistoryStateForLine(line),        // {history, historyIndex}
 *     frameNameForLine(session, line),
 *     mainFlowFrameForLine(session, line),
 *     subOriginFrameForLine(session, line),
 *     lineIdNum(id),
 *   }
 *
 * State it keeps: each map connection's `__sentTrails` (see linesForMapTab)
 * and `__sentWalked` (see walkedForMapTab).
 */

// A map tab is sent a line's trails only when they changed since the last
// push that tab received; otherwise the line says `trailKept` and the page
// reuses the ones it has (session-map.js withKnownTrails). Trails are the
// bulk of an ordinary push — a long performance's history, per line, resent
// on every join, leave and landing. Keyed by durable line identity, exactly
// as the page keys them, and forgotten for lines the push no longer carries on
// both sides alike.
function linesForMapTab(conn, fullLines, trailKeys) {
  const sent = conn.__sentTrails || new Map();
  const next = new Map();
  const lines = fullLines.map((line) => {
    const key = line.uid || line.id;
    const trailKey = trailKeys.get(line);
    next.set(key, trailKey);
    if (sent.get(key) === trailKey) {
      const { trail, mainTrail, ...rest } = line;
      return { ...rest, trailKept: true };
    }
    return line;
  });
  conn.__sentTrails = next;
  return lines;
}

// The frames the room has walked (orchestrator `roomWalkedRefs`) — what the
// map paints green. Bounded by the score's frame count, but still only sent
// when it changed since this tab's last push; a push without `walked` means
// "unchanged", and the page keeps the set it has.
function walkedForMapTab(conn, walked, walkedKey) {
  if (conn.__sentWalked === walkedKey) return {};
  conn.__sentWalked = walkedKey;
  return { walked };
}

function buildAdminSnapshots(session, connections, room) {
  const sends = [];
  // An admin is a player with extra tools (L3 decision), so admins count as
  // players here and in the per-line split below — isStaff is true for both
  // the player and admin passwords. Map-view tabs are observation tools and
  // appear in NO count this payload carries: a tool must leave no footprint.
  const performers = connections.filter(
    (conn) => conn.sessionId == session.id && !conn.isMapView,
  );
  const countPlayer = performers.filter((conn) => conn.isStaff).length;
  const countRider = performers.filter((conn) => !conn.isStaff).length;

  const basePayload = {
    m: room.messageType,
    playerCount: countPlayer,
    riderCount: countRider,
  };
  const ordinaryAdmins = connections.filter(
    (conn) => conn.sessionId === session.id && conn.isAdmin && !conn.isMapView,
  );
  const mapAdmins = connections.filter(
    (conn) => conn.sessionId === session.id && conn.isAdmin && conn.isMapView,
  );
  // Map-only operational history. It is small and capped, but ordinary admin
  // session tabs do not render it, so keep it off their frequent count push.
  let mapPayload =
    mapAdmins.length > 0
      ? { ...basePayload, rewindLog: session.rewindLog || [] }
      : basePayload;

  // Session Lines (Chunk M): per-line device distribution so the operator sees
  // the room's split across lines and can spot stalled ones (dormant, or parked
  // at a barrier). Ordinary admin/session tabs use `lines` for their compact
  // status panel, but none of the structural projection below.
  if (session.hasSessionLines && ordinaryAdmins.length + mapAdmins.length > 0) {
    // Which track groups the room can be rewound to, decided HERE.
    // The map used to re-derive this from `lines[]` with its own copy of
    // `commonCheckpoints`, and the two answers could not agree: the copy counted
    // riders as population (a spectator is never population — decision #12) so a
    // rider-only line hid a checkpoint the server would have accepted, and it
    // had no way to see the split records at all, so it could not know where a
    // line whose trail a fork truncated had really crossed the group. One
    // answer, computed where both inputs live, and the menu is a projection of
    // it like everything else on that canvas. Outside the memoized projection
    // because it turns on who is CONNECTED, which changes with every join and
    // leave; `session.graph.groups` is small and the trails are already in hand.
    if (mapAdmins.length > 0) {
      const structural = room.structuralProjection(session);
      mapPayload.roomCheckpoints = room.roomCheckpointOptions(session);
      mapPayload.structuralVersion = structural.version;
      mapPayload.structuralEvents = room
        .structuralEventSummaries(structural)
        .map((summary) => {
          if (summary.kind !== "merge" || !summary.available) return summary;
          const entry = structural.mergeRewinds.find(
            (candidate) => candidate.eventId === summary.eventId,
          );
          if (!entry) return summary;
          const counted = room.mergeLatecomerCount(session, entry);
          return {
            ...summary,
            latecomers: counted.total,
            latecomersHere: counted.live,
          };
        });
    }
    // The room's performers, grouped by line once (performerLineConnections,
    // for every line at once) rather than rescanning every socket per line.
    const performersByLine = new Map();
    for (const conn of performers) {
      if (!performersByLine.has(conn.lineId)) {
        performersByLine.set(conn.lineId, []);
      }
      performersByLine.get(conn.lineId).push(conn);
    }
    const fullLines = session.lines
      .filter((l) => l.status !== "retired")
      .map((l) => {
        // DISPLAY counts, so riders are kept here (and only here): the operator
        // wants to see the audience, while every decision the room makes runs
        // over populationLineConnections instead.
        const linePerformers = performersByLine.get(l.id) || [];
        const mainHistory = room.mainHistoryStateForLine(l);
        // The oldest app-level message on this line. A device whose JS is gone
        // (a frozen tab, a wedged renderer) keeps answering the transport
        // keepalive from its network stack, so the only tell left is that its
        // 60s MSG_PING stopped. Reported, never acted on: a backgrounded phone
        // throttles that ping too, and dropping a live performer would change
        // line population and group waits.
        // Population only: a quiet RIDER is not a stalled room — a spectator
        // holds nothing open — so flagging one would send the operator after a
        // device that cannot be the cause.
        const lastSeens = linePerformers
          .filter((c) => c.isStaff !== false)
          .map((c) => c.lastSeen)
          .filter((t) => typeof t === "number");
        return {
          id: l.id,
          // The durable identity behind the recycled number (§8.4). The map
          // needs it to tell a merge this line really walked through from one
          // that swallowed an OLDER route of the same number, before it warns
          // that a rewind reaches back past it.
          uid: l.uid,
          status: l.status,
          players: linePerformers.filter((c) => c.isStaff).length,
          riders: linePerformers.filter((c) => !c.isStaff).length,
          quietSince: lastSeens.length ? Math.min(...lastSeens) : null,
          frame: room.frameNameForLine(session, l),
          inSub: l.subStack.length > 0,
          sub:
            l.subStack.length > 0
              ? l.subStack[l.subStack.length - 1].score
              : null,
          // Where an operator eject would drop this line: the OUTERMOST dive's
          // return frame, resolved against the live list. Null while the score
          // no longer offers that landing, so the map's menu can say why it has
          // no button instead of offering one that would do nothing.
          subReturn:
            l.subStack.length > 0
              ? room.mainFlowFrameForLine(session, l)
              : null,
          // …and where a rollback would put it back: the frame it dived from.
          subOrigin:
            l.subStack.length > 0
              ? room.subOriginFrameForLine(session, l)
              : null,
          waiting: !!(l.isBarrierWaiting || l.isGroupWaiting),
          // A barrier — a track group's arrival wait or a hold-until — is held
          // open waiting for THIS line, so the map marks it and offers the
          // per-line advance on the node it is standing on.
          straggler: !!l.stragglerFor,
          voting: !!l.isVoting,
          holding: !!l.isHolding,
          // Per-line history (ACTIVE context — a line inside a sub carries its
          // sub trail), so the map can paint every line's visited trail and
          // checkpoint, not only the receiving admin's bound line.
          checkpoint: l.history[l.historyIndex] || null,
          trail: l.history.slice(0, l.historyIndex + 1),
          // Main-flow trail for room-wide checkpoint detection while a line is
          // inside a sub; the active sub trail above still drives the overlay.
          mainCheckpoint: mainHistory.history[mainHistory.historyIndex] || null,
          mainTrail: mainHistory.history.slice(0, mainHistory.historyIndex + 1),
        };
      })
      // By NUMBER, which is how the operator reads the room — `session.lines`
      // is in creation order, and a structural undo re-creates the lines it
      // brings back in the order it walks (newest event first), so an undo of
      // a convergence left the panel and the map legend reading "L0, L2, L1".
      // Sorted in the payload rather than in `session.lines`: the runtime's
      // own order is nobody's business but its own.
      .sort((a, b) => room.lineIdNum(a.id) - room.lineIdNum(b.id));
    // The session tab renders only the line-status strip. Histories, durable
    // identities and rewind landings are map-only and can be as large as the
    // performance, so do not make every ordinary admin parse them.
    basePayload.lines = fullLines.map((line) => ({
      id: line.id,
      status: line.status,
      players: line.players,
      riders: line.riders,
      quietSince: line.quietSince,
      frame: line.frame,
      inSub: line.inSub,
      sub: line.sub,
      waiting: line.waiting,
      straggler: line.straggler,
      voting: line.voting,
      holding: line.holding,
    }));
    if (mapAdmins.length > 0) {
      const walked = room.walkedRefs
        ? [...room.walkedRefs(session)].sort()
        : [];
      const walkedKey = JSON.stringify(walked);
      const trailKeys = new Map(
        fullLines.map((line) => [
          line,
          JSON.stringify([line.trail, line.mainTrail]),
        ]),
      );
      sends.push({ connections: ordinaryAdmins, payload: basePayload });
      for (const conn of mapAdmins) {
        sends.push({
          connections: [conn],
          payload: {
            ...mapPayload,
            ...walkedForMapTab(conn, walked, walkedKey),
            lines: linesForMapTab(conn, fullLines, trailKeys),
          },
        });
      }
      return sends;
    }
  }

  sends.push({ connections: ordinaryAdmins, payload: basePayload });
  sends.push({ connections: mapAdmins, payload: mapPayload });
  return sends;
}

module.exports = { buildAdminSnapshots, linesForMapTab, walkedForMapTab };
