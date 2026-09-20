/**
 * Session Lines — orchestration logic (pure).
 *
 * The decision functions here are the brains of Phase 3: split partitioning,
 * barrier (hold-until) satisfaction, rejoin (merge) survivor selection,
 * track-group window resolution (incl. the global STAY rule) and the small
 * index helpers used when a line dives into / returns from a sub-score.
 *
 * No express/ws/fs imports — every function is a pure transform over plain data,
 * so they are unit-testable in isolation. `createOrchestrator(transport)` wraps a
 * subset of them with injected senders + a line factory so bin/www can drive the
 * runtime (and tests can drive it with a fake transport).
 *
 * Single-line / vanilla invariant: nothing in here runs unless the caller has
 * already gated on `session.hasSessionLines`.
 */

const { lineIdNum, isSpectatorConn } = require("./routing");
const { pruneRetiredLines, reservedParentLineIds } = require("./line");

const lc = (s) => String(s).toLowerCase();

// ── Split ────────────────────────────────────────────────────────────────────

/**
 * Partition the members of a splitting line into N child lines.
 *
 * Choosers (a member with an in-range integer `choice`) go to the child they
 * tapped. Non-choosers are auto-assigned to BALANCE line sizes: each is placed
 * in the currently-smallest child bucket (ties → lowest child index), which both
 * keeps every child populated and minimizes empties (decision #2).
 *
 * @param {Array<{choice?: (number|null)}>} members
 * @param {number} n number of child lines
 * @returns {{assignment: number[], counts: number[]}}
 *   `assignment[i]` = child slot (0..n-1) for members[i]; `counts` = per-child size.
 */
function planSplitPartition(members, n) {
  const list = Array.isArray(members) ? members : [];
  const counts = new Array(Math.max(0, n)).fill(0);
  const assignment = new Array(list.length).fill(-1);
  if (n <= 0) {
    return { assignment, counts };
  }

  const isChoice = (c) => Number.isInteger(c) && c >= 0 && c < n;

  // Pass 1: honour explicit choices.
  list.forEach((m, i) => {
    const c = m && m.choice;
    if (isChoice(c)) {
      assignment[i] = c;
      counts[c]++;
    }
  });

  // Pass 2: balance the rest into the smallest bucket.
  list.forEach((m, i) => {
    if (assignment[i] === -1) {
      let best = 0;
      for (let k = 1; k < n; k++) {
        if (counts[k] < counts[best]) best = k;
      }
      assignment[i] = best;
      counts[best]++;
    }
  });

  return { assignment, counts };
}

/**
 * A split partition's slots as the client vote ids of the links they mean.
 *
 * A split frame has no single winning vote — the line DIVIDES — so instead of
 * one shared winner every device is shown the child link IT is going to. Slot k
 * is the frame's k-th link (planSplitPartition's slots are positions in
 * `childFrameIndices`, which is `frameLinks[frame]`), so the id's aEleIndex is
 * the slot itself: the same "target#frame#ordinal" shape `outgoingVoteIds`
 * builds, and the same id that link's `<a>` carries in the page.
 *
 * @param {string} frameName the split frame
 * @param {number[]} childFrameIndices ordered child frame indices (frameLinks)
 * @param {number[]} assignment per-member child slots (planSplitPartition)
 * @returns {Array<string|null>} destination vote id per member, index-aligned.
 */
function splitDestinationVoteIds(frameName, childFrameIndices, assignment) {
  const children = Array.isArray(childFrameIndices) ? childFrameIndices : [];
  return (assignment || []).map((slot) => {
    const frameIdx = children[slot];
    return frameIdx == null ? null : `${frameIdx}#${frameName}#${slot}`;
  });
}

/**
 * Resolve a tap/vote selectedId ("nextVoteId#currFileName#aEleIndex") to a frame
 * index. "stay" (or anything non-numeric) yields the supplied fallback.
 */
function parseVoteTargetIndex(selectedId, fallbackIndex = -1) {
  if (selectedId == null) return fallbackIndex;
  const head = String(selectedId).split("#")[0];
  if (head === "" || head === "stay") return fallbackIndex;
  const n = Number(head);
  return Number.isNaN(n) ? fallbackIndex : n;
}

// Outgoing links in the same vote-id shape the client uses:
// "nextVoteId#currFileName#aEleIndex". `frameLinks` preserves SVG link order;
// invalid/unresolved links are ignored.
function outgoingVoteCandidates(
  frameLinks,
  frameList,
  frameName,
) {
  if (!frameLinks || !frameList || !frameName) {
    return [];
  }
  const exact = frameLinks[frameName];
  const links =
    exact ||
    frameLinks[
      Object.keys(frameLinks).find((name) => lc(name) === lc(frameName))
    ];
  if (!Array.isArray(links)) {
    return [];
  }
  return links
    .map((idx, ordinal) => ({ idx, ordinal }))
    .filter(
      ({ idx }) =>
        Number.isInteger(idx) && idx >= 0 && idx < frameList.length,
    );
}

function outgoingVoteIds(frameLinks, frameList, frameName) {
  return outgoingVoteCandidates(frameLinks, frameList, frameName).map(
    ({ idx, ordinal }) => `${idx}#${frameName}#${ordinal}`,
  );
}

/**
 * Every frame index this frame can legitimately send a line to — the authority
 * a tap's destination is checked against before anything moves.
 *
 * The ORDINAL is deliberately not part of the answer. A vote id's third field
 * counts `<a>` tags in the built SVG, while `frameLinks` indexes only the ones
 * that RESOLVED, so an authored link with no href shifts them apart; matching
 * whole vote ids would refuse legitimate taps on such a frame. The destination
 * is what a mutation acts on, and that is what this pins down.
 *
 * @returns {number[]|null} null when the graph cannot speak for the frame at
 *   all (a vanilla score builds no `frameLinks`, or the name is unknown) — the
 *   caller then falls back to a plain bounds check. An empty array is an
 *   ANSWER: the frame is a dead end and no destination is legitimate.
 */
function outgoingTargetIndices(frameLinks, frameList, frameName) {
  if (!frameLinks || !frameName) {
    return null;
  }
  const key = Object.hasOwn(frameLinks, frameName)
    ? frameName
    : Object.keys(frameLinks).find((name) => lc(name) === lc(frameName));
  if (key === undefined) {
    return null;
  }
  return outgoingVoteCandidates(frameLinks, frameList, frameName).map(
    ({ idx }) => idx,
  );
}

function defaultOutgoingVoteId(
  frameLinks,
  frameList,
  frameName,
  randomFn = Math.random,
) {
  const candidates = outgoingVoteCandidates(frameLinks, frameList, frameName);
  if (candidates.length === 0) {
    return null;
  }
  const chosen =
    candidates.length === 1
      ? candidates[0]
      : candidates[Math.floor(randomFn() * candidates.length)];
  return `${chosen.idx}#${frameName}#${chosen.ordinal}`;
}

/**
 * Resolve a tap's `selectedId` to the frame index it may move a line to — or
 * null, meaning the tap is refused and NOTHING is touched.
 *
 * A vote id is "target#sourceFrame#ordinal", built into the score's own markup
 * and handed straight back by the page that was tapped. Until now it was handed
 * straight back INTO the line: the instant-advance path called
 * `setCurrIdxTo(Number(head))` on whatever arrived. Three things went through
 * that door.
 *
 *  - A destination the frame does not link to. The tally-time resolution
 *    validates a winning vote against the frame's links; the instant path has
 *    no tally, so a message naming any index at all repositioned the line.
 *  - A destination out of range, or not a number at all — and `NaN` is the one
 *    a REAL client produces, by tapping STAY on a zero-duration frame
 *    (`Number("stay")`). The playhead and its trail took a value no frame
 *    answers to, and the line was unreachable for the rest of the session.
 *  - A tap sent from somewhere else. The client index guards which FRAME INDEX
 *    the page thinks it is on, but a line inside a sub-score indexes the sub's
 *    list, so an index alone does not say which frame. The vote id carries its
 *    source frame; checking it makes a stale page's tap a refusal rather than a
 *    move the score never authored.
 *
 *  - A tap sent from another SCORE. A filename and an index do not identify a
 *    frame across a dive: a main score and its sub can both open on
 *    `START.svg` at index 0, so a main-flow tap delayed past the dive named
 *    the sub's START as its source and advanced the sub along a link the
 *    performer never saw. The page therefore reports the dive context it is
 *    DISPLAYING (`context`, the `diveContextKey` the server last sent it),
 *    and a caller that knows the line's own (`lineContext`) has the tap
 *    refused unless the two agree.
 *
 * STAY resolves to `currentIndex` — the frame the line is already on — which
 * callers read as "no movement" rather than a jump to index NaN.
 *
 * @param {object} a
 * @param {string} a.selectedId the tap's vote id
 * @param {string} a.frameName the frame the line is standing on
 * @param {string[]} a.frameList the ACTIVE frame list (the sub's, mid-dive)
 * @param {Object<string,number[]>} [a.frameLinks] the active score's link graph
 * @param {number} a.currentIndex where the line is now
 * @param {string} [a.context] the dive context the tapping page displays
 * @param {string} [a.lineContext] the line's own; omitted ⇒ not checked
 * @returns {number|null}
 */
function validateTapTarget({
  selectedId,
  frameName,
  frameList,
  frameLinks,
  currentIndex,
  context,
  lineContext,
}) {
  if (selectedId == null || selectedId === "") {
    return null;
  }
  if (lineContext !== undefined && context !== lineContext) {
    return null;
  }
  const [head, sourceFrame] = String(selectedId).split("#");

  // The complete source context: this tap was authored on the frame the line
  // is standing on. Omitted (the page's own STAY button carries no frame) ⇒
  // the client index alone stands, exactly as before.
  if (
    sourceFrame != null &&
    sourceFrame !== "" &&
    frameName &&
    lc(sourceFrame) !== lc(frameName)
  ) {
    return null;
  }

  if (head === "stay") {
    return currentIndex;
  }

  const list = frameList || [];
  const idx = Number(head);
  if (!Number.isInteger(idx) || idx < 0 || idx >= list.length) {
    return null;
  }

  // …and the destination is one this frame actually offers. `null` means the
  // graph cannot speak for the frame (a vanilla score builds no `frameLinks`),
  // and the bounds check above is then the whole answer — vanilla behavior
  // unchanged. An EMPTY list is an answer: a dead-end frame offers nothing.
  const allowed = outgoingTargetIndices(frameLinks, list, frameName);
  if (allowed && !allowed.includes(idx)) {
    return null;
  }
  return idx;
}

/**
 * The dive a line is in, as one comparable string: every level's sub-score and
 * the return landing it will come back out on, outermost first. `""` is the
 * main flow.
 *
 * The return landing is part of it because it is part of where the line IS:
 * two visits to the same sub that return to different frames are different
 * places, even standing on the same sub frame with the same trail — merging
 * them, or grouping them as one convergence, would have to choose one way back
 * out. Frames are compared case-insensitively everywhere else, so here too.
 *
 * @param {Array<{score: string, returnHref: string}>} subStack
 * @returns {string}
 */
function diveContextKey(subStack) {
  return (subStack || [])
    .map((entry) => `${entry.score}>${lc(String(entry.returnHref))}`)
    .join("|");
}

// ── Hold-until barrier ───────────────────────────────────────────────────────

/**
 * A hold-until barrier releases once every named target frame has been reached
 * (decision #6 / spec runtime step 5). `reached` is the set of target frames
 * covered so far (case-insensitive).
 *
 * @param {string[]} targets frame names this barrier waits on
 * @param {Iterable<string>} reached frames already reached
 */
function holdUntilSatisfied(targets, reached) {
  const list = Array.isArray(targets) ? targets : [];
  if (list.length === 0) return true;
  const set = reached instanceof Set ? reached : new Set(reached || []);
  const lowered = new Set([...set].map(lc));
  return list.every((t) => lowered.has(lc(t)));
}

/**
 * A hold-until barrier still has a viable future only if every missing target
 * can still be reached by at least one candidate line. The caller decides which
 * lines are eligible candidates (active, populated, unparked, etc.) and how a
 * target ref resolves in the live score graph.
 *
 * @param {string[]} targets all barrier targets
 * @param {Iterable<string>} covered targets already done in the registry
 * @param {Array} candidates lines that can still drive navigation
 * @param {(line: object, target: string) => boolean} canReachTarget
 * @returns {{missingTargets: string[], unreachableTargets: string[], reachable: boolean}}
 */
function holdUntilReachabilityState(
  targets,
  covered,
  candidates,
  canReachTarget,
) {
  const set = covered instanceof Set ? covered : new Set(covered || []);
  const lowered = new Set([...set].map(lc));
  const missingTargets = (targets || []).filter((t) => !lowered.has(lc(t)));
  const lines = Array.isArray(candidates) ? candidates : [];
  const reachableFn =
    typeof canReachTarget === "function" ? canReachTarget : () => false;
  const unreachableTargets = missingTargets.filter(
    (target) => !lines.some((line) => reachableFn(line, target)),
  );
  return {
    missingTargets,
    unreachableTargets,
    reachable: unreachableTargets.length === 0,
  };
}

/**
 * The STRAGGLERS of a hold-until barrier — the same idea as
 * `groupStragglerIds` one step over. A track group waits for lines to ARRIVE
 * on it; a hold-until waits for some line to REACH a named target, so the
 * lines it is really held open for are the ones that can still get there.
 * Until now they were nobody: the entry carried no stragglers at all and the
 * operator's only valve on a stuck hold-until was the plain release (let it go
 * without the target), never "send in the line that still owes it".
 *
 * Each straggler is paired with the frame a forced advance would drop it on:
 * the first missing target (author order) it can reach AND that `canLandOn`
 * accepts. `canLandOn` is asked per line, because a sub-qualified ref
 * ("Tetra/Echo.svg") resolves to a landing only if the score offers a way into
 * that sub the line could have taken. Where nothing resolves, the line is still
 * a straggler (the barrier IS waiting on it) but carries a null target, so the
 * UI can say why it offers no button instead of offering an inert one.
 *
 * @param {{missingTargets?: string[]}} state a holdUntilReachabilityState result
 * @param {{lines: Array, canReachTarget: (line, target)=>boolean,
 *   canLandOn?: (target, line)=>boolean}} opts `lines` is the same candidate
 *   collection the state was computed over (active, populated, unparked)
 * @returns {Array<{lineId: string, target: string|null}>}
 */
function holdUntilStragglerTargets(state, opts) {
  const canReach = (opts && opts.canReachTarget) || (() => false);
  const canLandOn = (opts && opts.canLandOn) || (() => true);
  const missing = (state && state.missingTargets) || [];
  const out = [];
  for (const line of (opts && opts.lines) || []) {
    if (!line || line.id == null) continue;
    const reachable = missing.filter((target) => canReach(line, target));
    if (reachable.length === 0) continue;
    out.push({
      lineId: line.id,
      target: reachable.find((target) => canLandOn(target, line)) || null,
    });
  }
  return out;
}

// Rendezvous registry phases (decision #6): a barrier target counts once ANY
// line has reached that frame anywhere in the session AND the frame's own
// holding period there has ended — the waiting lines stay parked at their own
// frames; they do not have to converge on the target.
const REACHED_ARRIVED = "arrived";
const REACHED_DONE = "done";

/**
 * Record a playhead landing in the session-global reached registry
 * (`session.reachedTargets`). Refs are stored lowercased; frames inside a sub
 * use the qualified "score/frame" form (matching hold-until sub refs). Phases
 * only move forward: "arrived" → "done" (done = the frame's own holding
 * period ended — or was never going to run).
 *
 * @param {Object<string,string>} reachedTargets mutable registry
 * @param {string} ref frame ref ("E.svg" or "Tetra2/End.svg")
 * @param {boolean} [done] mark the ref fully satisfied
 * @returns {boolean} true when the ref BECAME done (the edge on which open
 *   barriers must be re-checked)
 */
function markReached(reachedTargets, ref, done = false) {
  if (!reachedTargets || typeof ref !== "string" || ref === "") {
    return false;
  }
  const key = lc(ref);
  const prev = reachedTargets[key];
  if (done) {
    if (prev === REACHED_DONE) return false;
    reachedTargets[key] = REACHED_DONE;
    return true;
  }
  if (!prev) {
    reachedTargets[key] = REACHED_ARRIVED;
  }
  return false;
}

/**
 * The subset of a barrier's targets satisfied by the global reached registry —
 * rendezvous semantics: reached by any line, anywhere, ever (and that frame's
 * hold ended). Main refs ("E.svg") and qualified sub refs ("Tetra2/End.svg")
 * are looked up the same way.
 *
 * `claimants` (from `registryClaimants`) is what keeps the registry honest when
 * a passage is REPLAYED. The registry is a one-way latch and only a ROOM rewind
 * restarts it — the per-line rewind, the dive rollback and the structural undos
 * deliberately leave it alone, because the ROOM did not rewind. So a passage
 * walked a second time (which is what those undos are FOR: "this replays the
 * passage, it does not unmake it") used to meet its own `hold-until` frames
 * already satisfied, and a wait that is already met is not a wait: on the
 * owner's score `E` waited on `F`/`G`, both marked done 42 minutes earlier,
 * while the two lines that had since been rewound behind them were still inside
 * their sub-scores. Passing the claimant set asks a second question of every
 * mark — can any line still ACCOUNT for it? — and a rewind un-reaches what it
 * un-walks for free, because it is the trails that answer.
 *
 * `holds` is the other half of the same honesty, on the clock rather than the
 * trails (owner: "hold-until should also wait for other lines to finish their
 * intrinsic hold period to unlock — based on the target intrinsic holding period
 * instead of general holding state, to prevent holding block between hold-until
 * notes"). It answers, per ref, the question the latch cannot:
 *
 * - **`holdingNow`** — a line is standing on that frame with the frame's own
 *   holding period still to play, so it has NOT been played out and the wait is
 *   not over, whatever the latch says. The latch only ever moves forward
 *   (`markReached` never downgrades a `done`), so a frame played out in an
 *   earlier pass carries its `done` for the rest of the session — and once the
 *   corroboration above lets a rewound line restore that mark by stepping back
 *   onto the frame, the mark came back the instant the line LANDED rather than
 *   when it played the note. A barrier would then unlock on a rendezvous that is
 *   still in progress, which is the owner's report: "hold-until should also wait
 *   for other lines to finish their intrinsic hold period".
 * - **`playedOut`** — the frame has been reached and nothing is left to play
 *   there, so an `arrived` mark counts too. A landing is `arrived` until an
 *   EVENT ends its holding period (a timer firing, a departure), and when no
 *   such event is ever going to come — the operator toggled the room's hold, a
 *   state file was saved mid-hold and restored with `isHolding` true and no
 *   timer (§16), an operator advance landed the line phase-free — the mark stays
 *   `arrived` for ever and every barrier naming that frame waits on an edge that
 *   cannot happen.
 *
 * Both are asked of the FRAME's intrinsic holding period rather than of the
 * line's general holding state, and that is what keeps two `hold-until` frames
 * naming each other from blocking: a line parked at its own barrier has had its
 * hold EXTENDED by that barrier, so its holding STATE does not end until the
 * barrier releases — while the frame's authored period ends on its own clock. Ask
 * the state and `E` waits for `F` to leave while `F` waits for `E`; ask the frame
 * and both are played out on time and the room releases together.
 *
 * @param {Object<string,string>} reachedTargets session-global registry
 * @param {string[]} targets
 * @param {Set<string>} [claimants] lowercased refs the room can still account
 *   for; omitted, every `done` mark counts (the pre-corroboration reading, kept
 *   for pure registry-phase assertions)
 * @param {{playedOut?: Set<string>, holdingNow?: Set<string>}} [holds] the clock
 *   reading, lowercased refs (bin/www `holdRefStates`)
 * @returns {Set<string>} the subset of `targets` (original casing) covered
 */
