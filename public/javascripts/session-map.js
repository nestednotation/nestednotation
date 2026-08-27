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

  // Currently-waiting barriers (admin-flagged MSG_BARRIER_WAITING) — the same
  // payload the session page's admin panel consumes, so the map offers the same
  // operator valves without a trip back to the session tab.
  let lastBarriers = [];

  // History of the line this admin connection is assigned to, as pushed via
  // MSG_SELECT_HISTORY. VANILLA MODE ONLY: it drives the per-step rewind menu
  // (click / tap a visited node → "rewind here" {selectedIdx} —
  // legitimate there, the single playhead IS the room) and paints the overlay
  // before the first lines push. In session-lines mode the implicit bound-line
  // rewind is retired (2026-07-19): the menu offers room-wide track-group,
  // explicit line-targeted, and structural split rewinds.
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
    });
    renderHistory(); // trails/checkpoints ride on the same payload
    const active = lines.filter((l) => l.status === "active").length;
    const players = lines.reduce((n, l) => n + (l.players || 0), 0);
    const riders = lines.reduce((n, l) => n + (l.riders || 0), 0);
    setStatus(
      `${lines.length} lines (${active} active) · ${players} players` +
        (riders ? ` · ${riders} riders` : ""),
    );
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

  function renderBarrierPanel() {
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
    for (const b of barriers) {
      const parked = (b.parked || []).join(",") || "none";
      const stragglers = b.stragglers || [];

      const info = document.createElement("span");
      info.className = "map-barrier-info";
      // "group:<name>" entries are track-group arrival waits; anything else is
      // a hold-until frame. Shown as authored either way.
      info.textContent =
        `${frameLabel(b.frame)} [parked: ${parked}]` +
        (stragglers.length ? ` [waiting on: ${stragglers.join(",")}]` : "") +
        " ";

      const release = document.createElement("button");
      release.type = "button";
      release.title = "let this barrier go without the lines it is waiting for";
      release.textContent = "release";
      release.addEventListener("click", () => sendBarrierCommand(b.frame));
      info.appendChild(release);

      if (stragglers.length) {
        anyStragglers = true;
        const advance = document.createElement("button");
        advance.type = "button";
        advance.title = "move the waited-for lines onto this group instead";
        advance.textContent = "force advance";
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
  // the bring-them-in resolution over the let-it-go one.
  function sendBarrierCommand(frame, advance) {
    const payload = frame ? { frame } : {};
    if (advance) payload.advance = true;
    sendToServer(MSG_BARRIER_RELEASED, payload);
  }

  // Confirmed, unlike release: this MOVES performers' devices to another frame.
  function confirmAdvanceStragglers(lineIds, frame) {
    const ids = lineIds || [];
    const where = frame
      ? `⟨${frameLabel(frame).replace(/^group:/, "")}⟩`
      : "their waiting groups";
    const ok = confirm(
      `Force ${ids.length} straggler line${ids.length === 1 ? "" : "s"} ` +
        `(${ids.join(", ") || "none"}) onto ${where}? ` +
        `Those lines jump to the group from wherever they are now.`,
    );
    if (!ok) return;
    sendBarrierCommand(frame, true);
  }

  // ── History overlay + rewind node menu ─────────────────────────────────────

  function latestGroupTrailOccurrence(trail, groupFrames) {
    const set = new Set((groupFrames || []).map(lc));
    if (set.size === 0 || !Array.isArray(trail)) return null;
    for (let i = trail.length - 1; i >= 0; i--) {
      const frame = trail[i];
      if (set.has(lc(frame))) return { index: i, frame };
    }
    return null;
  }

  function commonCheckpointsForMap() {
    const groups = (graphData && graphData.main && graphData.main.groups) || {};
    const checkpointLines = (lastLines || [])
      .filter((l) => (l.players || 0) + (l.riders || 0) > 0)
      .map((l) => ({
        id: l.id,
        trail: Array.isArray(l.mainTrail) ? l.mainTrail : l.trail || [],
      }));
    if (checkpointLines.length === 0) return [];

    const checkpoints = [];
    for (const [group, frames] of Object.entries(groups)) {
      if (!Array.isArray(frames) || frames.length === 0) continue;
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
      if (ok) {
        checkpoints.push({
          group,
          byLine,
          order: Math.min(...indices),
          sum: indices.reduce((n, i) => n + i, 0),
          max: Math.max(...indices),
        });
      }
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
      cy.nodes().removeClass("visited visited-ahead checkpoint");
      // Session Lines: paint EVERY line's trail + checkpoint from the lines[]
      // payload (visited = union over lines; a checkpoint halo per line, which
      // normally sits on its `here` node since a landing always moves the
      // history pointer to the end). A line inside a sub carries its sub trail
      // — same prefix rule as its position, resolving into the sub box.
      if (!vanillaMode && Array.isArray(lastLines)) {
        for (const l of lastLines) {
          const prefix = l.sub ? `sub:${l.sub}:` : "main:";
          for (const name of l.trail || []) {
            const node = cy.getElementById(`${prefix}${name}`);
            if (!node.empty()) node.addClass("visited");
          }
          if (l.checkpoint) {
            const node = cy.getElementById(`${prefix}${l.checkpoint}`);
            if (!node.empty()) node.addClass("checkpoint");
          }
        }
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
  }

  // Vanilla mode only — a session-lines room rewinds room-wide by checkpoint.
  function requestRewind(idx, label) {
    hideMenu();
    const ok = confirm(`Rewind the session to "${label}" (step ${idx + 1})?`);
    if (!ok) return;
    sendToServer(MSG_SELECT_HISTORY, { selectedIdx: idx });
    // The server answers with fresh MSG_SELECT_HISTORY + positions pushes,
    // which redraw the overlay — nothing to do locally.
  }

  function requestRoomRewind(group) {
    hideMenu();
    const ok = confirm(
      `Rewind the room to checkpoint ⟨${group}⟩? ` +
        `Every line moves to its own frame in that group.`,
    );
    if (!ok) return;
    sendToServer(MSG_SELECT_HISTORY, { group });
  }

  function requestSplitRewind(eventId, frame, parentLineId, descendantCount) {
    hideMenu();
    const ok = confirm(
      `Undo the split at "${frameLabel(frame)}"? ` +
        `${descendantCount} descendant line${descendantCount === 1 ? "" : "s"} ` +
        `will collapse back into ${parentLineId}. ` +
        `All progress after this split will be discarded.`,
    );
    if (!ok) return;
    // Both values are a race guard: a stale menu cannot undo a later visit to
    // the same split frame.
    sendToServer(MSG_SELECT_HISTORY, { splitEventId: eventId, frame });
  }

  // Session-lines: targeted rewind of one named line within its own trail
  // (2026-07-19). `frame` is the server's race guard — refused if the line
  // moved (or left its sub) since this menu was built.
  function requestLineRewind(lineId, idx, frame, label) {
    hideMenu();
    const ok = confirm(
      `Rewind line ${lineId} to "${label}" (step ${idx + 1})? ` +
        `Only this line moves; the rest of the room is unaffected.`,
    );
    if (!ok) return;
    sendToServer(MSG_SELECT_HISTORY, { lineId, selectedIdx: idx, frame });
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
        html += `<button type="button" data-line-id="${escapeHtml(
          l.id,
        )}" data-idx="${i}" data-frame="${escapeHtml(
          trail[i],
        )}">⏪ rewind ${escapeHtml(l.id)} here${suffix}</button>`;
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
        html += `<button type="button" data-split-event="${escapeHtml(
          entry.eventId,
        )}" data-split-frame="${escapeHtml(
          entry.frame,
        )}" data-split-parent="${escapeHtml(
          entry.parentLineId,
        )}" data-split-count="${count}">⏪⏪ undo split ${escapeHtml(
          entry.parentLineId,
        )} here (${count} line${count === 1 ? "" : "s"} → 1)</button>`;
      } else if (entry.reason === "mixed-merge") {
        html +=
          `<div class="menu-note">split rewind unavailable — ` +
          `a later merge mixed this branch with another split subtree</div>`;
      }
    }
    return html;
  }

  function showNodeMenu(node, clientX, clientY) {
    const menu = ensureMenu();
    const label = node.data("label");
    const id = node.id();
    const isMain = id.startsWith("main:");
    const frameName = isMain ? id.slice("main:".length) : null;
    const subMatch = isMain ? null : /^sub:([^:]+):(.*)$/.exec(id);

    let html = `<div class="menu-title">${escapeHtml(label)}</div>`;
    if (!vanillaMode) {
      // Session-lines rooms (2026-07-19): room checkpoint, explicit line, and
      // structural split rewinds. The implicit bound-line rewind stays retired.
      if (isMain) {
        const splitHtml = splitRewindHtml(frameName);
        html += splitHtml;
        const group = groupForMainFrame(frameName);
        const roomCheckpoint =
          group &&
          commonCheckpointsForMap().find(
            (checkpoint) => lc(checkpoint.group) === lc(group),
          );
        if (roomCheckpoint) {
          html += `<button type="button" data-room-group="${escapeHtml(
            roomCheckpoint.group,
          )}">⏪⏪ rewind ROOM to ⟨${escapeHtml(roomCheckpoint.group)}⟩</button>`;
        }
        // Main-flow lines only: an in-sub line's main trail can't rewind
        // without pulling it out of its sub (out of scope — the room rewind
        // force-exits subs when that's needed).
        const lineButtons = lineRewindButtonsHtml(
          (lastLines || []).filter((l) => !l.sub),
          frameName,
        );
        html += lineButtons;
        if (!splitHtml && !roomCheckpoint && !lineButtons) {
          html += `<div class="menu-note">${
            group
              ? "not a room checkpoint yet — some line hasn't passed this group"
              : "no line trail through here — no rewind"
          }</div>`;
        }
      } else if (subMatch) {
        // Sub frame: rewindable for lines CURRENTLY inside this sub whose
        // dive trail passed here (each dive's trail is dropped on exit, so
        // only the current dive is rewindable).
        const lineButtons = lineRewindButtonsHtml(
          (lastLines || []).filter((l) => l.sub && lc(l.sub) === lc(subMatch[1])),
          subMatch[2],
        );
        html +=
          lineButtons ||
          `<div class="menu-note">no line mid-dive here — no rewind</div>`;
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
    menu.innerHTML = html;
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
    // Vanilla per-step entries only (line-targeted buttons carry data-idx too).
    for (const btn of menu.querySelectorAll(
      "button[data-idx]:not([data-line-id])",
    )) {
      btn.addEventListener("click", () =>
        requestRewind(parseInt(btn.dataset.idx, 10), label),
      );
    }

    // "flex", not "block": the stylesheet's column layout must survive this
    // inline override, or the entries render side by side on one line.
    menu.style.display = "flex";
    // Clamp inside the viewport (menu must be visible to measure).
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(clientX, window.innerWidth - rect.width - 4)}px`;
    menu.style.top = `${Math.min(clientY, window.innerHeight - rect.height - 4)}px`;
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
    if (msg === MSG_SHOW_NUMBER_CONNECTION) {
      if (Array.isArray(data.lines)) {
        lastSplitRewinds = Array.isArray(data.splitRewinds)
          ? data.splitRewinds
          : [];
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
