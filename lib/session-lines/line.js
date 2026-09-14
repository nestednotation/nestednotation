/**
 * Session Lines — BMLine (per-playhead line model).
 *
 * Today a BMSession owns a single playhead (currentIndex/history/voting/holding).
 * Session Lines turns that into an array of BMLine objects, each carrying its own
 * playhead + voting/holding state, so the flow can later split into parallel
 * lines. Until a split happens (Phase 3), a session has exactly one line
 * (`lines[0]`) and every path reduces to today's single-playhead behavior.
 *
 * Pure-ish: no express/ws/fs imports. A BMLine holds a non-enumerable back-ref
 * to its session purely to read session-global data (listFiles, randomItem) when
 * advancing the playhead.
 */

// The per-line fields that used to live flat on BMSession. This single list is
// the source of truth for:
//   - v1→v2 state migration (which flat fields move into lines[0]),
//   - toJSON / fromJSON.
// `id` and `status` are line identity (session.id is the SESSION id) and are
// handled separately.
const LINE_FIELDS = [
  // playhead / history
  "currentIndex",
  "history",
  "historyIndex",
  // voting
  "isVoting",
  "currentBeginTimeStamp",
  "currentEndTimeStamp",
  "currentVotingDuration",
  "votingTimer",
  "votingTimeStamp",
  "didSendStopVoting",
  "currWinningId",
  "previousWinningCount",
  // holding / standby
  "isHolding",
  "isStandby",
  "currentBeginHoldTimeStamp",
  "currentEndHoldTimeStamp",
  "currentHoldingDuration",
  "holdingTimer",
  "standbyTimer",
  "nextFrameHoldingDur",
  // coordination (new — inert until Phase 3 orchestration)
  "trackGroup",
  "pendingHoldUntil",
  "pendingRejoinAt",
  "subStack",
  "isBarrierWaiting",
  // parked at a track-group ARRIVAL barrier (waiting for incoming lines)
  "isGroupWaiting",
  // main-flow histories saved across sub dives (parallel to subStack)
  "savedHistories",
  // qualified "score/frame" visits inside subs (barrier sub-ref coverage)
  "visitedSubFrames",
  // Structural rewind lineage. Each id names an ACTIVE split event whose
  // subtree currently contains this line. Children inherit the parent's list
  // and append their new split; a merge keeps only ids common to every merged
  // line and marks crossed boundaries on the session's splitEvents registry.
  "splitAncestors",
];

// Timers never survive serialization (they reference live Node handles).
const TIMER_FIELDS = ["votingTimer", "holdingTimer", "standbyTimer"];

const DEFAULT_LINE_ID = "L0";

// A line NUMBER is recycled (`allocLineId` hands out the lowest free one), so
// "L1" names whatever route holds it now and nothing older. Structural history
// has to survive that: an undo recorded an hour ago must know which line OBJECT
// it took apart, and be sure the L1 standing there today is that same route
// rather than a later fork that inherited the number. `uid` is that durable
// identity — minted per line object, persisted, and RESTORED by both structural
// undos (a rewind hands a route its old uid back, so events older still keep
// chaining onto it). Time-prefixed so uids minted after a restart cannot
// collide with the ones already in the state file.
let lineUidSeq = 0;
function newLineUid() {
  lineUidSeq += 1;
  return `u${Date.now().toString(36)}${lineUidSeq.toString(36)}`;
}

