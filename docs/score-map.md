# Score Map — Requirements & As-Built Notes

Status: **experimental** (owner: "just give it a try, I might remove it later"), built 2026-07-10/11 on `feat/session-lines-v2`. This doc is the context for continuing (or removing) the feature.

## Context & purpose

A live, git-graph-like visualization of an entire score — main flow plus every sub-score — so the operator can **track where the room is** during a session: which frame each line sits on, who is parked at a barrier, who dived into a sub. It doubles as the **history/rewind control**: right-click (tap-hold) a visited frame → "rewind here", replacing trips to the session page's history dropdown. Works for **every score**: a vanilla score (no `session-*` markup) is presented as a **single-line session** (owner decision 2026-07-11).

## Locked design decisions

1. **Standalone page**, not embedded in the session view: `GET /session/:id/map?p=<adminPassword>` renders [views/session-map.jade](../views/session-map.jade). (First iteration was an overlay panel inside the session page; owner asked for a separate view same day.) The session page's only tie is a dynamic "map ↗" link in the admin footer.
2. **Zero cost to vanilla behavior.** The relationship graph is now built for *every* score in `buildSVGContent` (it always was — only the assignment was gated), but: it is never persisted (`toJSON` allowlist), all orchestration still gates on `hasSessionLines`, per-line message payloads (`payload.lines`) remain session-lines-only, and the map page/routes are rendered live (never baked into the apicache-shared session HTML). Vanilla baseline stays byte-identical.
3. **The map is an observer plus a thin rewind trigger — no new server operations.** Rewind sends the *same* `MSG_SELECT_HISTORY {selectedIdx}` the session-page dropdown sends; all hardening (in-sub refusal, `historyAvailable` re-check, generation bump, barrier carve-out, un-park) is the existing server path. If the map is removed, no server semantics are lost.
4. **Vanilla = one line.** With no `lines` payload available, the single playhead is tracked client-side from the broadcast `MSG_SHOW` (`showIdx` → `graph.frames[i]`; `-1` = paused placeholder, marker cleared) and room player/rider counts from the vanilla `MSG_SHOW_NUMBER_CONNECTION`.
5. **Rendering via CDN** (cytoscape + dagre + cytoscape-dagre from jsdelivr — the app already depends on jsdelivr for howler/qrcode). If dagre fails to load, fall back to cytoscape's built-in `breadthfirst` layout; if cytoscape fails, the map doesn't render (page + everything else unaffected). No internet ⇒ no map.
6. **Manual arrangement is client-local.** Nodes are draggable; positions persist in `localStorage` (`mapPos:<sessionId>`) and re-apply after the automatic layout on reload. A header **re-layout** button discards them and re-runs dagre. Live updates never move nodes.
7. **Admin gating is by ws signature, not by page access.** The page renders for anyone with the URL; the live feeds (`lines`, history) only flow when `p` matches the admin password, because the server addresses those messages to admin connections only. Wrong `p` ⇒ static graph, no badges/trail, rewinds silently refused server-side.

## Architecture

### Server (all additive)

- **`GET /session/:id/graph`** ([routes/session.js](../routes/session.js)) → `{ main: session.graph, subs: { <score>: subGraph } }`. 404 only when the session is missing or its graph hasn't been derived yet. **Deliberately uncached**: `session.graph` is re-derived asynchronously after boot, and apicache (which caches 404s) once wedged the map for a full 30-minute TTL from one boot-window fetch.
- **`GET /session/:id/map`** → renders `session-map.jade` live (never cached/baked). Locals: `sessionId`, `scoreTitle`, `wsPath` (now exported from [database.js](../database.js)), and **all `MSG_*` constants as one JSON blob** (`constantsJson`). The blob matters: jade renders the view from disk per request while route code lives in the booted process, so a per-constant local missing from a stale process rendered `window.X = ;` — a SyntaxError killing the whole inline script. The blob degrades to a caught runtime error instead.
- **Graph always assigned** ([database.js](../database.js) `buildSVGContent`): `this.graph = sessionGraph` for every score; `hasSessionLines`/`frameLinks` stay gated on markup.
- **Live positions**: `payload.lines[]` (admin-only, session-lines scores) gained `sub` — the top-of-stack sub-score name — so the client can address `sub:<score>:<frame>` nodes. `afterLineArrived` is wrapped (`afterLineArrivedInner` + `finally`) to call `updateNumberOfConnectionForSession(session)` after **every landing**, so admins get a positions snapshot on each frame advance / dive / return / split / merge, not just on connect/close. Vanilla messages untouched.

### Client ([public/javascripts/session-map.js](../public/javascripts/session-map.js) — the page's only script besides ws-client.js)

Reuses [ws-client.js](../public/javascripts/ws-client.js) wholesale (reconnect/backoff, visibility recovery, time sync) by implementing its `parseMessage` contract:

