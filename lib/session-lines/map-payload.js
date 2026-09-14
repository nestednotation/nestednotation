/**
 * Compact transport/persistence helpers for structural map history.
 *
 * Active events remain complete because any one of them may still be rewound.
 * Terminal events do not: undone events have no remaining effect, while an
 * expired event only needs enough identity to block an older rewind and enough
 * trail evidence to corroborate barriers/checkpoints.
 */

function structuralProjectionKey(session) {
  let key = `${session.contentHash || ""}:${(session.listFiles || []).length}|`;
  for (const event of session.splitEvents || []) {
    if (!event) continue;
    key += `S${event.id}:${event.status}:${event.blockedByMerge ? 1 : 0}|`;
  }
  for (const event of session.mergeEvents || []) {
    if (!event) continue;
    key += `M${event.id}:${event.status}|`;
  }
  for (const line of session.lines || []) {
    if (!line) continue;
    key += `L${line.id}:${line.uid || ""}:${line.status}|`;
  }
  return key;
}

// FNV-1a: this is a cache/version tag, not a security boundary.
function structuralProjectionVersion(key) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${key.length.toString(36)}-${(hash >>> 0).toString(36)}`;
}

function structuralEventSummaries(projection) {
  const splits = (projection.splitRewinds || []).map((entry) => ({
    eventId: entry.eventId,
    kind: "split",
    frame: entry.frame,
    available: !!entry.available,
    reason: entry.reason || null,
    lineCount: (entry.descendantLineIds || []).length,
    cascadeCount: (entry.cascade || []).length,
  }));
  const merges = (projection.mergeRewinds || []).map((entry) => ({
    eventId: entry.eventId,
    kind: "merge",
    frame: entry.frame,
    available: !!entry.available,
    reason: entry.reason || null,
    lineCount: (entry.restoredLineIds || []).length,
    cascadeCount: (entry.cascade || []).length,
  }));
  return [...splits, ...merges];
}

const pick = (source, keys) => {
  const out = {};
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
};

function compactExpiredSplit(event) {
  return pick(event, [
    "id",
    "gestureId",
    "seq",
    "createdAt",
    "status",
    "expiredAt",
    "frame",
    "parentLineId",
    "parentLineUid",
    "childLineIds",
    "childLineUids",
    "ancestorEventIds",
    "blockedByMerge",
    "parentHistory",
    "parentHistoryIndex",
    "parentVisitedSubFrames",
  ]);
}

function compactExpiredParticipant(snapshot) {
  return pick(snapshot || {}, [
    "lineId",
    "lineUid",
    "history",
    "historyIndex",
    "subStack",
    "savedHistories",
    "visitedSubFrames",
  ]);
}

function compactExpiredMerge(event) {
  return {
    ...pick(event, [
      "id",
      "seq",
      "createdAt",
      "status",
      "expiredAt",
      "frame",
      "survivorLineId",
      "survivorLineUid",
      "blockedSplitEventIds",
    ]),
    participants: (event.participants || []).map(compactExpiredParticipant),
  };
}

function compactPersistedEvents(events, kind) {
  const out = [];
  for (const event of events || []) {
    if (!event || event.status === "undone") continue;
    out.push(
      event.status === "expired"
        ? kind === "split"
          ? compactExpiredSplit(event)
          : compactExpiredMerge(event)
        : event,
    );
  }
  return out;
}

module.exports = {
  compactPersistedEvents,
  structuralEventSummaries,
  structuralProjectionKey,
  structuralProjectionVersion,
};