class BMLine {
  constructor(session, id = DEFAULT_LINE_ID) {
    // Non-enumerable so it never leaks into JSON / {...spread}.
    Object.defineProperty(this, "session", {
      value: session,
      enumerable: false,
      writable: true,
      configurable: true,
    });

    this.id = id;
    // Durable route identity, independent of the recycled number (above).
    this.uid = newLineUid();
    // Lifecycle status for the #11 dormancy/revival model. Dormant lines stay in
    // session.lines[] (so they survive restart + remain revivable); 'retired'
    // lines are structurally gone (split parent / rejoin-absorbed).
    this.status = "active";

    // playhead / history
    this.currentIndex = 0;
    this.history = [];
    this.historyIndex = 0;

    // voting
    this.isVoting = false;
    this.currentBeginTimeStamp = 0;
    this.currentEndTimeStamp = 0;
    this.currentVotingDuration = 0;
    this.votingTimer = null;
    this.votingTimeStamp = 0;
    this.didSendStopVoting = false;
    // currWinningId / previousWinningCount are intentionally left undefined until
    // the first tally (mirrors the original BMSession, which never declared them).

    // holding / standby
    this.isHolding = false;
    this.isStandby = false;
    this.currentBeginHoldTimeStamp = 0;
    this.currentEndHoldTimeStamp = 0;
    this.currentHoldingDuration = 0;
    this.holdingTimer = null;
    this.standbyTimer = null;
    this.nextFrameHoldingDur = null;

    // coordination (inert until Phase 3)
    this.trackGroup = null;
    this.pendingHoldUntil = [];
    this.pendingRejoinAt = null;
    this.subStack = [];
    this.isBarrierWaiting = false;
    this.isGroupWaiting = false;
    this.savedHistories = [];
    this.visitedSubFrames = [];
    this.splitAncestors = [];
  }

  // ── Playhead (moved verbatim from BMSession; reads session-global listFiles) ──

  // The frame-name list the playhead currently indexes. On the main flow this is
  // session.listFiles; inside a sub-session it is the sub-score's frame list
  // (Session Lines, Chunk K). When not in a sub it is exactly session.listFiles,
  // so single-line / vanilla behavior is unchanged.
  activeFrameList() {
    const top = this.subStack[this.subStack.length - 1];
    if (top && this.session.subFrames && this.session.subFrames[top.score]) {
      return this.session.subFrames[top.score].frameList;
    }
    return this.session.listFiles;
  }

  // Move the playhead to `index` of the ACTIVE frame list and record the
  // landing on the undo trail.
  //
  // CALLER INVARIANT — a caller that sets `historyIndex` externally (i.e. a
  // rewind) must then call this with the index of `history[historyIndex]`
  // itself: land the playhead ON the trail entry it rewound to. Every rewind
  // path obeys it by construction, each deriving the landing frame FROM that
  // trail entry — `lineRewind` and `jumpScoreForSession` via
  // `line.history[value]`, `roomRewind` via `roomRewindPlan`'s
  // `trail[historyIndex]` hit. Outside a rewind a line always RESTS with
  // `historyIndex === history.length - 1` (set below), so the truncation is a
  // no-op and only the push applies.
  setCurrIdxTo(index) {
    this.currentIndex = parseInt(index);
    this.isVoting = false;
    this.isStandby = false;

    const frame = this.activeFrameList()[index];

    if (this.history.length > 0) {
      if (
        this.historyIndex < this.history.length - 1 &&
        this.history[this.historyIndex] !== frame
      ) {
        // Truncating to a rewind point we are NOT landing on — the invariant
        // above is broken. Not fatal (the entry at historyIndex survives and
        // the landing is appended after it), but the caller is wrong.
        console.warn(
          `setCurrIdxTo: line ${this.id} rewinding to historyIndex ${this.historyIndex} ` +
            `("${this.history[this.historyIndex]}") but landing on "${frame}"`,
        );
      }
      // Drop the redo tail ahead of the rewind point. `historyIndex` names the
      // entry being landed on, so it SURVIVES — only what came after it goes.
      this.history.splice(this.historyIndex + 1);
      // Heal adjacent duplicates left at the tail by sessions predating the
      // guarded push below (the map menu offered "(visit 1)/(visit 2)" for what
      // was a single visit). Collapsing equal neighbours never loses the
      // landing frame — the survivor is that same frame name.
      while (
        this.history.length >= 2 &&
        this.history[this.history.length - 1] ===
          this.history[this.history.length - 2]
      ) {
        this.history.pop();
      }
    }

    // Landing on the frame the trail already ends with records nothing new:
    // rewinds land every line through here, including one already sitting AT
    // its landing (roomRewind), and an unconditional push appended a duplicate
    // entry — the map menu then offered "(visit 1)/(visit 2)" for a
    // stay-in-place rewind. Same semantics as a group "stay": no trail entry.
    if (this.history[this.history.length - 1] !== frame) {
      this.history.push(frame);
    }
    this.historyIndex = this.history.length - 1;

    // Inside a sub, also record the qualified "score/frame" visit — barrier
    // sub refs ("Tetra/E") are matched against these, since plain history
    // entries are bare filenames and the sub history is dropped on exit.
    const top = this.subStack[this.subStack.length - 1];
    if (top) {
      const visited = `${top.score}/${frame}`.toLowerCase();
      if (!this.visitedSubFrames.includes(visited)) {
        this.visitedSubFrames.push(visited);
      }
    }
  }

