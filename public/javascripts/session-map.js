// Session Lines — standalone live score-map page (experimental).
//
// Loaded only by views/session-map.jade (GET /session/:id/map), never by the
// session page. Draws the whole score — main flow + sub-scores — as a DAG
// (cytoscape + dagre from the same jsdelivr CDN the app already uses) and marks
// each line's current frame live. It opens its own ws connection via
// ws-client.js and implements the minimal parseMessage contract: MSG_PING time
// calibration (mirrors session.js) and MSG_SHOW_NUMBER_CONNECTION, whose
// admin-only `lines` payload the server refreshes on every line landing.

(function () {
  const CDN_SCRIPTS = [
    "https://cdn.jsdelivr.net/npm/cytoscape@3/dist/cytoscape.min.js",
    "https://cdn.jsdelivr.net/npm/dagre@0.8.5/dist/dagre.min.js",
    "https://cdn.jsdelivr.net/npm/cytoscape-dagre@2/cytoscape-dagre.js",
  ];

  let cy = null;
  let pendingLines = null;
  let graphData = null;

  // Latest session-lines snapshot (MSG_SHOW_NUMBER_CONNECTION lines[]). Besides
  // the live badges it now carries every line's history trail + checkpoint, so
  // the history overlay is painted from here in session-lines mode.
  let lastLines = null;

  // Active structural split instances ride with the lines snapshot. The
  // original parent is retired (and absent from lastLines), so this separate
  // projection drives split-undo buttons and blocked-merge explanations.
  let lastSplitRewinds = [];

  // Undoable merges (rejoins), same push. The absorbed lines are retired — and
  // absent from lastLines — until the undo brings them back, so this projection
  // is the only place the menu can learn a merge happened here at all.
  let lastMergeRewinds = [];

  // The lines a still-undoable merge swallowed, with the trail its undo would
  // give them back (owner). They are retired, so they are in no count and no
  // `lastLines` entry — but their route is where the operator watched them
  // walk, so the map paints it as a GHOST and offers the same per-line rewind
  // on it. Clicking one brings the line back out of the merge on the way
  // (bin/www lineRewind).
  let lastAbsorbedLines = [];

  // The structural topology the three projections above describe, and the one
  // this page has already asked for. Cascades, restored identities, landings
  // and ghost trails are quadratic in the number of passages, so the count
  // push only announces a version tag: the map fetches the bodies once per
  // topology and leaves them alone on the ordinary landing/join/leave pushes
  // that carry the same tag. Leaving them alone is the point — a regular push
  // says nothing about them, so it must not be read as saying there are none.
  let structuralVersion = null;
  let structuralRequested = null;

  // The track groups the room can be rewound to, decided server-side and
  // pushed with the lines (`roomCheckpointFor`). The map does not re-derive
  // this: the rule reads the split records and the population, and only one of
  // those is on this page.
  let lastRoomCheckpoints = [];

  // Currently-waiting barriers (admin-flagged MSG_BARRIER_WAITING) — the same
  // payload the session page's admin panel consumes, so the map offers the same
  // operator valves without a trip back to the session tab.
  let lastBarriers = [];

  // The rewind this map last asked for, and the sentence to show back when the
  // server says it happened: `{kind, frame, text}`, cleared by either answer.
  // The server reports success with kind + frame only — what the operator needs
  // to read is what they were PROMISED, which is here and nowhere else.
  let pendingRewind = null;

  // The node menu on screen right now, and the exact markup it was built from:
  // `{ nodeId, html }`, or null when nothing is open. A menu is a projection of
  // a snapshot, and the room keeps moving under it — so when a push changes
  // what this node offers, the menu is CLOSED rather than left standing with
  // buttons that no longer mean what they say. Closing, not re-rendering: the
  // operator's pointer is on its way to a button, and moving the entries out
  // from under it would buy a topology change they never chose.
  let openMenu = null;

  // History of the line this admin connection is assigned to, as pushed via
  // MSG_SELECT_HISTORY. VANILLA MODE ONLY: it drives the per-step rewind menu
  // (click / tap a visited node → "rewind here" {selectedIdx} — legitimate
  // there, the single playhead IS the room) and paints the overlay before the
  // first lines push. In session-lines mode the implicit bound-line rewind is
  // retired: the menu offers room-wide track-group, explicit line-targeted,
  // and structural split rewinds.
  let historyState = { history: [], selectedIdx: -1 };

  // Vanilla mode: a score without session-* markup is presented as a
  // single-line session. There is no per-line payload — the one playhead is
  // tracked from the broadcast MSG_SHOW and the room-wide player/rider counts;
  // voting/holding come from the room's own MSG_BEGIN_VOTING/HOLDING (their
  // natural end is client-timed via endTime — the server sends no "ended" msg).
  let vanillaMode = false;
  let mainFrames = [];
  const vanillaState = {
    idx: -1,
    players: 0,
    riders: 0,
    voting: false,
    holding: false,
  };
  let vanillaPhaseTimer = null;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error(`failed to load ${src}`));
      document.head.appendChild(s);
    });
  }

  function setStatus(text) {
    const el = document.getElementById("session-map-status");
    if (el) el.textContent = text;
  }

  // What just happened, said once and then got out of the way. NOT the status
  // line: that is rewritten by every lines push (which a rewind sends several
  // of), so a message left there would be gone before it was read. Not an
  // alert() either — a refusal interrupts because the operator is waiting on
  // an answer, while a success only has to be seen.
  let toastTimer = null;

  /**
   * Keep the receipt clear of the barrier strip.
   *
   * The strip is in normal flow under the header and comes and goes with the
   * room; the toast is `position: fixed` so that showing it never reflows the
   * graph out from under a pointer. A constant `top` cannot satisfy both —
   * 3.2em at this element's own 0.8em font size is ~2.6 root-em, which lands
   * INSIDE the strip — so a receipt covered the strip's right-hand end, which
   * is exactly where `renderBarrierPanel` puts the "force advance stragglers"
   * valve. Measured instead, from whichever of the two is the last thing above.
   */
  function anchorBelowHeader(el) {
    if (!el) return;
    const strip = document.getElementById("session-map-barriers");
    const header = document.getElementById("session-map-header");
    const above =
      strip && strip.style.display !== "none" && strip.offsetParent !== null
        ? strip
        : header;
    const bottom = above ? above.getBoundingClientRect().bottom : 0;
    el.style.top = `${Math.round(bottom) + 8}px`;
  }

  // The session's last few receipts, newest first. The server owns and persists
  // these; this array is only the current rendering of that shared audit.
  const REWIND_LOG_MAX = 20;
  const rewindLog = [];

  function rewindLogText(entry) {
    if (entry.text) return entry.text;
    const where = entry.frame
      ? `⟨${frameLabel(entry.frame)}⟩`
      : "this room";
    let text;
    switch (entry.kind) {
      case "merge":
        text = `Undid the merge at ${where}.`;
        break;
      case "split":
        text = `Undid the split at ${where}.`;
        break;
      case "room":
        text = `Rewound the room to checkpoint ${where}.`;
        break;
      case "sub":
        text =
          `Rewound ${entry.lineId || "a line"} out of its sub-score ` +
          `to ${where}.`;
        break;
      default:
        text = `Rewound ${entry.lineId || "a line"} to ${where}.`;
        break;
    }
    return text + emptiedClause(entry.emptied);
  }

  function sameRewindEntry(a, b) {
    return (
      a &&
      b &&
      a.at === b.at &&
      a.kind === b.kind &&
      a.frame === b.frame &&
      a.lineId === b.lineId
    );
  }

  function logRewind(entry) {
    const normalized =
      entry && typeof entry === "object"
        ? entry
        : { text: String(entry || ""), at: Date.now() };
    if (!rewindLog.some((old) => sameRewindEntry(old, normalized))) {
      rewindLog.unshift(normalized);
    }
    rewindLog.splice(REWIND_LOG_MAX);
    renderRewindLog();
    const toggle = document.getElementById("session-map-log-toggle");
    if (toggle) toggle.disabled = false;
  }

  function syncRewindLog(entries) {
    rewindLog.splice(
      0,
      rewindLog.length,
      ...(Array.isArray(entries) ? entries.slice(0, REWIND_LOG_MAX) : []),
    );
    renderRewindLog();
    const toggle = document.getElementById("session-map-log-toggle");
    if (toggle) toggle.disabled = rewindLog.length === 0;
  }

  function renderRewindLog() {
    const panel = document.getElementById("session-map-log");
    if (!panel) return;
    panel.innerHTML =
      '<div class="legend-heading">what this session has rewound</div>' +
      (rewindLog.length === 0
        ? '<div class="log-empty">nothing yet</div>'
        : rewindLog
            .map(
              (entry) =>
                '<div class="log-row"><span class="log-time">' +
                escapeHtml(
                  typeof entry.at === "number"
                    ? new Date(entry.at).toLocaleTimeString()
                    : entry.at,
                ) +
                "</span><span>" +
                escapeHtml(rewindLogText(entry)) +
                "</span></div>",
            )
            .join(""));
  }

  function showToast(text, rewindEntry) {
    const el = document.getElementById("session-map-toast");
    if (!el || !text) return;
    logRewind(rewindEntry || text);
    // The × is not decoration: these run to several lines now, and a receipt
    // sitting over the canvas for its full dwell is in the way of the very
    // room it is describing.
    el.innerHTML =
      '<button type="button" class="toast-close" title="dismiss">×</button>' +
      "<span></span>";
    el.querySelector("span").textContent = text;
    el.querySelector(".toast-close").addEventListener("click", hideToast);
    el.style.display = "block";
    anchorBelowHeader(el);
    if (toastTimer) clearTimeout(toastTimer);
    // Longer than the 9s it was: a merge receipt now names the landings and any
    // line left empty, which is five or six lines to read while the operator is
    // watching the canvas rather than the corner. Dismissable, so the extra
    // dwell costs nothing.
    toastTimer = setTimeout(hideToast, 16000);
  }

  function hideToast() {
    const el = document.getElementById("session-map-toast");
    if (el) el.style.display = "none";
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = null;
  }

  function frameLabel(name) {
    return String(name).replace(/\.svg$/i, "");
  }

  function lc(value) {
    return String(value || "").toLowerCase();
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // Track groups: pastel fills chosen to stay clear of the state colors
  // (here = amber, visited = light green, dormant = grey) so a group tint is
  // never mistaken for live/history state.
  const GROUP_PALETTE = [
    "#bbdefb", // blue
    "#e1bee7", // purple
    "#ffccbc", // deep orange
    "#b2ebf2", // cyan
    "#f8bbd0", // pink
    "#c5cae9", // indigo
    "#d7ccc8", // brown
    "#ffe0b2", // orange
  ];

  // group name → color, stable across reloads: sorted names over main + every
  // sub graph share one assignment (same name in a sub = same group).
  function buildGroupColors(main, subs) {
    const names = new Set(Object.keys(main.groups || {}));
    for (const sub of Object.values(subs)) {
      for (const g of Object.keys(sub.groups || {})) names.add(g);
    }
    const colors = {};
    Array.from(names)
      .sort()
      .forEach((g, i) => {
        colors[g] = GROUP_PALETTE[i % GROUP_PALETTE.length];
      });
    return colors;
  }

  // "Tetra1/Echo.svg" → sub node, "H.svg" → main node. Null when unresolvable.
  function resolveRefToNodeId(ref, main, subs) {
    const slash = String(ref).indexOf("/");
    if (slash > 0) {
      const score = ref.slice(0, slash);
      const frame = ref.slice(slash + 1);
      const sub = subs[score];
      const resolved = sub && sub.frameNameByLower[frame.toLowerCase()];
      return resolved ? `sub:${score}:${resolved}` : null;
    }
    const resolved = main.frameNameByLower[String(ref).toLowerCase()];
    return resolved ? `main:${resolved}` : null;
  }

  function graphElements(data) {
    const { main, subs } = data;
    const elements = [];
    let edgeId = 0;
    const edge = (source, target, classes) => {
      elements.push({
        group: "edges",
        data: { id: `e${edgeId++}`, source, target },
        classes,
      });
    };

    const rejoinSources = main.rejoinTargets || {};
    const groupColors = buildGroupColors(main, subs || {});

    const addFrames = (graph, prefix, parent) => {
      for (const name of graph.frames) {
        const classes = [];
        if (/^START/i.test(name)) classes.push("start");
        if ((graph.splits || {})[name]) classes.push("split");
        if ((graph.holdUntilTargets || {})[name]) classes.push("barrier");
        if (((graph.subLinks || {})[name] || []).length > 0)
          classes.push("substart");
        if ((graph.subEnd || {})[name]) classes.push("subend");
        const trackGroup = ((graph.byFrame || {})[name] || {}).trackGroup || "";
        if (trackGroup) classes.push("grouped");
        elements.push({
          group: "nodes",
          data: {
            id: `${prefix}${name}`,
            label: frameLabel(name),
            badge: "",
            trackGroup,
            groupColor: groupColors[trackGroup] || "",
            parent,
          },
          classes: classes.join(" "),
        });
      }
    };

    const addHrefEdges = (graph, prefix) => {
      for (const name of graph.frames) {
        const attrs = graph.byFrame[name] || {};
        // Hrefs of this frame's session-sub-start <a> links: walked only
        // AFTER their sub (the link dives; the href is the return landing).
        const subReturns = new Set(
          ((graph.subLinks || {})[name] || [])
            .map((l) => String(l.returnHref || "").toLowerCase())
            .filter((h) => h),
        );
        const rejoinAt = (rejoinSources[name] || []).map((t) =>
          String(t).toLowerCase(),
        );
        for (const href of attrs.hrefs || []) {
          const target = graph.frameNameByLower[String(href).toLowerCase()];
          if (!target || target === name) continue;
          const classes = [];
          if ((graph.splits || {})[name]) classes.push("split-edge");
          if (rejoinAt.includes(target.toLowerCase()))
            classes.push("merge-edge");
          // Dot the return-landing href so the real path through the sub
          // (dive → …sub… → return) reads clearly.
          if (subReturns.has(target.toLowerCase())) classes.push("via-sub");
          edge(`${prefix}${name}`, `${prefix}${target}`, classes.join(" "));
        }
      }
    };

    addFrames(main, "main:");
    addHrefEdges(main, "main:");

    for (const [score, sub] of Object.entries(subs || {})) {
      elements.push({
        group: "nodes",
        data: { id: `subbox:${score}`, label: score },
        classes: "subbox",
      });
      addFrames(sub, `sub:${score}:`, `subbox:${score}`);
      addHrefEdges(sub, `sub:${score}:`);
    }

    // Dive / return edges around each session-sub-start link.
    for (const [name, links] of Object.entries(main.subLinks || {})) {
      for (const info of links) {
        const sub = (subs || {})[info.score];
        if (!sub) continue;
        const startFrame =
          sub.frames.find((f) => /^START/i.test(f)) || sub.frames[0];
        if (startFrame) {
          edge(`main:${name}`, `sub:${info.score}:${startFrame}`, "dive");
        }
        const returnTarget =
          info.returnHref &&
          main.frameNameByLower[String(info.returnHref).toLowerCase()];
        if (returnTarget) {
          for (const endFrame of Object.keys(sub.subEnd || {})) {
            edge(
              `sub:${info.score}:${endFrame}`,
              `main:${returnTarget}`,
              "return",
            );
          }
        }
      }
    }

    // Barrier "waits for" edges (targets may be sub-qualified "score/frame").
    for (const [name, targets] of Object.entries(main.holdUntilTargets || {})) {
      for (const t of targets) {
        const targetId = resolveRefToNodeId(t, main, subs || {});
        if (targetId) edge(`main:${name}`, targetId, "waits");
      }
    }

    return elements;
  }

  // Node label = frame name + optional ⟨group⟩ + optional live badge lines.
  function nodeLabelLines(ele) {
    const lines = [ele.data("label")];
    if (ele.data("trackGroup")) lines.push(`⟨${ele.data("trackGroup")}⟩`);
    if (ele.data("badge")) lines.push(ele.data("badge"));
    return lines;
  }

  // Explicit label-box sizing. width/height "label" (deprecated upstream) is a
  // trap here: cytoscape measures label text lazily AFTER the first layout and
  // paint, so dagre ranks 0-size boxes (cramped rows) and the style cache can
  // lock never-retouched nodes invisible — exactly the ungrouped frames, since
  // grouped/live ones get re-touched by badges and lines pushes. The label is
  // 11px monospace, so its box is computable up front: ~6.6px per char, ~13px
  // per line (padding is separate).
  function nodeLabelWidth(ele) {
    const longest = Math.max(
      ...nodeLabelLines(ele).map((line) => String(line).length),
    );
    return Math.max(20, longest * 6.6 + 4);
  }

  function nodeLabelHeight(ele) {
    return nodeLabelLines(ele).length * 13 + 4;
  }

  const STYLE = [
    {
      selector: "node",
      style: {
        shape: "round-rectangle",
        width: nodeLabelWidth,
        height: nodeLabelHeight,
        padding: "6px",
        "background-color": "#f4f4f4",
        "border-width": 1,
        "border-color": "#999",
        label: (ele) => nodeLabelLines(ele).join("\n"),
        "text-wrap": "wrap",
        "text-valign": "center",
        "text-halign": "center",
        "font-size": 11,
        "font-family": "monospace",
      },
    },
    {
      selector: "node.subbox",
      style: {
        shape: "round-rectangle",
        "background-color": "#eef4fb",
        "background-opacity": 0.5,
        "border-width": 1,
        "border-style": "dashed",
        "border-color": "#7fa8d0",
        label: "data(label)",
        "text-valign": "top",
        "font-size": 12,
      },
    },
    // Track-group tint. Declared before the state styles (visited/here/…) so a
    // node's live/history state still wins on background; the ⟨group⟩ label
    // line keeps the group readable while a state color covers the tint.
    {
      selector: "node.grouped",
      style: { "background-color": "data(groupColor)" },
    },
    { selector: "node.start", style: { "border-color": "#2e7d32", "border-width": 2 } },
    { selector: "node.split", style: { "border-color": "#e67e22", "border-width": 2 } },
    {
      selector: "node.barrier",
      style: { shape: "octagon", "border-color": "#c0392b", "border-width": 2 },
    },
    {
      selector: "node.substart",
      style: { shape: "diamond", "border-color": "#2b6cb0", "border-width": 2, padding: "10px" },
    },
    { selector: "node.subend", style: { "border-style": "double", "border-width": 3 } },
    // The route of a line a merge swallowed, while that merge can still be
    // undone. Declared BEFORE the live trail classes so a live line always wins
    // the node it shares — a ghost is what is no longer there.
    {
      selector: "node.ghost-trail",
      style: {
        // Distinctly greyer than the #f4f4f4 an unvisited frame carries : at
        // map zoom the old #eceff1 differed from "never walked" by a dashed
        // border alone, so the routes a rejoin can still be undone along read
        // as blank score rather than as history. The dimmed label and the
        // dashed `ghost-edge` between two of these carry the rest — a route
        // has to look like a route.
        "background-color": "#cfd8dc",
        "border-style": "dashed",
        "border-color": "#607d8b",
        "text-opacity": 0.7,
      },
    },
    {
      selector: "node.ghost-landing",
      style: {
        "underlay-color": "#78909c",
        "underlay-opacity": 0.22,
        "underlay-padding": 6,
      },
    },
    // History trail: visited ≤ checkpoint, "ahead" = redo entries past it.
    // Declared before .here so a line's live position wins on background.
    { selector: "node.visited", style: { "background-color": "#dcedc8" } },
    {
      selector: "node.visited-ahead",
      style: { "background-color": "#f1f8e9" },
    },
    {
      selector: "node.checkpoint",
      style: {
        "underlay-color": "#2b6cb0",
        "underlay-opacity": 0.25,
        "underlay-padding": 6,
      },
    },
    {
      selector: "node.here",
      style: {
        "background-color": "#ffd54f",
        "border-width": 3,
        "border-color": "#f57f17",
      },
    },
    // Frame lifecycle on the occupied node: voting window open / holding
    // period running. Declared before waiting/dormant so those still win.
    {
      selector: "node.here-voting",
      style: { "border-style": "dashed", "border-color": "#6a1b9a" },
    },
    { selector: "node.here-holding", style: { "border-color": "#00838f" } },
    { selector: "node.here-waiting", style: { "border-color": "#c0392b" } },
    { selector: "node.here-dormant", style: { "background-color": "#cfcfcf" } },
    {
      selector: "edge",
      style: {
        width: 1.5,
        "curve-style": "bezier",
        "line-color": "#aaa",
        "target-arrow-shape": "triangle",
        "target-arrow-color": "#aaa",
        "arrow-scale": 0.8,
      },
    },
    {
      selector: "edge.split-edge",
      style: { "line-color": "#e67e22", "target-arrow-color": "#e67e22", width: 2 },
    },
    {
      selector: "edge.merge-edge",
      style: { "line-color": "#8e44ad", "target-arrow-color": "#8e44ad", width: 2 },
    },
    {
      selector: "edge.dive",
      style: {
        "line-color": "#2b6cb0",
        "target-arrow-color": "#2b6cb0",
        "line-style": "dashed",
      },
    },
    {
      selector: "edge.return",
      style: {
        "line-color": "#2b6cb0",
        "target-arrow-color": "#2b6cb0",
        "line-style": "dotted",
      },
    },
    {
      selector: "edge.waits",
      style: {
        "line-color": "#c0392b",
        "target-arrow-color": "#c0392b",
        "line-style": "dotted",
        "arrow-scale": 0.6,
      },
    },
    { selector: "edge.via-sub", style: { "line-style": "dotted", "line-color": "#ccc" } },
    // A hop INSIDE a ghosted route. Declared last so it wins over the
    // structural edge colors along that stretch: what the operator needs to
    // see there is one dashed path, not a split's orange and a plain hop
    // reading as live score. The final hop INTO the rejoin is not ghosted —
    // its target is the node a line is standing on — so the purple rejoin
    // arrow still says where the passage ends.
    {
      selector: "edge.ghost-edge",
      style: {
        "line-color": "#607d8b",
        "target-arrow-color": "#607d8b",
        "line-style": "dashed",
        width: 2,
      },
    },
  ];

  // Manual arrangement: nodes are draggable; positions persist per session so
  // an arrangement survives reloads. "re-layout" clears them.
  //
  // Keyed by SCORE as well as session: the session manager can repoint a
  // session at a different folder, and node ids are frame names — under a
  // session-only key the frames the two scores happen to share (START.svg…)
  // would be dragged to their old coordinates on top of the new layout.
  function positionsKey() {
    const folder = (document.body && document.body.dataset.scoreFolder) || "";
    return `mapPos:${window.sessionId}:${folder}`;
  }

  function loadSavedPositions() {
    try {
      return JSON.parse(localStorage.getItem(positionsKey())) || null;
    } catch (e) {
      return null;
    }
  }

  function savePositions() {
    const pos = {};
    cy.nodes().forEach((n) => {
      if (!n.isParent()) pos[n.id()] = n.position();
    });
    try {
      localStorage.setItem(positionsKey(), JSON.stringify(pos));
    } catch (e) {
      // storage blocked/full — arrangement just won't persist
    }
  }

  function autoLayoutOptions() {
    return typeof window.dagre !== "undefined"
      ? { name: "dagre", rankDir: "TB", nodeSep: 18, rankSep: 36 }
      : {
          name: "breadthfirst",
          directed: true,
          spacingFactor: 1.1,
          roots: "node.start",
        };
  }

  // The automatic layout must read top-down: START on the top rank, flow
  // continuing below it. Two edge kinds would break that by giving START (or
  // other early frames) in-edges that drag them down dagre's ranking: barrier
  // "waits" annotations and hrefs that loop back to an ancestor frame. Both
  // stay visible — they are only left out of the collection the layout ranks.
  // Back edges are found by DFS from the START nodes (an edge whose target is
  // still on the DFS stack closes a cycle).
  function flowLayoutElements() {
    let excluded = cy.edges(".waits");
    const state = {}; // node id → "active" (on the DFS stack) | "done"
    const visit = (rootId) => {
      if (state[rootId]) return;
      state[rootId] = "active";
      const stack = [{ id: rootId, edges: null, i: 0 }];
      while (stack.length > 0) {
        const top = stack[stack.length - 1];
        if (!top.edges) {
          top.edges = cy
            .getElementById(top.id)
            .outgoers("edge")
            .not(excluded)
            .toArray();
        }
        if (top.i >= top.edges.length) {
          state[top.id] = "done";
          stack.pop();
          continue;
        }
        const edge = top.edges[top.i++];
        const targetId = edge.target().id();
        if (state[targetId] === "active") {
          excluded = excluded.union(edge);
        } else if (!state[targetId]) {
          state[targetId] = "active";
          stack.push({ id: targetId, edges: null, i: 0 });
        }
      }
    };
    cy.nodes(".start").forEach((n) => visit(n.id()));
    // Anything not reachable from a START (isolated frames, cycles with no
    // entry) roots its own DFS so its internal loops are still broken.
    cy.nodes().forEach((n) => {
      if (!n.isParent()) visit(n.id());
    });
    return cy.elements().not(excluded);
  }

  function runAutoLayout() {
    flowLayoutElements().layout(autoLayoutOptions()).run();
  }

  function relayout() {
    try {
      localStorage.removeItem(positionsKey());
    } catch (e) {
      // ignore
    }
    runAutoLayout();
    cy.fit(undefined, 20);
  }

  // Initial view: 100% zoom with START near the top of the viewport (the flow
  // reads down from it), instead of a whole-graph fit — large scores fit to an
  // unreadably small zoom. Scores without a START frame keep the fit.
  function focusStart() {
    let start = cy.nodes('.start[id ^= "main:"]');
    if (start.empty()) start = cy.nodes(".start");
    if (start.empty()) {
      cy.fit(undefined, 20);
      return;
    }
    const pos = start[0].position();
    cy.zoom(1);
    cy.pan({
      x: cy.width() / 2 - pos.x,
      y: Math.min(cy.height() * 0.15, 120) - pos.y,
    });
  }

  const ZOOM_STEP = 1.25;

  function updateZoomValue() {
    const el = document.getElementById("session-map-zoom-value");
    if (el && cy) el.textContent = `${Math.round(cy.zoom() * 100)}%`;
  }

  // Button zoom keeps the viewport center fixed (wheel/pinch zoom on the
  // cursor instead — cytoscape's default).
  function zoomBy(factor) {
    if (!cy) return;
    cy.zoom({
      level: cy.zoom() * factor,
      renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 },
    });
  }

  function render(container, elements) {
    cy = cytoscape({
      container,
      elements,
      style: STYLE,
      // No layout here: runAutoLayout ranks only the forward flow (see
      // flowLayoutElements), which needs the cy instance to exist first.
      layout: { name: "preset" },
      // Bounds keep the zoom buttons (and wheel/pinch) inside a useful range;
      // fit() clamps to them, which any realistic score stays well within.
      minZoom: 0.05,
      maxZoom: 8,
    });
    runAutoLayout();
    const saved = loadSavedPositions();
    if (saved) {
      cy.batch(() => {
        cy.nodes().forEach((n) => {
          if (saved[n.id()]) n.position(saved[n.id()]);
        });
      });
    }
    focusStart();
    cy.on("dragfree", "node", savePositions);
    const relayoutBtn = document.getElementById("session-map-relayout");
    if (relayoutBtn) relayoutBtn.addEventListener("click", relayout);
    // After `vanillaMode` is known (set from the graph fetch that led here), so
    // the legend can drop the encodings this score will never paint.
    wireLegend();
    wireRewindLog();
    const zoomInBtn = document.getElementById("session-map-zoom-in");
    if (zoomInBtn) zoomInBtn.addEventListener("click", () => zoomBy(ZOOM_STEP));
    const zoomOutBtn = document.getElementById("session-map-zoom-out");
    if (zoomOutBtn)
      zoomOutBtn.addEventListener("click", () => zoomBy(1 / ZOOM_STEP));
    // Covers buttons, wheel, pinch, and every fit() — they all end in a zoom.
    cy.on("zoom", updateZoomValue);
    updateZoomValue();
    wireNodeMenu(container);
    renderHistory(); // history may have arrived before the graph was ready
  }

  // Matches the session panel's threshold: a line whose stalest device has not
  // spoken in this long carries 💤. Badges here repaint on the next push, like
  // every other live marker on the map.
  const QUIET_THRESHOLD_MS = 180000;

  function updateLines(lines) {
    if (!Array.isArray(lines)) {
      return;
    }
    if (!cy) {
      pendingLines = lines;
      return;
    }
    lastLines = lines;
    cy.batch(() => {
      cy.nodes()
        .removeClass("here here-voting here-holding here-waiting here-dormant")
        .data("badge", "");
      for (const l of lines) {
        if (!l.frame) continue;
        const nodeId = l.sub ? `sub:${l.sub}:${l.frame}` : `main:${l.frame}`;
        const node = cy.getElementById(nodeId);
        if (node.empty()) continue;
        const badge = node.data("badge");
        // players (and riders when present) — admins count as players.
        const who = `${l.players}p${l.riders ? `+${l.riders}r` : ""}`;
        const phase = `${l.voting ? "✅" : ""}${l.holding ? "✋" : ""}`;
        // ⏳ this line is waiting on others; ⏩ others are waiting on IT;
        // 💤 a device on it has gone quiet (see quietSince in bin/www).
        const quiet =
          l.quietSince && getServerTime() - l.quietSince > QUIET_THRESHOLD_MS
            ? "💤"
            : "";
        const mark =
          `${l.id}·${who}${l.waiting ? "⏳" : ""}` +
          `${l.straggler ? "⏩" : ""}${quiet}${phase}`;
        node.data("badge", badge ? `${badge} ${mark}` : mark);
        node.addClass("here");
        if (l.voting) node.addClass("here-voting");
        if (l.holding) node.addClass("here-holding");
        if (l.waiting) node.addClass("here-waiting");
        if (l.status === "dormant") node.addClass("here-dormant");
      }
      // A still-undoable split or rejoin, marked on the frame it happened at.
      //
      // A merge point stays reachable for the whole session, but once its
      // passage stops being the newest one NOTHING drew it: the ghosts come
      // off (the absorbed numbers are back in the pool, so painting their
      // routes would put an "L1" on the canvas that is not the L1 the room is
      // playing) and the node carries no marking of its own — so the only way
      // to reach an older rejoin was to remember which frame it was and click
      // it. The badge is the affordance the feature never had, and it rides on
      // the mechanism that was already there rather than fighting the four
      // border colours a node can carry.
      const undoable = new Set();
      for (const entry of lastSplitRewinds || []) {
        if (entry && entry.available && entry.frame) undoable.add(entry.frame);
      }
      for (const entry of lastMergeRewinds || []) {
        // One convergence, one marker: its folded halves sit on this frame too.
        if (
          entry &&
          entry.available &&
          !entry.partOfConvergence &&
          entry.frame
        ) {
          undoable.add(entry.frame);
        }
      }
      for (const frame of undoable) {
        const node = cy.getElementById(`main:${frame}`);
        if (node.empty()) continue;
        const badge = node.data("badge");
        node.data("badge", badge ? `${badge} ⏪⏪` : "⏪⏪");
      }
      // …and the nodes the lines come BACK to, which offer the very same one
      // click (`remoteMergeLandingHtml`, and the collapsed entry on a landing
      // the whole convergence shares).
      //
      // Marking only the rejoin frame was the gap this badge was added to
      // close, one step short: once a passage stops being the newest, the
      // canvas paints no ghost route to its landings either, so those nodes
      // carried nothing at all — and an operator had to click them on spec to
      // discover that the undo they wanted was one press away. A single ⏪ says
      // "there is a way back in here" without claiming the rejoin happened on
      // this frame, which is what ⏪⏪ means everywhere else on the canvas.
      const landings = new Set();
      for (const entry of lastMergeRewinds || []) {
        if (!entry || !entry.available || entry.partOfConvergence) continue;
        for (const landing of entry.landings || []) {
          if (!landing || landing.sub || !landing.frame) continue;
          if (undoable.has(landing.frame)) continue; // the rejoin's own node
          landings.add(landing.frame);
        }
      }
      for (const frame of landings) {
        const node = cy.getElementById(`main:${frame}`);
        if (node.empty()) continue;
        const badge = node.data("badge");
        node.data("badge", badge ? `${badge} ⏪` : "⏪");
      }
    });
    renderHistory(); // trails/checkpoints ride on the same payload
    const active = lines.filter((l) => l.status === "active").length;
    const players = lines.reduce((n, l) => n + (l.players || 0), 0);
    const riders = lines.reduce((n, l) => n + (l.riders || 0), 0);
    const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
    setStatus(
      `${plural(lines.length, "line")} (${active} active) · ` +
        `${plural(players, "player")}` +
        (riders ? ` · ${plural(riders, "rider")}` : ""),
    );
    // This push may have changed what an open menu is offering — the rewinds,
    // the ghosts, the advance valves all come from it.
    refreshOpenMenu();
    // …and what an open QUESTION is promising. The in-page confirm does not
    // block the page, so unlike the native one it can be told that the room
    // moved under it (`revalidateDialog`).
    revalidateDialog();
  }

  function renderVanilla() {
    if (!cy || !vanillaMode) {
      return;
    }
    cy.batch(() => {
      cy.nodes()
        .removeClass("here here-voting here-holding here-waiting here-dormant")
        .data("badge", "");
      const name = vanillaState.idx >= 0 && mainFrames[vanillaState.idx];
      if (!name) return; // -1 = paused placeholder
      const node = cy.getElementById(`main:${name}`);
      if (node.empty()) return;
      const phase = `${vanillaState.voting ? "✅" : ""}${vanillaState.holding ? "✋" : ""}`;
      node.data(
        "badge",
        `${vanillaState.players}p${vanillaState.riders ? `+${vanillaState.riders}r` : ""}${phase}`,
      );
      node.addClass("here");
      if (vanillaState.voting) node.addClass("here-voting");
      if (vanillaState.holding) node.addClass("here-holding");
    });
    setStatus(
      `single line · ${vanillaState.players} players` +
        (vanillaState.riders ? ` · ${vanillaState.riders} riders` : ""),
    );
  }

  // ── Barrier valves (release / release all / force advance stragglers) ──────
  // The map is where the operator watches a stall develop, so the resolutions
  // live here too — the same commands the session page's admin panel sends
  // (MSG_BARRIER_RELEASED, optionally `advance`-flagged). The strip only exists
  // while something is waiting.

  // "group:<name>" barrier refs are track-group arrival waits; anything else is
  // a hold-until frame.
  function isGroupBarrier(barrier) {
    return String((barrier && barrier.frame) || "").startsWith("group:");
  }

  // Where a forced advance would put `lineId`, as the operator reads it: the
  // exact frame for a hold-until (the target it still owes, server-supplied in
  // `advanceTargets` — a "Sub/Frame.svg" ref lands inside that sub-score), the
  // group for a track-group wait (whose least-occupied frame is only picked
  // when the command runs). Null when the score offers nowhere to land the
  // line at all.
  function advanceDestination(barrier, lineId) {
    const dest = ((barrier && barrier.advanceTargets) || {})[lineId];
    if (dest) {
      const line = (lastLines || []).find((l) => l.id === lineId);
      // Positions compare in the target's own vocabulary: a line inside a sub
      // is at "Sub/Frame.svg", on the main flow it is just the frame.
      const at = !line
        ? null
        : line.sub
          ? `${line.sub}/${line.frame}`
          : line.frame;
      return {
        frame: dest,
        label: frameLabel(dest),
        // Already there: what the barrier is still waiting on is this line's
        // holding period, and the advance cuts that short rather than moving
        // anything. Said plainly, or the entry reads as a no-op.
        atDestination: at != null && lc(at) === lc(dest),
      };
    }
    if (isGroupBarrier(barrier)) {
      return {
        frame: null,
        label: frameLabel(barrier.frame).replace(/^group:/, ""),
        atDestination: false,
      };
    }
    return null;
  }

  function renderBarrierPanel() {
    // The strip's height decides where the receipt sits (`anchorBelowHeader`),
    // and it changes with the room — so re-anchor after every render rather
    // than only when a receipt appears.
    setTimeout(() => anchorBelowHeader(document.getElementById("session-map-toast")), 0);
    setTimeout(() => anchorBelowHeader(document.getElementById("session-map-log")), 0);
    const panel = document.getElementById("session-map-barriers");
    if (!panel) return;
    const barriers = lastBarriers || [];
    if (barriers.length === 0) {
      panel.style.display = "none";
      panel.innerHTML = "";
      return;
    }
    panel.style.display = "flex";
    panel.innerHTML = "";

    const heading = document.createElement("span");
    heading.className = "map-barrier-heading";
    heading.textContent = "waiting:";
    panel.appendChild(heading);

    let anyStragglers = false;
    let anyAdvanceable = false;
    for (const b of barriers) {
      const parked = (b.parked || []).join(",") || "none";
      const stragglers = b.stragglers || [];

      const info = document.createElement("span");
      info.className = "map-barrier-info";
      // "group:<name>" entries are track-group arrival waits; anything else is
      // a hold-until frame. Shown as authored either way.
      info.appendChild(
        document.createTextNode(`${frameLabel(b.frame)} [parked: ${parked}] `),
      );

      const release = document.createElement("button");
      release.type = "button";
      release.title = "let this barrier go without the lines it is waiting for";
      release.textContent = "release";
      release.addEventListener("click", () => sendBarrierCommand(b.frame));
      info.appendChild(release);

      if (stragglers.length) {
        anyStragglers = true;
        info.appendChild(document.createTextNode(" waiting on:"));
        // One button per straggler — "advance THIS line", the same command the
        // node menu carries, for the operator already reading the strip. The
        // plain id list this replaces named who was holding the room up but
        // gave no way to act on one of them.
        for (const id of stragglers) {
          const dest = advanceDestination(b, id);
          const one = document.createElement("button");
          one.type = "button";
          one.textContent = `⏩ ${id}`;
          one.title = !dest
            ? `no way to land ${id} on the target it owes — release instead`
            : dest.atDestination
              ? `end line ${id}'s holding period at ⟨${dest.label}⟩`
              : `advance line ${id} to ⟨${dest.label}⟩ on its own`;
          one.disabled = !dest;
          one.addEventListener("click", () =>
            confirmAdvanceLine(id, b.frame, dest),
          );
          info.appendChild(one);
        }
        const advanceable = stragglers.some((id) => advanceDestination(b, id));
        anyAdvanceable = anyAdvanceable || advanceable;
        const advance = document.createElement("button");
        advance.type = "button";
        advance.title = advanceable
          ? "move every waited-for line onto this barrier instead"
          : "nothing to advance — no line it waits on has a landing";
        advance.textContent = "force advance";
        advance.disabled = !advanceable;
        advance.addEventListener("click", () =>
          confirmAdvanceStragglers(stragglers, b.frame),
        );
        info.appendChild(advance);
      }

      panel.appendChild(info);
    }

    const releaseAll = document.createElement("button");
    releaseAll.type = "button";
    releaseAll.textContent = "release all";
    releaseAll.addEventListener("click", () => sendBarrierCommand());
    panel.appendChild(releaseAll);

    if (anyStragglers) {
      const advanceAll = document.createElement("button");
      advanceAll.type = "button";
      advanceAll.disabled = !anyAdvanceable;
      advanceAll.textContent = "advance all stragglers";
      advanceAll.addEventListener("click", () =>
        confirmAdvanceStragglers(
          barriers.reduce((ids, b) => ids.concat(b.stragglers || []), []),
        ),
      );
      panel.appendChild(advanceAll);
    }
  }

  // `frame` names one barrier; omitted means every waiting one. `advance` picks
  // the bring-them-in resolution over the let-it-go one; `lineIds` narrows that
  // to named lines (the per-line command — the server still filters them
  // against its own live straggler set, so a stale id is simply ignored).
  function sendBarrierCommand(frame, advance, lineIds) {
    const payload = frame ? { frame } : {};
    if (advance) payload.advance = true;
    if (lineIds && lineIds.length) payload.lineIds = lineIds;
    sendToServer(MSG_BARRIER_RELEASED, payload);
  }

  // Confirmed, unlike release: this MOVES performers' devices to another frame.
  // Deliberately sends no `lineIds`: the barrier-wide command should cover
  // whoever is a straggler when the server runs it, not whoever was one when
  // this snapshot was pushed.
  async function confirmAdvanceStragglers(lineIds, frame) {
    const ids = lineIds || [];
    const where = frame
      ? `⟨${frameLabel(frame).replace(/^group:/, "")}⟩`
      : "their waiting barriers";
    const ok = await mapConfirm({
      title: `Force ${ids.length} straggler line${
        ids.length === 1 ? "" : "s"
      } onto ${where}?`,
      body: [
        { list: ids.length ? ids : ["none"] },
        "Those lines jump there from wherever they are now.",
      ],
      okLabel: "Advance them",
      danger: true,
    });
    if (!ok) return;
    sendBarrierCommand(frame, true);
  }

  // "Advance this line" — one straggler, from the node menu or the strip. A
  // track group takes the line to its least-occupied frame; a hold-until takes
  // it to the target it still owes, so the wait ends met rather than waived.
  // `destination` is advanceDestination()'s reading of where that is; null
  // means there is nowhere to send it.
  async function confirmAdvanceLine(lineId, frame, destination) {
    hideMenu();
    if (!destination) return;
    const ok = await mapConfirm({
      title: destination.atDestination
        ? `End line ${lineId}'s holding period at ⟨${destination.label}⟩?`
        : `Advance line ${lineId} to ⟨${destination.label}⟩?`,
      body: [
        destination.atDestination
          ? "It has arrived — the barrier is only waiting out its hold."
          : "It jumps there from wherever it is now; the rest of the room stays put.",
      ],
      okLabel: destination.atDestination ? "End the hold" : "Advance the line",
      danger: !destination.atDestination,
    });
    if (!ok) return;
    sendBarrierCommand(frame, true, [lineId]);
  }

  // "Eject this line from its sub-score" — a forward move like the advances,
  // but tied to no barrier: it pops one line out of a dive onto that dive's
  // own return landing. Confirmed, because it moves performers' devices. `sub`
  // rides along as the server's race guard, so a stale click on a line that
  // has already popped out on its own is refused rather than acted on.
  async function confirmEjectLine(lineId, sub, label) {
    hideMenu();
    if (!lineId || !sub) return;
    const ok = await mapConfirm({
      title: `Eject line ${lineId} from sub-score ${sub} to ⟨${label}⟩?`,
      body: [
        "It leaves the sub now and rejoins the main flow there; the rest of" +
          " the room stays put.",
      ],
      okLabel: "Eject the line",
      danger: true,
    });
    if (!ok) return;
    sendToServer(MSG_BARRIER_RELEASED, { eject: true, lineId, sub });
  }

  // "Roll this line back out of its dive" — the eject's opposite. A rewind, so
  // it rides MSG_SELECT_HISTORY with the other three. `idx` picks an entry of
  // the line's MAIN trail; null means the frame it dived from, which the
  // server resolves from the line's own saved trail. `sub` and `frame` are the
  // server's two race guards.
  async function confirmRewindOutOfSub(lineId, sub, frame, idx) {
    hideMenu();
    if (!lineId || !sub) return;
    const ok = await mapConfirm({
      title:
        `Rewind line ${lineId} out of sub-score ${sub}, back to ` +
        `⟨${frameLabel(frame)}⟩${idx == null ? "" : ` (step ${idx + 1})`}?`,
      body:
        idx == null
          ? [
              "That is the frame it dived from. The dive is undone and the" +
                " line can take it again; only this line moves.",
            ]
          : [
              "It leaves the sub, and everything after that step is dropped" +
                " from its trail; only this line moves.",
            ],
      okLabel: "Rewind the line",
      danger: true,
    });
    if (!ok) return;
    rememberRewind(
      "sub",
      frame,
      `Rewound ${lineId} out of sub-score ${sub}, back to ⟨${frameLabel(
        frame,
      )}⟩`,
    );
    const payload = {
      lineId,
      exitSub: true,
      sub,
      frame,
      operationId: pendingOperationId(),
    };
    if (idx != null) payload.selectedIdx = idx;
    sendToServer(MSG_SELECT_HISTORY, payload);
  }

  // ── History overlay + rewind node menu ─────────────────────────────────────

  // The groups the room can be rewound to, as the SERVER decided them
  // (`roomCheckpoints`). This used to be a second implementation of
  // `commonCheckpoints` running on `lines[]`, and the two could not agree: it
  // counted riders as population, so a line carrying only spectators hid a
  // checkpoint the server would have accepted; and it could not see the split
  // records, so a line whose trail a fork had truncated blocked every group
  // the room crossed before that fork — the menu lost checkpoints as the room
  // split and merged, which is precisely when an operator reaches for one. The
  // rule needs inputs that live on the server, so it is answered there and the
  // menu is a projection of that answer, like everything else on this canvas.
  function roomCheckpointFor(group) {
    return (
      (lastRoomCheckpoints || []).find(
        (checkpoint) => checkpoint && lc(checkpoint.group) === lc(group),
      ) || null
    );
  }

  function groupForMainFrame(frameName) {
    const main = graphData && graphData.main;
    const byFrame = (main && main.byFrame) || {};
    const node = byFrame[frameName];
    if (node && node.trackGroup) return node.trackGroup;
    for (const [group, frames] of Object.entries((main && main.groups) || {})) {
      if ((frames || []).some((name) => lc(name) === lc(frameName))) {
        return group;
      }
    }
    return null;
  }

  function renderHistory() {
    if (!cy) {
      return;
    }
    cy.batch(() => {
      cy.nodes().removeClass(
        "visited visited-ahead checkpoint ghost-trail ghost-landing",
      );
      cy.edges().removeClass("ghost-edge");
      // Session Lines: paint EVERY line's trail + checkpoint from the lines[]
      // payload (visited = union over lines; a checkpoint halo per line, which
      // normally sits on its `here` node since a landing always moves the
      // history pointer to the end). A line inside a sub carries its sub trail
      // — same prefix rule as its position, resolving into the sub box.
      if (!vanillaMode && Array.isArray(lastLines)) {
        // Ghosts FIRST: every route feeding a still-undoable rejoin, so the
        // rewind entries those nodes carry sit on something the operator can
        // see. A live line still wins a node it SHARES, so the ghost classes
        // come off again below — except on its own pre-merge route.
        const ghost = (prefix, trail, landing) => {
          for (const name of trail || []) {
            const node = cy.getElementById(`${prefix}${name}`);
            if (!node.empty()) node.addClass("ghost-trail");
          }
          if (landing) {
            const node = cy.getElementById(`${prefix}${landing}`);
            if (!node.empty()) node.addClass("ghost-landing");
          }
        };
        for (const l of lastAbsorbedLines || []) {
          ghost(l.sub ? `sub:${l.sub}:` : "main:", l.trail, l.landing);
        }
        // …and the SURVIVOR's own route into each rejoin (owner). Behind a
        // still-undoable merge it is exactly as past as the routes it
        // swallowed — nobody is standing on it, and one undo gives all of them
        // back — so drawing it as live green history said the room had a main
        // line, when all it had was `planRecombine` electing the lowest number
        // as survivor. Collected per line, because the live pass below has to
        // know which of that line's OWN trail entries not to un-ghost.
        const survivorGhosts = new Map();
        for (const entry of lastMergeRewinds || []) {
          if (!entry || !entry.available || entry.partOfConvergence) continue;
          if (!Array.isArray(entry.survivorTrail) || !entry.survivorTrail.length)
            continue;
          // By ROUTE where both ends carry one, number as the fallback — the
          // test `mergesBehindLine` and the menu already share, for the same
          // reason: numbers recycle in both directions.
          const line = (lastLines || []).find((l) =>
            !l
              ? false
              : entry.survivorLineUid && l.uid
                ? l.uid === entry.survivorLineUid
                : l.id === entry.survivorLineId,
          );
          if (!line) continue;
          const prefix = entry.survivorSub
            ? `sub:${entry.survivorSub}:`
            : "main:";
          ghost(prefix, entry.survivorTrail, entry.survivorLanding);
          // Keyed by NODE id, not bare frame name: a sub-score frame can share
          // a name with a main one, and a line that has since left the dive it
          // merged from must not have its main trail greyed by a sub ghost.
          const seen = survivorGhosts.get(line.id) || new Set();
          for (const name of entry.survivorTrail) seen.add(`${prefix}${lc(name)}`);
          survivorGhosts.set(line.id, seen);
        }
        for (const l of lastLines) {
          const prefix = l.sub ? `sub:${l.sub}:` : "main:";
          // This line's own frames that lie behind one of its still-undoable
          // rejoins. Its green history begins at the rejoin frame; ANOTHER
          // line visiting one of them still un-ghosts it below, exactly as a
          // live line has always won a node it shares with a ghost.
          const behind = survivorGhosts.get(l.id);
          for (const name of l.trail || []) {
            if (behind && behind.has(`${prefix}${lc(name)}`)) continue;
            const node = cy.getElementById(`${prefix}${name}`);
            if (!node.empty()) node.removeClass("ghost-trail").addClass("visited");
          }
          if (l.checkpoint) {
            const node = cy.getElementById(`${prefix}${l.checkpoint}`);
            if (!node.empty()) node.removeClass("ghost-landing").addClass("checkpoint");
          }
        }
        // Draw the ghosted stretches as ROUTES, not as a handful of greyed
        // nodes: any hop whose BOTH ends are still ghosts after the live pass
        // above. Asking the classes rather than the trails keeps this honest
        // for free — a node another line has since walked onto is green again
        // by now, so the edges either side of it stop being ghosts with it.
        cy.edges().forEach((edge) => {
          if (
            edge.source().hasClass("ghost-trail") &&
            edge.target().hasClass("ghost-trail")
          ) {
            edge.addClass("ghost-edge");
          }
        });
        return;
      }
      // Vanilla mode (or before the first lines push): the bound line's
      // history as pushed via MSG_SELECT_HISTORY.
      const { history, selectedIdx } = historyState;
      history.forEach((name, i) => {
        const node = cy.getElementById(`main:${name}`);
        if (node.empty()) return;
        node.addClass(i <= selectedIdx ? "visited" : "visited-ahead");
        if (i === selectedIdx) node.addClass("checkpoint");
      });
    });
  }

  // ── Legend ────────────────────────────────────────────────────────────────
  //
  // The canvas carries a dozen encodings — three route colours, two trail
  // shades, a dashed ghost and its halo, four node shapes, five badge glyphs —
  // and until now explained none of them anywhere the operator could see. Off
  // by default (it is reference, not instrumentation) and remembered per
  // session, like the manual arrangement.
  //
  // Swatches are written from the same values the cytoscape STYLE above uses;
  // when one of those changes, its row here changes with it. `lines: true`
  // marks an encoding a vanilla score never paints — one shared playhead has no
  // splits, rejoins, ghosts or per-line badges — and those rows are dropped
  // rather than explaining markings that cannot appear.
  const LEGEND = [
    { heading: "Routes", lines: true },
    { edge: "#e67e22", text: "a split: this frame forks its line", lines: true },
    { edge: "#8e44ad", text: "a rejoin: lines merge at the target", lines: true },
    {
      edge: "#2b6cb0",
      text: "a dive into a sub-score, and its return",
      lines: true,
    },
    {
      edge: "#c0392b",
      text: "a hold-until: this frame waits for that one",
      lines: true,
    },
    { heading: "Where the lines are", lines: true },
    { fill: "#ffd54f", border: "#f57f17", text: "a line is standing here", lines: true },
    {
      fill: "#cfcfcf",
      border: "#f57f17",
      text: "…and it is dormant (nobody on it)",
      lines: true,
    },
    {
      fill: "#ffd54f",
      border: "#6a1b9a",
      // Dashed on the canvas too — the one phase that changes the border STYLE
      // and not only its colour.
      dashed: true,
      text: "…its voting window is open",
      lines: true,
    },
    {
      fill: "#ffd54f",
      border: "#00838f",
      text: "…its holding period is running",
      lines: true,
    },
    {
      fill: "#ffd54f",
      border: "#c0392b",
      text: "…it is parked, waiting on other lines",
      lines: true,
    },
    { heading: "Where they have been" },
    { fill: "#dcedc8", border: "#999", text: "visited — a trail passes here" },
    {
      fill: "#f1f8e9",
      border: "#999",
      text: "a step past the current position",
    },
    { fill: "#f4f4f4", border: "#2b6cb0", text: "the current trail entry" },
    {
      ghost: true,
      // Every route feeding a still-undoable rejoin, the survivor's own
      // included — the row used to say "a line a merge swallowed", which was
      // the old, lopsided rule.
      text: "a route into a rejoin that can still be undone — nobody is on it",
      lines: true,
    },
    { heading: "Frame kinds" },
    { fill: "#f4f4f4", border: "#2e7d32", text: "START" },
    { fill: "#f4f4f4", border: "#e67e22", text: "a split frame", lines: true },
    {
      fill: "#f4f4f4",
      border: "#c0392b",
      text: "a barrier (hold-until), drawn as an octagon",
      lines: true,
    },
    {
      fill: "#f4f4f4",
      border: "#2b6cb0",
      text: "a frame with a dive link, drawn as a diamond",
      lines: true,
    },
    { heading: "Badges", lines: true },
    {
      glyph: "L0·3p",
      text: "a line standing here, and the devices on it (+Nr = riders)",
      lines: true,
    },
    { glyph: "✅", text: "voting", lines: true },
    { glyph: "✋", text: "holding", lines: true },
    { glyph: "⏳", text: "this line is waiting on others", lines: true },
    { glyph: "⏩", text: "others are waiting on THIS line", lines: true },
    { glyph: "💤", text: "a device on it has gone quiet", lines: true },
    {
      // The one badge that is not about a line standing here: it marks a frame
      // whose split or rejoin the room can still be walked back through, which
      // otherwise had no marking at all once its ghosts came off.
      glyph: "⏪⏪",
      text: "this frame's split or rejoin can still be undone (tap it)",
      lines: true,
    },
    {
      // The other end of the same undo: the node a line comes BACK to.
      glyph: "⏪",
      text: "a line lands here if a rejoin elsewhere is undone (tap it)",
      lines: true,
    },
    { heading: "In a node's menu", lines: true },
    {
      glyph: "⏪",
      text: "moves one line inside its own trail — nothing else changes",
      lines: true,
    },
    {
      glyph: "⏪⏪",
      text: "changes the room: a split, a rejoin, or every line at once",
      lines: true,
    },
  ];

  function legendKey() {
    return `mapLegend:${window.sessionId}`;
  }

  function legendHtml() {
    const rows = LEGEND.filter((row) => !(row.lines && vanillaMode));
    let html = "";
    rows.forEach((row, i) => {
      if (row.heading) {
        // A heading whose whole section was filtered out has nothing to head.
        const next = rows[i + 1];
        if (!next || next.heading) return;
        html += `<div class="legend-heading">${escapeHtml(row.heading)}</div>`;
        return;
      }
      const swatch = row.edge
        ? `<span class="legend-swatch legend-edge" style="border-top-color:${row.edge}"></span>`
        : row.ghost
          ? `<span class="legend-swatch" style="background:#cfd8dc;border:1px dashed #607d8b"></span>`
          : row.glyph
            ? `<span class="legend-swatch legend-glyph">${escapeHtml(row.glyph)}</span>`
            : `<span class="legend-swatch" style="background:${row.fill};border-color:${
                row.border
              }${row.dashed ? ";border-style:dashed" : ""}"></span>`;
      html += `<div class="legend-row">${swatch}<span>${escapeHtml(
        row.text,
      )}</span></div>`;
    });
    return html;
  }

  function wireRewindLog() {
    const panel = document.getElementById("session-map-log");
    const toggle = document.getElementById("session-map-log-toggle");
    if (!panel || !toggle) return;
    renderRewindLog();
    let open = false;
    const apply = (next) => {
      open = next;
      panel.style.display = open ? "block" : "none";
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      if (open) anchorBelowHeader(panel);
    };
    apply(false);
    toggle.addEventListener("click", () => apply(!open));
  }

  function wireLegend() {
    const panel = document.getElementById("session-map-legend");
    const toggle = document.getElementById("session-map-legend-toggle");
    if (!panel || !toggle) return;
    panel.innerHTML = legendHtml();
    const apply = (open) => {
      panel.style.display = open ? "block" : "none";
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    };
    let open = false;
    try {
      open = localStorage.getItem(legendKey()) === "1";
    } catch (e) {
      // storage blocked — the legend just starts closed every time
    }
    apply(open);
    toggle.addEventListener("click", () => {
      open = !open;
      apply(open);
      try {
        localStorage.setItem(legendKey(), open ? "1" : "0");
      } catch (e) {
        // as above
      }
    });
  }

  // ── Confirmations and alerts, in-page ──────────────────────────────────────
  //
  // `confirm()` and `alert()` were doing this job. A rewind confirm has grown
  // into a paragraph — the question, who lands where, what the cascade
  // discards, whether the barrier that produced the rejoin comes back — and a
  // native dialog renders that as one unbroken wall in whatever face the OS
  // picked, with no way to emphasise the destructive half.
  //
  // The worse half is that it BLOCKS the page script. The map stops drawing the
  // room it is describing, every push queues behind the answer, and the click
  // then goes out against a snapshot that can be a minute old — which is how a
  // confirm promising "this first undoes 2 later steps" came to commit four.
  // The server refuses that now (`stale-cascade`), but a refusal the operator
  // could have been spared is still a worse answer than one they never needed:
  // with the page live, `guard` is re-checked on every push, and a question the
  // room has answered for itself closes with a note instead.
  let openDialog = null;

  function ensureDialog() {
    let backdrop = document.getElementById("session-map-dialog-backdrop");
    if (backdrop) return backdrop;
    backdrop = document.createElement("div");
    backdrop.id = "session-map-dialog-backdrop";
    backdrop.style.display = "none";
    backdrop.innerHTML =
      '<div id="session-map-dialog" role="dialog" aria-modal="true" ' +
      'aria-labelledby="session-map-dialog-title">' +
      '<div class="dialog-title" id="session-map-dialog-title"></div>' +
      '<div class="dialog-body"></div>' +
      '<div class="dialog-note" hidden></div>' +
      '<div class="dialog-actions">' +
      '<button type="button" class="dialog-cancel">Cancel</button>' +
      '<button type="button" class="dialog-ok"></button>' +
      "</div></div>";
    document.body.appendChild(backdrop);
    backdrop.addEventListener("click", (e) => {
      // Only the backdrop itself — a click inside the panel is not a dismissal.
      if (e.target === backdrop) closeDialog(false);
    });
    backdrop
      .querySelector(".dialog-cancel")
      .addEventListener("click", () => closeDialog(false));
    backdrop
      .querySelector(".dialog-ok")
      .addEventListener("click", () => closeDialog(true));
    document.addEventListener("keydown", (e) => {
      if (openDialog && e.key === "Escape") {
        e.preventDefault();
        closeDialog(false);
      }
    });
    return backdrop;
  }

  /** One body entry: a plain paragraph, a bullet list, or a warning line. */
  function dialogBodyHtml(body) {
    return (Array.isArray(body) ? body : [body])
      .filter(Boolean)
      .map((entry) => {
        if (typeof entry === "string") {
          return "<p>" + escapeHtml(entry) + "</p>";
        }
        if (entry.list) {
          return (
            "<ul>" +
            entry.list.map((item) => "<li>" + escapeHtml(item) + "</li>").join("") +
            "</ul>"
          );
        }
        if (entry.warn) {
          return '<p class="dialog-warn">' + escapeHtml(entry.warn) + "</p>";
        }
        return "";
      })
      .join("");
  }

  function closeDialog(result) {
    const backdrop = document.getElementById("session-map-dialog-backdrop");
    if (backdrop) backdrop.style.display = "none";
    const pending = openDialog;
    openDialog = null;
    if (pending) pending.resolve(result);
  }

  /**
   * @param {object} opts
   * @param {string} opts.title the question, in one line
   * @param {Array} opts.body paragraphs / `{list}` / `{warn}` entries
   * @param {string} [opts.okLabel] defaults to "Confirm"
   * @param {boolean} [opts.danger] paint the OK button as destructive
   * @param {() => boolean} [opts.guard] re-checked on every push; a false answer
   *   closes the dialog with a note rather than letting the operator commit to
   *   something the room has already changed
   * @returns {Promise<boolean>}
   */
  function mapConfirm(opts) {
    // One panel, one question. A refusal can land while a confirm is still up
    // (the room keeps running now that this does not block), and overwriting
    // the slot would leave the first question`s promise unresolved forever.
    closeDialog(false);
    const backdrop = ensureDialog();
    const panel = backdrop.querySelector("#session-map-dialog");
    panel.querySelector(".dialog-title").textContent = opts.title;
    panel.querySelector(".dialog-body").innerHTML = dialogBodyHtml(opts.body);
    const note = panel.querySelector(".dialog-note");
    note.hidden = true;
    note.textContent = "";
    const ok = panel.querySelector(".dialog-ok");
    const cancel = panel.querySelector(".dialog-cancel");
    ok.textContent = opts.okLabel || "Confirm";
    ok.classList.toggle("dialog-danger", !!opts.danger);
    ok.disabled = false;
    cancel.hidden = false;
    cancel.textContent = "Cancel";
    backdrop.style.display = "flex";
    ok.focus();
    return new Promise((resolve) => {
      openDialog = { resolve, guard: opts.guard || null };
    });
  }

  /** The same panel with one button — for a refusal, which the operator is
   * waiting on an answer to and has to acknowledge. */
  function mapAlert(title, body) {
    closeDialog(false); // as above — never two questions in one panel
    const backdrop = ensureDialog();
    const panel = backdrop.querySelector("#session-map-dialog");
    panel.querySelector(".dialog-title").textContent = title;
    panel.querySelector(".dialog-body").innerHTML = dialogBodyHtml(body);
    const note = panel.querySelector(".dialog-note");
    note.hidden = true;
    note.textContent = "";
    const ok = panel.querySelector(".dialog-ok");
    ok.textContent = "OK";
    ok.classList.remove("dialog-danger");
    ok.disabled = false;
    panel.querySelector(".dialog-cancel").hidden = true;
    backdrop.style.display = "flex";
    ok.focus();
    return new Promise((resolve) => {
      openDialog = { resolve, guard: null };
    });
  }

  /**
   * The room moved while a question was open. If what the question described is
   * gone, say so and take the button away rather than let it be answered — the
   * server would refuse it, and a refusal the operator could have been spared
   * reads as the tool failing rather than as the room having moved.
   */
  function revalidateDialog() {
    if (!openDialog || !openDialog.guard) return;
    let stillTrue = false;
    try {
      stillTrue = !!openDialog.guard();
    } catch (e) {
      console.warn("session-map: could not re-check the open dialog", e);
    }
    if (stillTrue) return;
    openDialog.guard = null; // said once
    const panel = document.getElementById("session-map-dialog");
    if (!panel) return;
    const note = panel.querySelector(".dialog-note");
    note.textContent =
      "The room moved while this was open — what it would have undone is no" +
      " longer what the map is showing. Close this and choose again.";
    note.hidden = false;
    panel.querySelector(".dialog-ok").disabled = true;
    const cancel = panel.querySelector(".dialog-cancel");
    cancel.hidden = false;
    cancel.textContent = "Close";
    cancel.focus();
  }

  function ensureMenu() {
    let menu = document.getElementById("session-map-menu");
    if (!menu) {
      menu = document.createElement("div");
      menu.id = "session-map-menu";
      menu.style.display = "none";
      document.body.appendChild(menu);
      // Any pointer interaction elsewhere dismisses the menu. Use pointerdown
      // rather than click: Cytoscape emits its node `tap` before the browser's
      // synthetic click, which would otherwise immediately close a menu that
      // was just opened by an ordinary mouse click or touch tap.
      document.addEventListener("pointerdown", (e) => {
        if (!menu.contains(e.target)) hideMenu();
      });
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") hideMenu();
      });
    }
    return menu;
  }

  function hideMenu() {
    const menu = document.getElementById("session-map-menu");
    if (menu) menu.style.display = "none";
    openMenu = null;
  }

  /**
   * Close an open node menu whose entries no longer describe the room.
   *
   * A menu is built from one snapshot and the room keeps playing under it, so
   * until now an operator could sit on a menu for a minute and then click a
   * button for a merge that had already been superseded, a line that had moved,
   * or a ghost that had come back. The server turns those away
   * (MSG_REWIND_REFUSED), but only after they have answered a confirm()
   * promising a topology change — so the honest moment to intervene is when the
   * offer stops being true.
   *
   * Rebuilt and compared rather than diffed: the menu's markup already IS the
   * projection, so "same string" is exactly "same offer", and a push that
   * changes only badges or positions leaves the menu alone.
   */
  function refreshOpenMenu() {
    if (!openMenu || !cy) return;
    const node = cy.getElementById(openMenu.nodeId);
    if (node.empty()) {
      hideMenu();
      return;
    }
    // Guarded because this now runs on EVERY push, not only on a tap: an
    // exception in the menu builder used to mean "the menu does not open", and
    // must not become "the map stops updating".
    try {
      if (nodeMenuHtml(node) !== openMenu.html) hideMenu();
    } catch (e) {
      console.warn("session-map: could not re-check the open menu", e);
      hideMenu();
    }
  }

  // Vanilla mode only — a session-lines room rewinds room-wide by checkpoint.
  async function requestRewind(idx, label) {
    hideMenu();
    const ok = await mapConfirm({
      title: `Rewind the session to "${label}" (step ${idx + 1})?`,
      body: ["Every device jumps back to that frame."],
      okLabel: "Rewind",
      danger: true,
    });
    if (!ok) return;
    sendToServer(MSG_SELECT_HISTORY, {
      selectedIdx: idx,
      operationId: newRewindOperationId(),
    });
    // The server answers with fresh MSG_SELECT_HISTORY + positions pushes,
    // which redraw the overlay — nothing to do locally.
  }

  // The rejoins a room rewind to ⟨group⟩ walks back through on the way — the
  // same question `mergesBehindRoomRewind` asks server-side, put the same way:
  // per line, in that line's own trail, against the frame this rewind lands it
  // on. A line with no occurrence of the group is placed by fill and keeps its
  // own rejoins, so it contributes nothing here either.
  //
  // Folded per PASSAGE, like every other merge affordance on this map: a
  // convergence is one thing the operator watched happen, and one thing the
  // undo takes off. Named by the SERVER (`roomCheckpoints[].undoes`): the
  // rejoins this rewind will walk off are decided by the same plan the click
  // runs, so the confirm promises what the gesture does. The map used to
  // re-walk the trails itself and could not see past a fork — a line whose
  // trail a split had truncated named none of its rejoins, so the confirm
  // under-reported exactly the case the ancestry landing exists for. Resolved
  // against the merge entries for their frames and `restoredLineIds`, which
  // ride the same push, so the two are always the same snapshot.
  function roomRewindMerges(group) {
    const checkpoint = roomCheckpointFor(group);
    const passages = [];
    for (const eventId of (checkpoint && checkpoint.undoes) || []) {
      const entry = (lastMergeRewinds || []).find(
        (candidate) => candidate && candidate.eventId === eventId,
      );
      if (entry && !passages.includes(entry)) passages.push(entry);
    }
    return passages;
  }

  // A room rewind is a walk back, so it says what the walk puts back (owner:
  // rewinding the room from a merged node to an older barrier arrived there
  // with two lines where the room had crossed it with three). The rejoins made
  // since the checkpoint come off on the way, which is a topology change the
  // operator did not literally ask for — the same thing the per-line rewind's
  // confirm already discloses.
  function restoredMergeClause(group) {
    const passages = roomRewindMerges(group);
    if (passages.length === 0) return "";
    const ids = [];
    for (const entry of passages) {
      for (const id of entry.restoredLineIds || []) {
        if (!ids.includes(id)) ids.push(id);
      }
    }
    const num = (id) => parseInt(String(id).replace(/^\D+/, ""), 10) || 0;
    ids.sort((a, b) => num(a) - num(b));
    const n = passages.length;
    return (
      ` ${n} rejoin${n === 1 ? "" : "s"} made since then ` +
      `${n === 1 ? "is" : "are"} undone on the way, so ${ids.join(", ")} ` +
      `stand on their own frames again.`
    );
  }

  // The forks a room rewind takes off on the way, in the operator's terms.
  //
  // The same disclosure the rejoins get, for the same reason: rewinding to a
  // checkpoint the room crossed as two lines has to arrive with two lines, so
  // every fork made since comes off — and that is a topology change the
  // operator did not literally ask for. It matters most on a checkpoint frame
  // that is ITSELF a split frame, where the lines land back on it and the next
  // release would otherwise fork every one of them again.
  function undoneSplitsClause(group) {
    const forks = ((roomCheckpointFor(group) || {}).undoesSplits || []).filter(
      Boolean,
    );
    if (forks.length === 0) return "";
    const where = [...new Set(forks.map((f) => `⟨${frameLabel(f.frame)}⟩`))];
    const n = forks.length;
    return (
      `${n} fork${n === 1 ? "" : "s"} made since then ${
        n === 1 ? "is" : "are"
      } undone on the way — at ${where.join(", ")} — so the lines ${
        n === 1 ? "it" : "they"
      } created collapse back into the ones that crossed the checkpoint.`
    );
  }

  async function requestRoomRewind(group) {
    hideMenu();
    const restoring = restoredMergeClause(group);
    const collapsing = undoneSplitsClause(group);
    // Tagged ids across BOTH kinds — the same list `roomRewindUndoes` builds.
    const checkpoint = roomCheckpointFor(group) || {};
    const undoes = [
      ...(checkpoint.undoes || []).map((id) => `merge:${id}`),
      ...(checkpoint.undoesSplits || []).map((step) => `split:${step.eventId}`),
    ];
    const ok = await mapConfirm({
      title: `Rewind the room to checkpoint ⟨${group}⟩?`,
      body: [
        "Every line moves to its own frame in that group.",
        restoring ? restoring.trim() : null,
        collapsing ? { warn: collapsing } : null,
      ].filter(Boolean),
      okLabel: "Rewind the room",
      danger: true,
      guard: () => {
        const now = roomCheckpointFor(group);
        if (!now) return false;
        return sameSig(undoes, [
          ...(now.undoes || []).map((id) => `merge:${id}`),
          ...(now.undoesSplits || []).map((step) => `split:${step.eventId}`),
        ]);
      },
    });
    if (!ok) return;
    // The room rewind reports on its GROUP, which is what it names server-side.
    rememberRewind(
      "room",
      group,
      `Rewound the room to checkpoint ⟨${group}⟩` +
        (restoring || collapsing
          ? ` — and the ${
              restoring && collapsing
                ? "forks and rejoins"
                : collapsing
                  ? "forks"
                  : "rejoins"
            } made since came off`
          : ""),
    );
    sendToServer(MSG_SELECT_HISTORY, {
      group,
      cascade: undoes,
      operationId: pendingOperationId(),
    });
  }

  // The OTHER forks of the same release this click also takes off.
  //
  // A track group's release divides every populated line standing on a split
  // frame at once, so one thing the operator watched is several events — and
  // each of them is undone together (`orch.splitGestureEvents`). Each keeps
  // its own node, because an operator looks at the node the fork happened on;
  // what changes is that the question names the rest of the release instead of
  // pretending this fork stands alone.
  function siblingForksClause(eventId) {
    const entry = splitEntryFor(eventId);
    const others = ((entry || {}).gesture || []).filter(Boolean);
    if (others.length === 0) return "";
    const where = others
      .map(
        (fork) => `${fork.parentLineId} at ⟨${frameLabel(fork.frame)}⟩`,
      )
      .join(", ");
    return (
      `The same release forked ${others.length} other line${
        others.length === 1 ? "" : "s"
      } — ${where} — and ${
        others.length === 1 ? "that fork comes" : "those forks come"
      } off with this one, because it was one release.`
    );
  }

  async function requestSplitRewind(
    eventId,
    frame,
    parentLineId,
    descendantCount,
  ) {
    hideMenu();
    const cascade = cascadeSig(splitCascadeFor(eventId));
    const siblings = siblingForksClause(eventId);
    const siblingIds = ((splitEntryFor(eventId) || {}).gesture || []).map(
      (fork) => fork.eventId,
    );
    const ok = await mapConfirm({
      title: siblings
        ? `Undo the release that forked at "${frameLabel(frame)}"?`
        : `Undo the split at "${frameLabel(frame)}"?`,
      body: [
        `${descendantCount} line${descendantCount === 1 ? "" : "s"} will ` +
          `collapse back ${siblings ? "into their parents" : `into ${parentLineId}`}.`,
        siblings ? { warn: siblings } : null,
        { warn: "All progress after this split will be discarded." },
        // A split undo cascades just as a merge undo does, so it can discard a
        // rejoin the operator still has on screen — say so before they commit.
        cascadeSentence(splitCascadeFor(eventId), frame).trim() || null,
      ].filter(Boolean),
      okLabel: "Undo the split",
      danger: true,
      guard: () => {
        const now = splitEntryFor(eventId);
        return (
          !!now &&
          now.available &&
          sameSig(cascade, cascadeSig(now.cascade)) &&
          // A fork joining or leaving the release while the question is open
          // changes what this click takes off just as a cascade step does.
          sameSig(
            siblingIds,
            (now.gesture || []).map((fork) => fork.eventId),
          )
        );
      },
    });
    if (!ok) return;
    rememberRewind(
      "split",
      frame,
      `Undid the ${siblings ? "release" : "split"} at ⟨${frameLabel(
        frame,
      )}⟩ — ${descendantCount} line` +
        `${descendantCount === 1 ? "" : "s"} collapsed back ${
          siblings ? "into their parents" : `into ${parentLineId}`
        }`,
    );
    // Both values are a race guard: a stale menu cannot undo a later visit to
    // the same split frame. `cascade` guards the far bigger half — everything
    // this click takes off on the way, which the confirm has just named.
    sendToServer(MSG_SELECT_HISTORY, {
      splitEventId: eventId,
      frame,
      cascade,
      operationId: pendingOperationId(),
    });
  }

  // `landingFrame` is set when the button was reached from a node the lines
  // come BACK to rather than from the rejoin itself — the collapsed and remote
  // entries, whose labels promise "L0, L1, L2 all come back here". The question
  // then opens in those words instead of re-framing the act around a frame the
  // operator did not click.
  async function requestMergeRewind(eventId, frame, lineIds, landingFrame) {
    hideMenu();
    // Counted, not named: the numbers in the button are the ones the rejoin
    // recorded, and a cascade can hand a line a different one on the way back
    // (`freeLineId`) — so naming them here would be a promise the undo does
    // not keep. The frame is the landmark that cannot move, which is also why
    // `mergeLandingParts` can name the DESTINATIONS without the same risk.
    const cascade = cascadeSig(mergeCascadeFor(eventId));
    const ok = await mapConfirm({
      title: landingFrame
        ? `Undo the merge at "${frameLabel(frame)}" — bringing ${
            lineIds.length
          } lines back to "${frameLabel(landingFrame)}"?`
        : `Undo the merge at "${frameLabel(frame)}"?`,
      body: [
        `${lineIds.length} lines go back to the frame each of them came into ` +
          `it from, and every device goes back to the line it was on` +
          latecomerClause(eventId) +
          ".",
        ...mergeLandingBody(eventId),
        cascadeSentence(mergeCascadeFor(eventId), frame).trim() || null,
      ].filter(Boolean),
      okLabel: "Undo the merge",
      danger: true,
      guard: () => {
        const now = mergeEntryFor(eventId);
        return (
          !!now && now.available && sameSig(cascade, cascadeSig(now.cascade))
        );
      },
    });
    if (!ok) return;
    rememberRewind(
      "merge",
      frame,
      `Undid the merge at ⟨${frameLabel(frame)}⟩`,
      eventId,
    );
    // Both values are a race guard, exactly as the split undo's are; `cascade`
    // guards what the click takes off on the way.
    sendToServer(MSG_SELECT_HISTORY, {
      mergeEventId: eventId,
      frame,
      cascade,
      operationId: pendingOperationId(),
    });
  }

  // Unique per click. The server echoes it on both answers (MSG_REWIND_DONE /
  // MSG_REWIND_REFUSED) so each map tab can tell its own gesture from one a
  // different operator made at the same frame.
  let rewindOperationSeq = 0;
  function newRewindOperationId() {
    rewindOperationSeq++;
    return `${Date.now().toString(36)}-${rewindOperationSeq}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
  }

  // The id of the gesture whose confirm was just answered — attached to the
  // message that carries it out.
  function pendingOperationId() {
    return (pendingRewind && pendingRewind.operationId) || null;
  }

  // What to show back when the server says this rewind happened. Composed at
  // CLICK time, from the same projection the confirm was built from: after the
  // undo the entry is gone, so the receipt could not be written then even if
  // the server sent enough to write it with.
  function rememberRewind(kind, frame, what, mergeEventId, exceptLineId) {
    const where = mergeEventId
      ? mergeLandingList(mergeEventId, exceptLineId)
      : "";
    pendingRewind = {
      // The one value that says WHICH click this is. Kind + frame described
      // the event, and two rewinds of the same kind on the same frame — a
      // second operator tab, or this one clicking twice — answer to the same
      // description, so a receipt could be matched to the wrong confirm and
      // the sentence shown back would be another operator gesture.
      operationId: newRewindOperationId(),
      kind,
      frame,
      text: where
        ? `${what}. ${exceptLineId ? "The others" : "They"} land ${where}.`
        : `${what}.`,
    };
  }

  // "L2 has nobody on it now — dormant until someone joins."
  //
  // The one thing about a rewind the operator could not read off the confirm
  // they answered: a merge undo hands a route back to whoever was walking it,
  // and if that performer has since gone home the line comes back DORMANT,
  // with nothing on it. The confirm cannot honestly promise this — which lines
  // end up empty depends on how `spreadMergeLatecomers` distributes the late
  // joiners across every step of a cascade, and a guess that names the wrong
  // line is worse than saying nothing — so the SERVER reports it as a fact
  // afterwards (`MSG_REWIND_DONE.emptied`), the same way the receipt itself
  // exists to close the loop a confirm opened.
  function emptiedClause(entries) {
    const lines = (Array.isArray(entries) ? entries : [])
      .filter(Boolean)
      // A line and where it is standing. The two ends of this gesture do not
      // name lines on the same basis — the confirm used the numbers the REJOIN
      // recorded, this uses the numbers the lines actually came back ON, and
      // `freeLineId` hands a route the lowest free number when an unrelated
      // fork is holding its own. So the operator could read "L0, L1, L2 come
      // back" and then "L4 has nobody on it" and have no way to connect them.
      // The FRAME does connect them: it is the landmark that keeps its word
      // whichever number the line came back on.
      .map((entry) =>
        typeof entry === "string"
          ? entry
          : `${entry.id} at ⟨${frameLabel(
              entry.sub ? `${entry.sub}/${entry.frame}` : entry.frame,
            )}⟩`,
      );
    if (lines.length === 0) return "";
    const named =
      lines.length === 1
        ? lines[0]
        : `${lines.slice(0, -1).join(", ")} and ${lines[lines.length - 1]}`;
    const one = lines.length === 1;
    return (
      ` ${named} ${one ? "has" : "have"} nobody on ${one ? "it" : "them"} ` +
      `now — dormant until someone joins.`
    );
  }

  // A refusal in the operator's own terms. The server sends the machine reason
  // it decided on; anything not listed here is still shown rather than hidden,
  // because a raw reason beats "nothing happened".
  const REWIND_REFUSALS = {
    "stale-frame":
      "the line moved since this menu was built, so that step is no longer the frame you clicked",
    "stale-merge": "that rejoin is no longer on record",
    "stale-split": "that split is no longer on record",
    "stale-trail": "that step is no longer in the line's trail",
    expired:
      "this room's saved state does not say which lines that rejoin swallowed, so nothing can be put back",
    superseded:
      "something newer is standing on this passage and could not be taken off first",
    "blocked-by-expired":
      "a step in between can no longer be undone, and it has to come off first",
    "mixed-merge":
      "a later merge mixed this branch with another split subtree, and that merge can no longer be undone",
    "parent-unavailable": "the line that carried this split on is gone",
    "no-live-descendants": "nothing is left of this split to collapse",
    "survivor-unavailable": "the line this rejoin merged into is gone",
    "nothing-to-separate": "there is nothing left to separate here",
    "unseparable-step":
      "a rejoin it had to take off first has nothing left to separate",
    "unknown-line": "that line is not in the room any more",
    "merge-undo-refused":
      "a rejoin it had to take off first could not be undone",
    "split-undo-refused":
      "a fork it had to take off first could not be undone",
    "stale-cascade":
      "the room built on this passage while the question was open, so this" +
      " click would have discarded more (or less) than it offered to — the map" +
      " has been redrawn, so choose again from what it shows now",
    "restore-failed": "the undo did not bring that line back",
    "sub-unavailable": "the score no longer has the sub-score that line is in",
    "frame-missing": "the score no longer has that frame",
    // Room checkpoint rewind.
    "no-checkpoints": "this room has no synchronized checkpoints to rewind to",
    "not-a-checkpoint":
      "that group is not a common checkpoint any more — some line's trail no longer passes through it",
    "line-unplaced": "a line in the room has no landing in that group",
    // Sub rollback.
    "not-in-sub": "that line is not inside a sub-score any more",
    "stale-sub": "that line is in a different sub-score now",
    // Not a refusal the room decided — the gesture itself fell over, and this
    // is the server saying so rather than leaving the click unanswered.
    "internal-error":
      "the server hit an error part-way through this rewind, and stopped where it was",
  };

  // What a tab that did not click sees. Deliberately plainer than the
  // clicking tab's: it names the act and where, which is what an operator
  // watching the canvas move needs in order to place it, and promises nothing
  // about lines it has no confirm to quote.
  function othersRewindText(data) {
    const where = data.frame ? `⟨${frameLabel(data.frame)}⟩` : "this room";
    switch (data.kind) {
      case "merge":
        return `Another operator undid the merge at ${where}.`;
      case "split":
        return `Another operator undid the split at ${where}.`;
      case "room":
        return `Another operator rewound the room to checkpoint ${where}.`;
      case "sub":
        return `Another operator rewound a line out of its sub-score to ${where}.`;
      default:
        return `Another operator rewound a line to ${where}.`;
    }
  }

  function refusalTitle(data) {
    const what =
      data.kind === "split"
        ? "split undo"
        : data.kind === "merge"
          ? "merge undo"
          : data.kind === "room"
            ? "room rewind"
            : data.kind === "sub"
              ? "sub rollback"
              : "rewind";
    const where = data.frame
      ? data.kind === "room"
        ? ` to ⟨${frameLabel(data.frame)}⟩`
        : ` at "${frameLabel(data.frame)}"`
      : "";
    return `That ${what}${where} did not happen.`;
  }

  function refusalBody(data) {
    const why = REWIND_REFUSALS[data.reason] || data.reason || "unavailable";
    return [
      `${why.charAt(0).toUpperCase()}${why.slice(1)}.`,
      // `moved` is the server saying the walk-back had already committed some
      // of its steps before it stopped. Those cannot be put back — each is a
      // validated snapshot restore in its own right — so the operator must not
      // be told "nothing moved" and left trusting a map that has changed.
      data.moved
        ? {
            warn:
              "Some of the steps it takes off first WERE undone, so the room" +
              " has changed — check the map before trying again.",
          }
        : "Nothing moved.",
    ];
  }

  // "…and the N who joined since are spread evenly between them" — printed
  // only when there is somebody to spread. It used to be unconditional, which
  // told every operator about a redistribution that most of the time involved
  // nobody at all.
  function latecomerClause(eventId) {
    const entry = (lastMergeRewinds || []).find(
      (candidate) => candidate && candidate.eventId === eventId,
    );
    const n = entry && entry.latecomers;
    if (!n) return "";
    // The count is of DEVICES the undo reassigns, and a device that registered
    // and left really is one of them — so it belongs in the total. But the
    // operator reads that number against the room in front of them, and "4
    // devices" while three people are playing reads as the tool being wrong
    // rather than as somebody having gone home. Say which is which whenever
    // they differ; when they agree this is what it always was.
    const here = entry.latecomersHere;
    const away = here == null ? 0 : n - here;
    return (
      ` (the ${n} device${n === 1 ? "" : "s"} that joined since ` +
      `${n === 1 ? "is" : "are"} spread evenly between them` +
      (away > 0 ? ` — ${here} here now, ${away} registered but away` : "") +
      `)`
    );
  }

  // The cascade a confirm names, as the server will re-derive it.
  //
  // A confirm is a promise about what comes off — "this first undoes 2 later
  // steps — the split at ⟨FORK2⟩, then the merge at ⟨MERGE2⟩" — and the room
  // keeps playing underneath it. The click therefore carries the list it was
  // shown, and the server refuses (`stale-cascade`) if the walk it is about to
  // make is a different one: the frame guard pins the EVENT, and until now
  // nothing at all pinned the far larger thing the operator was agreeing to.
  function cascadeSig(cascade) {
    return (cascade || []).map((step) => `${step.kind}:${step.eventId}`);
  }

  function sameSig(a, b) {
    return (a || []).join(",") === (b || []).join(",");
  }

  function mergeEntryFor(eventId) {
    return (
      (lastMergeRewinds || []).find(
        (candidate) => candidate && candidate.eventId === eventId,
      ) || null
    );
  }

  function splitEntryFor(eventId) {
    return (
      (lastSplitRewinds || []).find(
        (candidate) => candidate && candidate.eventId === eventId,
      ) || null
    );
  }

  function mergeCascadeFor(eventId) {
    const entry = (lastMergeRewinds || []).find(
      (candidate) => candidate && candidate.eventId === eventId,
    );
    return (entry && entry.cascade) || [];
  }

  function splitCascadeFor(eventId) {
    const entry = (lastSplitRewinds || []).find(
      (candidate) => candidate && candidate.eventId === eventId,
    );
    return (entry && entry.cascade) || [];
  }

  // A structural rewind point stays reachable for the whole session , so the
  // room may well have built on top of it since. The server walks those later
  // steps off first; the confirm says which, because "undo the merge at
  // MERGE1" an hour later can discard a fork and a rejoin the operator still
  // has on screen.
  //
  // `targetLabel` names the event the operator actually clicked, and it is not
  // decoration. A node that is BOTH a rejoin frame and the landing of a LATER
  // rejoin carries two ⏪⏪ buttons, and the cascade of the first one names the
  // second one's frame — so the confirm for "undo the rejoin at ⟨Z⟩" read
  // "…the merge at ⟨B-prime⟩…", which is exactly the frame an operator who
  // meant to undo B-prime was looking for. One did, and said yes to the wrong
  // gesture. Saying what this undo IS before saying what it drags with it is
  // the difference.
  function cascadeSentence(cascade, targetLabel) {
    if (!cascade || cascade.length === 0) return "";
    const steps = cascade.map(
      (step) =>
        `the ${step.kind === "split" ? "split" : "merge"} at ` +
        `⟨${frameLabel(step.frame)}⟩`,
    );
    return (
      ` ${targetLabel ? `To reach ⟨${frameLabel(targetLabel)}⟩ this` : "This"} ` +
      `first undoes ${steps.length} later step` +
      `${steps.length === 1 ? "" : "s"} — ${steps.join(", then ")} — ` +
      `so everything the room played after ${steps.length === 1 ? "it" : "them"} ` +
      `is discarded.`
    );
  }

  // The same list, short enough for a button: the frames, not a bare count.
  //
  // "— also undoes 1 later step" told the operator there was one and left them
  // to find out which after committing, which on a node carrying two undos is
  // the whole question.
  function cascadeLabel(cascade) {
    if (!cascade || cascade.length === 0) return "";
    const where = cascade.map(
      (step) =>
        `the ${step.kind === "split" ? "split" : "merge"} at ⟨${frameLabel(
          step.frame,
        )}⟩`,
    );
    const shown = where.slice(0, 2).join(" and ");
    const rest = where.length - Math.min(2, where.length);
    return ` — also undoes ${shown}${rest > 0 ? ` and ${rest} more` : ""}`;
  }

  // Where one convergence puts every line back, straight from the server, which
  // works it out with the same `preMergeLanding` the undo itself uses. Any
  // member of a passage carries the same passage-wide answer, so a ghost button
  // naming the older half of a pair-merge resolves it just as well.
  function mergeLandingsFor(eventId) {
    const entry = (lastMergeRewinds || []).find(
      (candidate) => candidate && candidate.eventId === eventId,
    );
    return (entry && entry.landings) || [];
  }

  // Every line the one gesture brings back — the server's list where it has
  // one, the landings otherwise (they name the same set).
  function mergeRestoredIdsFor(eventId) {
    const entry = (lastMergeRewinds || []).find(
      (candidate) => candidate && candidate.eventId === eventId,
    );
    if (entry && (entry.restoredLineIds || []).length) {
      return entry.restoredLineIds;
    }
    return mergeLandingsFor(eventId).map((l) => l.lineId);
  }

  // "L0 → ⟨A2⟩, L1 → ⟨B2⟩, L2 → ⟨C2⟩", or "" when the server sent no landings.
  // `exceptLineId` drops a line the sentence around this one has already
  // placed: the one that walks on AFTER the undo (naming where it was put
  // back, one clause after saying it then moves further, described a position
  // it does not end on) — and the one an entry was reached from its own
  // LANDING node, whose confirm opens "onto ⟨A2⟩, the frame it came into it
  // from" and then went on to read "They land L0 → ⟨A2⟩, …", saying A2 twice
  // in one breath. The list says "The others" in both cases; only the barrier
  // note tells them apart (`staysAtLanding`).
  function mergeLandingList(eventId, exceptLineId) {
    // Grouped by DESTINATION. A barrier release parks every line on one frame,
    // so the list came out "L0 → ⟨BARRIER⟩, L1 → ⟨BARRIER⟩, L2 → ⟨BARRIER⟩" —
    // three clauses saying one thing, which reads as the sentence having gone
    // wrong rather than as the lines really landing together.
    const groups = [];
    for (const l of mergeLandingsFor(eventId)) {
      if (exceptLineId && l.lineId === exceptLineId) continue;
      // Plain text: this goes into confirm()/the receipt, never into markup.
      const where = `⟨${frameLabel(l.sub ? `${l.sub}/${l.frame}` : l.frame)}⟩`;
      const found = groups.find((g) => g.where === where);
      if (found) found.ids.push(l.lineId);
      else groups.push({ where, ids: [l.lineId] });
    }
    // The separator only has to work harder once something IS grouped: one
    // line per landing is character-for-character what it always was.
    const sep = groups.some((g) => g.ids.length > 1) ? "; " : ", ";
    return groups.map((g) => `${g.ids.join(", ")} → ${g.where}`).join(sep);
  }

  // Where the lines will actually appear, and what will NOT be holding them
  // there.
  //
  // Behind the newest rejoin the ghosts already draw the landings, but reaching
  // an OLDER merge draws nothing at all — its absorbed numbers went back in the
  // pool, so no route is painted — and the confirm was asking the operator to
  // commit to "1 → 3 lines" with no idea where three lines were about to
  // appear. The barrier note is the same honesty: an undo restores the topology
  // but not the WAIT that produced it (§8.4 — restored lines land un-parked and
  // phase-less, an operator rewind being authoritative), so lines put back on a
  // hold-until frame can walk straight off it and the passage replays as a
  // co-presence merge rather than the barrier release it was.
  function mergeLandingParts(eventId, exceptLineId, staysAtLanding) {
    const where = mergeLandingList(eventId, exceptLineId);
    if (!where) return null;
    const barriers = [
      ...new Set(
        mergeLandingsFor(eventId)
          .filter(
            (l) =>
              l.barrier &&
              // The excepted line keeps its barrier note when it STAYS on its
              // landing: the clause above has just named that frame, and
              // "nothing holds it there" is exactly what an operator putting a
              // line back onto a hold-until frame needs to know. Dropped only
              // when the line walks on, where the wait is moot.
              (staysAtLanding || !exceptLineId || l.lineId !== exceptLineId),
          )
          .map((l) => frameLabel(l.frame)),
      ),
    ];
    return {
      lands: `${exceptLineId ? "The others" : "They"} land ${where}.`,
      barrier: barriers.length
        ? `The hold-until wait at ${barriers
            .map((f) => `⟨${f}⟩`)
            .join(" and ")} is not re-armed — nothing holds them there.`
        : null,
    };
  }

  /** The same two clauses as body entries, in the order they read. */
  function mergeLandingBody(eventId, exceptLineId, staysAtLanding) {
    const parts = mergeLandingParts(eventId, exceptLineId, staysAtLanding);
    if (!parts) return [];
    return [parts.lands, parts.barrier ? { warn: parts.barrier } : null].filter(
      Boolean,
    );
  }

  // "The merge is undone, so 2 other lines land on their own frames too, each
  // device back on the line it was on" — the clause every entry that separates
  // a convergence shares, whichever of its lines it was reached from.
  function mergeSeparationClause(eventId, exceptLineId) {
    const others = mergeRestoredIdsFor(eventId).filter(
      (id) => id && id !== exceptLineId,
    );
    return (
      ` The merge is undone, so ` +
      (others.length
        ? `${others.length} other ${others.length === 1 ? "line" : "lines"} ` +
          `${others.length === 1 ? "lands" : "land"} on ` +
          `${others.length === 1 ? "its own frame" : "their own frames"} too, ` +
          `each device back on the line it was on`
        : `every device goes back to the line it was on`) +
      latecomerClause(eventId) +
      `.`
    );
  }

  // Session-lines: targeted rewind of one named line within its own trail .
  // `frame` is the server's race guard — refused if the line moved (or left
  // its sub) since this menu was built. The merges this line would be reaching
  // back THROUGH, newest first — the server undoes exactly these on the way
  // (lineRewind), so the confirm says so before the operator commits to a
  // topology change they did not ask for.
  //
  // Matched on the durable `uid`, not the number, for the same reason
  // `orch.mergesBehindLine` is: a fork mints a fresh identity for the line that
  // carries on, so an older rejoin naming "L0" can be describing a route the L0
  // standing here today merely inherited the number of — and its history index
  // indexes THAT route's trail, not this one's. Without the test the confirm
  // promised to undo merges the server then (correctly) left alone.
  function mergesBehindLineRewind(lineId, idx) {
    const uid = ((lastLines || []).find((l) => l && l.id === lineId) || {}).uid;
    return (lastMergeRewinds || [])
      .filter(
        (entry) =>
          entry &&
          entry.reason !== "expired" &&
          // One convergence, one entry: the older events of a passage are
          // folded into its newest, which already names every line coming
          // back out.
          !entry.partOfConvergence &&
          // Route first, number only as the fallback — the same test
          // `mergesBehindLine` applies. Keying on the number cuts both ways:
          // it names merges this line never walked through, and it MISSES the
          // ones it did whenever the line came back on a number a fork had
          // taken in the meantime.
          (uid && entry.survivorLineUid
            ? entry.survivorLineUid === uid
            : entry.survivorLineId === lineId) &&
          // BELOW the floor, not at it. The floor is the merged line's own
          // position — for a co-presence rejoin, the rejoin frame itself — and
          // standing the line back on a frame it stood on AS the merged line
          // asks nothing of the merge. Reading it as "at or behind" left the
          // rejoin node offering "⏪⏪ rewind L0 here — out of the merge at
          // ⟨B-prime⟩" beside "⏪⏪ undo the merge at ⟨B-prime⟩", so the
          // operator who wanted only the first had no way to buy it.
          entry.survivorRewindFloor != null &&
          idx < entry.survivorRewindFloor,
      )
      // `mergeEvents[]` order is chronological; the walk is newest-first, and
      // the confirm names them in the order they will actually come off.
      .reverse();
  }

  // The same targeted rewind, aimed at a line a merge SWALLOWED. It cannot
  // move until it exists again, so the click undoes the merge that took it —
  // the whole convergence, exactly as the rejoin node's own entry does — and
  // then walks this line on alone. Aiming at the last node of its ghost trail
  // is simply "bring it back where it was": the undo lands it there and
  // nothing else moves.
  async function requestAbsorbedRewind(lineId, idx, frame, label, eventId) {
    hideMenu();
    // Identified by the passage as well as the number: `absorbedLines[]` can
    // hold two entries with the same id (a merge frees the number, a later
    // fork mints it again, a later merge swallows that one too), and both
    // entries' buttons used to resolve to whichever was published first.
    const ghost = (lastAbsorbedLines || []).find(
      (l) => l && l.id === lineId && (!eventId || l.mergeEventId === eventId),
    );
    if (!ghost) return;
    // "…so N other lines land on their own frames too" comes from the merge
    // entry the server built for this passage (`mergeSeparationClause`): it
    // already folds the pair-events of one convergence, so it names lines
    // whose route this map may not be drawing a ghost for at all.
    const atLanding = idx === (ghost.trail || []).length - 1;
    const cascade = cascadeSig(mergeCascadeFor(ghost.mergeEventId));
    const ok = await mapConfirm({
      title:
        `Bring ${lineId} back out of the merge at ` +
        `"${frameLabel(ghost.mergeFrame)}"` +
        (atLanding
          ? ` — onto "${label}", the frame it came into the merge from?`
          : ` and rewind it to "${label}" (step ${idx + 1})?`),
      body: [
        mergeSeparationClause(ghost.mergeEventId, lineId).trim(),
        atLanding ? null : `Only ${lineId} then moves any further.`,
        // Dropped from the list either way — the clause above has placed it,
        // onto its landing or one step further back — but a line that STAYS on
        // its landing keeps that frame's barrier note.
        ...mergeLandingBody(ghost.mergeEventId, lineId, atLanding),
        cascadeSentence(mergeCascadeFor(ghost.mergeEventId), ghost.mergeFrame).trim() ||
          null,
      ].filter(Boolean),
      okLabel: `Bring ${lineId} back`,
      danger: true,
      guard: () => {
        const now = (lastAbsorbedLines || []).find(
          (l) =>
            l && l.id === lineId && l.mergeEventId === ghost.mergeEventId,
        );
        const entry = mergeEntryFor(ghost.mergeEventId);
        return (
          !!now &&
          !!entry &&
          entry.available &&
          lc((now.trail || [])[idx] || "") === lc(frame || "") &&
          sameSig(cascade, cascadeSig(entry.cascade))
        );
      },
    });
    if (!ok) return;
    rememberRewind(
      "line",
      frame,
      atLanding
        ? `Brought ${lineId} back out of the merge at ⟨${frameLabel(
            ghost.mergeFrame,
          )}⟩`
        : `Brought ${lineId} out of the merge at ⟨${frameLabel(
            ghost.mergeFrame,
          )}⟩ and rewound it to ⟨${frameLabel(label)}⟩`,
      ghost.mergeEventId,
      atLanding ? null : lineId,
    );
    // The line is no longer in the room's lines[] at all — its number went back
    // in the pool at the rejoin — so the merge event is how the server finds
    // the route this entry names.
    sendToServer(MSG_SELECT_HISTORY, {
      lineId,
      selectedIdx: idx,
      frame,
      absorbedEventId: ghost.mergeEventId,
      operationId: pendingOperationId(),
    });
  }

  // The passage entry the menu offers for a rejoin at `mergeFrame` — the one
  // that carries the whole convergence (its folded halves raise no button).
  function mergePassageAt(mergeFrame) {
    return (
      (lastMergeRewinds || []).find(
        (entry) =>
          entry &&
          entry.available &&
          !entry.partOfConvergence &&
          lc(entry.frame || "") === lc(mergeFrame || ""),
      ) || null
    );
  }

  // Would the undo ALONE put this line on this frame — is the entry here "bring
  // it back where it was" and nothing more? The merges come off oldest last, so
  // the frame the line ends on is the landing the OLDEST of them gives it.
  //
  // @returns {{frame: string, eventId: string}|null} the rejoin it comes out of
  function undoLandsLineHere(lineId, idx, frameName) {
    const behind = mergesBehindLineRewind(lineId, idx);
    const oldest = behind[behind.length - 1];
    if (!oldest) return null;
    const landing = mergeLandingsFor(oldest.eventId).find(
      (l) => l.lineId === lineId && !l.sub,
    );
    if (!landing || lc(landing.frame || "") !== lc(frameName || "")) return null;
    return { frame: oldest.frame, eventId: oldest.eventId };
  }

  // Three buttons for one act, collapsed into one.
  //
  // On the node a whole convergence lands back on, EVERY entry the menu would
  // carry — the survivor's per-line rewind and each swallowed line's ghost —
  // resolves to the same undo: it puts all of them here and nothing walks any
  // further. The operator was offered "⏪⏪ rewind L0 here", "⏪⏪ rewind L1
  // here" and "⏪⏪ rewind L2 here" for three identical outcomes, none of them
  // named for what it actually does. Offered once instead, in the words the
  // rejoin node's own entry uses.
  //
  // Returns "" the moment anything here is a REAL rewind (a line that would
  // walk on after the undo, an earlier step of a ghost's route) — those must
  // keep their own entries, and the collapse must never hide one.
  function collapsedMergeLandingHtml(frameName) {
    const found = [];
    for (const l of (lastLines || []).filter((line) => line && !line.sub)) {
      const trail = Array.isArray(l.trail) ? l.trail : [];
      for (let i = 0; i < trail.length - 1; i++) {
        if (lc(trail[i]) !== lc(frameName)) continue;
        const at = undoLandsLineHere(l.id, i, frameName);
        if (!at) return "";
        found.push({ id: l.id, at });
      }
    }
    for (const g of lastAbsorbedLines || []) {
      if (g.sub) continue;
      const trail = Array.isArray(g.trail) ? g.trail : [];
      for (let i = 0; i < trail.length; i++) {
        if (lc(trail[i]) !== lc(frameName)) continue;
        // Any earlier step of a ghost's route is a rewind of its own.
        if (i !== trail.length - 1) return "";
        found.push({ id: g.id, at: { frame: g.mergeFrame } });
      }
    }
    if (found.length < 2) return "";
    const frame = found[0].at.frame;
    // One passage, or nothing: two rejoins landing lines on the same node are
    // two things the operator watched happen.
    if (found.some((f) => lc(f.at.frame || "") !== lc(frame || ""))) return "";
    const passage = mergePassageAt(frame);
    if (!passage) return "";
    return `<button type="button" data-merge-event="${escapeHtml(
      passage.eventId,
    )}" data-merge-frame="${escapeHtml(
      passage.frame,
    )}" data-merge-lines="${escapeHtml(
      (passage.restoredLineIds || []).join(","),
    )}" data-merge-here="${escapeHtml(frameName)}">⏪⏪ undo the merge at ⟨${escapeHtml(
      frameLabel(frame),
    )}⟩ — ${escapeHtml(
      found.map((f) => f.id).join(", "),
    )} all come back here</button>`;
  }

  // Rewind entries for a line a merge swallowed, on every node of the trail its
  // undo would give back — the LAST one included, unlike a live line's, because
  // a ghost is standing nowhere: that entry is the "bring it back" case.
  function absorbedRewindButtonsHtml(frameName, sub) {
    let html = "";
    for (const l of lastAbsorbedLines || []) {
      if (lc(l.sub || "") !== lc(sub || "")) continue;
      const trail = Array.isArray(l.trail) ? l.trail : [];
      const hits = [];
      trail.forEach((name, i) => {
        if (lc(name) === lc(frameName)) hits.push(i);
      });
      for (const i of hits) {
        const suffix = hits.length > 1 ? ` (visit ${hits.indexOf(i) + 1})` : "";
        html += `<button type="button" data-absorbed-line="${escapeHtml(
          l.id,
        )}" data-absorbed-event="${escapeHtml(
          l.mergeEventId || "",
        )}" data-idx="${i}" data-frame="${escapeHtml(
          trail[i],
        )}">⏪⏪ rewind ${escapeHtml(l.id)} here${suffix} — out of the merge at ⟨${escapeHtml(
          frameLabel(l.mergeFrame),
        )}⟩</button>`;
      }
    }
    return html;
  }

  // The landing nodes of a passage the room has since built ON TOP of.
  //
  // Ghosts are painted only for a passage nothing is standing on (§8.4), and a
  // split truncates the trails it forks from (§6) — so the moment a rejoin
  // stopped being the newest one, every frame its lines would come back to
  // went quiet: `A2` said "no line's current trail reaches here — no rewind"
  // while the undo on `MERGE1` was still one click away and would land L0 on
  // that very node. The rejoin node's ⏪⏪ badge was then the only way in,
  // which asks the operator to remember which frame the rejoin was on, mid-
  // piece. The landings are known — the server works them out with the same
  // `preMergeLanding` the undo itself uses — so the node a line comes back to
  // can carry the same one-click undo the rejoin node does. It is the same act
  // either way, which is the rule the rest of §8.4 already follows: one thing
  // the operator watched happen, reachable from wherever they remember it.
  //
  // Offered ONLY where the menu would otherwise be empty (see `nodeMenuHtml`):
  // anything the structural, ghost or per-line sections already put on this
  // node belongs to the NEWEST passage, which is reached through its own
  // routes and must not grow a second button for the same undo.
  function remoteMergeLandingHtml(frameName) {
    let html = "";
    for (const entry of lastMergeRewinds || []) {
      if (!entry || !entry.available || entry.partOfConvergence) continue;
      // The rejoin's own node already offers this, as the merge it was.
      if (lc(entry.frame || "") === lc(frameName)) continue;
      const ids = (entry.landings || [])
        .filter((l) => l && !l.sub && lc(l.frame || "") === lc(frameName))
        .map((l) => l.lineId);
      if (ids.length === 0) continue;
      // `data-merge-frame` is the REJOIN frame, not this node's: it is the
      // race guard, and the server checks it against the event.
      html += `<button type="button" data-merge-event="${escapeHtml(
        entry.eventId,
      )}" data-merge-frame="${escapeHtml(
        entry.frame,
      )}" data-merge-lines="${escapeHtml(
        (entry.restoredLineIds || []).join(","),
      )}" data-merge-here="${escapeHtml(frameName)}">⏪⏪ undo the merge at ⟨${escapeHtml(
        frameLabel(entry.frame),
      )}⟩ — ${escapeHtml(ids.join(", "))} ${
        ids.length === 1 ? "comes" : "come"
      } back here</button>`;
    }
    return html;
  }

  async function requestLineRewind(lineId, idx, frame, label) {
    hideMenu();
    const behind = mergesBehindLineRewind(lineId, idx);
    // Counted, not named — a cascade can bring a line back on a number no
    // longer its own, so the frame is the only landmark that keeps its word.
    const undone = behind
      .map((entry) => {
        const others = (entry.restoredLineIds || []).filter(
          (id) => id !== lineId,
        );
        return (
          `⟨${frameLabel(entry.frame)}⟩ (${others.length} ` +
          `${others.length === 1 ? "line comes" : "lines come"} back out)`
        );
      })
      .join(", ");
    // Does the undo alone BE the whole request? The merges come off oldest
    // last, so the frame this line ends on is the landing the OLDEST of them
    // gives it; when that is the frame the operator clicked, nothing walks any
    // further. The ghost entries have always said so (their `atLanding`),
    // while the live survivor's confirm ended "Only L0 then moves any further"
    // about a line that did not move — the same lopsidedness the button labels
    // had, one level down.
    const oldest = behind[behind.length - 1];
    const landsHere =
      !!oldest &&
      lc(
        (
          mergeLandingsFor(oldest.eventId).find(
            (l) => l.lineId === lineId && !l.sub,
          ) || {}
        ).frame || "",
      ) === lc(frame || "");
    const cascade = behind.map((entry) => String(entry.eventId));
    const ok = await mapConfirm({
      title: landsHere
        ? `Bring ${lineId} back out of the merge at ` +
          `"${frameLabel(oldest.frame)}" — onto "${label}", the frame it came ` +
          `into it from?`
        : `Rewind line ${lineId} to "${label}" (step ${idx + 1})?`,
      body: landsHere
        ? [
            mergeSeparationClause(oldest.eventId, lineId).trim(),
            ...mergeLandingBody(oldest.eventId, lineId, true),
            cascadeSentence(mergeCascadeFor(oldest.eventId), oldest.frame).trim() ||
              null,
          ].filter(Boolean)
        : undone
          ? [
              // "No other line moves" was the no-cascade sentence left
              // standing: the clause before it has just said that several other
              // lines come back out onto their own frames, which is a move.
              // What is true is that they STOP there — only the clicked line
              // walks on — which is how the absorbed-line confirm has always
              // put it.
              `That reaches back past ${
                behind.length === 1 ? "a merge" : "merges"
              } — undoing ${undone} on the way, each line landing on the frame ` +
                `it came from. Only ${lineId} then moves any further.`,
              ...mergeLandingBody(oldest.eventId, lineId),
            ].filter(Boolean)
          : ["Only this line moves; the rest of the room is unaffected."],
      okLabel: landsHere ? `Bring ${lineId} back` : `Rewind ${lineId}`,
      danger: true,
      guard: () =>
        sameSig(cascade, mergesBehindLineRewind(lineId, idx).map((e) => String(e.eventId))),
    });
    if (!ok) return;
    rememberRewind(
      "line",
      frame,
      landsHere
        ? `Brought ${lineId} back out of the merge at ⟨${frameLabel(
            oldest.frame,
          )}⟩`
        : `Rewound ${lineId} to ⟨${frameLabel(label)}⟩`,
      oldest && oldest.eventId,
      landsHere ? null : lineId,
    );
    sendToServer(MSG_SELECT_HISTORY, {
      lineId,
      selectedIdx: idx,
      frame,
      // The rejoins this rewind promised to walk back through, so the server
      // can refuse one the room has added since (`stale-cascade`).
      cascade,
      operationId: pendingOperationId(),
    });
  }

  // Targeted rewind entries for `frameName`, matched (case-insensitively)
  // against each given line's ACTIVE trail: one "⏪ rewind <line> here" per
  // PAST occurrence — the trail-end occurrence is the line's current position,
  // nothing to rewind. The exact trail entry rides along as `data-frame`, the
  // server's race guard (refused if the line moved since this menu was built).
  function lineRewindButtonsHtml(lines, frameName) {
    let html = "";
    for (const l of lines || []) {
      const trail = Array.isArray(l.trail) ? l.trail : [];
      const hits = [];
      trail.forEach((name, i) => {
        if (lc(name) === lc(frameName)) hits.push(i);
      });
      for (const i of hits) {
        if (i === trail.length - 1) continue; // current position
        const suffix = hits.length > 1 ? ` (visit ${hits.indexOf(i) + 1})` : "";
        // An entry reaching back past a rejoin UNDOES it on the way (§8.2), so
        // it says so — in the same words the swallowed lines' entries have
        // always used. Without this the three routes that fed one merge
        // offered three different-looking buttons for one act, and the
        // plainest of them ("⏪ rewind L0 here", the survivor's) was the one
        // that would take a whole rejoin off the room: which route got the
        // quiet label was decided by nothing but `planRecombine` electing the
        // lowest-numbered line as survivor.
        const behind = mergesBehindLineRewind(l.id, i);
        const via =
          behind.length === 0
            ? ""
            : behind.length === 1
              ? ` — out of the merge at ⟨${escapeHtml(
                  frameLabel(behind[0].frame),
                )}⟩`
              : ` — out of ${behind.length} merges (${behind
                  .map((entry) => `⟨${escapeHtml(frameLabel(entry.frame))}⟩`)
                  .join(", ")})`;
        html += `<button type="button" data-line-id="${escapeHtml(
          l.id,
        )}" data-idx="${i}" data-frame="${escapeHtml(trail[i])}">${
          behind.length ? "⏪⏪" : "⏪"
        } rewind ${escapeHtml(l.id)} here${suffix}${via}</button>`;
      }
    }
    return html;
  }

  // "⏩ advance <line> to ⟨…⟩" — the per-line half of the strip's
  // force-advance, offered on the node the straggler is standing on, which is
  // where the operator is already looking when a track group or a hold-until
  // has stalled the room on one line. The barrier is found by asking which
  // waiting entry lists this line as a straggler; the destination comes from
  // the same push, so the entry can name where the line will land before the
  // operator commits to it.
  function advanceButtonsHtml(nodeId) {
    let html = "";
    for (const l of lastLines || []) {
      if (!l.frame) continue;
      const id = l.sub ? `sub:${l.sub}:${l.frame}` : `main:${l.frame}`;
      if (id !== nodeId) continue;
      const barrier = (lastBarriers || []).find((b) =>
        (b.stragglers || []).includes(l.id),
      );
      if (!barrier) continue;
      const dest = advanceDestination(barrier, l.id);
      if (!dest) {
        html +=
          `<div class="menu-note">${escapeHtml(l.id)} is holding ` +
          `${escapeHtml(frameLabel(barrier.frame))} open, but the score offers ` +
          `no way to land it on the target it owes — release instead</div>`;
        continue;
      }
      html +=
        `<button type="button" class="menu-advance" data-advance-line="${escapeHtml(
          l.id,
        )}" data-advance-frame="${escapeHtml(
          barrier.frame,
        )}" data-advance-label="${escapeHtml(dest.label)}" data-advance-hold="${
          dest.atDestination ? "1" : ""
        }">` +
        (dest.atDestination
          ? `⏩ end ${escapeHtml(l.id)}'s hold at ⟨${escapeHtml(dest.label)}⟩`
          : `⏩ advance ${escapeHtml(l.id)} to ⟨${escapeHtml(dest.label)}⟩`) +
        `</button>`;
    }
    return html;
  }

  // The two sub-score valves, on the SUB frame a line is standing on — where an
  // operator watching a line stuck mid-dive is already looking. Neither needs a
  // barrier: the whole point is the line nothing is waiting on, whose only
  // previous way out was a room rewind that discards everyone's progress.
  //
  // ⏫ eject — forward, to where this dive RETURNS (`subReturn`). ⏪ rewind —
  // back to where it dived FROM (`subOrigin`), the dive undone, the line free
  // to take it again.
  //
  // Both destinations come from the same push, so each entry names its landing
  // before the operator commits to it.
  function subValveButtonsHtml(nodeId) {
    if (!/^sub:/.test(nodeId)) return "";
    let html = "";
    for (const l of lastLines || []) {
      if (!l.sub || !l.frame) continue;
      if (`sub:${l.sub}:${l.frame}` !== nodeId) continue;
      // Each valve stands on its own destination: a dive whose RETURN frame
      // is gone can still be rolled back to the frame it came from, which is
      // exactly when that is the only move left.
      if (l.subReturn) {
        const dest = frameLabel(l.subReturn);
        html +=
          `<button type="button" class="menu-advance" data-eject-line="${escapeHtml(
            l.id,
          )}" data-eject-sub="${escapeHtml(l.sub)}" data-eject-label="${escapeHtml(
            dest,
          )}">⏫ eject ${escapeHtml(l.id)} to ⟨${escapeHtml(dest)}⟩</button>`;
      } else {
        html +=
          `<div class="menu-note">${escapeHtml(l.id)} cannot be ejected — the ` +
          `score no longer has the frame this dive returns to</div>`;
      }
      html += rollbackButtonHtml(l);
    }
    return html;
  }

  // "⏪ rewind <line> to ⟨…⟩" — the shortcut for the common case, on the sub
  // frame the line stands on: back to the fork it dived from, which is this
  // command's default (no trail index sent — the server reads the line's own).
  // Every OTHER frame of its main trail is offered on that frame's own node by
  // subTrailRewindButtonsHtml, in the rewind grammar the map already uses.
  function rollbackButtonHtml(l) {
    if (!l.subOrigin) {
      return (
        `<div class="menu-note">${escapeHtml(l.id)} cannot be rolled back — the ` +
        `score no longer has the frame it dived from</div>`
      );
    }
    // data-unsub-frame carries the trail entry VERBATIM — it is the server's
    // race guard, matched against the line's own history. frameLabel() is for
    // the eye only: sending the stripped label refused every click in silence.
    return (
      `<button type="button" data-unsub-line="${escapeHtml(
        l.id,
      )}" data-unsub-sub="${escapeHtml(l.sub)}" data-unsub-frame="${escapeHtml(
        l.subOrigin,
      )}">` +
      `⏪ rewind ${escapeHtml(l.id)} to ⟨${escapeHtml(
        frameLabel(l.subOrigin),
      )}⟩</button>`
    );
  }

  // The same command from the destination end, and generalized: on a MAIN
  // frame, one entry per occurrence of it in the MAIN trail of every line
  // currently mid-dive. An operator thinking "send it back to B" looks at B,
  // not at the sub box the line is lost inside — and any frame the line has
  // already played is a legitimate answer, not only the fork it dived from.
  //
  // Unlike a main-flow line's entries, the trail-END occurrence is offered here:
  // the line is not standing on it, it is down in a sub, and that entry IS the
  // fork — which makes the dive-origin rollback this command's default case.
  function subTrailRewindButtonsHtml(frameName) {
    let html = "";
    for (const l of lastLines || []) {
      if (!l.sub) continue;
      const trail = Array.isArray(l.mainTrail) ? l.mainTrail : [];
      const hits = [];
      trail.forEach((name, i) => {
        if (lc(name) === lc(frameName)) hits.push(i);
      });
      for (const i of hits) {
        const suffix = hits.length > 1 ? ` (visit ${hits.indexOf(i) + 1})` : "";
        html += `<button type="button" data-unsub-line="${escapeHtml(
          l.id,
        )}" data-unsub-sub="${escapeHtml(l.sub)}" data-unsub-idx="${i}" data-unsub-frame="${escapeHtml(
          trail[i],
        )}">⏪ rewind ${escapeHtml(l.id)} here${suffix} (out of ${escapeHtml(
          l.sub,
        )})</button>`;
      }
    }
    return html;
  }

  function splitRewindHtml(frameName) {
    let html = "";
    for (const entry of lastSplitRewinds || []) {
      if (lc(entry.frame) !== lc(frameName)) continue;
      if (entry.available) {
        const count = (entry.descendantLineIds || []).length;
        const forks = (entry.gesture || []).length;
        html += `<button type="button" data-split-event="${escapeHtml(
          entry.eventId,
        )}" data-split-frame="${escapeHtml(
          entry.frame,
        )}" data-split-parent="${escapeHtml(
          entry.parentLineId,
        )}" data-split-count="${count}">⏪⏪ undo ${
          // One release forks every populated line of a track group standing
          // on a split frame, and undoing it takes all of them off
          // (`orch.splitGestureEvents`). Say which, so the button is not
          // promising less than it does.
          forks > 0 ? "the release that forked" : "the split of"
        } ${escapeHtml(entry.parentLineId)} at ⟨${escapeHtml(
          frameLabel(entry.frame),
        )}⟩ (${
          count === 1
            ? // Nothing left to join up — a merge took the siblings, or an
              // expired one did and they can never come back. "1 line → 1"
              // then read as a button that does nothing, when what it does is
              // put the line back on this frame and discard the branch it
              // played. Describe THAT instead of counting to one twice.
              "1 line, back to this frame"
            : // …and back into as many parents as the release had forks, which
              // for a track group's release is more than one.
              `${count} lines → ${forks + 1}`
        })${
          forks > 0
            ? ` + ${forks} other fork${forks === 1 ? "" : "s"} from the same release`
            : ""
        }${cascadeLabel(entry.cascade)}</button>`;
      } else if (entry.reason === "expired") {
        // The fork counterpart of the merge menu's expired note. Nothing
        // expires a fork at runtime; the uid migration on load does, when a
        // saved room's records cannot be tied back to its lines — and until
        // now that node simply offered an empty menu.
        html +=
          `<div class="menu-note">split rewind unavailable — ` +
          `this room's saved state does not say which lines that fork ` +
          `produced, so it can no longer be collapsed</div>`;
      } else if (entry.reason === "mixed-merge") {
        // Only printed when the block is FINAL: while the crossing merge is
        // still active the undo takes it off on the way, so the entry above is
        // a button instead.
        html +=
          `<div class="menu-note">split rewind unavailable — ` +
          `a later merge mixed this branch with another split subtree, ` +
          `and that merge can no longer be undone</div>`;
      } else if (entry.reason) {
        // Every OTHER refusal used to render nothing at all, so a split frame
        // whose undo had become impossible offered an empty menu that said why
        // it was empty — indistinguishable from a bug. Naming the reason is
        // worth more than hiding it — in the operator's own words where there
        // are any (the same table the refusal alert reads, so the note and the
        // alert it saves say the same thing), raw otherwise, which still beats
        // silence.
        html +=
          `<div class="menu-note">split rewind unavailable — ` +
          `${escapeHtml(REWIND_REFUSALS[entry.reason] || entry.reason)}</div>`;
      }
    }
    return html;
  }

  function mergeRewindHtml(frameName) {
    let html = "";
    let expiredHere = false;
    let supersededBy = null;
    for (const entry of lastMergeRewinds || []) {
      if (lc(entry.frame || "") !== lc(frameName)) continue;
      // Lines arriving apart merge in pairs, so one convergence is several
      // events. The server undoes the passage whole, so its newest event is the
      // only entry the menu shows — and the older ones must not raise the
      // "undo the later merge first" note about a merge on this very frame.
      if (entry.partOfConvergence) continue;
      if (entry.available) {
        // Named as the numbers the REJOIN recorded, which is what "merged here
        // as L0, L1, L2" says and all it says: an absorbed line's number goes
        // into the pool at the merge, so a fork since — related or not — can
        // be holding it, and the undo then re-creates the route on the lowest
        // free one (`freeLineId`). The confirm's landings name the same
        // recorded numbers, so the same caveat covers both: unwinding this
        // passage frees the numbers its own cascade took, but a fork on an
        // unrelated population is not in that cascade and keeps the one it
        // holds. Rare, and the ROUTES are exact either way — it is only the
        // label that can shift.
        const ids = entry.restoredLineIds || [];
        html += `<button type="button" data-merge-event="${escapeHtml(
          entry.eventId,
        )}" data-merge-frame="${escapeHtml(
          entry.frame,
        )}" data-merge-lines="${escapeHtml(
          ids.join(","),
        )}">⏪⏪ undo the merge at ⟨${escapeHtml(
          frameLabel(entry.frame),
        )}⟩ (1 → ${ids.length} line${
          ids.length === 1 ? "" : "s"
        }, merged here as ${escapeHtml(
          ids.join(", "),
        )})${cascadeLabel(entry.cascade)}</button>`;
      } else if (entry.reason === "expired") {
        expiredHere = true;
      } else if (entry.reason === "superseded") {
        // Only worth saying when the merge to undo first is somewhere else —
        // a convergence that merged in pairs puts both events on this frame,
        // and the available one is already on the menu above.
        if (lc(entry.supersededByFrame || "") !== lc(frameName)) {
          supersededBy = entry.supersededByFrame;
        }
      }
    }
    // One note for the frame, and only when nothing here is still undoable —
    // which no longer includes "something newer is in the way": the undo takes
    // that off itself.
    if (!html && supersededBy) {
      html +=
        `<div class="menu-note">merge rewind unavailable — ` +
        `the later merge at ⟨${escapeHtml(frameLabel(supersededBy))}⟩ ` +
        `cannot be undone either</div>`;
    } else if (!html && expiredHere) {
      html +=
        `<div class="menu-note">merge rewind unavailable — ` +
        `the saved state does not say which lines this rejoin swallowed</div>`;
    }
    return html;
  }

  // What this node's menu says, as a pure function of the node and the latest
  // snapshot — so a push can ask "does the open menu still read the same?"
  // without disturbing the one on screen (`refreshOpenMenu`).
  function nodeMenuHtml(node) {
    const label = node.data("label");
    const id = node.id();
    const isMain = id.startsWith("main:");
    const frameName = isMain ? id.slice("main:".length) : null;
    const subMatch = isMain ? null : /^sub:([^:]+):(.*)$/.exec(id);

    let html = `<div class="menu-title">${escapeHtml(label)}</div>`;
    if (!vanillaMode) {
      // The live stall comes first: an advance acts on the room as it stands
      // now, the rewinds below it act on what already happened. Kept in a
      // variable because the rewind sections' "nothing here" notes must not
      // contradict entries these already put on the menu.
      const liveHtml =
        advanceButtonsHtml(id) +
        // Same "live stall first" reasoning, for the stall a barrier cannot
        // see: a line sitting inside a sub-score with no way back out.
        subValveButtonsHtml(id);
      html += liveHtml;
      // Session-lines rooms: room checkpoint, explicit line, and structural
      // split rewinds. The implicit bound-line rewind stays retired.
      if (isMain) {
        // Both structural undos, split and merge, live on the frame the
        // event happened at — which is where the operator goes looking.
        const structuralHtml =
          splitRewindHtml(frameName) + mergeRewindHtml(frameName);
        html += structuralHtml;
        const group = groupForMainFrame(frameName);
        const roomCheckpoint = group && roomCheckpointFor(group);
        if (roomCheckpoint) {
          // Every line already standing in this group ⇒ the rewind would put
          // the room exactly where it is. The per-line entries have always
          // marked their own trail-end that way — "current position",
          // disabled — while the ROOM entry offered a live button for the same
          // no-op, on the one gesture that repositions every line in the room.
          // A line inside a sub is not standing in the group, so
          // `!l.sub` keeps the real button on offer for it.
          const roomHere =
            (lastLines || []).length > 0 &&
            (lastLines || []).every(
              (l) =>
                l &&
                !l.sub &&
                lc(groupForMainFrame(l.frame) || "") ===
                  lc(roomCheckpoint.group),
            );
          html += roomHere
            ? `<button type="button" disabled>room is at ⟨${escapeHtml(
                roomCheckpoint.group,
              )}⟩ — current position</button>`
            : `<button type="button" data-room-group="${escapeHtml(
                roomCheckpoint.group,
              )}">⏪⏪ rewind ROOM to ⟨${escapeHtml(
                roomCheckpoint.group,
              )}⟩</button>`;
        }
        // On the node a whole convergence lands back on, every per-line and
        // ghost entry is the SAME undo — one entry instead of three identical
        // ones (`collapsedMergeLandingHtml`, which returns "" the moment
        // anything here is a real rewind of its own).
        const collapsed = collapsedMergeLandingHtml(frameName);
        // Main-flow lines here; an in-sub line's main trail is offered by
        // subTrailRewindButtonsHtml below, whose entries pull it out of the sub
        // on the way — which is the whole point of them.
        const lineButtons = collapsed
          ? ""
          : lineRewindButtonsHtml(
              (lastLines || []).filter((l) => !l.sub),
              frameName,
            );
        html += collapsed + lineButtons;
        // …and the lines a still-undoable merge swallowed, whose ghost route
        // runs through here. They come back out of the merge on the way.
        const ghostButtons = collapsed
          ? ""
          : absorbedRewindButtonsHtml(frameName, null);
        html += ghostButtons;
        const rollbacks = subTrailRewindButtonsHtml(frameName);
        html += rollbacks;
        // …and the landings of an OLDER passage, whose routes the canvas no
        // longer paints. Last, and only when nothing above has claimed this
        // node: everything above belongs to the newest passage, which already
        // offers the same undo through its own ghosts.
        const remote =
          structuralHtml || collapsed || lineButtons || ghostButtons || rollbacks
            ? ""
            : remoteMergeLandingHtml(frameName);
        html += remote;
        if (
          !structuralHtml &&
          !roomCheckpoint &&
          !collapsed &&
          !lineButtons &&
          !ghostButtons &&
          !rollbacks &&
          !remote &&
          !liveHtml
        ) {
          // Same rule as the sub branch below: this note speaks for the rewind
          // sections only, and only when nothing else made the menu. A line
          // STANDING here has a trail through the frame — its trail-end entry
          // is just not a rewind target — so say that rather than denying the
          // line the operator can see on the node.
          //
          // And it speaks about TRAILS, not about history: a split truncates
          // the trail it forks from (§6), so after a fork the frames the room
          // walked before it carry no line's trail at all. "No line trail
          // through here" told the operator who watched three lines walk into
          // this very frame that nothing had — the undo is simply reached from
          // the rejoin node instead.
          const standingHere = (lastLines || []).some(
            (l) => !l.sub && lc(l.frame || "") === lc(frameName),
          );
          html += `<div class="menu-note">${
            group
              ? "not a room checkpoint yet — some line hasn't passed this group"
              : standingHere
                ? "only a line's current position here — no rewind"
                : "no line's current trail reaches here — no rewind"
          }</div>`;
        }
      } else if (subMatch) {
        // Sub frame: rewindable for lines CURRENTLY inside this sub whose
        // dive trail passed here (each dive's trail is dropped on exit, so
        // only the current dive is rewindable).
        const inThisSub = (lastLines || []).filter(
          (l) => l.sub && lc(l.sub) === lc(subMatch[1]),
        );
        const lineButtons = lineRewindButtonsHtml(inThisSub, subMatch[2]);
        html += lineButtons;
        // A line absorbed mid-DIVE keeps the sub's trail, so its ghost entries
        // belong on this sub's frames.
        const ghostButtons = absorbedRewindButtonsHtml(
          subMatch[2],
          subMatch[1],
        );
        html += ghostButtons;
        // The note is the REWIND section's, so it may only speak for that
        // section — and only when the menu is otherwise empty. On the frame a
        // diver is standing on it used to print "no line mid-dive here" under
        // that very line's advance/eject/rollback entries: the trail-END
        // occurrence is the line's current position and is deliberately not
        // offered (history is an undo trail, not teleport, §8), so this
        // section is legitimately empty while the ones above it are full.
        if (!lineButtons && !ghostButtons && !liveHtml) {
          html += `<div class="menu-note">${
            inThisSub.length
              ? "no earlier step of this dive here — no rewind"
              : "no line mid-dive here — no rewind"
          }</div>`;
        }
      }
    } else if (!isMain) {
      html += `<div class="menu-note">sub-score frame — no rewind</div>`;
    } else {
      // Vanilla: one shared playhead, so a per-step rewind IS a room rewind.
      const { history, selectedIdx } = historyState;
      const occurrences = [];
      history.forEach((name, i) => {
        if (name === frameName) occurrences.push(i);
      });
      if (occurrences.length === 0) {
        html += `<div class="menu-note">not visited — no rewind</div>`;
      }
      for (const i of occurrences) {
        const current = i === selectedIdx;
        const suffix =
          occurrences.length > 1 ? ` (visit ${occurrences.indexOf(i) + 1})` : "";
        html += `<button type="button" data-idx="${i}" ${
          current ? "disabled" : ""
        }>${current ? "current position" : `⏪ rewind here${suffix}`}</button>`;
      }
    }
    return html;
  }

  function showNodeMenu(node, clientX, clientY) {
    const menu = ensureMenu();
    const label = node.data("label");
    const html = nodeMenuHtml(node);
    menu.innerHTML = html;
    // Remembered verbatim: the next push compares against it, and any
    // difference — a new entry, a vanished one, a changed cascade count —
    // means this menu is describing a room that has moved on.
    openMenu = { nodeId: node.id(), html };
    for (const btn of menu.querySelectorAll("button[data-split-event]")) {
      btn.addEventListener("click", () =>
        requestSplitRewind(
          btn.dataset.splitEvent,
          btn.dataset.splitFrame,
          btn.dataset.splitParent,
          parseInt(btn.dataset.splitCount, 10),
        ),
      );
    }
    for (const btn of menu.querySelectorAll("button[data-merge-event]")) {
      btn.addEventListener("click", () =>
        requestMergeRewind(
          btn.dataset.mergeEvent,
          btn.dataset.mergeFrame,
          (btn.dataset.mergeLines || "").split(",").filter(Boolean),
          // Set only by the entries reached from a LANDING node, whose label
          // promises the lines come back "here" — the question then opens in
          // the same words (`requestMergeRewind`).
          btn.dataset.mergeHere || null,
        ),
      );
    }
    for (const btn of menu.querySelectorAll("button[data-advance-line]")) {
      btn.addEventListener("click", () =>
        confirmAdvanceLine(btn.dataset.advanceLine, btn.dataset.advanceFrame, {
          label: btn.dataset.advanceLabel,
          atDestination: btn.dataset.advanceHold === "1",
        }),
      );
    }
    for (const btn of menu.querySelectorAll("button[data-eject-line]")) {
      btn.addEventListener("click", () =>
        confirmEjectLine(
          btn.dataset.ejectLine,
          btn.dataset.ejectSub,
          btn.dataset.ejectLabel,
        ),
      );
    }
    for (const btn of menu.querySelectorAll("button[data-unsub-line]")) {
      btn.addEventListener("click", () =>
        confirmRewindOutOfSub(
          btn.dataset.unsubLine,
          btn.dataset.unsubSub,
          btn.dataset.unsubFrame,
          btn.dataset.unsubIdx == null
            ? null
            : parseInt(btn.dataset.unsubIdx, 10),
        ),
      );
    }
    for (const btn of menu.querySelectorAll("button[data-room-group]")) {
      btn.addEventListener("click", () => requestRoomRewind(btn.dataset.roomGroup));
    }
    for (const btn of menu.querySelectorAll("button[data-line-id]")) {
      btn.addEventListener("click", () =>
        requestLineRewind(
          btn.dataset.lineId,
          parseInt(btn.dataset.idx, 10),
          btn.dataset.frame,
          label,
        ),
      );
    }
    for (const btn of menu.querySelectorAll("button[data-absorbed-line]")) {
      btn.addEventListener("click", () =>
        requestAbsorbedRewind(
          btn.dataset.absorbedLine,
          parseInt(btn.dataset.idx, 10),
          btn.dataset.frame,
          label,
          // The passage this button was built for. A number is not enough to
          // find it again: absorbed numbers go back in the pool at the rejoin,
          // so two still-undoable merges can each have swallowed an "L3", and
          // resolving by number alone picked whichever came first — undoing a
          // rejoin at a frame the button did not name.
          btn.dataset.absorbedEvent,
        ),
      );
    }
    // Vanilla per-step entries only (both line-targeted button kinds carry
    // data-idx too, and must not also fire the room's single-playhead rewind).
    for (const btn of menu.querySelectorAll(
      "button[data-idx]:not([data-line-id]):not([data-absorbed-line])",
    )) {
      btn.addEventListener("click", () =>
        requestRewind(parseInt(btn.dataset.idx, 10), label),
      );
    }

    // "flex", not "block": the stylesheet's column layout must survive this
    // inline override, or the entries render side by side on one line.
    menu.style.display = "flex";
    // Clamp inside the viewport (menu must be visible to measure). Both ends
    // matter: on a phone-width screen a menu can be WIDER or TALLER than the
    // viewport, and then the right/bottom clamp alone put it at a negative
    // offset — the entries scrolled off the top-left corner with no way back.
    // The CSS caps its size against the viewport; this keeps its origin on
    // screen so what does not fit is reachable by scrolling the menu itself.
    const rect = menu.getBoundingClientRect();
    const maxLeft = Math.max(4, window.innerWidth - rect.width - 4);
    const maxTop = Math.max(4, window.innerHeight - rect.height - 4);
    menu.style.left = `${Math.max(4, Math.min(clientX, maxLeft))}px`;
    menu.style.top = `${Math.max(4, Math.min(clientY, maxTop))}px`;
  }

  function wireNodeMenu(container) {
    // Cytoscape's `tap` covers an ordinary primary-button click and a touch
    // tap. Right-click and tap-hold retain their normal browser behavior.
    cy.on("tap", "node", (evt) => {
      const node = evt.target;
      if (node.isParent()) return; // sub boxes have no actions
      const box = container.getBoundingClientRect();
      const pos = evt.renderedPosition || { x: 0, y: 0 };
      showNodeMenu(node, box.left + pos.x, box.top + pos.y);
    });
    cy.on("tap", (evt) => {
      if (evt.target === cy) hideMenu();
    });
    cy.on("pan zoom", hideMenu);
  }

  // Ask for the heavy structural bodies behind an announced topology version.
  // Cheap to call on every push: it sends nothing while the version already in
  // hand matches, and nothing while a request for that same version is still
  // in flight. The in-flight mark ages out, so a reply lost to a reconnect or
  // a restart is re-asked for on the next push rather than leaving the menus
  // built on a topology the room has moved past.
  const STRUCTURAL_RETRY_MS = 5000;
  function requestStructuralDetails(version) {
    if (!version) return; // vanilla score: no structural topology to describe
    if (version === structuralVersion) return;
    if (
      structuralRequested &&
      structuralRequested.version === version &&
      Date.now() - structuralRequested.at < STRUCTURAL_RETRY_MS
    ) {
      return;
    }
    structuralRequested = { version, at: Date.now() };
    sendToServer(MSG_NEED_DISPLAY, { structuralDetails: true });
  }

  // Minimal ws-client parseMessage contract for this page: MSG_PING time
  // calibration (mirrors session.js, incl. the shared ws-client globals), then
  // MSG_NEED_DISPLAY whose reply chain includes the admin lines snapshot.
  window.parseMessage = function parseMessage(data) {
    const msg = data.m;
    if (msg === MSG_PING) {
      const { serverTime, clientTime } = data;
      const ping = Date.now() - clientTime;
      timeStampOffset +=
        (serverTime + ping / 2.0 - Date.now() - timeStampOffset) *
        timeStampRate;
      if (pingCountToReady > 0) {
        pingCountToReady--;
        sendToServer(MSG_PING, { clientTime: Date.now() });
        return;
      }
      if (pingCountToReady === 0) {
        pingCountToReady--;
        timeStampRate = 0.1;
        isReady = true;
        pingTimer = setInterval(pingCallback, 1000 * 60);
        sendToServer(MSG_NEED_DISPLAY);
      }
      return;
    }
    if (msg === MSG_SHOW) {
      // Track the playhead like the session page does (cid rides on outgoing
      // messages); in vanilla mode this IS the single line's position.
      window.currentIndex = data.showIdx;
      if (vanillaMode) {
        vanillaState.idx = data.showIdx;
        vanillaState.voting = false; // an advance means the window resolved
        renderVanilla();
      }
      return;
    }
    // Vanilla only: the room's voting/holding phases, timed out client-side at
    // endTime (server time) since no "ended" message exists. In session-lines
    // mode these are per-line messages for the map's own bound line — ignored;
    // the `lines` payload carries every line's flags instead.
    if (msg === MSG_BEGIN_VOTING || msg === MSG_BEGIN_HOLDING) {
      if (!vanillaMode) return;
      const remaining = data.endTime - getServerTime();
      const active = remaining > 0;
      vanillaState.voting = msg === MSG_BEGIN_VOTING && active;
      vanillaState.holding = msg === MSG_BEGIN_HOLDING && active;
      clearTimeout(vanillaPhaseTimer);
      if (active) {
        vanillaPhaseTimer = setTimeout(() => {
          vanillaState.voting = false;
          vanillaState.holding = false;
          renderVanilla();
        }, remaining);
      }
      renderVanilla();
      return;
    }
    // A rewind this map asked for did not happen. Every one of them can be
    // refused — the room moves while a menu sits open — and the operator has
    // just answered a confirm() promising a topology change, so silence reads
    // as a broken app. The lines payload follows this message, so the menu the
    // click came from is already being rebuilt behind the alert.
    if (msg === window.MSG_REWIND_REFUSED) {
      // Only this tab own gesture clears the sentence it is holding: a refusal
      // of somebody else click must not swallow the receipt this operator is
      // still waiting for. A refusal with no id at all (an older server) is
      // taken as ours, which is what the previous behaviour was.
      if (
        !data.operationId ||
        (pendingRewind && pendingRewind.operationId === data.operationId)
      ) {
        pendingRewind = null;
      }
      // The in-page panel rather than alert(): same interruption, but the
      // canvas behind it keeps drawing the room the operator is about to look
      // at, and the reason gets a line of its own instead of being run together
      // with what did or did not move.
      mapAlert(refusalTitle(data), refusalBody(data));
      return;
    }
    // …and the same rewind when it DID happen. A successful structural undo
    // re-creates lines, moves every device onto a different one and discards
    // everything the room played since, and until now said nothing at all:
    // the operator answered a confirm and got a redrawn canvas to infer from.
    // The sentence shown back is the one the confirm promised, held here since
    // the click; `rewindEntry` is the canonical receipt shared by the log.
    if (msg === window.MSG_REWIND_DONE) {
      // Correlated on the operation id alone. Kind + frame describe the EVENT,
      // and two operators can undo at the same frame within a second of each
      // other — so that pair matched another tab gesture and showed its
      // sentence back as this one.
      const mine =
        pendingRewind && !!data.operationId &&
        pendingRewind.operationId === data.operationId;
      // The receipt reaches every operator tab now, not only the one that
      // clicked. Only the clicking tab holds the sentence its own confirm
      // promised — the others watched the canvas rearrange and got no account
      // of why at all, so they compose the plainer one from what the server
      // sends.
      showToast(
        (mine ? pendingRewind.text : othersRewindText(data)) +
          emptiedClause(data.emptied),
        data.rewindEntry,
      );
      if (mine) pendingRewind = null;
      return;
    }
    if (msg === MSG_SHOW_NUMBER_CONNECTION) {
      if (Array.isArray(data.rewindLog)) {
        syncRewindLog(data.rewindLog);
      }
      // The answer to this page own detail request: the heavy half of the
      // structural projection, carrying no lines[] of its own. Redraw off the
      // snapshot already in hand rather than waiting for the next push, or the
      // ghosts and undo buttons of a passage that just happened would not
      // appear until the room moved again.
      if (data.structuralDetails) {
        lastSplitRewinds = Array.isArray(data.splitRewinds)
          ? data.splitRewinds
          : [];
        lastMergeRewinds = Array.isArray(data.mergeRewinds)
          ? data.mergeRewinds
          : [];
        lastAbsorbedLines = Array.isArray(data.absorbedLines)
          ? data.absorbedLines
          : [];
        structuralVersion = data.structuralVersion || null;
        structuralRequested = null;
        if (Array.isArray(lastLines)) updateLines(lastLines);
        return;
      }
      if (Array.isArray(data.lines)) {
        lastRoomCheckpoints = Array.isArray(data.roomCheckpoints)
          ? data.roomCheckpoints
          : [];
        requestStructuralDetails(data.structuralVersion);
        updateLines(data.lines);
      } else if (vanillaMode) {
        vanillaState.players = data.playerCount || 0;
        vanillaState.riders = data.riderCount || 0;
        renderVanilla();
      }
      return;
    }
    // Only the admin-flagged variant matters here: the map is bound to a line
    // like any other connection, but it is an observation tool — a banner for
    // "its" line would be meaningless. The barrier LIST drives the valves.
    if (msg === MSG_BARRIER_WAITING) {
      if (data.admin) {
        lastBarriers = data.barriers || [];
        renderBarrierPanel();
        // The node menu's "advance this line" valves read the barrier list too.
        refreshOpenMenu();
      }
      return;
    }
    if (msg === MSG_SELECT_HISTORY) {
      // `data.available` is ignored here: the map's session-lines menu no
      // longer offers per-line rewind, and vanilla pushes carry no flag.
      historyState = {
        history: data.history || [],
        selectedIdx: data.selectedIdx ?? -1,
      };
      renderHistory();
      return;
    }
    // The score under the map just changed, or the operator asked every
    // device to reload: the session manager broadcasts MSG_CHANGE_FOLDER when
    // "Update session" swaps the folder (and when a session is stopped), and
    // the session page's "global refresh" button broadcasts
    // MSG_GLOBAL_REFRESH. Everything here is derived from the score — the
    // graph fetch, the title, the saved arrangement — so reload the page the
    // way the session page does instead of patching the pieces.
    //
    // window.-qualified on purpose: this file is served straight from disk
    // while routes/session.js (which builds the constants blob) lives in the
    // running process, so a not-yet-restarted server sends a blob without
    // these two. A bare identifier would throw ReferenceError and take every
    // other message down with it; an undefined comparison just never matches.
    if (msg === window.MSG_CHANGE_FOLDER || msg === window.MSG_GLOBAL_REFRESH) {
      window.location.reload();
      return;
    }
    // Everything else (SHOW/voting/… addressed to this connection's line) is
    // irrelevant to the map.
  };

  async function init() {
    const container = document.getElementById("session-map-canvas");
    if (!container) {
      return; // not the map page
    }
    const back = document.getElementById("session-map-back");
    if (back) {
      back.href = `/session/${window.sessionId}/?p=${encodeURIComponent(
        window.staffCode || "",
      )}&t=1`;
    }
    try {
      // Right after a server (re)start the graph is re-derived asynchronously,
      // so a 404 may just mean "still building" — retry before concluding the
      // score has no session lines.
      let res = null;
      for (let attempt = 0; attempt < 15; attempt++) {
        res = await fetch(`/session/${window.sessionId}/graph`);
        if (res.ok) break;
        setStatus(`score still building — retrying… (${attempt + 1})`);
        await new Promise((r) => setTimeout(r, 2000));
      }
      if (!res.ok) {
        setStatus("this score has no session-lines graph");
        return;
      }
      const data = await res.json();
      graphData = data;
      vanillaMode = !data.main.hasSessionLines;
      mainFrames = data.main.frames || [];
      for (const src of CDN_SCRIPTS) {
        try {
          await loadScript(src);
        } catch (e) {
          // dagre / cytoscape-dagre are optional (breadthfirst fallback);
          // cytoscape itself is not.
          if (src.includes("/cytoscape@")) throw e;
          console.warn("session-map: optional layout lib failed", e);
        }
      }
      render(container, graphElements(data));
      if (pendingLines) {
        updateLines(pendingLines);
        pendingLines = null;
      }
      renderVanilla(); // position/counts may have arrived before the graph
      setStatus("connecting…");
      connectWebSocket();
      document.addEventListener("visibilitychange", onVisibilityChange);
      window.addEventListener("pagehide", onPageHide);
      window.addEventListener("pageshow", onPageShow);
    } catch (e) {
      console.error("session-map init failed", e);
      setStatus("map failed to load (see console)");
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