function registryCoveredTargets(reachedTargets, targets, claimants, holds) {
  const covered = new Set();
  const reg = reachedTargets || {};
  const playedOut = (holds && holds.playedOut) || null;
  const holdingNow = (holds && holds.holdingNow) || null;
  for (const target of targets || []) {
    const key = lc(target);
    const phase = reg[key];
    if (!phase) continue; // nobody has ever been there
    if (holdingNow && holdingNow.has(key)) continue; // being played right now
    if (phase !== REACHED_DONE && !(playedOut && playedOut.has(key))) continue;
    if (claimants && !claimants.has(key)) continue;
    covered.add(target);
  }
  return covered;
}

/**
 * Every frame ref the room can still account for having been on — the trails,
 * plus the snapshots that hold the trails a split or a merge took away, plus
 * whatever an operator rewind granted outright.
 *
 * Only the records answer here; nothing is guessed:
 *
 * - **Every line that is not retired** contributes its own trail. A line mid-
 *   dive keeps its main trail in `savedHistories`, so those are read too, and
 *   its in-sub `history` is deliberately NOT: those entries are bare sub frame
 *   names ("START.svg"), which would corroborate the MAIN frame of the same
 *   name. The qualified form of exactly those landings is in `visitedSubFrames`.
 * - **`visitedSubFrames` is never trimmed**, so a sub frame stays reached once
 *   a line has stood on it. That is the dive rollback's own rule, decided by
 *   the owner ("the sub frames the line reached stay reached, because it really
 *   did stand on them"), and it falls out of the records rather than being
 *   special-cased here.
 * - **An ACTIVE split event** contributes its parent's history: a split
 *   truncates the trails it forks (§6), so a frame the room crossed before the
 *   fork is in no child's trail though the room demonstrably walked it. Undo
 *   the split and the parent comes back carrying that history itself, which is
 *   why an `undone` event is ignored — its evidence would outlive the rewinds
 *   that follow it.
 * - **An ACTIVE merge event** contributes each participant's snapshot for the
 *   same reason: an absorbed line's own object is gone. Undoing the merge
 *   restores those lines with those trails, so again, `undone` counts for
 *   nothing. An `expired` event of either kind DOES count: it can never be
 *   undone, so nothing will ever hand those trails back, and the room did walk
 *   them.
 * - **`reachedGranted`** is the room rewind's landing carve-out (see
 *   `beginReachedGeneration`): targets the room is DECLARED to have met,
 *   belonging to no trail by construction.
 *
 * @param {object} session read-only: lines[], splitEvents[], mergeEvents[],
 *   reachedGranted[]
 * @returns {Set<string>} lowercased refs
 */
function registryClaimants(session) {
  const out = trailRefs(session, false);
  for (const ref of (session && session.reachedGranted) || []) {
    if (typeof ref === "string" && ref !== "") out.add(lc(ref));
  }
  return out;
}

/**
 * Every frame ref the room demonstrably WALKED — `registryClaimants` without
 * the granted carve-out, which no line stood on. This is what the score map
 * paints green: a fork restarts every branch's trail and a rejoin retires the
 * lines it swallows, so the lines' own trails alone left the route before a
 * fork, the main route of a line mid-dive and every merged-away route blank.
 *
 * One difference from the claimants: a DORMANT line's own position is left
 * out. A split with fewer devices than branches seeds an empty line on every
 * branch nobody took, and that line's whole trail is the one frame it was
 * seeded on — a frame no device ever stood on. The map marks a dormant line's
 * position with its own grey fill and badge anyway, so leaving it out costs
 * nothing while the line stands there, and keeps the frame blank if the line
 * goes. (Barriers keep counting it: `registryClaimants` is unchanged.)
 *
 * Main-flow frames come back bare (`left.svg`), sub-score frames qualified
 * (`tetra/echo.svg`), all lowercased.
 *
 * @param {object} session read-only: lines[], splitEvents[], mergeEvents[]
 * @returns {Set<string>} lowercased refs
 */
function roomWalkedRefs(session) {
  return trailRefs(session, true);
}

/** Shared by `registryClaimants` and `roomWalkedRefs` — see both. */
function trailRefs(session, skipDormantPosition) {
  const out = new Set();
  const add = (ref) => {
    if (typeof ref === "string" && ref !== "") out.add(lc(ref));
  };
  const addTrail = (holder) => {
    if (!holder) return;
    if (!holder.subStack || holder.subStack.length === 0) {
      for (const frame of holder.history || []) add(frame);
    }
    for (const saved of holder.savedHistories || []) {
      for (const frame of (saved && saved.history) || []) add(frame);
    }
    for (const ref of holder.visitedSubFrames || []) add(ref);
  };

  for (const line of (session && session.lines) || []) {
    if (!line || line.status === "retired") continue;
    if (
      skipDormantPosition &&
      line.status === "dormant" &&
      !(line.subStack && line.subStack.length)
    ) {
      const history = line.history || [];
      const at =
        line.historyIndex == null ? history.length - 1 : line.historyIndex;
      addTrail({ ...line, history: history.filter((_, i) => i !== at) });
      continue;
    }
    addTrail(line);
  }
  const standing = (ev) =>
    !!ev && (ev.status === "active" || ev.status === "expired");
  for (const ev of (session && session.splitEvents) || []) {
    if (!standing(ev)) continue;
    for (const frame of ev.parentHistory || []) add(frame);
    for (const ref of ev.parentVisitedSubFrames || []) add(ref);
  }
  for (const ev of (session && session.mergeEvents) || []) {
    if (!standing(ev)) continue;
    for (const p of ev.participants || []) addTrail(p);
  }
  return out;
}

/**
 * SM jump = rewind: start a new reached generation (open-item S2/R4, option
 * (b)). Everything the registry accumulated belongs to the pre-rewind story,
 * so a barrier met again after the rewind gates like a first pass — even one
 * that was satisfied before. The ONE exception is the barrier AT the rewind
 * landing itself: the room already passed it, so its own targets are
 * pre-satisfied and it stays unlocked.
 *
 * Those pre-satisfied targets are also the one kind of mark no trail can
 * corroborate — the room is DECLARED to have met them, and the lines have just
 * been rewound behind the frames in question — so they are recorded in
 * `reachedGranted` as well, which `registryClaimants` accounts for. Without
 * that the carve-out would be undone by the corroboration check the same tick
 * it was granted.
 *
 * @param {object} session mutated: reachedGeneration++, reachedTargets reset,
 *   reachedGranted replaced, latestGroupArrival cleared (the revival
 *   fast-forward record belongs to the pre-rewind story too — the caller
 *   re-records it if the landing is grouped)
 * @param {string[]} [landingHoldTargets] the landing frame's own hold-until
 *   targets (empty/absent when the landing is not a barrier frame)
 */
function beginReachedGeneration(session, landingHoldTargets) {
  session.reachedGeneration = (session.reachedGeneration || 0) + 1;
  session.reachedTargets = {};
  session.reachedGranted = [];
  session.latestGroupArrival = null;
  for (const target of landingHoldTargets || []) {
    markReached(session.reachedTargets, target, true);
    session.reachedGranted.push(lc(target));
  }
}

/**
 * Un-park a line an SM jump is about to move (open-item S2/R4, mandatory under
 * history reading (i)): clear its barrier flags, drop it from every barrier
 * entry's parked set, and delete entries left empty (nothing waits there
 * anymore). Without this, a line jumped away from a barrier frame would stay
 * "parked" forever and keep ignoring taps after the barrier releases.
 *
 * @returns {boolean} true when barrier state changed (the caller should
 *   refresh the admins' barrier panel)
 */
function unparkLine(session, line) {
  let changed = line.isBarrierWaiting === true;
  line.isBarrierWaiting = false;
  line.pendingHoldUntil = [];
  const byFrame = (session._barrier && session._barrier.byFrame) || {};
  for (const frameName of Object.keys(byFrame)) {
    const entry = byFrame[frameName];
    if (entry.parked.delete(line.id)) {
      changed = true;
    }
    if (entry.parked.size === 0) {
      delete byFrame[frameName];
    }
  }
  return changed;
}

// ── Rejoin / merge ───────────────────────────────────────────────────────────

/**
 * All lines expected to converge at a rejoin point have arrived.
 *
 * @param {string[]} expectedLineIds lines designated to rejoin here
 * @param {Iterable<string>} arrivedLineIds lines that have parked here
 */
function rejoinSatisfied(expectedLineIds, arrivedLineIds) {
  const expected = Array.isArray(expectedLineIds) ? expectedLineIds : [];
  if (expected.length === 0) return false;
  const arrived = new Set(arrivedLineIds || []);
  return expected.every((id) => arrived.has(id));
}

/**
 * Pick the survivor of a merge: the lowest line id keeps its playhead + history;
 * the rest are absorbed (and hard-retired by the caller).
 *
 * @param {string[]} lineIds
 * @returns {{survivorId: (string|null), absorbedIds: string[]}}
 */
function planRecombine(lineIds) {
  const uniq = [...new Set((lineIds || []).filter(Boolean))];
  if (uniq.length === 0) return { survivorId: null, absorbedIds: [] };
  uniq.sort((a, b) => lineIdNum(a) - lineIdNum(b));
  return { survivorId: uniq[0], absorbedIds: uniq.slice(1) };
}

// ── Track groups ─────────────────────────────────────────────────────────────

/** The group name a frame belongs to (or null). */
function groupOfFrame(graph, frameName) {
  if (!graph || !frameName) return null;
  const node = (graph.byFrame || {})[frameName];
  if (node && node.trackGroup) return node.trackGroup;
  // Fall back to scanning groups (frame may be referenced by canonical name).
  for (const [name, members] of Object.entries(graph.groups || {})) {
    if ((members || []).some((m) => lc(m) === lc(frameName))) return name;
  }
  return null;
}

/** Lowercased frame names belonging to a track group. */
function groupFramesLower(graph, groupName) {
  const members = ((graph && graph.groups) || {})[groupName] || [];
  return members.map(lc);
}

/**
 * The lines currently sitting on a frame in the given group (votable subset only:
 * status 'active', not retired/dormant). `frameNameForLine(line)` resolves a
 * line's current frame name (injected so this stays pure).
 */
function linesOnGroupFrames(lines, frameNameForLine, groupFrames) {
  const set = new Set((groupFrames || []).map(lc));
  return (lines || []).filter((l) => {
    if (!l || l.status === "retired" || l.status === "dormant") return false;
    const fn = frameNameForLine(l);
    return fn != null && set.has(lc(fn));
  });
}

/**
 * Decision #13 revision: the landing frame for a dormant-line revival. A
 * revived line abandons its frozen (stale) position and lands where the ROOM
 * is — so the joiner who revived it plays with everybody else instead of
 * resurrecting an abandoned path.
 *
 * Where the room is has two shapes. While the latest track group is still
 * LIVE — some active line is standing on one of its frames — the room is
 * spread across that group, and the landing is its least-occupied frame, so
 * revivals fill missing track slots instead of doubling covered ones (ties →
 * the recorded arrival frame, then group declaration order).
 *
 * Once every line has LEFT that group the record is stale, and filling a slot
 * of it sends the joiner backwards into a passage the room has finished. A
 * room that has reached the end of the score is the case that made this
 * visible: the last group arrival still named a mid-score frame, so a player
 * joining a session sitting on `END` was dropped into the middle of the score
 * instead of being shown the ending. So the landing is then the room's own
 * front: the least-occupied of the frames the active lines currently occupy
 * (ties → frame-list order).
 *
 * Returns null — meaning "keep the frozen position" (the pre-revision
 * behavior) — when there is no recorded grouped landing, the recorded frame
 * is no longer grouped / no group frame resolves in the current frame list,
 * the line froze on the frame it would land on (leaving it would abandon the
 * slot), or the group is stale and there is no active line left to join.
 *
 * @param {object} opts
 * @param {object} opts.graph main-score graph (groups/byFrame)
 * @param {string[]} opts.listFiles main frame list
 * @param {string|null} opts.latestGroupFrame session.latestGroupArrival frame
 * @param {object} opts.line the reviving line (frozen position)
 * @param {(frameName: string) => number} opts.occupancy count of OTHER active
 *   main-flow lines currently sitting on the frame
 * @param {string[]} [opts.activeFrames] the frame each OTHER active main-flow
 *   line currently sits on — one entry per line, so repeats are occupancy
 * @returns {string|null} the frame NAME to land on, or null to revive in place
 */
function revivalLandingFrame({
  graph,
  listFiles,
  latestGroupFrame,
  line,
  occupancy,
  activeFrames,
}) {
  if (!latestGroupFrame) return null;
  const group = groupOfFrame(graph, latestGroupFrame);
  if (!group) return null;

  const listLower = (listFiles || []).map(lc);
  const present = (((graph && graph.groups) || {})[group] || []).filter(
    (name) => listLower.indexOf(lc(name)) >= 0,
  );
  if (present.length === 0) return null;

  const frozen =
    line && (!line.subStack || line.subStack.length === 0)
      ? (listFiles || [])[line.currentIndex]
      : null;

  // Is the group still the room's position? `activeFrames` is what says so.
  // Absent (a caller that does not supply it) the group is taken to be live,
  // which is the pre-liveness behavior.
  const occupied =
    activeFrames === undefined ||
    present.some((name) =>
      (activeFrames || []).some((frame) => lc(frame) === lc(name)),
    );

  let best = null;
  if (occupied) {
    if (frozen && present.some((name) => lc(name) === lc(frozen))) return null;
    for (const name of present) {
      const candidate = {
        name,
        count: occupancy ? occupancy(name) : 0,
        isRecorded: lc(name) === lc(latestGroupFrame),
      };
      if (
        best === null ||
        candidate.count < best.count ||
        (candidate.count === best.count && candidate.isRecorded && !best.isRecorded)
      ) {
        best = candidate;
      }
    }
  } else {
    // The room's front. Counted from `activeFrames` itself rather than through
    // `occupancy` so the two can never disagree about which frames are live.
    const counts = new Map();
    for (const frame of activeFrames || []) {
      if (!frame) continue;
      counts.set(lc(frame), (counts.get(lc(frame)) || 0) + 1);
    }
    for (const name of listFiles || []) {
      const count = counts.get(lc(name));
      if (count === undefined) continue;
      if (best === null || count < best.count) {
        best = { name, count };
      }
    }
    if (best && frozen && lc(best.name) === lc(frozen)) return null;
  }
  return best ? best.name : null;
}

function latestGroupTrailOccurrence(trail, groupFrames) {
  const set = new Set((groupFrames || []).map(lc));
  if (set.size === 0 || !Array.isArray(trail)) return null;
  for (let i = trail.length - 1; i >= 0; i--) {
    const frame = trail[i];
    if (set.has(lc(frame))) {
      return { index: i, frame };
    }
  }
  return null;
}

/**
 * Room-wide rewind checkpoints: track groups that every supplied line has
 * passed in its active trail. Callers decide which lines count as "currently
 * populated"; this helper treats every line it is given as checkpoint-blocking.
 *
 * A line PASSED a group if its own trail says so or, when a split truncated
 * that trail, if the route its forks recorded does (`groupOccurrenceForLine`) — the same test that places it there.
 *
 * @param {{lines: Array<{id:string, trail:string[], splitAncestors?:string[]}>, groups: Object<string,string[]>, splitEvents?: object[]}} opts
 * @returns {Array<{group:string, byLine:Object<string,string>}>} newest-first
 */
function commonCheckpoints({ lines, groups, splitEvents }) {
  const checkpointLines = (lines || []).filter((l) => l && l.id != null);
  if (checkpointLines.length === 0) {
    return [];
  }
  const checkpoints = [];
  for (const [group, frames] of Object.entries(groups || {})) {
    if (!Array.isArray(frames) || frames.length === 0) {
      continue;
    }
    const byLine = {};
    const indices = [];
    let ok = true;
    for (const line of checkpointLines) {
      const hit = groupOccurrenceForLine({ line, frames, splitEvents });
      if (!hit) {
        ok = false;
        break;
      }
      byLine[line.id] = hit.frame;
      indices.push(hit.index);
    }
    if (!ok) {
      continue;
    }
    checkpoints.push({
      group,
      byLine,
      // The checkpoint became common when the least-advanced relevant trail
      // reached it. Sum/max only make loop ties deterministic.
      order: Math.min(...indices),
      sum: indices.reduce((n, i) => n + i, 0),
      max: Math.max(...indices),
    });
  }
  checkpoints.sort(
    (a, b) =>
      b.order - a.order ||
      b.sum - a.sum ||
      b.max - a.max ||
      a.group.localeCompare(b.group),
  );
  return checkpoints.map(({ group, byLine }) => ({ group, byLine }));
}

function resolveGroupName(groups, group) {
  const wanted = lc(group || "");
  return (
    Object.keys(groups || {}).find((name) => lc(name) === wanted) || null
  );
}

function leastOccupiedFrame(groupFrames, occupancy) {
  let best = null;
  for (const name of groupFrames || []) {
    const count = occupancy ? occupancy(name) : 0;
    if (best === null || count < best.count) {
      best = { name, count };
    }
  }
  return best ? best.name : null;
}

/**
 * Where a line's ROUTE passed through a track group, when its own trail cannot
 * say.
 *
 * A split truncates the trails it forks from (§6): a line born at `H` starts
 * its history at the branch frame it took, so a group the room crossed BEFORE
 * that fork is nowhere in the line's own `trail` — even though the line was
 * demonstrably there, inside its parent. Every split event records the parent's
 * history at the moment it forked, and `splitAncestors` names those events
 * oldest-first, so the route is recoverable: walk it NEWEST-first and take the
 * first ancestor whose trail reaches the group. Newest-first because the line's
 * own trail begins where the newest split left off, so each older ancestor is a
 * step further back along one route.
 *
 * `index` is NEGATIVE and counts steps back from where this line's own trail
 * begins, so it orders against an own-trail index the way the route does: every
 * ancestry hit is older than anything the line walked itself, and a hit two
 * forks back is older than one just behind the newest fork.
 *
 * `route` is the same walk said in the vocabulary a MERGE scan needs: each
 * ancestor it passed through, as the identity that ancestor's merges were
 * recorded against, paired with the index in THAT line's trail the rewind is
 * returning to. The intermediate ancestors forked before ever reaching the
 * group, so their whole trail is on this side of the checkpoint and their index
 * is 0; the one that reaches it is pinned to the occurrence itself. Without it
 * a room rewind could only ask the merge question of the lines standing in the
 * room TODAY, whose uids postdate every fork — and a merge recorded against a
 * line a fork has since divided answered "not mine" to every one of them, so
 * the rewind undid the fork and left the rejoin standing (§8.14).
 *
 * @returns {{frame: string, eventId: string, index: number, route: Array<{lineId: string, lineUid: string, atIndex: number}>}|null}
 */
