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

const { lineIdNum } = require("./routing");

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
 * The STRAGGLERS of a hold-until barrier (2026-08-28) — the same idea as
 * `groupStragglerIds` one step over. A track group waits for lines to ARRIVE on
 * it; a hold-until waits for some line to REACH a named target, so the lines it
 * is really held open for are the ones that can still get there. Until now they
 * were nobody: the entry carried no stragglers at all and the operator's only
 * valve on a stuck hold-until was the plain release (let it go without the
 * target), never "send in the line that still owes it".
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

// Rendezvous registry phases (decision #6, decided 2026-07-04): a barrier
// target counts once ANY line has reached that frame anywhere in the session
// AND the frame's own holding period there has ended — the waiting lines stay
// parked at their own frames; they do not have to converge on the target.
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
 * @param {Object<string,string>} reachedTargets session-global registry
 * @param {string[]} targets
 * @returns {Set<string>} the subset of `targets` (original casing) covered
 */
function registryCoveredTargets(reachedTargets, targets) {
  const covered = new Set();
  const reg = reachedTargets || {};
  for (const target of targets || []) {
    if (reg[lc(target)] === REACHED_DONE) {
      covered.add(target);
    }
  }
  return covered;
}

/**
 * SM jump = rewind: start a new reached generation (open-item S2/R4,
 * decided 2026-07-07: option (b)). Everything the registry accumulated belongs
 * to the pre-rewind story, so a barrier met again after the rewind gates like
 * a first pass — even one that was satisfied before. The ONE exception is the
 * barrier AT the rewind landing itself: the room already passed it, so its own
 * targets are pre-satisfied and it stays unlocked.
 *
 * @param {object} session mutated: reachedGeneration++, reachedTargets reset,
 *   latestGroupArrival cleared (the revival fast-forward record belongs to the
 *   pre-rewind story too — the caller re-records it if the landing is grouped)
 * @param {string[]} [landingHoldTargets] the landing frame's own hold-until
 *   targets (empty/absent when the landing is not a barrier frame)
 */