  // Dive into sub-score `score`, remembering the main-flow `returnHref` to land
  // on when the sub ends. The sub runs with its own (fresh) history; the line's
  // main-flow history is SAVED (not wiped) so barrier coverage and the SM
  // history modal survive the round-trip. The caller then seeds the playhead at
  // the sub START via setCurrIdxTo.
  enterSub(score, returnHref) {
    this.subStack.push({ score, returnHref });
    this.savedHistories.push({
      history: this.history,
      historyIndex: this.historyIndex,
    });
    this.history = [];
    this.historyIndex = 0;
  }

  // Pop the current sub-session, returning its { score, returnHref } entry and
  // restoring the saved main-flow history. The caller sets the playhead to the
  // return landing in the main flow (appending it to the restored history).
  exitSub() {
    const popped = this.subStack.pop();
    const saved = this.savedHistories.pop();
    this.history = saved && Array.isArray(saved.history) ? saved.history : [];
    this.historyIndex =
      saved && saved.historyIndex != null
        ? saved.historyIndex
        : Math.max(0, this.history.length - 1);
    return popped;
  }

  setCurrIdxToStart() {
    const listFiles = this.session.listFiles;
    // random pick first index (files begin with Pre or Start)
    const listPreFile = listFiles.filter((o) => o.startsWith("PRE"));
    const listStartFile = listFiles.filter((o) => o.startsWith("START"));
    const startedFile = this.session.randomItem(
      listStartFile.length > 0 ? listStartFile : listPreFile,
    );

    this.setCurrIdxTo(listFiles.indexOf(startedFile));
  }

  resetHistory() {
    this.history = [];
    this.setCurrIdxToStart();
  }

  clearAllTimer() {
    if (this.holdingTimer != null) {
      clearTimeout(this.holdingTimer);
      this.holdingTimer = null;
    }
    if (this.standbyTimer != null) {
      clearTimeout(this.standbyTimer);
      this.standbyTimer = null;
    }
    if (this.votingTimer != null) {
      clearInterval(this.votingTimer);
      this.votingTimer = null;
    }
  }

  // ── Persistence ──────────────────────────────────────────────────────────

  toJSON() {
    const out = { id: this.id, uid: this.uid, status: this.status };
    for (const field of LINE_FIELDS) {
      out[field] = this[field];
    }
    // Timers never serialize; voting never resumes mid-window across a restart.
    for (const field of TIMER_FIELDS) {
      out[field] = null;
    }
    out.isVoting = false;
    return out;
  }

  static fromJSON(session, obj = {}) {
    const line = new BMLine(session, obj.id || DEFAULT_LINE_ID);
    if (obj.uid) {
      line.uid = obj.uid; // pre-uid state files keep the one minted above
    }
    if (obj.status) {
      line.status = obj.status;
    }
    for (const field of LINE_FIELDS) {
      if (obj[field] !== undefined) {
        line[field] = obj[field];
      }
    }
    // Timers + transient voting flag are never restored.
    for (const field of TIMER_FIELDS) {
      line[field] = null;
    }
    line.isVoting = false;

    // Defensive shape guarantees for fields the runtime indexes into.
    if (!Array.isArray(line.history)) line.history = [];
    if (!Array.isArray(line.pendingHoldUntil)) line.pendingHoldUntil = [];
    if (!Array.isArray(line.subStack)) line.subStack = [];
    if (!Array.isArray(line.savedHistories)) line.savedHistories = [];
    if (!Array.isArray(line.visitedSubFrames)) line.visitedSubFrames = [];
    if (!Array.isArray(line.splitAncestors)) line.splitAncestors = [];

    return line;
  }
}