function ancestorGroupOccurrence({ line, splitEvents, frames }) {
  const ancestors = [...((line && line.splitAncestors) || [])].reverse();
  let behind = 0; // steps already walked back through the newer forks
  const route = [];
  for (const id of ancestors) {
    const event = (splitEvents || []).find(
      (candidate) => candidate && String(candidate.id) === String(id),
    );
    if (!event || !Array.isArray(event.parentHistory)) {
      continue;
    }
    const at =
      event.parentHistoryIndex == null
        ? event.parentHistory.length - 1
        : event.parentHistoryIndex;
    const trail = event.parentHistory.slice(0, at + 1);
    const hit = latestGroupTrailOccurrence(trail, frames);
    if (hit) {
      route.push({
        lineId: event.parentLineId,
        lineUid: event.parentLineUid,
        atIndex: hit.index,
      });
      return {
        frame: hit.frame,
        eventId: event.id,
        index: hit.index - trail.length - behind,
        route,
      };
    }
    route.push({
      lineId: event.parentLineId,
      lineUid: event.parentLineUid,
      atIndex: 0,
    });
    behind += trail.length;
  }
  return null;
}

/**
 * Where one line stands in a track group's history: its own trail if it
 * reaches the group, else the route its forks recorded.
 *
 * The single question both halves of a room rewind ask — `commonCheckpoints`
 * to decide whether the group is a checkpoint at all, `roomRewindPlan` to place
 * the line on it. They used to ask it differently, and a line whose trail a
 * split had truncated then blocked the very checkpoint the plan knew exactly
 * where to put it: the group vanished from the menu the moment the room forked
 * past it, so which checkpoints survived depended on which lines happened to be
 * carrying untruncated trails.
 *
 * @returns {{frame: string, index: number, source: ("history"|"ancestor")}|null}
 */
function groupOccurrenceForLine({ line, frames, splitEvents }) {
  const own = latestGroupTrailOccurrence((line || {}).trail, frames);
  if (own) {
    return { frame: own.frame, index: own.index, source: "history" };
  }
  const hit = ancestorGroupOccurrence({ line, splitEvents, frames });
  return hit
    ? {
        frame: hit.frame,
        index: hit.index,
        source: "ancestor",
        route: hit.route,
      }
    : null;
}

/**
 * Per-line landing plan for a room-wide rewind to `group`.
 *
 * `checkpointLines` should be the currently-populated line subset used to
 * decide whether the group is a legal checkpoint. `lines` is the full set of
 * non-retired lines to reposition.
 *
 * A line lands where it WAS: its own trail first, then — when a split
 * truncated that trail past the group — the route its `splitAncestors` record
 * (`ancestorGroupOccurrence`). Only a line with neither takes the
 * least-occupied group frame, which is a guess and was being asked to cover a
 * case the records answer exactly. Both of the landings a merge undo gives
 * back mid-rewind are that case: their trails begin at the branch frames of
 * the fork that made them, so a room rewound to the group its lines forked
 * AFTER put every restored line on whichever frame the fill reached first —
 * two lines and four players onto `G` while `H`, the frame one of those routes
 * actually came through, took the empty line.
 *
 * @param {object} opts
 * @param {Array<{id:string, trail:string[], splitAncestors?:string[]}>} opts.lines all lines to move
 * @param {Array<{id:string, trail:string[]}>} [opts.checkpointLines]
 * @param {object[]} [opts.splitEvents] session split records, for the ancestry
 * @param {Object<string,string[]>} opts.groups
 * @param {string} opts.group requested group name
 * @returns {{group:string, checkpoint:Object, lines:Array<{lineId:string, frame:string, source:string, historyIndex:number}>}|null}
 */
function roomRewindPlan({ lines, checkpointLines, groups, group, splitEvents }) {
  const resolvedGroup = resolveGroupName(groups, group);
  if (!resolvedGroup) {
    return null;
  }
  const checkpoints = commonCheckpoints({
    lines: checkpointLines || lines,
    groups,
    splitEvents,
  });
  const checkpoint =
    checkpoints.find((c) => lc(c.group) === lc(resolvedGroup)) || null;
  if (!checkpoint) {
    return null;
  }

  const frames = (groups || {})[resolvedGroup] || [];
  const occupancy = new Map(frames.map((name) => [lc(name), 0]));
  const plans = [];
  const fill = [];

  for (const line of lines || []) {
    if (!line || line.id == null) {
      continue;
    }
    const hit = groupOccurrenceForLine({ line, frames, splitEvents });
    if (hit) {
      plans.push({
        lineId: line.id,
        frame: hit.frame,
        source: hit.source,
        // An ancestry landing has no index in this line's OWN trail to rewind
        // to, so it APPENDS, exactly as a fill does.
        historyIndex: hit.source === "history" ? hit.index : -1,
        // …but the route it came by DOES have one, per ancestor, and that is
        // where this line's older rejoins are recorded (`mergesBehindRoomRewind`).
        route: hit.route || null,
      });
      occupancy.set(lc(hit.frame), (occupancy.get(lc(hit.frame)) || 0) + 1);
    } else {
      fill.push(line);
    }
  }

  // Last, and against an occupancy every recorded landing has already been
  // counted into: a guess must never take the frame a route is about to ask for.
  for (const line of fill) {
    const frame = leastOccupiedFrame(frames, (name) => occupancy.get(lc(name)) || 0);
    if (!frame) {
      return null;
    }
    occupancy.set(lc(frame), (occupancy.get(lc(frame)) || 0) + 1);
    plans.push({
      lineId: line.id,
      frame,
      source: "fill",
      historyIndex: -1,
      route: null,
    });
  }

  return { group: resolvedGroup, checkpoint, lines: plans };
}

// ── Structural timeline (splits + merges) ──────────────────────────────────

/**
 * The ONE ordering across splits and merges, oldest first.
 *
 * The two kinds live in separate append-only arrays with their own id
 * counters, so neither array alone says what happened between two events of
 * the other kind — and a cascade undo needs exactly that. `seq`, allocated
 * from a single session-wide counter, is that ordering. Records written before
 * it existed carry none and are not backfilled, so they fall back to
 * `createdAt`, and then to `at` — the order the caller assembled them in.
 *
 * Exported because the ROOM rewind sorts its own list of forks and rejoins
 * (bin/www `roomRewind`) and has to agree with every chain walk about which of
 * two events is newer. It carried a second comparator, which mapped a missing
 * `seq` onto a scaled `createdAt` so that every legacy event sorted below
 * every stamped one — a different rule that agreed with this one only through
 * the arithmetic of the scaling factor, with nothing holding the two together.
 *
 * `at` is optional; a caller that omits it leaves exact ties to its own stable
 * sort, which is the order it built the list in.
 *
 * @param {{event: object, at?: number}} a
 * @param {{event: object, at?: number}} b
 */
function compareStructural(a, b) {
  const sa = a.event.seq;
  const sb = b.event.seq;
  if (sa != null && sb != null && sa !== sb) return sa - sb;
  const ca = a.event.createdAt || 0;
  const cb = b.event.createdAt || 0;
  if (ca !== cb) return ca - cb;
  return (a.at || 0) - (b.at || 0);
}

/** Every structural event of the session, oldest first (`compareStructural`). */
function structuralEvents(session) {
  const out = [];
  for (const event of (session && session.splitEvents) || []) {
    if (event) out.push({ kind: "split", event, at: out.length });
  }
  for (const event of (session && session.mergeEvents) || []) {
    if (event) out.push({ kind: "merge", event, at: out.length });
  }
  return out.sort(compareStructural);
}

/**
 * The durable identities one structural event took apart or produced.
 *
 * Line NUMBERS are recycled, so "L1" in an event recorded an hour ago and the
 * L1 standing in the room now may be two different routes — which is why every
 * event records the participants' `uid` beside their number. A line with no uid
 * (a state file written before uids, a test fake) falls back to its number,
 * which is exactly the identity the room had before this change.
 */
function eventLineKeys(entry) {
  const keys = new Set();
  const add = (uid, id) => {
    if (uid) keys.add(String(uid));
    else if (id) keys.add(`id:${id}`);
  };
  if (!entry || !entry.event) return keys;
  const event = entry.event;
  if (entry.kind === "split") {
    add(event.parentLineUid, event.parentLineId);
    const uids = event.childLineUids || [];
    (event.childLineIds || []).forEach((id, i) => add(uids[i], id));
  } else {
    for (const snapshot of event.participants || []) {
      if (snapshot) add(snapshot.lineUid, snapshot.lineId);
    }
  }
  return keys;
}

/**
 * What has to be undone BEFORE one structural event can be — newest first, the
 * order the runtime walks (owner: "able to rewind back to multiple merge
 * points later still possible, not losing the route path").
 *
 * A merge used to be undoable only until the room took its next structural step
 * — the merged line split, and the rejoin stopped being separable for the rest
 * of the evening. That is the wrong shape for a score like FORK → MERGE1 →
 * FORK2 → MERGE2, where MERGE1 is a moment the operator may well want back an
 * hour later. It is undoable again by cascading: every LATER event standing on
 * the same population is undone first, newest-first, each one an ordinary
 * fully-validated snapshot restore, so the room walks back through its own
 * history rather than jumping to a state no snapshot describes.
 *
 * "Standing on the same population" is transitive and measured in line
 * identities (`eventLineKeys`): start from the target's participants, and any
 * later event touching one of them joins the chain and contributes its own
 * lines. Recycled numbers therefore do NOT drag an unrelated branch in — the
 * L2 a later fork minted is a different uid from the L2 this merge swallowed.
 *
 * The one thing that still blocks: an EXPIRED event in between (a room
 * checkpoint rewind repositioned the population wholesale, and nothing
 * describes where it stood). Undone events are simply skipped — that step of
 * the walk-back has already happened.
 *
 * @returns {{available: boolean, reason: (string|null), target: object,
 *   chain: object[], blocker?: object}} `chain` entries are
 *   `{kind, event}`, newest first.
 */
function structuralRewindChain({ session, kind, eventId }) {
  const events = structuralEvents(session);
  const at = events.findIndex(
    (entry) =>
      entry.kind === kind && String(entry.event.id) === String(eventId),
  );
  const staleReason = kind === "merge" ? "stale-merge" : "stale-split";
  if (at < 0) {
    return { available: false, reason: staleReason, target: null, chain: [] };
  }
  const target = events[at];
  if (target.event.status !== "active") {
    return {
      available: false,
      reason: target.event.status === "expired" ? "expired" : staleReason,
      target,
      chain: [],
    };
  }

  const affected = eventLineKeys(target);
  const chain = [];
  for (let i = at + 1; i < events.length; i++) {
    const entry = events[i];
    const keys = eventLineKeys(entry);
    let touches = false;
    for (const key of keys) {
      if (affected.has(key)) {
        touches = true;
        break;
      }
    }
    if (!touches) continue;
    // Already walked back — its lines are wherever its own undo put them.
    if (entry.event.status === "undone") continue;
    if (entry.event.status !== "active") {
      return {
        available: false,
        reason: "blocked-by-expired",
        target,
        blocker: entry,
        chain: [],
      };
    }
    chain.push(entry);
    for (const key of keys) affected.add(key);
  }
  chain.reverse();
  return { available: true, reason: null, target, chain };
}

// ── Structural split rewind ────────────────────────────────────────────────

function splitEventById(splitEvents, eventId) {
  return (
    (Array.isArray(splitEvents) ? splitEvents : []).find(
      (event) => event && String(event.id) === String(eventId),
    ) || null
  );
}

function lineSplitAncestors(line) {
  return Array.isArray(line && line.splitAncestors)
    ? line.splitAncestors.map(String)
    : [];
}

/**
 * Validate and describe an undo of one structural split event.
 *
 * Every non-retired line carrying the event id is a current descendant that
 * will collapse into the original parent. Later nested splits inherit the id,
 * so recursion falls out naturally. applyRecombine marks an event blocked when
 * a merge crosses its subtree boundary; such a merge cannot be separated again
 * without per-device ancestry, so the rewind is refused.
 */
function splitRewindPlan({ splitEvents, lines, eventId, expectedFrame }) {
  const event = splitEventById(splitEvents, eventId);
  if (!event || event.status !== "active") {
    return { available: false, reason: "stale-split" };
  }
  if (
    expectedFrame &&
    lc(expectedFrame) !== lc(event.frame)
  ) {
    return { available: false, reason: "stale-frame", event };
  }
  if (event.blockedByMerge) {
    return { available: false, reason: "mixed-merge", event };
  }

  const allLines = lines || [];
  const eventKey = String(event.id);
  const descendants = allLines.filter((line) =>
    lineSplitAncestors(line).includes(eventKey),
  );
  // The parent is either this split's CONTINUING first branch — it kept the
  // parent's number, so it is one of the event's own descendants — or, for an
  // event recorded before splits continued the parent, the retired object that
  // split left behind (kept out of `pruneRetiredLines` for exactly this). A
  // line that is neither means the number now names something unrelated.
  //
  // Found by ROUTE, because the number is not one: a merge undo re-creates an
  // absorbed line on the lowest FREE number when a fork has taken its own
  // (`freeLineId`), and the fork holding it is a different route entirely.
  // Asking for `parentLineId` therefore reads either nothing or somebody else,
  // and reported `parent-unavailable` for a split whose parent was standing
  // right there under another number. `childLineUids[0]` is the continuing
  // branch's durable identity; `parentLineUid` covers the older shape where the
  // split retired its parent. The number stays as the fallback for events
  // recorded before uids existed.
  const parentUids = [
    (event.childLineUids || [])[0],
    event.parentLineUid,
  ].filter(Boolean);
  const parent =
    (parentUids.length > 0
      ? allLines.find(
          (line) => line && line.uid && parentUids.includes(line.uid),
        )
      : null) ||
    allLines.find((line) => line && line.id === event.parentLineId);
  if (
    !parent ||
    (parent.status !== "retired" && !descendants.includes(parent))
  ) {
    return { available: false, reason: "parent-unavailable", event };
  }
  const liveDescendants = descendants.filter(
    (line) => line.status !== "retired",
  );
  if (liveDescendants.length === 0) {
    return { available: false, reason: "no-live-descendants", event };
  }

  const nestedEvents = (Array.isArray(splitEvents) ? splitEvents : []).filter(
    (candidate) =>
      candidate &&
      candidate.status === "active" &&
      (String(candidate.id) === eventKey ||
        (candidate.ancestorEventIds || []).map(String).includes(eventKey)),
  );

  return {
    available: true,
    reason: null,
    event,
    parent,
    descendants,
    liveDescendants,
    nestedEvents,
  };
}

/**
 * What one structural undo takes off ON THE WAY, as the map's confirm names it
 * — newest first, with each merge CONVERGENCE folded to a single step (three
 * lines meeting at one frame is two events but one thing the operator watched
 * happen, and one gesture undoes it).
 *
 * `folded` pre-seeds the fold set with events that are not "on the way" at all
 * because they ARE the undo — a target merge's own convergence.
 */
function cascadeSteps({ chain, mergeEvents, folded = [] }) {
  const foldedIds = new Set(folded.map(String));
  const steps = [];
  for (const entry of chain || []) {
    if (entry.kind === "merge") {
      if (foldedIds.has(String(entry.event.id))) continue;
      for (const member of mergeConvergenceEvents({
        mergeEvents,
        eventId: entry.event.id,
      })) {
        foldedIds.add(String(member.id));
      }
    }
    steps.push({
      kind: entry.kind,
      eventId: entry.event.id,
      frame: entry.event.frame,
      lineIds:
        entry.kind === "split"
          ? (entry.event.childLineIds || []).slice()
          : (entry.event.participants || []).map((s) => s && s.lineId),
    });
  }
  return steps;
}

/**
 * The merges that still hold one split's subtree mixed with another's.
 *
 * `applyRecombine` marks a split `blockedByMerge` when a rejoin crosses its
 * boundary, and records the split's id on the rejoin (`blockedSplitEventIds`)
 * — so the block is not a property of the split alone. It is a property of the
 * merges naming it, and an UNDONE merge names nothing any more. This is the
 * single place that reads that relation, for the three questions asked of it:
 * will a walk lift the block (`splitStepState`, `chainSplitsCanUndo`), and
 * does it lift now (`rewindMergeStructure`).
 */
function blockingMergesFor(splitEventId, mergeEvents) {
  const key = String(splitEventId);
  return (Array.isArray(mergeEvents) ? mergeEvents : []).filter(
    (merge) =>
      merge &&
      merge.status !== "undone" &&
      (merge.blockedSplitEventIds || []).map(String).includes(key),
  );
}

/** The MERGE steps of a rewind chain, by id — what a block can lift against. */
function chainMergeIdSet(chain) {
  return new Set(
    (chain || [])
      .filter((entry) => entry && entry.kind === "merge")
      .map((entry) => String(entry.event.id)),
  );
}

/**
 * Will the walk named by `chainIds` lift this split's `blockedByMerge` mark?
 *
 * Only if EVERY merge still holding it is one that walk undoes first: an
 * expired merge can never be undone, so its mixing is final.
 *
 * A split carrying the mark with no merge left to hold it answers NO, not yes.
 * That case is unreachable in the runtime — `rewindMergeStructure` clears the
 * mark as it takes the last holder off — and where it did arise (a hand-edited
 * or migrated file) the two callers used to disagree about it. The stricter
 * answer is the right one, because `splitRewindPlan` reads the MARK and
 * refuses `mixed-merge` on it regardless of whether the merges behind it are
 * still there; a lenient answer here would promise a walk that then stops.
 */
function splitBlockLifts(splitEvent, mergeEvents, chainIds) {
  const blockers = blockingMergesFor(splitEvent.id, mergeEvents);
  return (
    blockers.length > 0 &&
    blockers.every(
      (merge) => merge.status === "active" && chainIds.has(String(merge.id)),
    )
  );
}

