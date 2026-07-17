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
 * @param {object} session mutated: reachedGeneration++, reachedTargets reset
 * @param {string[]} [landingHoldTargets] the landing frame's own hold-until
 *   targets (empty/absent when the landing is not a barrier frame)
 */
function beginReachedGeneration(session, landingHoldTargets) {
  session.reachedGeneration = (session.reachedGeneration || 0) + 1;
  session.reachedTargets = {};
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
 *     says it can still navigate to a group frame.
 * Empty (0-device) and dormant/retired lines are ignored entirely.
 *
 * Kept pure: the caller injects frame/device/sub/barrier/reachability
 * resolution, mirroring linesOnGroupFrames/historyAvailability.
 *
 * @param {Array} lines
 * @param {Iterable<string>} groupFrames the group's frame names
 * @param {{
 *   frameNameForLine: (line)=>(string|null|undefined),
 *   deviceCount: (line)=>number,
 *   inSub?: (line)=>boolean,
 *   isBlocked?: (line)=>boolean,
 *   canReach: (line)=>boolean,
 * }} opts
 * @returns {{waiting: boolean, incomingIds: string[], blockedIds: string[]}}
 */
function groupArrivalState(lines, groupFrames, opts) {
  const set = new Set([...(groupFrames || [])].map(lc));
  const inSub = opts.inSub || (() => false);
  const isBlocked = opts.isBlocked || (() => false);
  const incomingIds = [];
  const blockedIds = [];
  for (const l of lines || []) {
    if (!l || l.status !== "active") continue;
    if (opts.deviceCount(l) === 0) continue; // empty lines excluded (owner)
    const frameName = inSub(l) ? null : opts.frameNameForLine(l);
    if (frameName != null && set.has(lc(frameName))) {
      if (isBlocked(l)) blockedIds.push(l.id);
    } else if (opts.canReach(l)) {
      incomingIds.push(l.id);
    }
  }
  return {
    waiting: incomingIds.length + blockedIds.length > 0,
    incomingIds,
    blockedIds,
  };
}

// ── Session manager: history-modal availability (Chunk M) ────────────────────

/**
 * SM history-modal availability (the FigJam "history modal behavior" rule).
 *
 * With 2+ populated lines, history/jump is only coherent while the room is
 * SYNCHRONIZED — i.e. every device-bearing active line sits on a track-grouped
 * frame. The moment any device-bearing line occupies a non-grouped frame (or
 * has dived into a sub-session), the lines have diverged/unsynced and history
 * becomes "impossible" (disabled; the decided reading (i) checkpoint fallback
 * is future modal work). Empty lines (0 devices — e.g. a child born with no
 * choosers, or a line mid-attrition) represent no participant view, so they are
 * ignored rather than blocking the operator's history for populated lines.
 *
 * A single populated line is an UNDIVERGED room (S6, decided 2026-07-07 — the
 * FigJam a.svg "global history" row; lines are git branches, and one branch is
 * always safe to rewind): history is available on any main-flow frame. Inside a
 * sub it stays disabled — history names resolve against the main frame list, so
 * a jump there is meaningless (the MSG_SELECT_HISTORY handler refuses it too).
 *
 * Kept pure so it is unit-testable: the caller injects how to resolve a line's
 * current track group, its live device count, and whether it is inside a sub.
 * A vanilla score never calls this (bin/www short-circuits to "available"), so
 * today's SM history is unchanged.
 *
 * @param {Array} lines active lines to consider
 * @param {(line)=>(string|null)} groupForLine current track-group of the line's
 *   frame, or null when it is on a non-grouped frame / inside a sub-session
 * @param {(line)=>number} deviceCountForLine live device count on the line
 * @param {(line)=>boolean} [inSubForLine] line is inside a sub-session
 * @returns {boolean} true when history/jump is available
 */
function historyAvailability(
  lines,
  groupForLine,
  deviceCountForLine,
  inSubForLine = () => false,
) {
  const populated = (lines || []).filter((l) => deviceCountForLine(l) > 0);
  if (populated.length === 0) return true;
  if (populated.length === 1) return !inSubForLine(populated[0]);
  return populated.every((l) => groupForLine(l) != null);
}

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
    const n = childFrameIndices.length;
    const children = childFrameIndices.map((frameIdx) => {
      const id = allocLineId(session);
      const child = t.createLine(session, id);
      child.status = "active";
      child.trackGroup = parentLine.trackGroup || null;
      seedLineAt(child, frameIdx);
      session.lines.push(child);
      return child;
    });

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
    seedLineAt,
    // Re-export pure helpers so bin/www has a single import surface.
    planSplitPartition,
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
    resolveGroupStay,
    groupLinkWinner,
    canReachFrames,
    groupArrivalState,
    historyAvailability,
    subReturnIndex,
  };
}

module.exports = {
  planSplitPartition,
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
  resolveGroupStay,
  groupLinkWinner,
  canReachFrames,
  groupArrivalState,
  historyAvailability,
  subReturnIndex,
  createOrchestrator,
};
