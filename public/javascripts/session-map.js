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

  // History of the line this admin connection is assigned to, as pushed via
  // MSG_SELECT_HISTORY. VANILLA MODE ONLY: it drives the per-step rewind menu
  // (right-click / tap-hold a visited node → "rewind here" {selectedIdx} —
  // legitimate there, the single playhead IS the room) and paints the overlay
  // before the first lines push. In session-lines mode the implicit bound-line
  // rewind is retired (2026-07-19): the menu offers the room-wide track-group
  // checkpoint rewind plus EXPLICIT line-targeted rewinds ({lineId}), both
  // built from the lines[] payload — which also drives the overlay.
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
        if ((graph.subStart || {})[name]) classes.push("substart");
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
        const isSubStart = !!(graph.subStart || {})[name];
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
          // A sub-start's href is walked only AFTER the sub (dive → …sub… →
          // return); dot it so the real path through the sub reads clearly.
          if (isSubStart) classes.push("via-sub");
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

    // Dive / return edges around each sub-start frame.
    for (const [name, info] of Object.entries(main.subStart || {})) {
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

    // Barrier "waits for" edges (targets may be sub-qualified "score/frame").
    for (const [name, targets] of Object.entries(main.holdUntilTargets || {})) {
      for (const t of targets) {
        const targetId = resolveRefToNodeId(t, main, subs || {});
        if (targetId) edge(`main:${name}`, targetId, "waits");
      }
    }

    return elements;
  }

  const STYLE = [
    {
      selector: "node",
      style: {
        shape: "round-rectangle",
        width: "label",
        height: "label",
        padding: "6px",
        "background-color": "#f4f4f4",
        "border-width": 1,
        "border-color": "#999",
        label: (ele) => {
          const lines = [ele.data("label")];
          if (ele.data("trackGroup")) lines.push(`⟨${ele.data("trackGroup")}⟩`);
          if (ele.data("badge")) lines.push(ele.data("badge"));
          return lines.join("\n");
        },
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
  function positionsKey() {
    return `mapPos:${window.sessionId}`;
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

  function relayout() {
    try {
      localStorage.removeItem(positionsKey());
    } catch (e) {
      // ignore
    }
    cy.layout(autoLayoutOptions()).run();
    cy.fit(undefined, 20);
  }

  function render(container, elements) {
    cy = cytoscape({
      container,
      elements,
      style: STYLE,
      layout: autoLayoutOptions(),
      wheelSensitivity: 0.2,
    });
    const saved = loadSavedPositions();
    if (saved) {
      cy.batch(() => {
        cy.nodes().forEach((n) => {
          if (saved[n.id()]) n.position(saved[n.id()]);
        });
      });
    }
    cy.fit(undefined, 20);
    cy.on("dragfree", "node", savePositions);
    const relayoutBtn = document.getElementById("session-map-relayout");
    if (relayoutBtn) relayoutBtn.addEventListener("click", relayout);
    wireContextMenu(container);
    renderHistory(); // history may have arrived before the graph was ready
  }

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
        const mark = `${l.id}·${who}${l.waiting ? "⏳" : ""}${phase}`;
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

  // ── History overlay + rewind context menu ──────────────────────────────────

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
      // Any interaction elsewhere dismisses the menu.
      document.addEventListener("click", (e) => {
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

  function showNodeMenu(node, clientX, clientY) {
    const menu = ensureMenu();
    const label = node.data("label");
    const id = node.id();
    const isMain = id.startsWith("main:");
    const frameName = isMain ? id.slice("main:".length) : null;
    const subMatch = isMain ? null : /^sub:([^:]+):(.*)$/.exec(id);

    let html = `<div class="menu-title">${escapeHtml(label)}</div>`;
    if (!vanillaMode) {
      // Session-lines rooms (2026-07-19): rewinds are the room-wide
      // track-group checkpoint rewind plus EXPLICIT per-line rewinds within a
      // line's own trail — main flow, or its current sub dive (a sub is its
      // own session). The implicit bound-line rewind stays retired.
      if (isMain) {
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
        if (!roomCheckpoint && !lineButtons) {
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

  function wireContextMenu(container) {
    // Native context menu would cover ours on right-click.
    container.addEventListener("contextmenu", (e) => e.preventDefault());
    cy.on("cxttap taphold", "node", (evt) => {
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
        updateLines(data.lines);
      } else if (vanillaMode) {
        vanillaState.players = data.playerCount || 0;
        vanillaState.riders = data.riderCount || 0;
        renderVanilla();
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
    } catch (e) {
      console.error("session-map init failed", e);
      setStatus("map failed to load (see console)");
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