| message | map reaction |
|---|---|
| `MSG_PING` | 3-ping time calibration mirroring session.js (shares ws-client's top-level `let`s), then `MSG_NEED_DISPLAY` — whose admin reply chain includes history + a positions snapshot |
| `MSG_SHOW` | `window.currentIndex` tracked (rides as `cid`); in vanilla mode = the single line's position |
| `MSG_SHOW_NUMBER_CONNECTION` | `lines[]` present → per-line badges; absent + vanilla mode → synthesize the one line from `playerCount`/`riderCount` |
| `MSG_SELECT_HISTORY` | history trail overlay + rewind menu state (`{history, selectedIdx, available}`) |
| anything else | ignored (addressed to the map connection's line; irrelevant) |

**Visual vocabulary** (cytoscape classes):

- Nodes: `start` (green border), `split` (orange), `barrier` (red octagon), `substart` (blue diamond), `subend` (double border), sub-score frames grouped in dashed `subbox` compound nodes.
- Track groups: `grouped` nodes get a per-group pastel fill (stable palette, sorted group names over main + subs, cycles past 8 groups) and a `⟨group⟩` label line under the frame name. The palette avoids the state hues (amber/green/grey), and state fills (`here`/`visited`/…) deliberately override the tint — the label line keeps the group readable meanwhile.
- Edges: plain hrefs (grey), `split-edge` (orange), `merge-edge` (purple, = href that is also its source's `rejoin-at` target), `dive`/`return` (blue dashed/dotted, around sub-starts), `waits` (red dotted, barrier → hold-until target, sub-qualified `score/frame` refs resolve into subboxes), `via-sub` (dotted grey — a sub-start's own href, walked only after the sub).
- Live: `here` (yellow) with badge `L0·2p+1r⏳` (players + riders; ⏳ = parked at barrier; **admins deliberately excluded** — they only ever count in `devices`), `here-waiting` (red border), `here-dormant` (grey).
- History: `visited` (green tint, ≤ checkpoint), `visited-ahead` (pale, redo entries), `checkpoint` (blue underlay halo).

**Rewind context menu** (`cxttap` / `taphold` on a node): one "⏪ rewind here" entry **per occurrence** of that frame in the history (loops make frames repeat); entries disabled when it is the current checkpoint, `available === false` ("history unavailable — lines diverged"), the frame was never visited, or it's a sub-score frame (history jumps resolve against the main list only). Confirm dialog ("moves the room, not just one device") before sending.

**Boot resilience**: the graph fetch retries every 2 s (≤15×, status "score still building — retrying…") before concluding the score has no graph, covering the post-restart rebuild window.

## Known limitations & gotchas

- **The map tab is an admin ws connection → it populates a line** (open item L3, same as any admin tab). Consequences: it can hold a line awake, count as "someone coming" for barriers, and — because the session tab and map tab are separate `sessionStorage` devices — the two can land on *different* lines in a multi-line moment, flipping S6 single-line history availability to the stricter all-on-track-group rule. The rewind also acts on the **map connection's** line history. All of this dissolves when lines converge; the root fix is the parked L3 decision (skip `ensureLineAssignment` for admins).
- **Reading-(i) fallback-checkpoint is NOT implemented.** When diverged, the menu correctly disables with a reason; it does not yet *offer* the last synchronized checkpoint as a room-wide rewind target (see [session-lines-open-items.md](session-lines-open-items.md) item 1). The map is the natural home for that UX when it lands.
- **History is an undo trail, not teleport** — only visited frames are rewindable. Jump-to-arbitrary-frame would be a new server operation with real design questions (registry/barrier/other-line semantics); out of scope.
- **Boot parses orphan `.subs.json` files as session state** (`loadStoredSessionStates` takes every non-`.html`/`.svg` file): each orphan makes a garbage in-memory `BMSession` that survives only because `buildSVGContent` early-returns on a missing folder. Pre-existing, harmless today, worth a filename filter eventually.
- Chrome "duplicate tab" copies `sessionStorage` → duplicated map tab shares the `did` until refresh.
- Sub boxes auto-fit their children; sub frames are dragged individually (no compound drag).

## Files (for removal or continuation)

Added: [public/javascripts/session-map.js](../public/javascripts/session-map.js), [views/session-map.jade](../views/session-map.jade), this doc.
Touched: [routes/session.js](../routes/session.js) (`/graph` + `/map` routes), [database.js](../database.js) (always-assign graph, `wsPath` export), [bin/www](../bin/www) (`sub` field, `afterLineArrived` wrapper), [public/javascripts/session.js](../public/javascripts/session.js) (admin-footer "map ↗" link), [public/stylesheets/style.css](../public/stylesheets/style.css) (`.session-map-page`, `#session-map-menu`, `.score-map-link` blocks).
To remove the feature: delete the two added files, the two routes, the footer link, the CSS blocks, the `sub` payload field, the `wsPath` export, and unwrap `afterLineArrivedInner`.

## Verification so far

Headless (all green, 89 tests + baseline byte-identical): graph route shape for session-lines (14 frames/3 subs) and vanilla (19 frames, `hasSessionLines:false`) scores; element builder against real payloads (29 nodes/40 edges/0 dangling; split/merge/waits/dive/return counts match the FigJam score's structure); page render including executing the inline script; real admin ws round-trips — lines snapshot (in-sub/waiting/dormant states), vanilla contract (SHOW + counts + history sans `available`), rewind happy path (`selectedIdx 2→1` acknowledged with the right frame) and the diverged/in-sub refusal path.

Still needs a browser pass: cytoscape rendering quality, drag/persist feel, context-menu placement on touch, trail colors vs badges.