/**
 * Would every SPLIT step of a cascade actually come off?
 *
 * A cascade is walked by `undoStructuralChain`, which runs each split step
 * through `splitRewindPlan` — and that refuses a split a merge has mixed with
 * another subtree (`mixed-merge`). The merge side used to offer any entry with
 * a non-empty chain on the grounds that "everything reachable with a chain is
 * `superseded`, which is what the walk takes off"; true of the chain's MERGE
 * steps, but its split steps have a refusal of their own, and a walk that hits
 * one stops half-way with the room already changed — the very outcome
 * step-by-step validation exists to prevent. `splitRewindOptions` has always
 * asked this about its own entries; asked here, the merge menu can refuse
 * before the operator commits instead of after.
 *
 * Static and sound, deliberately: it tests only what the RECORDS decide — a
 * block lifts if every merge still holding the split is one this same walk
 * undoes first (an expired one can never be, so its mixing is final), which is
 * the rule `rewindMergeStructure` applies when it clears the mark. Refusals
 * that depend on intermediate state (`no-live-descendants`,
 * `parent-unavailable`) are left to the walk, where the earlier steps that
 * repair them have already run.
 */
function chainSplitsCanUndo({ chain, mergeEvents }) {
  const steps = (chain || []).filter((entry) => entry && entry.kind === "split");
  if (steps.length === 0) {
    return true;
  }
  const chainIds = chainMergeIdSet(chain);
  return steps.every(
    (entry) =>
      !entry.event.blockedByMerge ||
      splitBlockLifts(entry.event, mergeEvents, chainIds),
  );
}

/**
 * Would every MERGE step of a cascade actually come off?
 *
 * The mirror of `chainSplitsCanUndo`, and the same argument one event kind
 * over. A merge step of a chain is `superseded` while things stand on it, and
 * the walk takes those off first — but `mergeRewindPlan` has one refusal that
 * no amount of walking repairs, because it is a property of the RECORD rather
 * than of the room: an event with fewer than two participants has nothing to
 * separate. `mergeRewindOptions` has always asked this about its OWN event
 * (`separable`) and never about the steps it would walk through, and
 * `splitRewindOptions` never asked it at all — so a walk could stop half-way
 * on a refusal both menus could have seen coming.
 *
 * Nothing in the runtime can currently write such a record (`planRecombine`
 * dedupes, so an event exists only when it absorbed somebody), which is why
 * this has never fired. That is an invariant of one function, held in place by
 * nothing, and a hand-edited or migrated state file is outside it — the same
 * reason every other static test here exists.
 */
function chainMergesCanUndo({ chain }) {
  return (chain || [])
    .filter((entry) => entry && entry.kind === "merge")
    .every(
      (entry) =>
        ((entry.event && entry.event.participants) || []).filter(
          (snapshot) => snapshot && snapshot.lineId,
        ).length >= 2,
    );
}

/**
 * The split events of ONE operator gesture, newest first — the order they
 * undo in.
 *
 * The fork counterpart of `mergeConvergenceEvents`, and it exists for the
 * counterpart reason. A track group's release divides EVERY populated line
 * standing on a split frame (`resolveGroupVoting`), so one release is as many
 * events as there were lines — and the operator watched one thing happen. Left
 * unfolded, the map offered a button per event and each click undid a fraction
 * of the release, leaving the room in a shape no single gesture had produced.
 *
 * Unlike a convergence, the members are NOT all on one frame: each line forks
 * on its own frame of the group. So this does not hide the older members the
 * way the merge menu does — every one keeps its node and its button, because
 * an operator looks at the node — and each of those buttons undoes the whole
 * release instead.
 *
 * `gestureId` is stamped by the release itself (`applySplit`). A fork with
 * none — a lone choice window closing, or any event recorded before this —
 * stands alone, which is exactly what it was.
 *
 * @returns {object[]} the active events of `eventId`'s gesture, newest first;
 *   empty when the event is unknown or no longer active.
 */
function splitGestureEvents({ splitEvents, eventId }) {
  const events = Array.isArray(splitEvents) ? splitEvents : [];
  const event = splitEventById(events, eventId);
  if (!event || event.status !== "active") {
    return [];
  }
  if (!event.gestureId) {
    return [event];
  }
  return events
    .filter(
      (candidate) =>
        candidate &&
        candidate.status === "active" &&
        candidate.gestureId === event.gestureId,
    )
    .reverse();
}

/**
 * Can this ONE split event be undone, and why not — the per-event half of
 * `splitRewindOptions`, which asks it of every member of the gesture.
 */
function splitStepState({ event, splitEvents, mergeEvents, lines }) {
  const plan = splitRewindPlan({
    splitEvents,
    lines,
    eventId: event.id,
  });
  const chain = structuralRewindChain({
    session: { splitEvents, mergeEvents },
    kind: "split",
    eventId: event.id,
  });
  const cascading = chain.available && chain.chain.length > 0;
  // The block lifts only if EVERY merge still holding this split is one the
  // walk will undo (`splitBlockLifts` — the same rule `rewindMergeStructure`
  // applies when it clears the mark).
  const blockLifted = splitBlockLifts(
    event,
    mergeEvents,
    chainMergeIdSet(chain.chain),
  );
  // Only the refusals a walk-back actually REPAIRS may be offered on the
  // strength of one. "Anything but mixed-merge" was too generous: it
  // promised a button for reasons the cascade cannot touch, and the click
  // then committed the chain and refused the step it was for — leaving the
  // room half-walked and the frame's menu permanently empty. These two are
  // the lines this split made standing inside something newer, which is
  // exactly what the chain takes off: `no-live-descendants` (a merge
  // swallowed them) and `parent-unavailable` (it swallowed the continuing
  // branch, whose object the rejoin dissolved — the undo re-creates it).
  const repairedByCascade =
    plan.reason === "no-live-descendants" ||
    plan.reason === "parent-unavailable";
  // …and the walk has to be POSSIBLE at all. `plan.available` is
  // `splitRewindPlan`'s answer about this one step, and it never sees the
  // chain — so a split whose own collapse is fine but which has an EXPIRED
  // event standing on it was published as available, and the click then bought
  // `blocked-by-expired` from `undoStructuralChain`. That is the shape this
  // menu has learnt not to have: a button that always refuses is worse than a
  // note saying why there is none, and after a room checkpoint rewind it was
  // the ONLY affordance left on the fork, so the operator's last apparent
  // route back was a dead one. The merge side has always gated on this
  // (`mergeRewindPlan` tests the chain before anything else); this is the same
  // rule, one event kind later.
  //
  // The cascade's own MERGE steps have to be undoable too, for the reason its
  // split steps do (`chainMergesCanUndo`).
  const mergesWalkable = chainMergesCanUndo({ chain: chain.chain });
  const available =
    chain.available &&
    mergesWalkable &&
    (plan.available ||
      (cascading &&
        (plan.reason === "mixed-merge" ? blockLifted : repairedByCascade)));
  return {
    event,
    plan,
    chain,
    cascading,
    available,
    // The PLAN's reason first, the chain's only when it has none. A
    // blocked chain is not a fact about this split's own collapse, so a
    // step that is perfectly undoable in itself (`plan.reason` null) now
    // reports what actually stopped it. But where the plan does have a
    // reason it is the more specific of the two — `mixed-merge` says which
    // merge mixed the subtree and that it can never come off, where
    // `blocked-by-expired` only says something in the way expired — and
    // the map has a bespoke note for exactly that case.
    reason: available
      ? null
      : !mergesWalkable
        ? "unseparable-step"
        : plan.reason || chain.reason,
  };
}

/**
 * Admin-map projection: active split instances, including blocked entries so
 * the menu can explain why a structural rewind is unavailable.
 *
 * A split undo cascades exactly as a merge undo does (`splitRewind` runs
 * `undoStructuralChain` first), so this reads the same chain the runtime will
 * walk. Two things follow, and the menu was getting both wrong before:
 *
 * - `descendantLineIds` describes the topology the collapse actually acts on.
 *   With a later merge standing on the subtree, the lines in `lines[]` today
 *   are NOT what collapses — the cascade brings the split's own children back
 *   first, so a cascading entry reports those.
 * - a `blockedByMerge` split is offered again whenever the merge that crossed
 *   it is still `active` and is one of the steps coming off (undoing it lifts
 *   the mark, §8.3). Only an EXPIRED crossing merge makes the block final.
 */
function splitRewindOptions({ splitEvents, mergeEvents, lines }) {
  return (Array.isArray(splitEvents) ? splitEvents : [])
    .filter(
      (event) =>
        event && (event.status === "active" || event.status === "expired"),
    )
    .map((event) => {
      // An EXPIRED fork is a note on a node and nothing else — the affordance
      // an expired rejoin has always had, and the fork never did. Nothing
      // expires at runtime any more; what does expire one is the uid migration
      // on load (`migrateStructuralIdentities`), when a saved room's records
      // cannot be tied back to its lines. That left the fork's node with an
      // empty menu, which is the one shape this menu has learnt not to have:
      // indistinguishable from a bug, and silent about the only thing the
      // operator needs to know.
      if (event.status === "expired") {
        return {
          eventId: event.id,
          parentLineId: event.parentLineId,
          frame: event.frame,
          available: false,
          reason: "expired",
        };
      }
      // ONE RELEASE, ONE UNDO — see `splitGestureEvents`. Every member keeps
      // its own node and its own button, and each of them undoes the whole
      // release, so the question the operator answers is the gesture they
      // actually watched happen.
      const gesture = splitGestureEvents({ splitEvents, eventId: event.id });
      const states = gesture.map((member) =>
        splitStepState({ event: member, splitEvents, mergeEvents, lines }),
      );
      const self =
        states.find((state) => state.event === event) || states[0] || null;
      if (!self) {
        return {
          eventId: event.id,
          parentLineId: event.parentLineId,
          frame: event.frame,
          available: false,
          reason: "stale-split",
        };
      }
      // All of it or none of it: a click that could only take half the release
      // off is the half-walked room this menu exists to prevent. The reason
      // shown is this event's own where it has one, else the first sibling's —
      // the operator is looking at this node, so its own answer comes first.
      const available = states.every((state) => state.available);
      const blocked = states.find((state) => !state.available);
      // Everything the one click takes off first, newest first — across the
      // WHOLE gesture. Sibling forks divide different lines, so they never
      // appear in each other's chains and nothing here is double-counted; a
      // later event standing on two of them is, so it is deduped.
      const seen = new Set();
      const cascade = [];
      if (available) {
        for (const state of states) {
          for (const step of cascadeSteps({
            chain: state.chain.chain,
            mergeEvents,
          })) {
            const key = `${step.kind}:${step.eventId}`;
            if (seen.has(key)) continue;
            seen.add(key);
            cascade.push(step);
          }
        }
      }
      // What collapses into its parent: the live descendants when nothing
      // stands on a member, else the children its cascade puts back.
      const descendantLineIds = [];
      if (available) {
        for (const state of states) {
          const ids = state.cascading
            ? (state.event.childLineIds || []).slice()
            : state.plan.liveDescendants.map((line) => line.id);
          for (const id of ids) {
            if (!descendantLineIds.includes(id)) descendantLineIds.push(id);
          }
        }
      }
      return {
        eventId: event.id,
        parentLineId: event.parentLineId,
        frame: event.frame,
        available,
        reason: available
          ? null
          : self.available
            ? blocked.reason
            : self.reason,
        cascade,
        descendantLineIds,
        // The OTHER forks of the same release — what this click also takes
        // off, and where. Absent on a fork that is on its own, so a lone
        // split reads exactly as it always did.
        ...(states.length > 1
          ? {
              gesture: states
                .filter((state) => state.event !== event)
                .map((state) => ({
                  eventId: state.event.id,
                  frame: state.event.frame,
                  parentLineId: state.event.parentLineId,
                })),
            }
          : {}),
      };
    });
}

/**
 * Commit the topology portion of a validated split rewind. Runtime callers
 * cancel phases and release UI banners before this rebinds connections.
 * Global reached/checkpoint state is deliberately untouched: only this split
 * subtree rewinds, while unrelated lines keep their room progress.
 */
function rewindSplitStructure({
  session,
  eventId,
  expectedFrame,
  connections,
  now = () => Date.now(),
}) {
  const plan = splitRewindPlan({
    splitEvents: session && session.splitEvents,
    lines: session && session.lines,
    eventId,
    expectedFrame,
  });
  if (!plan.available) {
    return plan;
  }

  const descendantIds = new Set(plan.descendants.map((line) => line.id));
  for (const line of plan.descendants) {
    if (typeof line.clearAllTimer === "function") line.clearAllTimer();
    line.status = "retired";
    line.isVoting = false;
    line.isHolding = false;
    line.isStandby = false;
    line.isBarrierWaiting = false;
    line.isGroupWaiting = false;
    line.pendingHoldUntil = [];
    line.pendingRejoinAt = null;
  }

  const conns = connections || [];
  for (const conn of conns) {
    if (
      conn &&
      conn.sessionId === session.id &&
      descendantIds.has(conn.lineId)
    ) {
      conn.lineId = plan.parent.id;
      conn.currentVoteTo = -1;
    }
  }
  for (const [deviceId, lineId] of Object.entries(session.deviceRegistry || {})) {
    if (descendantIds.has(lineId)) {
      session.deviceRegistry[deviceId] = plan.parent.id;
    }
  }

  const event = plan.event;
  const parent = plan.parent;
  if (typeof parent.clearAllTimer === "function") parent.clearAllTimer();
  // The route the parent was walking before the fork comes back whole — its
  // durable identity included, so structural events older than this split keep
  // recognising it (`eventLineKeys`).
  if (event.parentLineUid) parent.uid = event.parentLineUid;
  parent.currentIndex = event.parentCurrentIndex;
  parent.history = Array.isArray(event.parentHistory)
    ? event.parentHistory.slice()
    : parent.history;
  parent.historyIndex =
    event.parentHistoryIndex == null
      ? Math.max(0, parent.history.length - 1)
      : event.parentHistoryIndex;
  parent.trackGroup = event.parentTrackGroup || null;
  parent.visitedSubFrames = Array.isArray(event.parentVisitedSubFrames)
    ? event.parentVisitedSubFrames.slice()
    : parent.visitedSubFrames || [];
  parent.splitAncestors = Array.isArray(event.ancestorEventIds)
    ? event.ancestorEventIds.slice()
    : [];
  parent.subStack = [];
  parent.savedHistories = [];
  parent.isVoting = false;
  parent.isHolding = false;
  parent.isStandby = false;
  parent.isBarrierWaiting = false;
  parent.isGroupWaiting = false;
  parent.pendingHoldUntil = [];
  parent.pendingRejoinAt = null;
  parent.votingTimer = null;
  parent.holdingTimer = null;
  parent.standbyTimer = null;
  parent.currWinningId = undefined;
  parent.previousWinningCount = 0;
  parent._lastVoteCounts = null;
  parent._lastReachedRef = null;

  const hasPerformer = conns.some(
    (conn) =>
      conn &&
      conn.sessionId === session.id &&
      conn.lineId === parent.id &&
      !conn.isMapView,
  );
  parent.status = hasPerformer ? "active" : "dormant";

  const undoneAt = now();
  for (const nestedEvent of plan.nestedEvents) {
    nestedEvent.status = "undone";
    nestedEvent.undoneAt = undoneAt;
  }

  // The collapsed siblings are gone for good — hand their numbers back, now
  // that the events which reserved them are undone.
  pruneRetiredLines(session);

  return { ...plan, parent, descendantIds: [...descendantIds] };
}

// ── Structural merge (rejoin) rewind ───────────────────────────────────────

function mergeEventById(mergeEvents, eventId) {
  return (
    (Array.isArray(mergeEvents) ? mergeEvents : []).find(
      (event) => event && String(event.id) === String(eventId),
    ) || null
  );
}

/**
 * The live line one snapshot describes, or null.
 *
 * A snapshot that carries a `lineUid` names a ROUTE, so only that uid answers:
 * the L1 standing in the room now may be a later fork that inherited the
 * number, and restoring onto it would overwrite a line the operator is
 * watching. Snapshots without a uid (written before uids existed, or by a test
 * fake) fall back to the number, which is the identity the room had then.
 */
function lineForSnapshot(lines, snapshot, fallbackId) {
  const all = lines || [];
  const uid = snapshot && snapshot.lineUid;
  if (uid) {
    return all.find((line) => line && line.uid === uid) || null;
  }
  const id = (snapshot && snapshot.lineId) || fallbackId;
  return all.find((line) => line && line.id === id) || null;
}

