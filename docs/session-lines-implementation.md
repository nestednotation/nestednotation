# Session Lines — Implementation Plan (chunked)

> **Requirements / source of truth:** [session-lines.md](session-lines.md). This file is the *build* plan: how to deliver that spec in small, independently verifiable chunks.

## Context

Session Lines turns the single shared playhead (`BMSession.currentIndex`) into **multiple parallel lines**, each with its own playhead/voting/holding, that can split, sync (track-group), barrier (hold-until), merge (rejoin), and dive into sub-scores. The runtime today lives in [bin/www](../bin/www) (voting/holding/messaging) and [database.js](../database.js) (state + build). The whole feature must ship **incrementally without ever breaking vanilla scores**.

## Guiding principles (apply to every chunk)

1. **Gate everything** on `session.hasSessionLines`. A score with no `session-*` markup must stay **byte-for-byte identical** in its built output and behavior.
2. **Pure logic in `lib/session-lines/`** (parser, graph, validator, routing, orchestrator) — no `require` of express/ws — so it's unit-testable without booting servers. Mirrors the existing split of concerns.
3. **Each chunk is shippable + verifiable on its own.** Order is chosen so the app runs at every step.
4. **Single-line invariant:** until a split happens, `lines == [lines[0]]` and all new code must reduce to today's behavior (the safety net for the big refactor).
5. **Test harness (dependency-free):** plain Node scripts in `test/` using `node:assert`, run by `test/run.js`; add `"test": "node test/run.js"`. Works on Node 14+ (README floor). A **baseline guard** builds a vanilla score and diffs `server_state/*.content.svg` + `.html` against a saved snapshot to prove no-regression after build/state changes.

---

## Phase 1 — Foundation (no runtime change)

### Chunk A — Test harness + baseline guard + offline build tool
- **Build:** `test/run.js` (requires all `test/*.test.js`, non-zero exit on failure) + `"test"` script. New `bin/build-score.js <folder>`: constructs a `BMSession`, runs `buildSVGContent`, prints output paths — lets us build/inspect a score without the ws server. Requires an **additive** `module.exports` of `BMSession` from [database.js](../database.js). Snapshot `-u- Hello` (vanilla) `.content.svg`+`.html` into `test/baseline/`.
- **Verify:** `npm test` green; `node bin/build-score.js "-u- Hello"` writes expected files; baseline captured.

