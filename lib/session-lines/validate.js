/**
 * Session Lines — score validator (pure).
 *
 * Runs before a score is used in a session (and is the basis for a future
 * upload/lint check). Given a relationship graph (graph.js), the main-score
 * frame names, and a loader for sub-scores, returns { errors, warnings }.
 *
 * Checks (from docs/session-lines.md "Validation"):
 *   - every ordinary frame link resolves to a frame in the same score
 *   - split N == href count (and N >= 2)
 *   - every hold-until / rejoin-at / sub-start target resolves
 *   - session-sub-start sits on an <a> link (root placement is a legacy
 *     error), never on a split frame's links
 *   - each sub-start score has a START + at least one sub-end
 *   - track-group consistency (including identical voting/holding overrides)
 *   - hold-until on a track-grouped frame must not target frames of the SAME
 *     group (the group's arrival barrier already waits for those — decided
 *     2026-07-16; out-of-group targets are valid and compose)
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

function timingValue(node, attribute) {
  const value = node && node[attribute];
  return value == null || String(value).trim() === ""
    ? null
    : String(value).trim();
}

function displayTimingValue(value) {
  return value == null ? "<session default>" : `"${value}"`;
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
  const rawLoadSub = typeof subLoader === "function" ? subLoader : () => null;

  const resolveMain = (ref) => byLower[String(ref).toLowerCase()] ?? null;

  const addUnresolvedLinks = (
    linkGraph,
    linkFrameNames,
    score = null,
    skipSubReturns = false,
  ) => {
    const knownFrames = lowerSet(linkFrameNames);
    for (const [frame, node] of Object.entries(
      (linkGraph && linkGraph.byFrame) || {},
    )) {
      // Main-score sub-start hrefs already have the more specific
      // sub-start-return-unresolved diagnostic below. Skip those here so one
      // broken link produces one useful error instead of two.
      const subReturnHrefs = skipSubReturns
        ? new Set(
            (node.subLinks || [])
              .map((link) => link.href)
              .filter((href) => href != null && href !== "")
              .map((href) => String(href).toLowerCase()),
          )
        : new Set();

      for (const href of node.hrefs || []) {
        const hrefLower = String(href).toLowerCase();
        if (subReturnHrefs.has(hrefLower) || knownFrames[hrefLower]) {
          continue;
        }
        errors.push({
          code: "link-unresolved",
          frame,
          ...(score ? { score } : {}),
          message: score
            ? `link on ${frame} in sub-score "${score}" points to unknown frame "${href}"`
            : `link on ${frame} points to unknown frame "${href}"`,
        });
      }
    }
  };

  const loadedSubs = new Map();
  const loadSub = (score) => {
    if (!loadedSubs.has(score)) {
      const sub = rawLoadSub(score);
      loadedSubs.set(score, sub);
      if (sub) {
        const subNames =
          Array.isArray(sub.frameNames) && sub.frameNames.length > 0
            ? sub.frameNames
            : (sub.graph && sub.graph.frames) || [];
        addUnresolvedLinks(sub.graph, subNames, score);
      }
    }
    return loadedSubs.get(score);
  };

  // 1) Every ordinary navigation link resolves within its own score. Marked
  // sub-start links are checked by the specialized return-link validation.
  addUnresolvedLinks(graph, names, null, true);

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

  // 2) Split N == href count.
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

  // 3) hold-until targets resolve (main refs + sub refs like "Tetra2/E").
  for (const [frame, targets] of Object.entries(graph.holdUntilTargets || {})) {
    // Track-group × hold-until (decided 2026-07-16): a grouped frame already
    // waits for the group's other frames via the ARRIVAL barrier, so hold-until
    // may only name frames OUTSIDE the frame's own group (the waits compose).
    const ownGroup = ((graph.byFrame || {})[frame] || {}).trackGroup || null;
    const ownGroupMembers = new Set(
      ((graph.groups || {})[ownGroup] || []).map((m) => m.toLowerCase()),
    );
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
      if (ownGroup && ownGroupMembers.has(resolved.toLowerCase())) {
        errors.push({
          code: "hold-until-in-track-group",
          frame,
          message: `hold-until on ${frame} references "${target}" which is in the same track-group "${ownGroup}" — the group's arrival barrier already waits for its frames; hold-until may only target frames outside the group`,
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

  // 4) rejoin-at targets resolve (main frames) AND are the frame's own links.
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

  // 5) sub links: `session-sub-start` lives on an <a> tag (its href = the
  // return landing). Each named sub-score exists, has START + >=1 sub-end;
  // the marked <a>'s href resolves to a main frame.
  //
  // Legacy root-level session-sub-start is refused outright: the runtime no
  // longer dives on frame arrival, so the old markup would silently do nothing.
  for (const frameName of names) {
    const attrs = (graph.byFrame || {})[frameName] || {};
    if (attrs.subStart) {
      errors.push({
        code: "sub-start-on-root",
        frame: frameName,
        message: `session-sub-start on the <svg> root of ${frameName} is no longer supported — put it on the <a> link that dives into the sub (its href is the return landing)`,
      });
    }
  }

  const deadEndCheckedSubs = new Set();
  for (const [frame, links] of Object.entries(graph.subLinks || {})) {
    // A split frame's links are child paths, never dives — a child line must
    // land on a real main frame (put the sub link on an intermediate frame).
    if ((graph.splits || {})[frame]) {
      errors.push({
        code: "split-sub-link",
        frame,
        message: `session-split frame ${frame} has a session-sub-start link — split paths cannot dive; land the child on an intermediate frame that carries the sub link instead`,
      });
    }

    for (const info of links) {
      const sub = loadSub(info.score);
      if (!sub) {
        errors.push({
          code: "sub-start-missing-score",
          frame,
          message: `sub-start link on ${frame} references sub-score "${info.score}" which was not found`,
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
        // sub-end (decided in lieu of the runtime R2 hardening): a line
        // stranded inside a sub can never advance or be history-jumped, and
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
          message: `sub-start link on ${frame} has no href (return landing) in the main flow`,
        });
      } else if (!resolveMain(info.returnHref)) {
        errors.push({
          code: "sub-start-return-unresolved",
          frame,
          message: `sub-start return landing "${info.returnHref}" on ${frame} is not a known main-score frame`,
        });
      }
    }
  }

  // 6) Track-group consistency: a group needs >= 2 members to synchronize,
  // and every member must use the same frame-level timing overrides. Group
  // voting windows open from whichever member is tapped first, while holding
  // waits for every member; differing overrides would make synchronization
  // depend on which line acts first or finishes last.
  for (const [groupName, members] of Object.entries(graph.groups || {})) {
    if (members.length < 2) {
      warnings.push({
        code: "track-group-singleton",
        group: groupName,
        message: `track-group "${groupName}" has only ${members.length} frame — nothing to synchronize`,
      });
    }

    for (const attribute of ["voting", "holding"]) {
      const values = members.map((frame) => ({
        frame,
        value: timingValue((graph.byFrame || {})[frame], attribute),
      }));
      if (values.some(({ value }) => value !== values[0].value)) {
        errors.push({
          code: `track-group-${attribute}-mismatch`,
          group: groupName,
          attribute,
          frames: members.slice(),
          message: `track-group "${groupName}" must use the same ${attribute} attribute on every frame (${values
            .map(({ frame, value }) => `${frame}=${displayTimingValue(value)}`)
            .join(", ")})`,
        });
      }
    }
  }

  return { errors, warnings };
}

module.exports = { validateScore };
