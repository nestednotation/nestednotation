/**
 * Session Lines — score validator (pure).
 *
 * Runs before a score is used in a session (and is the basis for a future
 * upload/lint check). Given a relationship graph (graph.js), the main-score
 * frame names, and a loader for sub-scores, returns { errors, warnings }.
 *
 * Checks (from docs/session-lines.md "Validation"):
 *   - split N == href count (and N >= 2)
 *   - every hold-until / rejoin-at / sub-start target resolves
 *   - each sub-start score has a START + at least one sub-end
 *   - track-group consistency
 *   - best-effort unsatisfiable-barrier check
 *
 * No express/ws/fs imports — fully unit-testable.
 */

function baseName(name) {
  return String(name)
    .replace(/\\/g, "/")
    .split("/")
    .pop();
}

function lowerSet(names) {
  const map = {};
  for (const n of names || []) {
    map[String(n).toLowerCase()] = n;
  }
  return map;
}

function isStartFrame(name) {
  const b = baseName(name).toUpperCase();
  return b.startsWith("START") || b.startsWith("PRE");
}

/**
 * The sub-score frames a line can land on (following hrefs from its START
 * frames) that have NO path onward to a session-sub-end frame. Empty for a
 * well-formed sub. `sub` is a subLoader result ({frameNames, graph}).
 */
function subFramesWithoutExit(sub) {
  const names = sub.frameNames || [];
  const byLower = lowerSet(names);
  const hrefsOf = (frame) => {
    const node = ((sub.graph && sub.graph.byFrame) || {})[frame];
    return ((node && node.hrefs) || [])
      .map((h) => byLower[String(h).toLowerCase()])
      .filter(Boolean);
  };

  // Frames that can reach a sub-end: fixpoint over reversed href edges.
  const canExit = new Set(
    Object.keys((sub.graph && sub.graph.subEnd) || {}).map((f) =>
      f.toLowerCase(),
    ),
  );
  let grew = true;
  while (grew) {
    grew = false;
    for (const frame of names) {
      if (canExit.has(frame.toLowerCase())) continue;
      if (hrefsOf(frame).some((next) => canExit.has(next.toLowerCase()))) {
        canExit.add(frame.toLowerCase());
        grew = true;
      }
    }
  }

  // Frames a line can actually land on: forward walk from the START frames.
  const reachable = new Set();
  const queue = names.filter(isStartFrame);
  while (queue.length > 0) {
    const frame = queue.pop();
    if (reachable.has(frame.toLowerCase())) continue;
    reachable.add(frame.toLowerCase());
    queue.push(...hrefsOf(frame));
  }

  return names.filter(
    (f) => reachable.has(f.toLowerCase()) && !canExit.has(f.toLowerCase()),
  );
}

/**
 * @param {object} graph - result of buildGraph(mainFrames).
 * @param {string[]} [frameNames] - main-score frame names (defaults to graph.frames).
 * @param {(score: string) => ({frameNames: string[], graph: object}|null)} [subLoader]
 *   Resolves a sub-score by name. Returns its frame names + graph, or null if missing.
 * @returns {{errors: object[], warnings: object[]}}
 */