/** Deep copy of the plain-object line state a merge snapshot carries. */
function cloneState(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

/**
 * Validate and describe an undo of one merge (rejoin).
 *
 * A merge is the one structural event that DESTROYS lines, so its undo is the
 * mirror of the split undo: every line the merge swallowed comes back at the
 * frame it was standing on when it happened, carrying the devices it had, and
 * the survivor goes back to its own pre-merge frame — nobody keeps the merged
 * line's route.
 *
 * This is the SINGLE STEP, and it is deliberately strict: it refuses while
 * anything the room built on top of this merge is still standing (`superseded`
 * — a later split or merge on the same population). The cascade lives one
 * level up: `structuralRewindChain` names those later events, the runtime
 * undoes them newest-first, and each one lands here as an ordinary
 * fully-validated step. A merge therefore stays undoable for the rest of the
 * session (owner) instead of dying at the room's next structural step; only a
 * room checkpoint rewind still `expire`s one, because it repositions the whole
 * population with nothing describing where it stood.
 */
function mergeRewindPlan({
  mergeEvents,
  splitEvents,
  lines,
  eventId,
  expectedFrame,
  // Optional: the chain for THIS event, already walked. `mergeRewindOptions`
  // needs it for the menu's cascade anyway, and computing it twice per event
  // was the hot half of the O(events²) the admin projection pays on every push.
  chain: precomputedChain,
}) {
  const event = mergeEventById(mergeEvents, eventId);
  if (!event) {
    return { available: false, reason: "stale-merge" };
  }
  if (event.status !== "active") {
    return {
      available: false,
      reason: event.status === "expired" ? "expired" : "stale-merge",
      event,
    };
  }
  if (expectedFrame && lc(expectedFrame) !== lc(event.frame || "")) {
    return { available: false, reason: "stale-frame", event };
  }

  // Nothing may be standing on this population that was built after the merge:
  // a snapshot cannot be put back underneath a split that grew out of it. The
  // chain names those later events (a merge OR a split — the pairs of one
  // convergence included, which is why undoing the newest of a passage frees
  // the next), and the runtime walks them newest-first before coming back here.
  const chain =
    precomputedChain ||
    structuralRewindChain({
      session: { splitEvents, mergeEvents },
      kind: "merge",
      eventId: event.id,
    });
  if (!chain.available) {
    return {
      available: false,
      reason: chain.reason,
      event,
      blocker: chain.blocker,
    };
  }
  if (chain.chain.length > 0) {
    const next = chain.chain[0];
    return {
      available: false,
      reason: "superseded",
      event,
      superseder: next.event,
      supersederKind: next.kind,
    };
  }

  const allLines = lines || [];
  const survivorSnapshot = (event.participants || []).find(
    (snapshot) => snapshot && snapshot.lineId === event.survivorLineId,
  );
  const survivor = lineForSnapshot(
    allLines,
    survivorSnapshot,
    event.survivorLineId,
  );
  if (!survivor || survivor.status === "retired") {
    return { available: false, reason: "survivor-unavailable", event };
  }

  const restores = [];
  for (const snapshot of event.participants || []) {
    if (!snapshot || !snapshot.lineId) {
      continue;
    }
    // An absorbed line's OBJECT is gone — its number went back in the pool the
    // moment the rejoin ran — so the snapshot IS the line until the undo
    // re-creates it (`rewindMergeStructure`). A line found here is either the
    // survivor, still walking, or a legacy retired object an older server kept.
    const line =
      snapshot.lineId === event.survivorLineId
        ? survivor
        : lineForSnapshot(allLines, snapshot, snapshot.lineId);
    restores.push({ line: line || null, snapshot });
  }
  if (restores.length < 2) {
    return { available: false, reason: "nothing-to-separate", event };
  }

  return { available: true, reason: null, event, survivor, restores };
}

/** The survivor's own snapshot in one merge event, or null. */
function survivorSnapshotOf(event) {
  return (
    ((event && event.participants) || []).find(
      (entry) => entry && entry.lineId === event.survivorLineId,
    ) || null
  );
}

/**
 * Do two merges name the same survivor — the same ROUTE, not merely the same
 * number?
 *
 * Numbers recycle, so a rejoin from an hour ago and one from a minute ago can
 * both say "L0" while describing unrelated lines: the fork that carried the
 * first one on mints a fresh uid for the line that keeps the number. Grouping
 * a convergence on the number alone let two separate passages at the same
 * frame read as one whenever `stayedAtRejoin` could not tell their trails
 * apart (both reduced to the rejoin frame itself, say) — and the walk then
 * committed the newer event before refusing the older one with
 * `survivor-unavailable`, which is precisely the half-done cascade a
 * validated-step-by-step walk exists to prevent. The number stays the fallback
 * for records written before uids.
 */
function sameSurvivorRoute(a, b) {
  const ua = (survivorSnapshotOf(a) || {}).lineUid;
  const ub = (survivorSnapshotOf(b) || {}).lineUid;
  return ua && ub ? ua === ub : a.survivorLineId === b.survivorLineId;
}

/** The survivor's own trail as one merge event recorded it, up to where it was
 * standing. Null when the event no longer carries the snapshot. */
function survivorTrailOf(event) {
  const snapshot = survivorSnapshotOf(event);
  if (!snapshot || !Array.isArray(snapshot.history)) {
    return null;
  }
  const at =
    snapshot.historyIndex == null
      ? snapshot.history.length - 1
      : snapshot.historyIndex;
  return snapshot.history.slice(0, at + 1);
}

/**
 * The first index of the survivor's own trail this rejoin is NOT behind.
 *
 * A per-line rewind landing BELOW this undoes the rejoin on the way; one
 * landing on it or past it leaves the rejoin standing. Which index that is
 * depends on where the merge FOUND the survivor, and its snapshot says — the
 * same question `preMergeLanding` asks, read from the other end:
 *
 *   - **Parked somewhere else** — a hold-until barrier release, where
 *     `runRejoin` advances the survivor to the rejoin frame immediately after
 *     the snapshot is taken. The recorded index is strictly pre-merge, and
 *     standing the merged line back on it would put the swallowed lines'
 *     devices on a frame their route never touched. The floor is one PAST it.
 *   - **Already standing on the rejoin frame** — a co-presence merge, where
 *     the lines met there and the survivor's playhead never moves. That index
 *     is the MERGED line's own position, the frame every participant arrived
 *     at, so a rewind to it needs no undo at all. The floor IS it.
 *
 * Measuring both shapes as the first one cost an operator a rejoin (owner).
 * The node a co-presence rejoin happened on offered "⏪⏪ rewind L0 here — out
 * of the merge at ⟨B-prime⟩" beside "⏪⏪ undo the merge at ⟨B-prime⟩", so
 * putting the line back on that frame — the one thing the second button does
 * not do — could only be bought by taking the rejoin off.
 */
function survivorRewindFloor(snapshot, frame) {
  if (!snapshot) return null;
  const history = Array.isArray(snapshot.history) ? snapshot.history : [];
  const at =
    snapshot.historyIndex == null ? history.length - 1 : snapshot.historyIndex;
  if (at < 0) return null;
  return lc(history[at] || "") === lc(frame || "") ? at : at + 1;
}

/**
 * Did the survivor stay AT the rejoin point between these two snapshots?
 *
 * `older` must be a prefix of `newer`, and every entry past the prefix must be
 * the rejoin frame itself. That single test covers both merge paths — a barrier
 * release records the survivor still parked on its own frame while a
 * co-presence merge records it standing on the rejoin frame, so the survivor's
 * trail grows by exactly that frame between the two — and still reads a LOOP
 * back to the same frame (entries in between that are not it) as the separate
 * passage it is.
 */
function stayedAtRejoin(older, newer, frame) {
  if (!older || !newer || older.length > newer.length) {
    return false;
  }
  for (let i = 0; i < older.length; i++) {
    if (lc(older[i] || "") !== lc(newer[i] || "")) return false;
  }
  for (let i = older.length; i < newer.length; i++) {
    if (lc(newer[i] || "") !== lc(frame || "")) return false;
  }
  return true;
}

/**
 * WHERE, in the dive sense, the survivor was standing when this merge was
 * recorded: its complete dive stack (every sub and the landing it returns to,
 * `diveContextKey`) plus the main-flow trail each dive saved on the way in.
 *
 * The sub name alone was not enough. A sub history restarts on every entry, so
 * two visits to the same sub produce the same sub trail, and the passage test
 * (`stayedAtRejoin`) reads them as one convergence — a survivor that merged on
 * `JOIN.svg` in Tetra on its way to A, and again on its way to B, had both
 * rejoins folded into one undo. The return landing tells the visits apart when
 * the dives go different ways; the saved trail tells them apart when they do
 * not (the second dive saved a main trail the first one had not walked yet).
 * Arrivals within ONE dive share both, so they still group.
 *
 * An event whose survivor snapshot carries no dive stack (recorded before
 * snapshots had one) falls back to the sub name it recorded.
 */
function mergeDiveIdentity(event) {
  const snapshot = survivorSnapshotOf(event);
  if (!snapshot || !Array.isArray(snapshot.subStack)) {
    return `sub:${lc((event && event.sub) || "")}`;
  }
  const saved = (snapshot.savedHistories || [])
    .map((entry) => {
      const history = Array.isArray(entry && entry.history) ? entry.history : [];
      const at =
        entry && entry.historyIndex != null
          ? entry.historyIndex
          : history.length - 1;
      return history.slice(0, at + 1).map(lc).join(",");
    })
    .join("|");
  return `dive:${diveContextKey(snapshot.subStack)}#${saved}`;
}

/**
 * The merge events of ONE convergence, newest first — the order they undo in.
 *
 * Lines converging on a rejoin frame merge in PAIRS: `applyRecombine` runs
 * once per arrival, so three lines meeting at `H` are two events. The operator
 * watched ONE thing happen, so undoing it is ONE gesture (owner): every line
 * that met here goes back to the node it came from, and the pairing stays what
 * it always was — the record of how the room got there, not a queue of
 * separate undos to click through. `mergeRewindPlan` still refuses any order
 * but newest-first; this is the set the runtime walks in that order.
 *
 * Same convergence = same survivor ROUTE (`sameSurvivorRoute` — the uid, since
 * numbers recycle and two unrelated lines can both be "L0"), same frame, same
 * dive (`mergeDiveIdentity`), and the survivor never left the rejoin point in
 * between (`stayedAtRejoin`).
 * Grouping runs over the events in chronological order (`mergeEvents` is
 * append-only), so a room that merges at the same frame on a later pass keeps
 * its passages apart.
 *
 * @returns {object[]} the active events of `eventId`'s convergence, newest
 *   first; empty when the event is unknown or no longer active.
 */
function mergeConvergenceEvents({ mergeEvents, eventId }) {
  const events = Array.isArray(mergeEvents) ? mergeEvents : [];
  const event = mergeEventById(events, eventId);
  if (!event || event.status !== "active") {
    return [];
  }
  const dive = mergeDiveIdentity(event);
  const siblings = events.filter(
    (candidate) =>
      candidate &&
      candidate.status === "active" &&
      // The same ROUTE, not merely the same number (`sameSurvivorRoute`).
      sameSurvivorRoute(candidate, event) &&
      lc(candidate.frame || "") === lc(event.frame || "") &&
      // …and the same NODE. Frame names are unique within a score, not across
      // them: one line can rejoin on a main `End.svg` and later on an
      // `End.svg` inside a sub — or on the same sub frame in two different
      // dives — and folding those into one convergence would have a single
      // click claim to undo a passage that never happened.
      mergeDiveIdentity(candidate) === dive,
  );
  let passage = [];
  for (const candidate of siblings) {
    const previous = passage[passage.length - 1];
    if (
      previous &&
      !stayedAtRejoin(
        survivorTrailOf(previous),
        survivorTrailOf(candidate),
        event.frame,
      )
    ) {
      if (passage.includes(event)) break; // the passage we wanted just ended
      passage = [];
    }
    passage.push(candidate);
  }
  return passage.includes(event) ? passage.slice().reverse() : [event];
}

/** Admin-map projection: undoable merges, plus the expired ones so the menu can
 * say why a merge frame offers no undo. */
function mergeRewindOptions({ mergeEvents, splitEvents, lines }) {
  return (Array.isArray(mergeEvents) ? mergeEvents : [])
    .filter(
      (event) =>
        event && (event.status === "active" || event.status === "expired"),
    )
    .map((event) => {
      // An older merge is still on offer: what stands on top of it comes off
      // first. The chain is what the runtime will actually walk, so the menu
      // can say so before the operator commits to it — and the plan needs the
      // same answer, so it is walked ONCE and handed down.
      const chain = structuralRewindChain({
        session: { splitEvents, mergeEvents },
        kind: "merge",
        eventId: event.id,
      });
      const plan = mergeRewindPlan({
        mergeEvents,
        splitEvents,
        lines,
        eventId: event.id,
        chain,
      });
      // A cascade may carry an entry that the plan alone refuses, but only for
      // the refusals a walk-back actually repairs — `splitRewindOptions` learnt
      // that the hard way, and the merge side needs the same discipline for one
      // reason. `mergeRewindPlan` tests the chain BEFORE it looks at the
      // survivor, so every refusal reachable with a non-empty chain is
      // `superseded`, which is precisely what the walk takes off; the survivor
      // it cannot find yet comes back with it. The exception is
      // `nothing-to-separate`, which is a property of the RECORD — an event
      // with fewer than two participants — and no amount of walking repairs
      // that. Decided here, before anything commits, rather than by the step
      // that would refuse after the cascade had already moved the room.
      const separable =
        (event.participants || []).filter(
          (snapshot) => snapshot && snapshot.lineId,
        ).length >= 2;
      // …and the SPLIT steps of that cascade have to be undoable too: a merge
      // step comes off by being `superseded`, but a split the room has since
      // mixed into another subtree refuses on its own terms and stops the walk
      // where it stands (`chainSplitsCanUndo`).
      const walkable = chainSplitsCanUndo({
        chain: chain.chain,
        mergeEvents,
      });
      // …and so does a rejoin ON the way with nothing left to separate
      // (`chainMergesCanUndo`): `separable` asks this of THIS event and never
      // asked it of the steps the walk goes through.
      const stepsSeparable = chainMergesCanUndo({ chain: chain.chain });
      const available =
        separable &&
        walkable &&
        stepsSeparable &&
        (plan.available || chain.chain.length > 0);
      // One convergence is ONE menu entry, whether the room merged in one event
      // or in pairs: the newest event of the passage carries it, and the older
      // ones are marked so the map lists neither a second button nor a note
      // telling the operator to undo something they never saw happen.
      const convergence = mergeConvergenceEvents({
        mergeEvents,
        eventId: event.id,
      });
      const newest = convergence[0] || event;
      const partOfConvergence = convergence.length > 1 && newest !== event;
      // The passage folds into one gesture, so its own events are not listed
      // as things that "also come off" — they ARE this undo. Every OTHER
      // convergence on the way folds the same way, so it is named once too:
      // three lines meeting at MERGE2 is two events and one thing the operator
      // watched happen.
      const cascade = cascadeSteps({
        chain: chain.chain,
        mergeEvents,
        folded: convergence.map((member) => member.id),
      });
      // An EXPIRED passage is a note on a node and nothing else: the map reads
      // its frame and its reason, and `mergesBehindLine`/`mergesBehindLineRewind`
      // filter it out on both sides. Nothing expires except by a room checkpoint
      // rewind and nothing is ever removed from `mergeEvents[]`, so these are
      // the entries that accumulate for the life of a session — and they were
      // carrying a cascade array, a line list and a trail index on every push,
      // to every operator tab, for an undo that can never run again.
      if (event.status === "expired") {
        return {
          eventId: event.id,
          frame: event.frame,
          survivorLineId: event.survivorLineId,
          available: false,
          reason: "expired",
        };
      }
      // Every line the one gesture brings back — what the map's button names.
      // By NUMBER, because the confirm the button raises names the same set
      // that way (`mergeRestoreLandings`): merge order put the last line to
      // arrive in the middle, so one gesture read `L0, L2, L1` on the button
      // and `L0 → …, L1 → …, L2 → …` one click later, and the unsorted half
      // looks like a fault to whoever is reading it mid-piece.
      const restoredIds = [];
      for (const member of convergence) {
        for (const snapshot of member.participants || []) {
          if (snapshot && !restoredIds.includes(snapshot.lineId)) {
            restoredIds.push(snapshot.lineId);
          }
        }
      }
      restoredIds.sort((a, b) => lineIdNum(a) - lineIdNum(b));
      return {
        eventId: event.id,
        frame: event.frame,
        // …and the score that frame belongs to. A rejoin can happen inside a
        // sub-score, where frame names are the SUB's and collide freely with
        // the main flow's — so a bare name sent the map's ⏪⏪ badge to an
        // unrelated main frame of the same name, or to no node at all. Null on
        // the main flow, which is every merge recorded before this field
        // existed and keeps their badges exactly where they are.
        sub: event.sub || null,
        survivorLineId: event.survivorLineId,
        // Numbers are recycled, so the number alone does not say WHICH route
        // this rejoin swallowed: a later fork mints a fresh uid for the line
        // that carries on, and an event naming "L0" may be describing a route
        // the L0 standing in the room today only inherited the number of. The
        // map compares this against the line's own `uid` before warning that a
        // per-line rewind reaches back through here — `mergesBehindLine`
        // applies exactly the same test server-side.
        survivorLineUid: (survivorSnapshotOf(event) || {}).lineUid,
        available,
        // An unseparable event reads `superseded` from the plan whenever
        // something stands on it, which would send the operator looking for a
        // later merge to undo first. Say the real reason.
        reason: available
          ? null
          : !separable
            ? "nothing-to-separate"
            : !walkable
              ? "mixed-merge"
              : !stepsSeparable
                ? "unseparable-step"
                : plan.reason,
        supersededByFrame: plan.superseder ? plan.superseder.frame : null,
        // Everything this one click takes off on the way, newest first — the
        // splits and merges the room built on top of this rejoin.
        cascade,
        // An older event of the operator's own convergence — the newest entry's
        // one click undoes this too, so the menu skips it (the flag is absent
        // on everything else, so a merge that really is on its own is
        // unchanged).
        ...(partOfConvergence ? { partOfConvergence: true } : {}),
        // The first point of the survivor's trail this convergence is NOT
        // behind: the map marks per-line rewind entries BELOW it, which is
        // exactly the set lineRewind will undo on the way. The DEEPEST floor of
        // the passage, because its one gesture undoes every member.
        survivorRewindFloor: (() => {
          const floors = (available ? convergence : [event])
            // A record that does not carry the survivor's snapshot at all — a
            // legacy state file, or a hand-built one — has no floor to report
            // rather than a wrong one.
            .map((member) =>
              survivorRewindFloor(survivorSnapshotOf(member), member.frame),
            )
            .filter((floor) => floor != null);
          return floors.length > 0 ? Math.max(...floors) : null;
        })(),
        // Guarded like every other participant walk in this file: this one is
        // built on EVERY push, inside `structuralProjection`, so a malformed
        // record would not cost a menu entry but the whole room's admin feed.
        restoredLineIds:
          available && restoredIds.length > 0
            ? restoredIds
            : (event.participants || [])
                .filter((snapshot) => snapshot && snapshot.lineId)
                .map((snapshot) => snapshot.lineId)
                .sort((a, b) => lineIdNum(a) - lineIdNum(b)),
      };
    });
}

/**
 * The merges standing BEHIND a point of one line's own trail, newest first.
 *
 * A merge is the one structural event a trail survives: a split truncates its
 * children's trails (§6), but the merge survivor keeps its history, so the map
 * offers per-line rewind entries on frames the line visited BEFORE it merged.
 * Walking it back there as one line would put devices that arrived from
 * another route onto a frame that route never touched — a room state the score
 * never produced — so `lineRewind` undoes these first (owner).
 *
 * "Behind" is measured in the survivor's own trail, against the floor the
 * snapshot sets (`survivorRewindFloor`): where the line stood when the merge
 * ran, plus one whenever that position is a moment the merge then moved it out
 * of. Everything below the floor is a moment the absorbed lines were still
 * separate; the floor itself is the merged line's own position.
 *
 * @returns {object[]} active events, newest first — the order they undo in.
 */
function mergesBehindLine({ mergeEvents, lineId, lineUid, atIndex }) {
  const behind = [];
  for (const event of Array.isArray(mergeEvents) ? mergeEvents : []) {
    if (!event || event.status !== "active") continue;
    // This line's own snapshot, found by ROUTE. Numbers are recycled in both
    // directions, so neither answer the number gives can be trusted: a merge
    // this line really walked through can name a number it no longer has (its
    // own undo re-creates a line on the lowest FREE one), and a merge it never
    // saw can name the number it holds today. Keying on the number missed the
    // first case silently — the rewind then walked the line back past a merge
    // it never undid, standing devices that arrived by another route on a
    // frame that route never touched, which is the one thing §8.2 exists to
    // prevent. The number is the fallback for events recorded before uids.
    const snapshot = (event.participants || []).find((entry) => {
      if (!entry) return false;
      return lineUid && entry.lineUid
        ? entry.lineUid === lineUid
        : entry.lineId === lineId;
    });
    if (!snapshot) continue;
    // Only the line the merge SURVIVED as keeps a trail reaching behind it —
    // an absorbed one had its history replaced by the survivor's.
    if (snapshot.lineId !== event.survivorLineId) continue;
    const floor = survivorRewindFloor(snapshot, event.frame);
    if (floor == null || atIndex >= floor) continue; // lands after the merge
    behind.push(event);
  }
  // mergeEvents is append-only, so array order IS chronological; undoing runs
  // newest-first, which is also the only order mergeRewindPlan allows.
  return behind.reverse();
}

/**
 * The rejoins a ROOM checkpoint rewind walks back through, newest first.
 *
 * The room-wide rewind is the same gesture as the per-line one, at room scale,
 * so it answers to the same rule (owner: "why don't we undo merge
 * automatically?"). Sending every line back to a checkpoint BEHIND a rejoin
 * without undoing the rejoin loses the lines it swallowed: the room stands at
 * a barrier it once crossed with three lines and only two are there, because
 * the third was absorbed after it and nothing brought it back.
 *
 * "Behind" is measured exactly as `mergesBehindLine` measures it — in the
 * SURVIVOR's own trail, against the index this rewind is landing that line on.
 * A merge whose survivor was already past the checkpoint when it ran happened
 * after the moment being returned to and comes off; one it reached the
 * checkpoint from is older history and is left alone.
 *
 * An ANCESTRY landing measures from zero. The frame comes from the route a
 * fork recorded, which is a moment BEFORE this line's own trail begins — so
 * every rejoin the line survived happened after the checkpoint and every one
 * of them comes off. Leaving them standing would be the same loss this
 * function exists to prevent, one fork further back: the room would return to
 * a group it crossed with three lines and find two, precisely for the lines a
 * split's truncated trail made eligible in the first place.
 *
 * A line placed by FILL still contributes nothing. Neither its trail nor its
 * forks hold an occurrence of the group, so it cannot say which side of the
 * checkpoint its own rejoins fall on — and inventing an answer would take a
 * rejoin off the room on no evidence. Such a line is dormant by construction
 * (the checkpoint is only common when every POPULATED line has passed it), so
 * its merges keep their ordinary map entry instead.
 *
 * @param {object} opts
 * @param {object[]} opts.mergeEvents the session's events, chronological
 * @param {Array<{id:string, uid:string}>} opts.lines the room's current lines
 * @param {object} opts.plan a `roomRewindPlan` result
 * @returns {object[]} active events, newest first — the order they undo in
 */
function mergesBehindRoomRewind({ mergeEvents, lines, plan }) {
  const events = Array.isArray(mergeEvents) ? mergeEvents : [];
  if (!plan || !Array.isArray(plan.lines) || events.length === 0) {
    return [];
  }
  const byId = new Map();
  for (const line of lines || []) {
    if (line && line.id != null) byId.set(String(line.id), line);
  }
  const wanted = new Set();
  for (const entry of plan.lines) {
    if (!entry) continue;
    // Where the landing sits in this line's OWN trail: the index for a history
    // landing, and zero for an ancestry one — its frame is from before that
    // trail begins, so everything in it is on this side of the checkpoint.
    const atIndex =
      entry.source === "history" && entry.historyIndex >= 0
        ? entry.historyIndex
        : entry.source === "ancestor"
          ? 0
          : null;
    if (atIndex === null) continue;
    const line = byId.get(String(entry.lineId));
    if (!line) continue;
    // The line as it stands today, and then — for an ancestry landing — each
    // line it USED to be. A merge is recorded against the identity that
    // survived it, and a fork mints new identities for its children, so a
    // rejoin the parent survived is invisible to every line in the room once
    // that parent has divided. Asking only today's lines undid the fork and
    // left the rejoin standing, which collapsed a room that crossed the
    // checkpoint as two lines into one (§8.14).
    const points = [
      { lineId: line.id, lineUid: line.uid, atIndex },
      ...(entry.source === "ancestor" ? entry.route || [] : []),
    ];
    for (const point of points) {
      if (!point) continue;
      for (const event of mergesBehindLine({
        mergeEvents: events,
        lineId: point.lineId,
        lineUid: point.lineUid,
        atIndex: point.atIndex,
      })) {
        wanted.add(event);
      }
    }
  }
  // One order for the whole room, not one per line: append-only array order is
  // chronological, and the walk runs newest-first like every other undo.
  return events.filter((event) => wanted.has(event)).reverse();
}

/**
 * The FORKS a room checkpoint rewind walks back through, newest first.
 *
 * The mirror of `mergesBehindRoomRewind`, and it exists for the mirror reason.
 * A rewind to a checkpoint the room crossed as two lines must arrive with two
 * lines. Undoing the rejoins alone got half of that: the room could still come
 * back with MORE lines than it left with, because every fork made since the
 * checkpoint was left standing — and when the checkpoint frame is itself a
 * split frame (a frame carrying both `session-track-group` and
 * `session-split`), each of those extra lines forks AGAIN on the next release.
 * One real room reached 16 lines with two performers in it that way, 15 split
 * events deep on one frame.
 *
 * "Since" is read from the fork's own record, which is the only place it
 * survives: a split TRUNCATES its children's trails (§6), so no child can say
 * where the room was when it happened, but `parentHistory` is the parent's
 * trail as the fork found it. If that trail had already reached this group,
 * the parent was at or past the checkpoint when it divided, so the division
 * happened after the moment being returned to and comes off. A fork the parent
 * made before ever reaching the group is older history and stays — which is
 * what keeps the lines that crossed the checkpoint separately from collapsing
 * into one.
 *
 * @param {object} opts
 * @param {object[]} opts.splitEvents the session's events, chronological
 * @param {string[]} opts.groupFrames the checkpoint group's frames, lowercased
 * @returns {object[]} active events, newest first — the order they undo in
 */
function splitsBehindRoomRewind({ splitEvents, groupFrames }) {
  const frames = new Set((groupFrames || []).map(lc));
  if (frames.size === 0) {
    return [];
  }
  return (Array.isArray(splitEvents) ? splitEvents : [])
    .filter((event) => {
      if (!event || event.status !== "active") return false;
      const history = Array.isArray(event.parentHistory)
        ? event.parentHistory
        : [];
      const at =
        event.parentHistoryIndex == null
          ? history.length - 1
          : event.parentHistoryIndex;
      // The parent's trail up to the fork — including the frame it forked ON,
      // which for a grouped split frame IS the checkpoint.
      for (let i = 0; i <= at && i < history.length; i++) {
        if (frames.has(lc(history[i] || ""))) return true;
      }
      return false;
    })
    .reverse();
}

/**
 * Where one participant of a merge goes back to: **the node it came into the
 * merge from**.
 *
 * The two merge paths leave the participants in different places, and this is
 * what makes the undo read the same either way. A barrier release merges lines
 * that are still PARKED on their own frames (`E`/`F`/`G` rejoining at `H`), so
 * the snapshot already names the frame each came from and nothing is stepped
 * back. A co-presence merge happens when lines walk ONTO the rejoin frame
 * (`V`/`W` → `Z`), so every snapshot names the rejoin frame itself — and the
 * frame the operator wants them back on is the previous entry of each line's
 * own trail. Consecutive occurrences of the rejoin frame (a loop, or a stale
 * duplicate from an older session) are walked past.
 *
 * A line mid-DIVE is stepped back the same way, INSIDE its sub. Its trail is
 * the sub's (`enterSub` saves the main-flow one and starts a fresh list), its
 * `currentIndex` indexes the sub's frame list, and its return context lives in
 * `subStack`/`savedHistories`, which the undo restores untouched — so the only
 * thing that changes is which frame list the predecessor is resolved against.
 * That is what `frameIndexOf`'s second argument is for.
 *
 * It used to return null for every dived snapshot instead, which is the same
 * answer as "it is already back home" — so two lines that merged on a frame
 * inside a sub were both restored ON the merge node, and the settlement that
 * follows an undo merged them again on the spot. The operator's gesture
 * reported a separation it had already undone.
 *
 * @param {function(string, ?string): number} frameIndexOf resolves a frame name
 *   to its index in the score the snapshot was walking — the second argument is
 *   the sub-score's name, or null on the main flow.
 * @returns {{index:number, history:string[], historyIndex:number}|null} null
 *   when the snapshot position stands (the ordinary case).
 */
function preMergeLanding({ snapshot, mergeFrame, frameIndexOf }) {
  if (!snapshot || !mergeFrame || typeof frameIndexOf !== "function") {
    return null;
  }
  const subStack = snapshot.subStack || [];
  const top = subStack[subStack.length - 1];
  const subScore = top ? top.score : null;
  const history = Array.isArray(snapshot.history) ? snapshot.history : [];
  const at =
    snapshot.historyIndex == null ? history.length - 1 : snapshot.historyIndex;
  if (at < 1 || lc(history[at] || "") !== lc(mergeFrame)) {
    return null; // not standing on the rejoin frame — it is already back home
  }
  let i = at - 1;
  while (i >= 0 && lc(history[i] || "") === lc(mergeFrame)) {
    i--;
  }
  if (i < 0) {
    return null;
  }
  const index = frameIndexOf(history[i], subScore);
  if (!Number.isInteger(index) || index < 0) {
    return null; // the score no longer has that frame
  }
  return { index, history: history.slice(0, i + 1), historyIndex: i };
}

/**
 * The frame-index resolver `preMergeLanding` (and everything that reads a merge
 * snapshot's route) asks: a name and the score it was walked in — the main flow,
 * or one of the session's sub-scores.
 *
 * One builder, so the undo, the map's ghost routes and the confirm panel all
 * answer the question the same way. Before this they shared a MAIN-FLOW-only
 * resolver, and a sub frame that happened to share a name with a main one
 * resolved to the main index.
 */
function frameIndexResolver(session) {
  const mainLower = (
    (session && session.listFilesInLowerCase) ||
    ((session && session.listFiles) || []).map(lc)
  ).map(lc);
  return (name, subScore) => {
    const wanted = lc(name || "");
    if (subScore) {
      const sub = (session && session.subFrames && session.subFrames[subScore]) || null;
      const list = (sub && sub.frameList) || [];
      return list.findIndex((frame) => lc(frame) === wanted);
    }
    return mainLower.indexOf(wanted);
  };
}

/**
 * The number a restored line may take: the one it had, unless something holds
 * it now (a live or retired object, or a split undo that would restore it as
 * its parent) — then the lowest free one, exactly as a split allocates.
 */
function freeLineId(session, wantedId, alloc) {
  const taken = new Set(
    ((session && session.lines) || [])
      .map((line) => line && line.id)
      .filter(Boolean),
  );
  for (const id of reservedParentLineIds(session && session.splitEvents)) {
    taken.add(id);
  }
  if (wantedId && !taken.has(wantedId)) {
    return wantedId;
  }
  if (typeof alloc === "function") {
    return alloc(session);
  }
  let n = 1;
  while (taken.has(`L${n}`)) n++;
  return `L${n}`;
}

/** Plain-object stand-in for a restored line, for callers with no line class
 * (the pure unit tests). The runtime injects `createLine` → a real BMLine. */
function plainRestoredLine(session, id) {
  return {
    id,
    status: "active",
    currentIndex: 0,
    history: [],
    historyIndex: 0,
    trackGroup: null,
    splitAncestors: [],
    subStack: [],
    savedHistories: [],
    visitedSubFrames: [],
    pendingHoldUntil: [],
    pendingRejoinAt: null,
    isVoting: false,
    isHolding: false,
    isStandby: false,
    isBarrierWaiting: false,
    isGroupWaiting: false,
  };
}

/**
 * Spread the devices that have no line of their own across the lines a merge
 * undo brings back — and settle each of those lines' dormancy from what lands
 * on them.
 *
 * A device that joined AFTER the merge is in no snapshot: it has no line of its
 * own to be sent back to. It used to stay with the survivor wholesale, which
 * handed one route the entire late audience while the others came back empty;
 * they are SPREAD instead (owner), the same balancing a split gives the
 * members it finds unassigned, so the undo leaves the room as evenly populated
 * as the moment it is undoing.
 *
 * Split out of `rewindMergeStructure` because a CONVERGENCE undoes in PAIRS:
 * `applyRecombine` runs once per arrival, so three lines meeting on one frame
 * are two events, and balancing inside each event in turn spends the
 * latecomers before the last line is back — the first step can only see two of
 * the three destinations. Three latecomers over three lines came out 2/1/3
 * while the confirm promised them "spread evenly". The runtime therefore runs
 * this once more over the WHOLE passage when the walk is done, with the union
 * of every step's snapshot devices as `knownDeviceIds`; the pass re-seeds from
 * those and re-assigns every latecomer from scratch, so it is the same
 * computation for a merge that was a single event and moves nobody.
 *
 * A RIDER present at the merge does go back to the line it was watching — its
 * device id is in the snapshot like anyone's, and following the route it was
 * actually following is the view it asked for. What a spectator never does is
 * COUNT: it is outside the balancing, and (decision #12) it cannot make a line
 * populated, so a restored line holding only riders lands dormant like any
 * other line nobody came back to — which is what lets #11 release the waits on
 * it and #13 fast-forward the next real joiner instead of stranding them on a
 * frozen position.
 *
 * @param {Set<string>} knownDeviceIds devices a snapshot names: already back on
 *   their own line, so they only COUNT here.
 * @returns {{moved: {conn: object, from: string, to: string}[]}} the live
 *   connections this re-homed, so a caller that has already addressed them
 *   about a frame can address them again.
 */
function spreadMergeLatecomers({
  session,
  lines,
  knownDeviceIds,
  connections,
}) {
  const targets = (lines || []).filter(Boolean);
  const moved = [];
  if (targets.length === 0) {
    return { moved };
  }
  const known = knownDeviceIds || new Set();
  const ours = new Set(targets.map((line) => line.id));
  const all = (connections || []).filter(
    (conn) => conn && conn.sessionId === session.id,
  );
  // The merged population: whoever is standing on one of these lines right now.
  const conns = all.filter((conn) => ours.has(conn.lineId));

  // Decision #12's own predicate, not a copy of it: this settles who counts
  // toward the balancing AND each restored line's dormancy, and the definition
  // of a spectator has already been rewritten once.
  const isPopulation = (conn) => !isSpectatorConn(conn);
  const population = new Map(targets.map((line) => [line.id, 0]));
  const bump = (lineId) =>
    population.set(lineId, (population.get(lineId) || 0) + 1);
  const leastPopulated = () => {
    let best = null;
    for (const line of targets) {
      const count = population.get(line.id) || 0;
      if (
        best === null ||
        count < best.count ||
        (count === best.count && lineIdNum(line.id) < lineIdNum(best.line.id))
      ) {
        best = { line, count };
      }
    }
    return best && best.line;
  };

  const latecomers = [];
  for (const conn of conns) {
    if (!isPopulation(conn)) continue;
    if (conn.deviceId != null && known.has(String(conn.deviceId))) {
      bump(conn.lineId);
    } else {
      latecomers.push(conn);
    }
  }
  // Deterministic order, so the same room state always spreads the same way.
  latecomers.sort((a, b) =>
    String(a.deviceId == null ? "" : a.deviceId).localeCompare(
      String(b.deviceId == null ? "" : b.deviceId),
    ),
  );
  for (const conn of latecomers) {
    const target = leastPopulated();
    if (!target) break;
    if (target.id !== conn.lineId) {
      moved.push({ conn, from: conn.lineId, to: target.id });
      conn.lineId = target.id;
      conn.currentVoteTo = -1;
    }
    bump(target.id);
    if (conn.deviceId != null && session.deviceRegistry) {
      session.deviceRegistry[conn.deviceId] = target.id;
    }
  }
  // …and the late joiners who are OFFLINE right now, swept the same way an
  // absent performer is swept across a split's branches (decision #13).
  const liveDeviceIds = new Set(
    all
      .filter((conn) => !conn.isMapView && conn.deviceId != null)
      .map((conn) => String(conn.deviceId)),
  );
  for (const [deviceId, lineId] of Object.entries(
    session.deviceRegistry || {},
  )) {
    if (!ours.has(lineId)) continue;
    if (known.has(String(deviceId))) continue;
    if (liveDeviceIds.has(String(deviceId))) continue;
    const target = leastPopulated();
    if (!target) break;
    session.deviceRegistry[deviceId] = target.id;
    bump(target.id);
  }

  // A restored line nobody came back to is DORMANT, not retired: #11 revives it
  // for the next joiner and releases anything waiting on it meanwhile.
  // "Nobody" means no POPULATION (decision #12, above).
  for (const line of targets) {
    line.status = conns.some(
      (conn) => conn.lineId === line.id && isPopulation(conn),
    )
      ? "active"
      : "dormant";
  }
  return { moved };
}

/**
 * Commit the topology portion of a validated merge undo. Runtime callers cancel
 * phases and release banners first, and drive the restored lines' displays
 * after — devices change line here, so both have to bracket this call.
 *
 * Like the split undo this is a SUBTREE rewind: the reached registry and
 * `latestGroupArrival` are left alone (the ROOM did not rewind), and the
 * restored lines land un-parked and phase-less, an operator rewind being
 * authoritative. Their next window is an ordinary one, so a route that leads
 * back to the rejoin frame merges them again — "replay that passage" rather
 * than "unmake it".
 */
function rewindMergeStructure({
  session,
  eventId,
  expectedFrame,
  connections,
  createLine,
  allocLineId,
  now = () => Date.now(),
}) {
  const plan = mergeRewindPlan({
    mergeEvents: session && session.mergeEvents,
    splitEvents: session && session.splitEvents,
    lines: session && session.lines,
    eventId,
    expectedFrame,
  });
  if (!plan.available) {
    return plan;
  }

  const survivorId = plan.survivor.id;
  const conns = (connections || []).filter(
    (conn) => conn && conn.sessionId === session.id,
  );

  // Sub-aware: a line absorbed mid-dive steps back inside its own sub-score.
  const frameIndexOf = frameIndexResolver(session);

  // The absorbed lines exist only as snapshots now (their objects and numbers
  // went back in the pool at the rejoin), so the undo BUILDS them again. Each
  // asks for the number it had; a fork that has since been handed it keeps it,
  // and the route comes back on the lowest free number instead — its `uid`, not
  // its number, is what makes it the same line as the one the snapshot took.
  for (const entry of plan.restores) {
    if (entry.line) continue;
    const id = freeLineId(session, entry.snapshot.lineId, allocLineId);
    const line = (createLine || plainRestoredLine)(session, id);
    line.id = id;
    if (entry.snapshot.lineUid) line.uid = entry.snapshot.lineUid;
    session.lines.push(line);
    entry.line = line;
  }

  // Where each device goes back to.
  const deviceTarget = new Map();
  for (const { line, snapshot } of plan.restores) {
    for (const deviceId of snapshot.deviceIds || []) {
      deviceTarget.set(String(deviceId), line.id);
    }
  }

  for (const { line, snapshot } of plan.restores) {
    if (typeof line.clearAllTimer === "function") line.clearAllTimer();
    if (snapshot.lineUid) line.uid = snapshot.lineUid;
    // The node it came from, which is the snapshot's own frame unless the merge
    // caught the line standing ON the rejoin frame (preMergeLanding).
    const stepBack = preMergeLanding({
      snapshot,
      mergeFrame: plan.event.frame,
      frameIndexOf,
    });
    line.currentIndex = stepBack ? stepBack.index : snapshot.currentIndex;
    line.history = stepBack
      ? stepBack.history.slice()
      : Array.isArray(snapshot.history)
        ? snapshot.history.slice()
        : line.history;
    line.historyIndex = stepBack
      ? stepBack.historyIndex
      : snapshot.historyIndex == null
        ? Math.max(0, (line.history || []).length - 1)
        : snapshot.historyIndex;
    line.trackGroup = snapshot.trackGroup || null;
    line.splitAncestors = Array.isArray(snapshot.splitAncestors)
      ? snapshot.splitAncestors.slice()
      : [];
    line.subStack = cloneState(snapshot.subStack) || [];
    line.savedHistories = cloneState(snapshot.savedHistories) || [];
    line.visitedSubFrames = Array.isArray(snapshot.visitedSubFrames)
      ? snapshot.visitedSubFrames.slice()
      : [];
    line.isVoting = false;
    line.isHolding = false;
    line.isStandby = false;
    line.isBarrierWaiting = false;
    line.isGroupWaiting = false;
    line.pendingHoldUntil = [];
    line.pendingRejoinAt = null;
    line.votingTimer = null;
    line.holdingTimer = null;
    line.standbyTimer = null;
    line.currWinningId = undefined;
    line.previousWinningCount = 0;
    line._lastVoteCounts = null;
    line._lastReachedRef = null;
  }

  // Registered devices that were on a line the merge swallowed — offline ones
  // included — go back to it.
  for (const [deviceId, lineId] of Object.entries(
    session.deviceRegistry || {},
  )) {
    if (lineId !== survivorId) {
      continue;
    }
    const target = deviceTarget.get(String(deviceId));
    if (target && target !== lineId) {
      session.deviceRegistry[deviceId] = target;
    }
  }

  // Every device a snapshot names goes back to the line it was on.
  for (const conn of conns) {
    if (conn.lineId !== survivorId) {
      continue; // not part of the merged population
    }
    const target =
      conn.deviceId != null ? deviceTarget.get(String(conn.deviceId)) : null;
    if (target && target !== conn.lineId) {
      conn.lineId = target;
      conn.currentVoteTo = -1;
    }
  }
  // …and everyone else is spread across the lines coming back, which also
  // settles each line's dormancy. A CONVERGENCE runs this again over the whole
  // passage once its last step is back (`spreadMergeLatecomers`).
  spreadMergeLatecomers({
    session,
    lines: plan.restores.map(({ line }) => line),
    knownDeviceIds: new Set(deviceTarget.keys()),
    connections: conns,
  });

  // Split undos this merge had blocked become possible again — unless another
  // merge crossed the same boundary and has NOT been undone (an expired merge
  // still blocks: its own undo can never run, so the mixing it did is final).
  // This event is still `active` here, so it names itself among the blockers
  // and is discounted.
  for (const blockedId of plan.event.blockedSplitEventIds || []) {
    const others = blockingMergesFor(blockedId, session.mergeEvents).filter(
      (merge) => merge !== plan.event,
    );
    if (others.length > 0) {
      continue;
    }
    const splitEvent = splitEventById(session.splitEvents, blockedId);
    if (splitEvent && splitEvent.status === "active") {
      splitEvent.blockedByMerge = false;
      splitEvent.blockedAt = null;
    }
  }

  plan.event.status = "undone";
  plan.event.undoneAt = now();

  return { ...plan, restoredLineIds: plan.restores.map((r) => r.line.id) };
}

/**
 * Resolve a track-group voting window at close. Across EVERY grouped line's
 * tally, find the single largest count (random tiebreak among equals). If that
 * leader is a STAY, the whole group stays (group-wide brake, decision #3);
 * otherwise each line proceeds to its own link winner.
 *
 * @param {Array<{lineId: string, counts: Object<string,number>}>} tallies
 *   each line's vote counts (the countVoteForLine map, winningVoteId stripped/ignored)
 * @param {() => number} [randomFn]
 * @returns {{isStay: boolean, globalMax: number, leader: ({lineId:string,voteId:string}|null)}}
 */
function resolveGroupStay(tallies, randomFn = Math.random) {
  let max = -Infinity;
  let leaders = [];
  for (const t of tallies || []) {
    for (const [voteId, count] of Object.entries((t && t.counts) || {})) {
      if (voteId === "winningVoteId") continue;
      if (typeof count !== "number") continue;
      if (count > max) {
        max = count;
        leaders = [{ lineId: t.lineId, voteId }];
      } else if (count === max) {
        leaders.push({ lineId: t.lineId, voteId });
      }
    }
  }
  if (leaders.length === 0) {
    return { isStay: false, globalMax: 0, leader: null };
  }
  const leader = leaders[Math.floor(randomFn() * leaders.length)];
  return { isStay: leader.voteId === "stay", globalMax: max, leader };
}

/**
 * A single line's own LINK winner — the highest-count vote EXCLUDING "stay"
 * (and the synthetic "winningVoteId" key), random tiebreak among equals. Used
 * when the group did NOT globally stay: each line then proceeds to its own link
 * winner regardless of its local stay tally (decision #3). If no live link
 * counts remain but countVoteForLine preserved a window-local winning link
 * (for example the voter reconnected before close), use that remembered winner.
 * Returns null if the line has no link winner; the caller decides whether that
 * means stay or default-advance.
 */
function groupLinkWinner(counts, randomFn = Math.random) {
  let max = -Infinity;
  let leaders = [];
  for (const [voteId, count] of Object.entries(counts || {})) {
    if (voteId === "winningVoteId" || voteId === "stay") continue;
    if (typeof count !== "number") continue;
    if (count > max) {
      max = count;
      leaders = [voteId];
    } else if (count === max) {
      leaders.push(voteId);
    }
  }
  if (leaders.length === 0) {
    const retained = counts && counts.winningVoteId;
    return retained && retained !== "stay" ? retained : null;
  }
  return leaders[Math.floor(randomFn() * leaders.length)];
}

// ── Track-group ARRIVAL barrier ──────────────────────────────────────────────
// Grouped frames don't just vote together — they WAIT for each other. A line
// landing on a track-grouped frame parks (no voting) until every populated
// line that can still reach a group frame has arrived on one. Empty (0-device)
// lines neither count as occupants nor are waited for. The wait dissolves
// timeout-free via reachability (like dormancy releasing hold-until barriers,
// decision #11): a line that can no longer navigate to the group stops being
// "incoming" the moment its position/status says so.
//
// Hold synchronization: once everyone has ARRIVED, the group keeps waiting
// until every occupant's own holding period has also ended, so all lines leave
// the held frame TOGETHER and open their synchronized voting windows together
// — the group unlocks on the last node's hold release. Only meaningful with 2+
// occupants: a lone line has no one to sync with, so its hold never parks it
// (which would flash a spurious "waiting" banner on every solo grouped frame).
// The matching release edge is the holding timer firing (bin/www).

/**
 * Can a line standing at `fromFrame` still navigate to any frame in
 * `targetFrames`? BFS over `frameLinks` (frame name → ordered link target
 * indices into `listFiles`, built in buildSVGContent), cycle-safe,
 * case-insensitive. Unresolved links (index -1) are skipped. Standing on a
 * target counts as reaching it.
 *
 * @param {Object<string,number[]>} frameLinks
 * @param {string[]} listFiles index → frame name
 * @param {string} fromFrame
 * @param {Iterable<string>} targetFrames
 * @returns {boolean}
 */
function canReachFrames(frameLinks, listFiles, fromFrame, targetFrames) {
  if (!fromFrame) return false;
  const targets = new Set([...(targetFrames || [])].map(lc));
  if (targets.size === 0) return false;
  const next = frameAdjacency(frameLinks, listFiles);
  const visited = new Set([lc(fromFrame)]);
  const queue = [lc(fromFrame)];
  // A cursor, not shift(): shift re-indexes the whole queue on every step.
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head];
    if (targets.has(cur)) return true;
    for (const to of next.get(cur) || []) {
      if (!visited.has(to)) {
        visited.add(to);
        queue.push(to);
      }
    }
  }
  return false;
}