/**
 * The parent line ids a still-undoable split event would have to restore, so
 * neither `pruneRetiredLines` nor `allocLineId` may give their numbers away.
 *
 * A `blockedByMerge` event reserves nothing: a later merge mixed its subtree
 * with another's, so its rewind is refused (`splitRewindPlan` returns
 * `mixed-merge` before it ever looks the parent up) and holding a number for it
 * would keep the room's numbering climbing for an undo that can never run.
 */
function reservedParentLineIds(splitEvents) {
  return new Set(
    (Array.isArray(splitEvents) ? splitEvents : [])
      .filter(
        (event) =>
          event &&
          event.status === "active" &&
          !event.blockedByMerge &&
          event.parentLineId,
      )
      .map((event) => event.parentLineId),
  );
}

/**
 * Drop hard-retired lines nothing can address any more, so their NUMBERS become
 * free again (`allocLineId` hands out the lowest unused one — a room that
 * splits and merges all evening keeps reading L0/L1/L2 instead of climbing).
 *
 * A retired line is KEPT while an undoable split event names it as its parent
 * (above): the structural undo must still find it. That covers legacy events
 * recorded before a split's first branch began CONTINUING the parent's line
 * (their parent is a retired object), and events whose continuing line was
 * later absorbed by a merge. A merge-ABSORBED line is not kept: its number
 * goes back in the pool the moment the rejoin runs, and its merge undo
 * RE-CREATES it from the snapshot instead of holding the object — which is
 * what lets a merge stay undoable for the rest of the session without the
 * room's numbering climbing. Everything else retired — the siblings a split
 * undo collapsed — is unreachable by id and goes.
 *
 * Works on a live BMSession and on a plain persisted state object alike (both
 * carry `lines` + `splitEvents`); `lines` is REPLACED in place.
 *
 * @returns {string[]} the ids dropped.
 */
function pruneRetiredLines(holder) {
  if (!holder || !Array.isArray(holder.lines)) {
    return [];
  }
  const reserved = reservedParentLineIds(holder.splitEvents);
  const kept = [];
  const dropped = [];
  for (const line of holder.lines) {
    if (line && line.status === "retired" && !reserved.has(line.id)) {
      dropped.push(line.id);
    } else {
      kept.push(line);
    }
  }
  if (dropped.length > 0) {
    holder.lines = kept;
  }
  return dropped;
}

/**
 * Give a restored room the durable identities the structural undos run on.
 *
 * A state file written before `uid` existed carries none — not on its lines and
 * not on its `splitEvents` — and the lines are handed fresh uids at load. A
 * merge recorded AFTER the restart therefore keys on real uids while the older
 * split still keys on `id:<number>` (`eventLineKeys`'s fallback), the two never
 * intersect, and `structuralRewindChain` hands that split an EMPTY chain: the
 * undo collapses the subtree while leaving a merge standing on top of it, with
 * a snapshot that will restore a pre-merge trail onto a line that no longer
 * exists. That is the upgrade path for any room mid-session across this deploy,
 * so it is repaired here rather than guarded downstream.
 *
 * Lines are stamped first (`fromJSON` keeps a uid it finds, so this is what the
 * BMLine ends up with). Events are then stamped only where the room CORROBORATES
 * the number — a child number must resolve to a line whose own `splitAncestors`
 * names this event — because a wrong uid is worse than none: it would drag an
 * unrelated branch into a cascade. Anything that cannot be corroborated is
 * marked `expired`, which the existing machinery already reads as "not
 * offerable, and blocks any walk that would cross it".
 *
 * Merge events are never stamped: a merge's absorbed participants have no line
 * objects left to corroborate against, so their identities are simply gone.
 * (They only appear in files written by a server that already had uids, so in
 * practice this expires nothing.)
 */