function beginReachedGeneration(session, landingHoldTargets) {
  session.reachedGeneration = (session.reachedGeneration || 0) + 1;
  session.reachedTargets = {};
  session.latestGroupArrival = null;
  for (const target of landingHoldTargets || []) {
    markReached(session.reachedTargets, target, true);
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
 * Decision #13 revision (2026-07-18): the landing frame for a dormant-line
 * revival. A revived line abandons its frozen (stale) position and
 * fast-forwards to the latest track group the room has reached — landing on
 * that group's least-occupied frame, so revivals fill missing track slots
 * instead of doubling covered ones (ties → the recorded arrival frame, then
 * group declaration order).
 *
 * Returns null — meaning "keep the frozen position" (the pre-revision
 * behavior) — when there is no recorded grouped landing, the recorded frame
 * is no longer grouped / no group frame resolves in the current frame list,
 * or the line froze on a frame of that same group (its own frame IS a slot
 * of the latest group; leaving it would abandon the slot).
 *
 * @param {object} opts
 * @param {object} opts.graph main-score graph (groups/byFrame)
 * @param {string[]} opts.listFiles main frame list
 * @param {string|null} opts.latestGroupFrame session.latestGroupArrival frame
 * @param {object} opts.line the reviving line (frozen position)
 * @param {(frameName: string) => number} opts.occupancy count of OTHER active
 *   main-flow lines currently sitting on the frame
 * @returns {string|null} the frame NAME to land on, or null to revive in place
 */
function revivalLandingFrame({ graph, listFiles, latestGroupFrame, line, occupancy }) {
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
  if (frozen && present.some((name) => lc(name) === lc(frozen))) return null;

  let best = null;
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
 * @param {{lines: Array<{id:string, trail:string[]}>, groups: Object<string,string[]>}} opts
 * @returns {Array<{group:string, byLine:Object<string,string>}>} newest-first
 */
function commonCheckpoints({ lines, groups }) {
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
      const hit = latestGroupTrailOccurrence(line.trail, frames);
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
 * Per-line landing plan for a room-wide rewind to `group`.
 *
 * `checkpointLines` should be the currently-populated line subset used to
 * decide whether the group is a legal checkpoint. `lines` is the full set of
 * non-retired lines to reposition; lines with no group occurrence take the
 * least-occupied group frame after history landings are counted.
 *
 * @param {object} opts
 * @param {Array<{id:string, trail:string[]}>} opts.lines all lines to move
 * @param {Array<{id:string, trail:string[]}>} [opts.checkpointLines]
 * @param {Object<string,string[]>} opts.groups
 * @param {string} opts.group requested group name
 * @returns {{group:string, checkpoint:Object, lines:Array<{lineId:string, frame:string, source:string, historyIndex:number}>}|null}
 */
function roomRewindPlan({ lines, checkpointLines, groups, group }) {
  const resolvedGroup = resolveGroupName(groups, group);
  if (!resolvedGroup) {
    return null;
  }
  const checkpoints = commonCheckpoints({
    lines: checkpointLines || lines,
    groups,
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
    const hit = latestGroupTrailOccurrence(line.trail, frames);
    if (hit) {
      plans.push({
        lineId: line.id,
        frame: hit.frame,
        source: "history",
        historyIndex: hit.index,
      });
      occupancy.set(lc(hit.frame), (occupancy.get(lc(hit.frame)) || 0) + 1);
    } else {
      fill.push(line);
    }
  }

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
    });
  }

  return { group: resolvedGroup, checkpoint, lines: plans };
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
  const parent = allLines.find((line) => line && line.id === event.parentLineId);
  if (!parent || parent.status !== "retired") {
    return { available: false, reason: "parent-unavailable", event };
  }

  const eventKey = String(event.id);
  const descendants = allLines.filter((line) =>
    lineSplitAncestors(line).includes(eventKey),
  );
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

/** Admin-map projection: active split instances, including blocked entries so
 * the menu can explain why a structural rewind is unavailable. */
function splitRewindOptions({ splitEvents, lines }) {
  return (Array.isArray(splitEvents) ? splitEvents : [])
    .filter((event) => event && event.status === "active")
    .map((event) => {
      const plan = splitRewindPlan({
        splitEvents,
        lines,
        eventId: event.id,
      });
      return {
        eventId: event.id,
        parentLineId: event.parentLineId,
        frame: event.frame,
        available: plan.available,
        reason: plan.reason,
        descendantLineIds: plan.available
          ? plan.liveDescendants.map((line) => line.id)
          : [],
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

  return { ...plan, parent, descendantIds: [...descendantIds] };
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

// ── Track-group ARRIVAL barrier (decided 2026-07-16) ─────────────────────────
// Grouped frames don't just vote together — they WAIT for each other. A line
// landing on a track-grouped frame parks (no voting) until every populated
// line that can still reach a group frame has arrived on one. Empty (0-device)
// lines neither count as occupants nor are waited for. The wait dissolves
// timeout-free via reachability (like dormancy releasing hold-until barriers,
// decision #11): a line that can no longer navigate to the group stops being
// "incoming" the moment its position/status says so.
//
// Hold synchronization (added 2026-07-20): once everyone has ARRIVED, the group
// keeps waiting until every occupant's own holding period has also ended, so all
// lines leave the held frame TOGETHER and open their synchronized voting windows
// together — the group unlocks on the last node's hold release. Only meaningful
// with 2+ occupants: a lone line has no one to sync with, so its hold never
// parks it (which would flash a spurious "waiting" banner on every solo grouped
// frame). The matching release edge is the holding timer firing (bin/www).

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
  const linksLower = {};
  for (const [name, idxs] of Object.entries(frameLinks || {})) {
    linksLower[lc(name)] = idxs;
  }
  const files = listFiles || [];
  const visited = new Set([lc(fromFrame)]);
  const queue = [lc(fromFrame)];
  while (queue.length > 0) {
    const cur = queue.shift();
    if (targets.has(cur)) return true;
    for (const idx of linksLower[cur] || []) {
      const next = idx >= 0 && idx < files.length ? lc(files[idx]) : null;
      if (next && !visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}

/**
 * Decide whether a track group's arrival barrier is still waiting, and on
 * whom. A populated active line is:
 *   - an OCCUPANT when it sits on a group frame (main flow only). It still
 *     blocks the group while its own hold-until barrier is unreleased
 *     (`isBlocked`) — an out-of-group hold-until composes with the arrival
 *     barrier (validated: in-group targets are rejected).
 *   - INCOMING when it is elsewhere (or inside a sub) but `canReach(line)`
 *     says it can still navigate to a group frame — UNLESS `hasPassed(line)`
 *     says its trail already went through this group (owner rule, 2026-07-19,
 *     with the targeted per-line rewind: a line that already passed the group
 *     counts as arrived forever, so a line rewound BEHIND the group and
 *     replaying forward is never wedged waiting for the lines ahead of it.
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
 * The STRAGGLERS of a track-group arrival barrier (owner, 2026-08-16): the
 * lines the group is still waiting on that could actually do something about
 * it. Derived from `groupArrivalState(...).incomingIds` by dropping the lines
 * that are themselves parked at a barrier.
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
// rule + S6 single-line reading) lived here until 2026-07-19, when the implicit
// bound-line {selectedIdx} rewind was retired for session-lines rooms. Rewinds
// there are the room-wide track-group checkpoint rewind (commonCheckpoints /
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

  /** Allocate the next "L<n>" id from the session counter. */
  function allocLineId(session) {
    const n = session.nextLineId != null ? session.nextLineId : 1;
    session.nextLineId = n + 1;
    return `L${n}`;
  }

  /** Allocate a persisted, never-reused structural split event id. */
  function allocSplitEventId(session) {
    let n = session.nextSplitEventId != null ? session.nextSplitEventId : 1;
    const events = Array.isArray(session.splitEvents) ? session.splitEvents : [];
    while (events.some((event) => event && event.id === `S${n}`)) n++;
    session.nextSplitEventId = n + 1;
    return `S${n}`;
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
   * Execute a split. Spawns N child lines (one per child frame index), assigns
   * choosers to their tapped child + balances the rest, reassigns connections +
   * deviceRegistry, hard-retires the parent, and emits MSG_BEGIN_SPLIT +
   * MSG_LINE_ASSIGNED + MSG_SHOW to each child's connections.
   *
   * @param {object} a
   * @param {object} a.session
   * @param {object} a.parentLine
   * @param {number[]} a.childFrameIndices ordered child frame indices (frameLinks)
   * @param {Array<{conn?: object, key?: string, choice?: (number|null)}>} a.members
   * @returns {{children: object[], assignment: number[], counts: number[]}}
   */
  function applySplit({ session, parentLine, childFrameIndices, members }) {
    if (!Array.isArray(session.splitEvents)) session.splitEvents = [];
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
      status: "active",
      blockedByMerge: false,
      createdAt: now(),
    };
    session.splitEvents.push(splitEvent);

    const n = childFrameIndices.length;
    const children = childFrameIndices.map((frameIdx) => {
      const id = allocLineId(session);
      const child = t.createLine(session, id);
      child.status = "active";
      child.trackGroup = parentLine.trackGroup || null;
      child.splitAncestors = [...ancestorEventIds, splitEventId];
      seedLineAt(child, frameIdx);
      session.lines.push(child);
      return child;
    });
    splitEvent.childLineIds = children.map((child) => child.id);

    const { assignment, counts } = planSplitPartition(members, n);

    members.forEach((m, i) => {
      const child = children[assignment[i]];
      if (m.conn) m.conn.lineId = child.id;
      if (m.key != null && session.deviceRegistry) {
        session.deviceRegistry[m.key] = child.id;
      }
    });

    // Devices OFFLINE during the split are still registered to the parent —
    // sweep them onto the smallest child so a later reconnect never lands on
    // the hard-retired parent (decision #13), mirroring applyRecombine's sweep.
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

    // Parent is structural — hard-retired, not dormant (decision #11).
    parentLine.status = "retired";

    // Tell each child's devices their new line. Frame DISPLAY (MSG_SHOW vs a
    // MSG_SUB_ENTER when the child lands on a sub-start) is the caller's job —
    // keeping it here would race a delayed SHOW against an immediate SUB_ENTER.
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
  function applyRecombine({ session, lineIds, connections }) {
    const { survivorId, absorbedIds } = planRecombine(lineIds);
    const survivor = session.lines.find((l) => l.id === survivorId) || null;
    if (!survivor) return { survivor: null, absorbed: [] };

    // A merge may be inside a split subtree (safe to rewind recursively), or
    // may mix that subtree with an outside line (not separable later). Keep the
    // split ids common to EVERY participant on the survivor; mark every crossed
    // active boundary so its structural rewind is refused with an explanation.
    const participants = [...new Set(lineIds || [])]
      .map((id) => session.lines.find((line) => line.id === id))
      .filter(Boolean);
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
      }
    }
    survivor.splitAncestors = commonAncestry;

    const absorbedSet = new Set(absorbedIds);
    for (const conn of connections || []) {
      if (conn && absorbedSet.has(conn.lineId)) {
        conn.lineId = survivor.id;
        if (conn.deviceId != null && session.deviceRegistry) {
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
    survivor.status = "active";
    return { survivor, absorbed };
  }

  return {
    applySplit,
    applyRecombine,
    allocLineId,
    allocSplitEventId,
    seedLineAt,
    // Re-export pure helpers so bin/www has a single import surface.
    planSplitPartition,
    splitDestinationVoteIds,
    parseVoteTargetIndex,
    outgoingVoteIds,
    defaultOutgoingVoteId,
    holdUntilSatisfied,
    holdUntilReachabilityState,
    markReached,
    registryCoveredTargets,
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
    splitRewindPlan,
    splitRewindOptions,
    rewindSplitStructure,
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
  defaultOutgoingVoteId,
  holdUntilSatisfied,
  holdUntilReachabilityState,
  markReached,
  registryCoveredTargets,
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
  splitRewindPlan,
  splitRewindOptions,
  rewindSplitStructure,
  resolveGroupStay,
  groupLinkWinner,
  canReachFrames,
  groupArrivalState,
  groupStragglerIds,
  holdUntilStragglerTargets,
  subReturnIndex,
  createOrchestrator,
};