// Lower-cased frame → lower-cased frames its links reach, built once per score
// revision. A build replaces both `frameLinks` and `listFiles` with new
// objects, so keying on them is keying on the revision, and a barrier or group
// evaluation (which asks this for every waiting line) reuses one index.
const adjacencyCache = new WeakMap();
function frameAdjacency(frameLinks, listFiles) {
  const links = frameLinks || {};
  const files = listFiles || [];
  if (typeof links !== "object" || typeof files !== "object") {
    return buildFrameAdjacency(links, files);
  }
  let byFiles = adjacencyCache.get(links);
  if (!byFiles) {
    byFiles = new WeakMap();
    adjacencyCache.set(links, byFiles);
  }
  let adjacency = byFiles.get(files);
  if (!adjacency) {
    adjacency = buildFrameAdjacency(links, files);
    byFiles.set(files, adjacency);
  }
  return adjacency;
}

function buildFrameAdjacency(frameLinks, listFiles) {
  const adjacency = new Map();
  for (const [name, idxs] of Object.entries(frameLinks || {})) {
    adjacency.set(
      lc(name),
      (idxs || [])
        .map((idx) =>
          idx >= 0 && idx < listFiles.length ? lc(listFiles[idx]) : null,
        )
        .filter(Boolean),
    );
  }
  return adjacency;
}