function migrateStructuralIdentities(state) {
  const lines = Array.isArray(state.lines) ? state.lines : [];
  for (const line of lines) {
    if (line && !line.uid) {
      line.uid = newLineUid();
    }
  }
  for (const event of Array.isArray(state.splitEvents) ? state.splitEvents : []) {
    if (!event || event.status !== "active") continue;
    if (Array.isArray(event.childLineUids) && event.childLineUids.length > 0) {
      continue;
    }
    const key = String(event.id);
    const uids = (event.childLineIds || []).map((id) => {
      const line = lines.find(
        (candidate) =>
          candidate &&
          candidate.id === id &&
          (candidate.splitAncestors || []).map(String).includes(key),
      );
      return line ? line.uid : null;
    });
    if (uids.length > 0 && uids.every(Boolean)) {
      event.childLineUids = uids;
      continue;
    }
    event.status = "expired";
    event.expiredAt = Date.now();
  }
  for (const event of Array.isArray(state.mergeEvents) ? state.mergeEvents : []) {
    if (!event || event.status !== "active") continue;
    const identified = (event.participants || []).every(
      (snapshot) => snapshot && snapshot.lineUid,
    );
    if (identified) continue;
    event.status = "expired";
    event.expiredAt = Date.now();
  }
  return state;
}

/**
 * Migrate a stored session-state object to the v2 shape (`lines: [one]`).
 *
 * v1 (today's format) is flat: per-line fields (currentIndex, history, voting,
 * holding, …) sit directly on the session object. v2 nests them inside a single
 * line. A vanilla, never-split session round-trips as exactly one line, so
 * behavior is unchanged.
 *
 * Applied only to FULL state objects on load — never to the partial patches
 * bin/www / routes pass to patchState (those carry no per-line flat fields).
 */
function migrateState(state) {
  if (!state || typeof state !== "object") {
    return state;
  }
  if (state.version >= 2 && Array.isArray(state.lines)) {
    // Already v2 — but a pre-uid server's events cannot chain (above), and a
    // pre-recycling server's retired lines are holding numbers the next split
    // wants back.
    migrateStructuralIdentities(state);
    pruneRetiredLines(state);
    return state;
  }

  const line = { id: DEFAULT_LINE_ID, status: "active" };
  for (const field of LINE_FIELDS) {
    if (field in state) {
      line[field] = state[field];
    }
  }
  // New coordination fields may be absent in a v1 file.
  if (!Array.isArray(line.pendingHoldUntil)) line.pendingHoldUntil = [];
  if (!Array.isArray(line.subStack)) line.subStack = [];
  if (line.pendingRejoinAt === undefined) line.pendingRejoinAt = null;
  if (line.trackGroup === undefined) line.trackGroup = null;
  if (!Array.isArray(line.history)) line.history = [];
  if (line.isBarrierWaiting === undefined) line.isBarrierWaiting = false;
  if (line.isGroupWaiting === undefined) line.isGroupWaiting = false;
  if (!Array.isArray(line.savedHistories)) line.savedHistories = [];
  if (!Array.isArray(line.visitedSubFrames)) line.visitedSubFrames = [];
  if (!Array.isArray(line.splitAncestors)) line.splitAncestors = [];

  const migrated = { ...state };
  // Move the per-line flat fields off the top level so they can't shadow the
  // session shim, and drop fields buildSVGContent re-derives on load.
  for (const field of LINE_FIELDS) {
    delete migrated[field];
  }
  for (const key of [
    "listFiles",
    "listFilesInLowerCase",
    "listMultiChooseImages",
    "graph",
    "hasSessionLines",
  ]) {
    delete migrated[key];
  }

  migrated.version = 2;
  migrated.lines = [line];
  migrated.deviceRegistry = state.deviceRegistry || {};
  migrated.splitEvents = Array.isArray(state.splitEvents)
    ? state.splitEvents
    : [];
  migrated.nextSplitEventId =
    state.nextSplitEventId != null ? state.nextSplitEventId : 1;
  migrated.mergeEvents = Array.isArray(state.mergeEvents)
    ? state.mergeEvents
    : [];
  migrated.nextMergeEventId =
    state.nextMergeEventId != null ? state.nextMergeEventId : 1;
  migrated.nextStructuralSeq =
    state.nextStructuralSeq != null ? state.nextStructuralSeq : 1;
  migrateStructuralIdentities(migrated);
  return migrated;
}

module.exports = {
  BMLine,
  pruneRetiredLines,
  reservedParentLineIds,
  LINE_FIELDS,
  TIMER_FIELDS,
  DEFAULT_LINE_ID,
  migrateState,
};