function validateScore(graph, frameNames, subLoader) {
  const errors = [];
  const warnings = [];

  if (!graph || typeof graph !== "object") {
    errors.push({ code: "no-graph", message: "No graph supplied to validator" });
    return { errors, warnings };
  }

  const names = Array.isArray(frameNames) && frameNames.length > 0
    ? frameNames
    : graph.frames || [];
  const byLower = lowerSet(names);
  const loadSub = typeof subLoader === "function" ? subLoader : () => null;

  const resolveMain = (ref) => byLower[String(ref).toLowerCase()] ?? null;

  // Set of frames that are reachable via some href (or are start frames).
  const referenced = new Set();
  for (const frame of names) {
    if (isStartFrame(frame)) {
      referenced.add(frame.toLowerCase());
    }
  }
  for (const frameName of Object.keys(graph.byFrame || {})) {
    const node = graph.byFrame[frameName];
    for (const href of node.hrefs || []) {
      const resolved = resolveMain(href);
      if (resolved) {
        referenced.add(resolved.toLowerCase());
      }
    }
  }

  // 1) Split N == href count.
  for (const [frame, split] of Object.entries(graph.splits || {})) {
    if (split.n == null || split.n < 2) {
      errors.push({
        code: "split-n-too-small",
        frame,
        message: `session-split on ${frame} must be >= 2 (got ${split.n})`,
      });
    }
    if (split.n != null && split.hrefs.length !== split.n) {
      errors.push({
        code: "split-href-mismatch",
        frame,
        message: `session-split="${split.n}" on ${frame} but frame exposes ${split.hrefs.length} href(s)`,
      });
    }
  }

  // 2) hold-until targets resolve (main refs + sub refs like "Tetra2/E").
  for (const [frame, targets] of Object.entries(graph.holdUntilTargets || {})) {
    for (const target of targets) {
      if (target.includes("/")) {
        const slash = target.indexOf("/");
        const subName = target.slice(0, slash);
        const subFrame = target.slice(slash + 1);
        const sub = loadSub(subName);
        if (!sub) {
          errors.push({
            code: "hold-until-sub-missing",
            frame,
            message: `hold-until on ${frame} references sub-score "${subName}" which was not found`,
          });
          continue;
        }
        if (!lowerSet(sub.frameNames)[String(subFrame).toLowerCase()]) {
          errors.push({
            code: "hold-until-unresolved",
            frame,
            message: `hold-until on ${frame} references "${target}" but frame "${subFrame}" is not in sub-score "${subName}"`,
          });
        }
        continue;
      }

      const resolved = resolveMain(target);
      if (!resolved) {
        errors.push({
          code: "hold-until-unresolved",
          frame,
          message: `hold-until on ${frame} references unknown frame "${target}"`,
        });
        continue;
      }
      if (resolved.toLowerCase() === frame.toLowerCase()) {
        warnings.push({
          code: "hold-until-self",
          frame,
          message: `hold-until on ${frame} references itself — barrier can never be satisfied by another line`,
        });
      } else if (!referenced.has(resolved.toLowerCase())) {
        warnings.push({
          code: "barrier-target-unreachable",
          frame,
          message: `hold-until target "${target}" on ${frame} is not linked by any frame and is not a start frame — barrier may be unsatisfiable`,
        });
      }
    }
  }

  // 3) rejoin-at targets resolve (main frames) AND are the frame's own links.
  // rejoin-at announces "this line merges at the target on its NEXT step"
  // (owner-clarified 2026-07-08), so every target must be one of the frame's
  // outgoing links — a merge frame the line cannot step to is a broken score.
  for (const [frame, targets] of Object.entries(graph.rejoinTargets || {})) {
    const node = (graph.byFrame || {})[frame] || {};
    const ownLinks = new Set((node.hrefs || []).map((h) => String(h).toLowerCase()));
    for (const target of targets) {
      if (!resolveMain(target)) {
        errors.push({
          code: "rejoin-unresolved",
          frame,
          message: `rejoin-at on ${frame} references unknown frame "${target}"`,
        });
        continue;
      }
      if (!ownLinks.has(String(target).toLowerCase())) {
        errors.push({
          code: "rejoin-not-linked",
          frame,
          message: `rejoin-at on ${frame} names "${target}" but the frame has no link to it — the merge frame must be one of the frame's own next steps`,
        });
      }
    }
  }

  // 4) sub-start: sub-score exists, has START + >=1 sub-end; return href resolves.
  const deadEndCheckedSubs = new Set();
  for (const [frame, info] of Object.entries(graph.subStart || {})) {
    const sub = loadSub(info.score);
    if (!sub) {
      errors.push({
        code: "sub-start-missing-score",
        frame,
        message: `sub-start on ${frame} references sub-score "${info.score}" which was not found`,
      });
    } else {
      const hasStart = (sub.frameNames || []).some(isStartFrame);
      if (!hasStart) {
        errors.push({
          code: "sub-missing-start",
          frame,
          message: `sub-score "${info.score}" has no START frame`,
        });
      }
      const subEndCount = Object.keys((sub.graph && sub.graph.subEnd) || {}).length;
      if (subEndCount < 1) {
        errors.push({
          code: "sub-missing-end",
          frame,
          message: `sub-score "${info.score}" has no session-sub-end frame`,
        });
      }
      // Every sub frame a line can land on must keep an outgoing path to a
      // sub-end (decided 2026-07-07, in lieu of the runtime R2 hardening): a
      // line stranded inside a sub can never advance or be history-jumped, and
      // counts as "coming" forever — holding every open barrier in the room.
      if (subEndCount >= 1 && !deadEndCheckedSubs.has(info.score)) {
        deadEndCheckedSubs.add(info.score);
        for (const stuck of subFramesWithoutExit(sub)) {
          errors.push({
            code: "sub-dead-end",
            frame: stuck,
            message: `sub-score "${info.score}": frame "${stuck}" has no path to a session-sub-end frame — a line reaching it would be stranded in the sub`,
          });
        }
      }
    }

    if (!info.returnHref) {
      errors.push({
        code: "sub-start-no-return",
        frame,
        message: `sub-start on ${frame} has no href (return landing) in the main flow`,
      });
    } else if (!resolveMain(info.returnHref)) {
      errors.push({
        code: "sub-start-return-unresolved",
        frame,
        message: `sub-start return landing "${info.returnHref}" on ${frame} is not a known main-score frame`,
      });
    }
  }

  // 5) Track-group consistency: a group needs >= 2 members to synchronize.
  for (const [groupName, members] of Object.entries(graph.groups || {})) {
    if (members.length < 2) {
      warnings.push({
        code: "track-group-singleton",
        group: groupName,
        message: `track-group "${groupName}" has only ${members.length} frame — nothing to synchronize`,
      });
    }
  }

  return { errors, warnings };
}

module.exports = { validateScore };