/**
 * Decide whether a track group's arrival barrier is still waiting, and on
 * whom. A populated active line is:
 *   - an OCCUPANT when it sits on a group frame (main flow only). It still
 *     blocks the group while its own hold-until barrier is unreleased
 *     (`isBlocked`) — an out-of-group hold-until composes with the arrival
 *     barrier (validated: in-group targets are rejected).
 *   - INCOMING when it is elsewhere (or inside a sub) but `canReach(line)`
 * says it can still navigate to a group frame — UNLESS `hasPassed(line)` says
 * its trail already went through this group (owner rule, with the targeted
 * per-line rewind: a line that already passed the group counts as arrived
 * forever, so a line rewound BEHIND the group and replaying forward is never
 * wedged waiting for the lines ahead of it.
 *     On a forward-only score `canReach` already excludes the ahead lines;
 *     `hasPassed` makes the rule hold on scores with loops too. A rewind
 *     truncates the trail, so a line pulled back behind the group genuinely
 *     loses its "passed" status and must re-arrive).
 * Empty (0-device) and dormant/retired lines are ignored entirely.
 *
 * An occupant that is still in its own holding period (`isHolding`) keeps the
 * group waiting too, but ONLY when 2+ occupants sit on group frames — hold
 * synchronization needs someone to sync with (see the section note above).
 *
 * Kept pure: the caller injects frame/device/sub/barrier/holding/reachability
 * resolution, mirroring linesOnGroupFrames.
 *
 * @param {Array} lines
 * @param {Iterable<string>} groupFrames the group's frame names
 * @param {{
 *   frameNameForLine: (line)=>(string|null|undefined),
 *   deviceCount: (line)=>number,
 *   inSub?: (line)=>boolean,
 *   isBlocked?: (line)=>boolean,
 *   isHolding?: (line)=>boolean,
 *   canReach: (line)=>boolean,
 *   hasPassed?: (line)=>boolean,
 * }} opts
 * @returns {{waiting: boolean, incomingIds: string[], blockedIds: string[], holdingIds: string[]}}
 */
function groupArrivalState(lines, groupFrames, opts) {
  const set = new Set([...(groupFrames || [])].map(lc));
  const inSub = opts.inSub || (() => false);
  const isBlocked = opts.isBlocked || (() => false);
  const isHolding = opts.isHolding || (() => false);
  const hasPassed = opts.hasPassed || (() => false);
  const incomingIds = [];
  const blockedIds = [];
  const occupants = [];
  for (const l of lines || []) {
    if (!l || l.status !== "active") continue;
    if (opts.deviceCount(l) === 0) continue; // empty lines excluded (owner)
    const frameName = inSub(l) ? null : opts.frameNameForLine(l);
    if (frameName != null && set.has(lc(frameName))) {
      occupants.push(l);
      if (isBlocked(l)) blockedIds.push(l.id);
    } else if (!hasPassed(l) && opts.canReach(l)) {
      incomingIds.push(l.id);
    }
  }
  // Hold sync: with 2+ occupants, the group also waits for every occupant's
  // holding period to end (the last node's hold release unlocks the group).
  const holdingIds =
    occupants.length >= 2
      ? occupants.filter((l) => isHolding(l)).map((l) => l.id)
      : [];
  return {
    waiting: incomingIds.length + blockedIds.length + holdingIds.length > 0,
    incomingIds,
    blockedIds,
    holdingIds,
  };
}

/**
 * The STRAGGLERS of a track-group arrival barrier (owner): the lines the group
 * is still waiting on that could actually do something about it. Derived from
 * `groupArrivalState(...).incomingIds` by dropping the lines that are
 * themselves parked at a barrier.
 *
 * That subtraction is the whole point of the function. A parked line still
 * belongs in `incomingIds` — the group really is waiting on it, and letting it
 * drop out would release the group early — but it cannot proceed, so telling
 * its performers "your move" would be a lie, and its own parked banner already
 * explains the wait. Blocked occupants (`blockedIds`) are never stragglers
 * either: they have arrived; the group waits on their hold, not their travel.
 *
 * Order follows `incomingIds`, i.e. the caller's line order.
 *
 * @param {{incomingIds?: string[]}} state a groupArrivalState result
 * @param {{lines: Array, isParked?: (line)=>boolean}} opts `lines` is the same
 *   collection the state was computed over; `isParked` reports a line held at
 *   a hold-until barrier OR at some group's arrival barrier
 * @returns {string[]} straggler line ids
 */
function groupStragglerIds(state, opts) {
  const isParked = (opts && opts.isParked) || (() => false);
  const byId = new Map();
  for (const line of (opts && opts.lines) || []) {
    if (line && line.id != null) byId.set(line.id, line);
  }
  return ((state && state.incomingIds) || []).filter((id) => {
    const line = byId.get(id);
    return line != null && !isParked(line);
  });
}

// The Chunk-M `historyAvailability` predicate (FigJam "history modal behavior"
// rule + S6 single-line reading) lived here until the implicit bound-line
// {selectedIdx} rewind was retired for session-lines rooms. Rewinds there are
// the room-wide track-group checkpoint rewind (commonCheckpoints /
// roomRewindPlan above) and the explicit line-TARGETED rewind ({lineId} —
// bin/www lineRewind) — both deliberately NOT availability-gated.

// ── Sub-sessions ─────────────────────────────────────────────────────────────

/** Resolve a sub-return href to its index in the main frame list (-1 if unknown). */
function subReturnIndex(returnHref, listFilesInLowerCase) {
  if (!returnHref) return -1;
  return (listFilesInLowerCase || []).indexOf(lc(returnHref));
}

// ── Orchestrator (transport-injected) ────────────────────────────────────────

/**
 * Build the orchestrator bin/www consults. `transport` supplies the runtime
 * seams so the orchestration logic stays testable with a fake transport:
 *
 *   transport = {
 *     send(session, lineId, time, payload),         // → sendToLine
 *     sendAdmins(session, lineId, time, payload),   // → sendToLineAdmins (optional)
 *     createLine(session, id),                       // → new BMLine(session, id)
 *     MESSAGES,                                       // protocol constants
 *     now(),                                          // → Date.now (optional)
 *   }
 */