### Chunk B — Markup parser + graph builder (pure)
- **Build:** `lib/session-lines/parse.js` → `parseFrameAttrs(svgString)` reads the `<svg>` root for `session-split/track-group/hold-until/rejoin-at/sub-start/sub-end` (+ extracts `<a>` href targets, reusing the `HREF_REGX`/`LINK_REGEX` patterns from [database.js:7-8](../database.js#L7-L8)). `lib/session-lines/graph.js` → `buildGraph(frames)` returns `{ hasSessionLines, byFrame, groups, splits, holdUntilTargets, rejoinTargets, subStart(→{score,returnHref}), subEnd }`, names resolved case-insensitively (mirror `listFilesInLowerCase`).
- **Verify:** `test/graph.test.js` feeds the FigJam **a–z** example and the **hybrid** example as inline fixtures; assert split N, group membership sets, hold/rejoin/sub maps.

### Chunk C — Validator (pure) + CLI
- **Build:** `lib/session-lines/validate.js` → `validateScore(graph, frameNames, subLoader)` → `{errors[], warnings[]}`: split `N` == href count; every `hold-until`/`rejoin-at`/`sub-start` target resolves; every `rejoin-at` target is one of its frame's own links (`rejoin-not-linked`, owner 2026-07-08 — rejoin-at is a pre-merge announcement, never paired with split); each sub-score has a `START` + ≥1 `sub-end` and every landable sub frame keeps a path to a sub-end (`sub-dead-end`, decided 2026-07-07); track-group consistency; best-effort unsatisfiable-barrier check. `bin/validate-session-lines.js` + `"validate-session-lines"` script (exit code by errors).
- **Verify:** `test/validate.test.js` with valid + broken fixtures (split N≠hrefs, dangling rejoin, rejoin target not linked, sub missing START/sub-end, stranded sub frame).

### Chunk D — Wire graph into the build (gated, inert)
- **Build:** in `buildSVGContent` ([database.js:345](../database.js#L345)) call `parseFrameAttrs` inside the existing per-frame loop ([database.js:370](../database.js#L370)); after the loop call `buildGraph` and set `this.graph` + `this.hasSessionLines` **only when attrs exist**. No other behavior.
- **Verify:** baseline diff for `-u- Hello` still byte-identical; a session-lines fixture yields a populated `session.graph` (assert via `bin/build-score.js`). Runtime unchanged.

---

## Phase 2 — Core model (single-line == today throughout)

### Chunk E — `BMLine` extraction + backward-compat shim + versioned persistence
- **Build:** new `BMLine` (own file or in database.js) holding the per-playhead fields currently on `BMSession` ([database.js:174-206](../database.js#L174-L206)): `currentIndex, history, historyIndex`, voting/holding/standby state + timestamps + timers, `currWinningId/previousWinningCount`, plus new `subStack`, `pendingHoldUntil`, `pendingRejoinAt`, and `status` (`'active'`/`'dormant'` for the #11 dormancy/revival lifecycle — dormant lines stay in `lines[]` so they survive restart and remain revivable). Methods `setCurrIdxTo*`/`resetHistory`/`clearAllTimer`; `toJSON` (timers null, `isVoting` false) + static `fromJSON`; non-enumerable `session` back-ref. `BMSession` gains `lines=[new BMLine(this,0)]`, `nextLineId`, `deviceRegistry`. A **prototype accessor shim** (`Object.defineProperty` over a field list) delegates `session.currentIndex/isVoting/votingTimer/…` read+write to `lines[0]` so **[bin/www](../bin/www) stays untouched** this chunk. Replace the `{...this}` spread in `saveSessionStateToFile` ([database.js:524](../database.js#L524)) with a `toJSON()` allowlist + `version`; serialize `lines[]`+`deviceRegistry`, drop re-derivable `listFiles*`/`graph`. Add `migrateState` v1(flat)→v2(`lines:[one]`); `loadStoredSessionStates`/`patchState` ([database.js:225](../database.js#L225), [database.js:629](../database.js#L629)) rehydrate `BMLine`.
- **Verify:** `test/line.test.js` (round-trip, v1→v2 migration, shim delegation, clearAllTimer-all-lines); run app on a vanilla score — voting/holding/history identical; baseline build byte-identical.

### Chunk F — Per-line messaging seam
- **Build (server seam):** `lib/session-lines/routing.js` (pure): `sessionConnections`, `lineConnections(conns, sid, lineId)`, `smallestLineId` (balance, ties→earliest). [bin/www](../bin/www): on `MSG_PING`/`MSG_NEED_DISPLAY` read `messageData.did`, set `conn.deviceId`+`conn.lineId` via `ensureLineAssignment` (one line → `lines[0]`); add `sendToLine/…WithDelay/…Admins`; `countVoteForSession`→`countVoteForLine(session, lineId)` ([bin/www:213](../bin/www#L213)). Convert line-scoped sends (`BEGIN_VOTING/UPDATE_VOTING/BEGIN_HOLDING/SHOW/SELECT_HISTORY`); keep global (`PAUSE/GLOBAL_REFRESH/CHECK_HOLD/SHOW_NUMBER_CONNECTION/FINISH`).
- **Build (device identity — sessionStorage):** a tab is assigned a stable UUID the moment it reaches the session and is associated with it from then on (per-tab, so multiple tabs of one browser are distinct performers).
  1. On session-page load the client runs `ensureDeviceId()`: read `sessionStorage.getItem("did")`; if absent, generate `crypto.randomUUID()`, `sessionStorage.setItem("did", …)`, and set `window.deviceId`. If `sessionStorage` is unavailable (throws/blocked), fall back to a module-scoped in-memory id for the page's life. (Client-side only — never baked into the shared, apicache-cached `${id}.html`.)
  2. `sendToServer` adds `did: window.deviceId` to every envelope ([ws-client.js:148](../public/javascripts/ws-client.js#L148)).
  3. Server keeps `session.deviceRegistry[did] = lineId`; `ensureLineAssignment` rejoins `deviceRegistry[did]` when known, else assigns via `smallestLineId` over **live votable ∪ dormant** lines — reviving a dormant line first when one exists (#13) — and records it.
  - `sessionStorage` persists across refresh and mobile tab-eviction restore, so the existing re-ping path ([ws-client.js:44](../public/javascripts/ws-client.js#L44), [ws-client.js:70](../public/javascripts/ws-client.js#L70)) restores line membership automatically; a closed tab mints a new `did` on return and is assigned per decision #13 (smallest live-or-dormant line). (Was `localStorage` originally; switched 2026-07-10 so tabs don't share one `did`.)
- **Verify:** `test/routing.test.js` (single-line `lineConnections` == old `sessionConnections`); run app — behavior identical; `window.deviceId` is created on first visit, stays stable across refresh, and the tab re-associates with the same line on reconnect.

### Chunk G — Per-line voting/holding lifecycle
- **Build:** make `startVotingForSessionWithDelay`/`stopVotingForSession`/`startHoldingForSessionWithDelay` + timers, the `MSG_TAP` path ([bin/www:530](../bin/www#L530)), `jumpScoreForSession`, `cancel*Timer`, and the `MSG_NEED_DISPLAY` reply all take `(session, line)` and read/write `line.*` / target `line.id`. Single line = `lines[0]` ⇒ identical. Shim now only backs persistence-field access.
- **Verify:** run app vanilla — voting/holding/tap/history identical; baseline unaffected.

---

## Phase 3 — Orchestration (the actual feature)

### Chunk H — Protocol constants + orchestrator skeleton
- **Build:** `MESSAGES` ([constants.js:1](../constants.js#L1)) += `MSG_LINE_ASSIGNED=16, MSG_BEGIN_SPLIT=17, MSG_BARRIER_WAITING=18, MSG_BARRIER_RELEASED=19, MSG_SUB_ENTER=20, MSG_SUB_EXIT=21`; wire each through the jade `fn({...})` in [database.js:439-454](../database.js#L439-L454) and the `window.MSG_*` block in [session.jade:41-56](../views/session.jade#L41). `lib/session-lines/orchestrator.js`: pure `planSplitPartition`, `holdUntilSatisfied`, `rejoinSatisfied`, `planRecombine` (survivor = lowest id, keeps history), `parseVoteTargetIndex`, track-group window helpers, `subReturnIndex`; `createOrchestrator(transport)` (transport-injected senders) consulted by [bin/www](../bin/www).
- **Verify:** `test/orchestrator.test.js` unit-tests each pure function.

### Chunk I — Split
- **Build:** build-time `buildFrameLinks` (per-frame ordered link target indices), gated. Runtime: arriving at a split frame opens a **choice window** (voting duration); `MSG_TAP` on a split frame records a *choice*. At window close: spawn N child `BMLine`s, assign choosers to their tapped child, **balance non-choosers** (`planSplitPartition`), **hard-retire** the parent (structural — not dormant), reassign `conn.lineId`+`deviceRegistry`, emit `MSG_BEGIN_SPLIT`+`MSG_LINE_ASSIGNED`. Client: handle `MSG_LINE_ASSIGNED` (store own line); optional split labeling.
- **Verify:** orchestrator test of the partition with a fake transport; fixture (1 split) multi-tab — lines diverge, balanced, then vote independently.

### Chunk J — Hold-until + rejoin (barrier)
- **Build:** transient `session._barrier` (satisfied set + rejoin arrivals). On hold-until arrival → park + `MSG_BARRIER_WAITING`; mark targets satisfied as lines reach them; all satisfied → `MSG_BARRIER_RELEASED` + proceed. Rejoin: converging lines merge (`planRecombine`), reassign devices, **hard-retire** absorbed lines. **Attrition → 0 devices sets the line dormant: release barriers depending on it (#11), keep it revivable (#13); split-parent / rejoin-absorbed lines hard-retire instead.** Client: barrier-waiting banner (`#barrier-waiting-indicator` + body class).
- **Verify:** orchestrator test of the hybrid (split→3→barrier→rejoin) via fake transport; fixture multi-tab — lines wait for all, then merge to one.

### Chunk K — Sub-sessions (decoupled, fetch-on-demand)
- **Build:** build-time `buildSubFramesContent()` in [database.js](../database.js) rewrites each `Subscores/<sub>/Frames` set (same id/`<a>` rewrite as the parent loop, resolved within the sub) → `${id}.subs.json` (gated; removed for vanilla). New **read-only** route `GET /session/:id/sub/:subName` → `{framesHtml, frameList, soundList}` (mirror the stream+apicache of [routes/session.js:15-37](../routes/session.js#L15-L37)). Runtime: sub-start → push `subStack {score, returnHref=frame href}`, `BMLine.enterSub` (cursor into sub list via `activeFrameList`), `MSG_SUB_ENTER`; sub-end → pop, set to `returnHref`, `MSG_SUB_EXIT`. Client: fetch+inject sub `<svg>` into **`#SubSessionContent`, a constant child of `#MainContent`** ([views/session.jade](../views/session.jade); hidden via stylesheet, shown as `display:contents` so sub frames adopt `#MainContent`'s layout — `generateSoundMap` stays scoped to `#MainSVGContent`, and `getListSvg` matching sub svgs is harmless since its only caller hides non-numeric ids), cache per sub; swap `window.listFiles` (restore via `window.parentListFiles`); `update-view` carries an explicit frame DOM id (`svg{idx}` vs `sub-{name}-{idx}`) so [audio-player.js:785](../public/javascripts/audio-player.js#L785) routes correctly; audio `registerSubFrames` + `getSoundLink(name, ctx)` → `/data/{score}/Subscores/{sub}/Sounds/` ([audio-player.js:17](../public/javascripts/audio-player.js#L17)).
- **Verify:** fixture main + `Subscores/Tetra1`; multi-tab — dive → play (sub sounds) → return to href landing; vanilla score still produces no `.subs.json` and byte-identical HTML (baseline re-captured once for the inert, always-present `#SubSessionContent` div — the only vanilla-visible markup this feature adds).

### Chunk L — Track-group windows + stay rule
- **Build:** when a line in group G starts voting, open synchronized windows on all **votable** co-group lines (initiator's duration). At group window close, compute the single global-max count across all grouped lines' tallies; if it's a **stay** → set every grouped line's winner to stay (all stay); else each line resolves its own link winner. Set each line's `winningVoteId` accordingly — the client glow already follows it ([voting.js:111](../public/javascripts/voting.js#L111), [voting.js:201](../public/javascripts/voting.js#L201)), **no client change**. Reuse the random tiebreak ([bin/www:236](../bin/www#L236)).
- **Verify:** orchestrator test (group window + global-stay propagation); fixture multi-tab — grouped lines vote together; strongest stay anywhere brakes all.

---

## Phase 4 — Session manager + close-out

### Chunk M — SM controls across lines
- **Build:** `MSG_CHECK_HOLD` iterates all lines; pause/global-refresh already global. Per-line **history modal** (FigJam rules): jump scoped to the device's line; "history impossible" while devices sit on non-track-grouped frames; available per track-group context (reuse `MSG_SELECT_HISTORY` per line, [session.js:198](../public/javascripts/session.js#L198)). Admin **barrier force-release** → emit `MSG_BARRIER_RELEASED` for a chosen barrier (defensive valve, decision #12). **Line visibility:** per-line device counts to admins (extend `MSG_SHOW_NUMBER_CONNECTION` / `#tablefooter` [session.jade:123](../views/session.jade#L123)).
- **Verify:** admin tab — pause all lines, force-release a stuck barrier, history follows the availability rules, per-line counts shown.

### Chunk N — Final verification + cleanup
- **Build:** drop any shim fields fully superseded by `line.*`; tidy.
- **Verify:** **backward-compat:** Tesseract (vanilla) end-to-end identical + baseline green. **Full E2E:** a crafted score exercising split + track-group + hold-until + rejoin + sub-session, walked through per the spec's verification section with 3+ tabs (diverge, vote independently, barrier waits for all, rejoin merges, sub dives + returns, refresh restores line via `deviceId`). Run `validate-session-lines` over the library.

---

## Dependency order

`A → B → C → D` (foundation, inert) → `E → F → G` (model, still vanilla-identical) → `H` → `I, J, K, L` (feature; I/J/K/L are largely independent after H, do I→J→K→L) → `M → N`.

## Critical files

- Pure/new: `lib/session-lines/{parse,graph,validate,routing,orchestrator}.js`, `BMLine`, `bin/build-score.js`, `bin/validate-session-lines.js`, `test/*`.
- [database.js](../database.js) — graph build, `BMLine`/shim, versioned persistence, sub-frame build.
- [bin/www](../bin/www) — per-line voting/holding/messaging, split/barrier/rejoin/sub orchestration, device identity.
- [routes/session.js](../routes/session.js) — sub-frame route. [constants.js](../constants.js) — new `MSG_*`.
- Client: [views/session.jade](../views/session.jade) (`#SubSessionContent`, MSG wiring, device id), [public/javascripts/ws-client.js](../public/javascripts/ws-client.js), [public/javascripts/session.js](../public/javascripts/session.js), [public/javascripts/audio-player.js](../public/javascripts/audio-player.js), [public/javascripts/voting.js](../public/javascripts/voting.js).
- **Score map (experimental, post-plan — see [score-map.md](score-map.md))**: `public/javascripts/session-map.js` + `views/session-map.jade` (new); `/graph` + `/map` routes in routes/session.js; `database.js` always assigns `session.graph` (vanilla included, orchestration still `hasSessionLines`-gated) and exports `wsPath`; bin/www `payload.lines[].sub` + per-landing admin positions broadcast (`afterLineArrivedInner` wrapper).

## Verification summary

Per-chunk `npm test` (pure modules) + the **baseline byte-diff** after every build/state chunk (A,D,E,K) + **manual multi-tab E2E** for the runtime chunks (I,J,K,L,M), culminating in the full crafted-score walkthrough in Chunk N.