function createOrchestrator(transport) {
  const t = transport || {};
  const M = t.MESSAGES || {};
  const now = t.now || (() => Date.now());
  const send = (session, lineId, time, payload) =>
    typeof t.send === "function" && t.send(session, lineId, time, payload);
  const sendAdmins = (session, lineId, time, payload) =>
    typeof t.sendAdmins === "function" &&
    t.sendAdmins(session, lineId, time, payload);

  /**
   * Allocate a line number: the LOWEST `L<n>` (n >= 1) nothing currently holds.
   *
   * Numbers are RECYCLED rather than consumed. A line is a route through the
   * score, and the same route should not keep collecting new names: a room that
   * splits and merges all evening reads L0/L1/L2 instead of climbing to L13.
   * Retired lines give their number back as soon as nothing can address them
   * (`pruneRetiredLines`), while an id an undoable split event still names as
   * its parent stays reserved so that undo can restore it.
   *
   * L0 is never handed out here: it is the room's first line, and it survives
   * every merge it takes part in (lowest id wins), so it is only ever free in a
   * room that has no lines at all.
   */
  function allocLineId(session) {
    const taken = new Set(
      ((session && session.lines) || [])
        .map((line) => line && line.id)
        .filter(Boolean),
    );
    for (const id of reservedParentLineIds(session && session.splitEvents)) {
      taken.add(id);
    }
    let n = 1;
    while (taken.has(`L${n}`)) {
      n++;
    }
    return `L${n}`;
  }

  /**
   * Allocate the session-wide ordering number every structural event carries.
   * Splits and merges have separate id counters, so this is the only thing that
   * says which of an S and an M happened first — and one cascade has to walk
   * them in a single order.
   */
  function allocStructuralSeq(session) {
    let n = session.nextStructuralSeq != null ? session.nextStructuralSeq : 1;
    for (const event of [
      ...(session.splitEvents || []),
      ...(session.mergeEvents || []),
    ]) {
      if (event && event.seq != null && event.seq >= n) n = event.seq + 1;
    }
    session.nextStructuralSeq = n + 1;
    return n;
  }

  /** Allocate a persisted, never-reused structural split event id. */
  function allocSplitEventId(session) {
    let n = session.nextSplitEventId != null ? session.nextSplitEventId : 1;
    const events = Array.isArray(session.splitEvents) ? session.splitEvents : [];
    while (events.some((event) => event && event.id === `S${n}`)) n++;
    session.nextSplitEventId = n + 1;
    return `S${n}`;
  }

  /**
   * Allocate a persisted, never-reused id for ONE operator gesture that forks
   * several lines at once (`splitGestureEvents`). Separate from the event
   * counter because one gesture covers many events.
   */
  function allocSplitGestureId(session) {
    let n = session.nextSplitGestureId != null ? session.nextSplitGestureId : 1;
    const events = Array.isArray(session.splitEvents) ? session.splitEvents : [];
    while (events.some((event) => event && event.gestureId === `G${n}`)) n++;
    session.nextSplitGestureId = n + 1;
    return `G${n}`;
  }

  /** Allocate a persisted, never-reused structural merge event id. */
  function allocMergeEventId(session) {
    let n = session.nextMergeEventId != null ? session.nextMergeEventId : 1;
    const events = Array.isArray(session.mergeEvents) ? session.mergeEvents : [];
    while (events.some((event) => event && event.id === `M${n}`)) n++;
    session.nextMergeEventId = n + 1;
    return `M${n}`;
  }

  function seedLineAt(line, index) {
    if (typeof line.setCurrIdxTo === "function") {
      line.setCurrIdxTo(index);
    } else {
      line.currentIndex = index;
      line.history = [index];
      line.historyIndex = 0;
    }
  }

  /**
   * Execute a split. The parent line CONTINUES down the first branch (keeping
   * its number); every further branch is a new line on a recycled number.
   * Assigns choosers to their tapped child + balances the rest, reassigns
   * connections + deviceRegistry, and emits MSG_BEGIN_SPLIT +
   * MSG_LINE_ASSIGNED + MSG_SHOW to each child's connections.
   *
   * @param {object} a
   * @param {object} a.session
   * @param {object} a.parentLine
   * @param {number[]} a.childFrameIndices ordered child frame indices (frameLinks)
   * @param {Array<{conn?: object, key?: string, choice?: (number|null)}>} a.members
   * @returns {{children: object[], assignment: number[], counts: number[]}}
   */
  function applySplit({
    session,
    parentLine,
    childFrameIndices,
    members,
    // Which operator GESTURE this fork belongs to, when it is one of several
    // (a track group's release divides every populated line standing on a
    // split frame at once). Null for a lone choice window, which is one fork
    // and one gesture already. See `splitGestureEvents`.
    gestureId = null,
  }) {
    // Branch 0 IS the parent line (below), so a split with no branches would
    // dissolve it. Refuse rather than silently empty the room.
    if (!Array.isArray(childFrameIndices) || childFrameIndices.length === 0) {
      return { children: [], assignment: [], counts: [] };
    }
    if (!Array.isArray(session.splitEvents)) session.splitEvents = [];
    // A split no longer ends the undoability of the merge that produced this
    // line: the merge stays recorded, and reaching back for it undoes THIS
    // split on the way (`structuralRewindChain`). Nothing has to be freed here
    // either — an absorbed line kept no number to give back.
    const splitEventId = allocSplitEventId(session);
    const ancestorEventIds = lineSplitAncestors(parentLine);
    const parentHistory = Array.isArray(parentLine.history)
      ? parentLine.history
      : [];
    const requestedHistoryIndex = Number(parentLine.historyIndex);
    const parentHistoryIndex = Math.max(
      0,
      Math.min(
        Number.isFinite(requestedHistoryIndex)
          ? requestedHistoryIndex
          : Math.max(0, parentHistory.length - 1),
        Math.max(0, parentHistory.length - 1),
      ),
    );
    const splitEvent = {
      id: splitEventId,
      parentLineId: parentLine.id,
      frame:
        parentHistory[parentHistoryIndex] ||
        (session.listFiles || [])[parentLine.currentIndex] ||
        null,
      parentCurrentIndex: parentLine.currentIndex,
      parentHistory: parentHistory.slice(0, parentHistoryIndex + 1),
      parentHistoryIndex,
      parentTrackGroup: parentLine.trackGroup || null,
      parentVisitedSubFrames: Array.isArray(parentLine.visitedSubFrames)
        ? parentLine.visitedSubFrames.slice()
        : [],
      ancestorEventIds,
      childLineIds: [],
      // Durable identity beside the recycled numbers, and the session-wide
      // ordering that lets one cascade walk splits and merges together.
      parentLineUid: parentLine.uid || null,
      childLineUids: [],
      seq: allocStructuralSeq(session),
      gestureId: gestureId || null,
      status: "active",
      blockedByMerge: false,
      createdAt: now(),
    };
    session.splitEvents.push(splitEvent);

    const n = childFrameIndices.length;
    // The FIRST branch (score order) CONTINUES the parent line: it keeps the
    // parent's number, so a split spends one new number per EXTRA branch
    // instead of renaming every line in the room. Reusing the parent OBJECT —
    // reset to a pristine line with the same id — keeps every runtime handle
    // bin/www holds (its attrition timer above all) pointing at the line that
    // carried on. Its playhead and history still start FRESH at the child
    // frame, exactly like its siblings': the pre-split trail lives on in
    // `splitEvent`, and the structural undo is what walks it back.
    const parentTrackGroup = splitEvent.parentTrackGroup;
    const children = childFrameIndices.map((frameIdx, i) => {
      let child;
      if (i === 0) {
        if (typeof parentLine.clearAllTimer === "function") {
          parentLine.clearAllTimer();
        }
        Object.assign(parentLine, t.createLine(session, parentLine.id));
        // Runtime-only fields live outside the line model, so the reset above
        // does not reach them; a stale tally must not follow the line onto its
        // new frame (rewindSplitStructure clears the same pair).
        parentLine._lastVoteCounts = null;
        parentLine._lastReachedRef = null;
        if (!session.lines.includes(parentLine)) session.lines.push(parentLine);
        child = parentLine;
      } else {
        child = t.createLine(session, allocLineId(session));
        session.lines.push(child);
      }
      child.status = "active";
      child.trackGroup = parentTrackGroup || null;
      child.splitAncestors = [...ancestorEventIds, splitEventId];
      seedLineAt(child, frameIdx);
      return child;
    });
    splitEvent.childLineIds = children.map((child) => child.id);
    splitEvent.childLineUids = children.map((child) => child.uid || null);

    const { assignment, counts } = planSplitPartition(members, n);

    members.forEach((m, i) => {
      const child = children[assignment[i]];
      if (m.conn) m.conn.lineId = child.id;
      if (m.key != null && session.deviceRegistry) {
        session.deviceRegistry[m.key] = child.id;
      }
    });

    // Devices OFFLINE during the split are still registered to the parent's id.
    // Branch 0 kept that id, so none of them points at a dead line any more,
    // but they are still swept onto the smallest child (decision #13): an
    // absent performer is balanced across the branches like any straggler
    // rather than silently kept on branch 0.
    if (session.deviceRegistry) {
      const assignedKeys = new Set(
        members.map((m) => m.key).filter((k) => k != null),
      );
      for (const [did, lid] of Object.entries(session.deviceRegistry)) {
        if (lid !== parentLine.id || assignedKeys.has(did)) continue;
        let best = 0;
        for (let k = 1; k < counts.length; k++) {
          if (counts[k] < counts[best]) best = k;
        }
        session.deviceRegistry[did] = children[best].id;
        counts[best]++;
      }
    }

    // A branch NOBODY took is born dormant.
    //
    // Every child used to be born `active`, including one that ended up with
    // no population at all — a `session-split="3"` taken by two performers
    // always makes one. That line is then immortal by construction: dormancy
    // is driven by a device LEAVING (#11), and a line born empty never had one
    // to lose, so nothing ever demotes it. It holds its number for the rest of
    // the session, it is counted in "N lines (N active)", and — the part that
    // actually hurt — `activeLines` hands it to `resolveGroupVoting`, which on
    // a grouped SPLIT frame divides it again on every window. A room whose
    // split frame sits in a track group therefore DOUBLED its line count every
    // time the group released: one real observation showed 15 splits at the
    // same frame and 16 lines, 14 of them empty, with two performers in the
    // room.
    //
    // Dormant is exactly what it is: no population, revivable by #11 for the
    // next joiner (who then takes the road nobody took — the right landing for
    // it), never waited for at a barrier, and never again offered to
    // `activeLines`. `counts` is final here: `planSplitPartition` filled it
    // from the live members and the registry sweep above added the offline
    // ones, so a zero means nobody at all, present or absent.
    children.forEach((child, i) => {
      if ((counts[i] || 0) === 0) child.status = "dormant";
    });

    // Nothing to retire: branch 0 is the parent line, carrying on.

    // Tell each child's devices their new line — the continuing branch is
    // told the id it already has, which is harmless and keeps one code path.
    // Frame DISPLAY (MSG_SHOW vs a MSG_SUB_ENTER when the child lands on a
    // sub-start) is the caller's job — keeping it here would race a delayed
    // SHOW against an immediate SUB_ENTER.
    for (const child of children) {
      send(session, child.id, 0, { m: M.MSG_BEGIN_SPLIT, lineId: child.id });
      send(session, child.id, 0, { m: M.MSG_LINE_ASSIGNED, lineId: child.id });
    }

    return { children, assignment, counts };
  }

  /**
   * Merge a set of lines into the lowest-id survivor. Reassigns the absorbed
   * lines' connections + deviceRegistry to the survivor and hard-retires them.
   * Does NOT move the survivor's playhead (caller decides where it proceeds).
   *
   * @returns {{survivor: (object|null), absorbed: object[]}}
   */
  function applyRecombine({ session, lineIds, connections, frame }) {
    // Line numbers are per-ROOM: every session starts at L0, so `L1` names a
    // different line in every performance running on the server. Everything
    // below matches connections by `lineId` alone, so an unfiltered list let
    // one room's rejoin walk into another's: room B's device was rebound to
    // room A's survivor, its id was written into room A's registry and merge
    // snapshot, and room B was told nothing at all. Narrow the list ONCE, here
    // at the orchestration boundary, so no call site can reintroduce it.
    const roomConns = (connections || []).filter(
      (conn) => conn && conn.sessionId === session.id,
    );
    // One line per node brings DORMANT lines into merges too (a husk standing
    // where a live line arrives). The survivor is the lowest-numbered LIVE
    // participant, so the performers keep the line they are playing and its
    // running phase; only an all-dormant merge falls back to the lowest number.
    const statusOf = (id) => {
      const line = session.lines.find((l) => l.id === id);
      return line ? line.status : null;
    };
    const liveIds = (lineIds || []).filter((id) => statusOf(id) === "active");
    const { survivorId } = planRecombine(liveIds.length ? liveIds : lineIds);
    const absorbedIds = [...new Set((lineIds || []).filter(Boolean))]
      .filter((id) => id !== survivorId)
      .sort((a, b) => lineIdNum(a) - lineIdNum(b));
    const anyLive = liveIds.length > 0;
    const survivor = session.lines.find((l) => l.id === survivorId) || null;
    if (!survivor) return { survivor: null, absorbed: [] };

    // A merge may be inside a split subtree (safe to rewind recursively), or
    // may mix that subtree with an outside line (not separable later). Keep the
    // split ids common to EVERY participant on the survivor; mark every crossed
    // active boundary so its structural rewind is refused with an explanation.
    const participants = [...new Set(lineIds || [])]
      .map((id) => session.lines.find((line) => line.id === id))
      .filter(Boolean);
    // Structural merge record: a merge is the one event that DESTROYS lines,
    // so it snapshots what it is about to swallow — each participant's frame,
    // trail, dive and devices — and `rewindMergeStructure` puts exactly that
    // back. Recorded BEFORE any field is touched: the survivor's ancestry is
    // narrowed and its playhead moved to the rejoin frame right after this. A
    // "merge" of ONE line (the barrier release path calls this for a lone
    // parked line) absorbs nothing, so it records nothing: there would be
    // nothing to separate again.
    if (!Array.isArray(session.mergeEvents)) session.mergeEvents = [];
    // An earlier merge involving these lines is NOT ended here: it is stacked
    // behind this one (mergeRewindPlan's newest-first rule), so a convergence
    // that merged in pairs can be walked all the way back.
    const deviceIdsFor = (lineId) => {
      const ids = new Set();
      for (const conn of roomConns) {
        // SPECTATORS are observation tools: a /map tab and a rider both follow
        // the survivor and are never restored to a line of their own. Durable
        // performer membership is what this snapshot is — writing an observer
        // into it would have the undo hand a line back to something that
        // cannot play it, and the registry would keep that claim after the tab
        // closed.
        if (
          conn.lineId === lineId &&
          conn.deviceId != null &&
          !isSpectatorConn(conn)
        ) {
          ids.add(String(conn.deviceId));
        }
      }
      for (const [did, lid] of Object.entries(session.deviceRegistry || {})) {
        if (lid === lineId) ids.add(String(did));
      }
      return [...ids];
    };
    let mergeEvent = null;
    if (absorbedIds.length > 0) {
      mergeEvent = {
        id: allocMergeEventId(session),
        frame: frame || null,
        // The SCORE the rejoin frame belongs to — the survivor's dive context,
        // which a co-presence merge shares with every participant (they merge
        // because they stand on the same node, and a node key includes the
        // dive). Null on the main flow. Without it nothing downstream could
        // tell a rejoin on `End.svg` inside `Tetra1` from one on a main
        // `End.svg`.
        sub:
          ((survivor.subStack || [])[(survivor.subStack || []).length - 1] || {})
            .score || null,
        survivorLineId: survivor.id,
        survivorLineUid: survivor.uid || null,
        seq: allocStructuralSeq(session),
        participants: participants.map((line) => ({
          lineId: line.id,
          // The route, not the number: L1 may name a different line by the
          // time this undo is reached for (`lineForSnapshot`).
          lineUid: line.uid || null,
          currentIndex: line.currentIndex,
          history: Array.isArray(line.history) ? line.history.slice() : [],
          historyIndex: line.historyIndex,
          trackGroup: line.trackGroup || null,
          splitAncestors: lineSplitAncestors(line),
          subStack: cloneState(line.subStack) || [],
          savedHistories: cloneState(line.savedHistories) || [],
          visitedSubFrames: Array.isArray(line.visitedSubFrames)
            ? line.visitedSubFrames.slice()
            : [],
          deviceIds: deviceIdsFor(line.id),
        })),
        blockedSplitEventIds: [],
        status: "active",
        createdAt: now(),
      };
    }

    const ancestrySets = participants.map(
      (line) => new Set(lineSplitAncestors(line)),
    );
    const ancestryUnion = new Set(
      ancestrySets.flatMap((set) => [...set]),
    );
    const commonAncestry = [...ancestryUnion].filter((eventId) =>
      ancestrySets.every((set) => set.has(eventId)),
    );
    for (const eventId of ancestryUnion) {
      if (commonAncestry.includes(eventId)) continue;
      const event = splitEventById(session.splitEvents, eventId);
      if (event && event.status === "active") {
        event.blockedByMerge = true;
        event.blockedAt = now();
        // Undoing THIS merge unblocks them again (rewindMergeStructure).
        if (mergeEvent) mergeEvent.blockedSplitEventIds.push(event.id);
      }
    }
    survivor.splitAncestors = commonAncestry;
    if (mergeEvent) session.mergeEvents.push(mergeEvent);

    const absorbedSet = new Set(absorbedIds);
    for (const conn of roomConns) {
      if (absorbedSet.has(conn.lineId)) {
        // Display follows the survivor for everyone in the room, observers
        // included — a /map tab or a rider watching an absorbed line must not
        // be left addressing a line that no longer exists. Only a PERFORMER's
        // device writes the durable claim: a spectator leaves no footprint in
        // the registry (`ensureLineAssignment` never looks one up for it), and
        // an entry written here would outlive the tab.
        conn.lineId = survivor.id;
        if (
          conn.deviceId != null &&
          session.deviceRegistry &&
          !isSpectatorConn(conn)
        ) {
          session.deviceRegistry[conn.deviceId] = survivor.id;
        }
      }
    }
    // Any device registered to an absorbed line follows the survivor too.
    if (session.deviceRegistry) {
      for (const [did, lid] of Object.entries(session.deviceRegistry)) {
        if (absorbedSet.has(lid)) session.deviceRegistry[did] = survivor.id;
      }
    }

    const absorbed = [];
    for (const id of absorbedIds) {
      const line = session.lines.find((l) => l.id === id);
      if (line) {
        line.status = "retired";
        absorbed.push(line);
      }
    }
    // All-dormant merges stay dormant: nobody is on any of them, and an active
    // line with no population would never be released by attrition.
    survivor.status = anyLive ? "active" : "dormant";
    // An absorbed line is structural — nothing can address it again, so its
    // number goes straight back in the pool. The merge undo does not need the
    // object: it re-creates the line from the snapshot it just took, which is
    // what lets the rejoin stay undoable all evening without the room's
    // numbering climbing.
    pruneRetiredLines(session);
    return { survivor, absorbed };
  }

  return {
    applySplit,
    applyRecombine,
    allocLineId,
    allocSplitEventId,
    allocSplitGestureId,
    allocMergeEventId,
    allocStructuralSeq,
    // A merge undo BUILDS the lines it restores, so the runtime's line class
    // and number allocator are wired in here.
    rewindMergeStructure: (args) =>
      rewindMergeStructure({
        createLine: t.createLine,
        allocLineId,
        ...args,
      }),
    pruneRetiredLines,
    seedLineAt,
    // Re-export pure helpers so bin/www has a single import surface.
    planSplitPartition,
    splitDestinationVoteIds,
    parseVoteTargetIndex,
    outgoingVoteIds,
    outgoingTargetIndices,
    validateTapTarget,
    diveContextKey,
    defaultOutgoingVoteId,
    holdUntilSatisfied,
    holdUntilReachabilityState,
    markReached,
    registryCoveredTargets,
    registryClaimants,
    roomWalkedRefs,
    beginReachedGeneration,
    unparkLine,
    rejoinSatisfied,
    planRecombine,
    groupOfFrame,
    groupFramesLower,
    linesOnGroupFrames,
    revivalLandingFrame,
    commonCheckpoints,
    roomRewindPlan,
    ancestorGroupOccurrence,
    splitRewindPlan,
    splitRewindOptions,
    rewindSplitStructure,
    mergeRewindPlan,
    mergeRewindOptions,
    mergeConvergenceEvents,
    splitGestureEvents,
    mergesBehindLine,
    mergesBehindRoomRewind,
    splitsBehindRoomRewind,
    preMergeLanding,
    frameIndexResolver,
    spreadMergeLatecomers,
    structuralEvents,
    compareStructural,
    structuralRewindChain,
    cascadeSteps,
    chainMergesCanUndo,
    splitStepState,
    resolveGroupStay,
    groupLinkWinner,
    canReachFrames,
    groupArrivalState,
    groupStragglerIds,
    holdUntilStragglerTargets,
    subReturnIndex,
  };
}

module.exports = {
  planSplitPartition,
  splitDestinationVoteIds,
  parseVoteTargetIndex,
  outgoingVoteIds,
  outgoingTargetIndices,
  validateTapTarget,
  diveContextKey,
  defaultOutgoingVoteId,
  holdUntilSatisfied,
  holdUntilReachabilityState,
  markReached,
  registryCoveredTargets,
  registryClaimants,
  roomWalkedRefs,
  beginReachedGeneration,
  unparkLine,
  rejoinSatisfied,
  planRecombine,
  groupOfFrame,
  groupFramesLower,
  linesOnGroupFrames,
  revivalLandingFrame,
  commonCheckpoints,
  roomRewindPlan,
  ancestorGroupOccurrence,
  splitRewindPlan,
  splitRewindOptions,
  rewindSplitStructure,
  mergeRewindPlan,
  mergeRewindOptions,
  mergeConvergenceEvents,
  splitGestureEvents,
  mergesBehindLine,
  mergesBehindRoomRewind,
  splitsBehindRoomRewind,
  preMergeLanding,
  frameIndexResolver,
  spreadMergeLatecomers,
  rewindMergeStructure,
  structuralEvents,
  compareStructural,
  structuralRewindChain,
  cascadeSteps,
  chainMergesCanUndo,
  splitStepState,
  resolveGroupStay,
  groupLinkWinner,
  canReachFrames,
  groupArrivalState,
  groupStragglerIds,
  holdUntilStragglerTargets,
  subReturnIndex,
  createOrchestrator,
};
