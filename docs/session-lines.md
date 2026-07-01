# Session Lines — Requirements & Implementation Plan

## Context

**Why:** Today a Nested Notation session has exactly **one shared playhead** (`BMSession.currentIndex`). Every connected device votes together and advances to the same frame at the same time ([bin/www:332](../bin/www#L332), [database.js:311](../database.js#L311)). **Session Lines** breaks that single-playhead assumption so that, within one session, the flow can **split into multiple parallel "lines"** through the score — each with its own playhead, voting, and holding — then coordinate and re-merge them. Goal: a diverse, simultaneous experience where different participants traverse different routes (and even different sub-scores) instead of everyone being forced down one path.

**Source of truth:** the FigJam "Nested Notation – Session lines" (exported PDF), plus the locked decisions below. The existing `feat/session-lines` branch is **explicitly ignored** — fresh start.

**Out of scope:** "Solving the Sound Transition Problem" (FigJam Section 1) — confirmed not part of this work.

---

## Locked design decisions

1. **Lines are first-class objects.** Each line has its own playhead, voting/holding state, and history. **Every device is bound to exactly one line** at a time.
2. **Split = personal choice with a bounded choice window** (confirmed). At a `session-split="N"` frame a choice window opens (= voting duration). Each device taps its path and joins that child line. **Non-choosers are auto-assigned at window end to BALANCE line sizes** — keeps lines populated and minimizes empty lines.
3. **`session-track-group` = synchronized timing + independent link tallies + a global STAY override.** Grouped frames begin/end voting together. Each line tallies independently; for **links**, each line advances to its **own** local winner. **Exception — STAY is group-wide:** at window end take the single largest count anywhere in the group; if it is a *stay*, **all grouped lines stay**; otherwise each line proceeds to its own link winner. (Stay = group-wide brake. Glow marker follows this.) **Tiebreak:** reuse today's random tie-break with leader-stabilization ([bin/www:236](../bin/www#L236)).
4. **Sub-session return is decoupled via `href`.** The return target is the `href` on the **main-flow `session-sub-start` frame**. The sub-score only marks its own exit (`session-sub-end`) and never references main-score frames. All rejoin/hold orchestration after a sub-session lives on the main-flow landing frame.
5. **Sub-score location:** `public/data/[main-score]/Subscores/[sub-score]/` with its own `Frames/ Sounds/ Documentation/`. Owned by the main score (not a shared library score). **Sub-frames fetched on demand**; main-score frames stay inlined as today.
6. **`session-hold-until` = ALL named frames must be reached** (and each named frame's own holding period ended) before this frame's hold releases.
7. **`session-rejoin-at` = merge** converging lines into a single line (shared playhead, collective voting resumes) at the target frame. Normally paired with `hold-until` to act as a barrier.
8. **No reciprocal attributes.** Server builds the relationship graph at session-create / score-update; a validation pass runs before a score is used.
9. **v1 sub-sessions are plain** (no nested lines), but the data model + runtime must not preclude nested lines later (high-likelihood future).
10. **Backward compatible.** A score with no `session-*` markup behaves exactly as today: one line = the whole room.
11. **Empty lines go dormant & are revivable.** A line that loses its last device through **attrition** (→ 0 devices) goes **dormant**, not destroyed: it immediately **releases any barrier/rejoin waiting on it** (the awaited frame can no longer be reached — this timeout-free release is the primary deadlock guard) and clears its timers/voting, but **retains its frame, history, `subStack`, and pending coordination** so a later joiner can revive it (see #13). Revival is independent — it brings the line back into circulation from its retained frame and **never re-arms a dependency that was already released**. *Structural* removals are different: the parent line at a split and lines absorbed into a survivor at a rejoin are **hard-retired** (gone, not revivable).
12. **Rider-only lines** (people present, none able to vote) are folded into the nearest votable line (confirmed). A lightweight SM **force-release** remains as a defensive valve.
13. **Late join & path revival.** A device joining (or an unknown `did` arriving) after the room has diverged is assigned via `smallestLineId` over **live votable ∪ dormant** lines (ties → earliest id). A dormant line has 0 devices so it is always the smallest ⇒ newcomers **revive dead paths first**, then balance across live lines; a revived line resumes its lifecycle from its retained frame. Never assigned to a retired start/parent line. Dormancy already released a line's barriers (#11), so revival is **opportunistic, never a hold** — nothing ever waits for a revive.

---

## Glossary

- **Line (flow):** an independent path through the score with its own playhead/voting/holding/history. A session has ≥1 lines.
- **Split:** a frame that divides one line into N child lines.
- **Rejoin / merge:** N lines converging into one at a named frame.
- **Track group:** a named set of frames whose voting windows are time-synchronized (but tallied independently).
- **Hold-until (barrier):** a frame that pauses its line until other named frames have been reached by their lines.
- **Sub-session:** a line temporarily diving into a separate sub-score, isolated, then returning to the main flow.
- **Device:** one connected client (player or rider), identified persistently (see Device Identity).

---

## Markup reference (attributes live on the `<svg>` root of each frame)

| Attribute | Placement | Semantics (locked) |
|---|---|---|
| `session-split="N"` | main frame | Frame divides its line into N child lines; frame must expose N hrefs. Choice window → personal choice → auto-assign stragglers. A line may split again (nesting allowed). |
| `session-track-group="name"` | any frame | Frames sharing a name begin/end voting windows together. Each line still tallies/resolves independently. |
| `session-hold-until="X,Y"` | any frame | This line holds at its current frame until lines occupying **all** of X and Y have arrived and ended those frames' holds. Supports sub refs like `Tetra2/E` only on the end node. |
| `session-rejoin-at="X"` | source frame | This line will merge into one at frame X. Multiple lines naming the same X merge there. May list multiple targets (with split). |
| `session-sub-start="Score"` | main frame | A line entering this frame dives into sub-score `Score` (starts at its `START`). The frame's own `href` is the **return landing** in the main flow. |
| `session-sub-end="Score"` | sub-score frame | Marks the sub-score's exit. On reaching it, the line pops back to the corresponding sub-start frame's `href`. Self-contained; names no main-score frame. |

---

## Data model

Refactor the single-playhead `BMSession` into **session-global state + an array of `BMLine` objects**.

**`BMLine`** (extract today's per-playhead fields from [database.js:174-206](../database.js#L174-L206)):
- `id` (line id, e.g. `L0`, generated on split)
- `currentIndex`, `history`, `historyIndex`
- voting: `isVoting`, `currentBeginTimeStamp`, `currentEndTimeStamp`, `currentVotingDuration`, `votingTimer`, `votingTimeStamp`, `didSendStopVoting`, `currWinningId`, `previousWinningCount`
- holding/standby: `isHolding`, `isStandby`, `currentBeginHoldTimeStamp`, `currentEndHoldTimeStamp`, `currentHoldingDuration`, `holdingTimer`, `standbyTimer`, `nextFrameHoldingDur`
- coordination: `trackGroup` (current frame's group, if any), `pendingHoldUntil` (set of frames still awaited), `pendingRejoinAt`, `subStack` (stack of `{score, returnHref}` for sub-sessions; stack ⇒ nesting-ready)
- membership is derived: the set of connections/devices whose `lineId === this.id`

**`BMSession`** keeps the global, score-level fields ([database.js:174-223](../database.js#L174-L223)): `id, ownerId, sessionName, adminPassword, playerPassword, folder, listFiles, listFilesInLowerCase, listMultiChooseImages, soundList, hasSounds, isHtml5, fadeDuration, defaultVolume, defaultAutoplay, enableAutoplayByDefault, votingDuration, holdDuration, votingSize, standbyDuration, synTimeInterval, preloadDuration, isPause, isSessionDeleted`. **Adds:** `lines[]`, `graph` (see below), `deviceRegistry` (persistent `deviceId → lineId`), `subFrameCache`.

**Connection tagging** (extend [bin/www:515-520](../bin/www#L515-L520)): keep `sessionId, isAdmin, isStaff, currentVoteTo`; **add `lineId` and `deviceId`**.

**Device identity (NEW requirement):** the server currently has no stable per-device id — a refresh creates a fresh connection and today just re-reads the session's single `currentIndex` ([bin/www:585](../bin/www#L585)). With lines, a refreshed device must rejoin **its** line. Plan: the moment a device reaches the session, the client assigns it a UUID and persists it in **`localStorage`** (`did`), with an in-memory fallback if storage is blocked; from that point the device is associated with that UUID. The `did` rides on every message (incl. `MSG_PING`/`MSG_NEED_DISPLAY`); the server keeps `deviceRegistry[deviceId] = lineId` so reconnects restore membership. (An unknown `did` is assigned per #13 — the smallest live-or-dormant line.) `localStorage` survives refresh, tab close, and mobile tab eviction, and keeps the id off every HTTP request.

**Relationship graph** (built in `buildSVGContent` / on reload, [database.js:345](../database.js#L345)): while reading each frame, additionally parse the `<svg>` root for `session-*` attributes and record: split nodes (+N + their hrefs), track-group membership, hold-until targets, rejoin targets, sub-start (→ score + return href) and sub-end (→ score) mappings. Produce a normalized model the runtime consults (no reciprocal attributes needed). Persist alongside state.

---

## Validation (pre-use)

A validator runs before a score is used in a session (and is the basis for a future upload/lint check). Checks: split node's `N` matches its href count; every `hold-until`/`rejoin-at`/`sub-start` reference resolves to an existing frame/sub-score; each `sub-start` score has a `START` and at least one `sub-end`; track-group consistency; no obviously unsatisfiable barriers (best-effort). Surface results to the admin console (proposed "Validate score" action) and the dev console, mirroring today's console-based markup checking. **Hook points:** `initState`/`buildSVGContent` ([database.js:240](../database.js#L240), [database.js:345](../database.js#L345)) and `reloadScore` ([database.js:279](../database.js#L279)), invoked from session create/update in [routes/sm.js](../routes/sm.js).

---

## Runtime lifecycle

All voting/holding functions in [bin/www](../bin/www) currently take a `session`; they become **per-line** (take a `line` within a `session`). Messaging helpers gain a per-line variant.

1. **Session start.** One line `L0` at a `START`/`PRE` frame ([database.js:294](../database.js#L294)). All devices join `L0`. Identical to today until a split occurs.
2. **Line-scoped voting.** `countVoteForSession` → `countVoteForLine`: tally `conn.currentVoteTo` only over connections with `conn.lineId === line.id` ([bin/www:213-252](../bin/www#L213-L252)). `startVoting/stopVoting/holding` operate on the line; `MSG_BEGIN_VOTING`, `MSG_UPDATE_VOTING`, `MSG_SHOW`, `MSG_BEGIN_HOLDING` are sent only to that line's connections via a new `sendToLine()` (filter on `conn.lineId`).
3. **Split.** Line reaches a `session-split="N"` frame → open a choice window (voting-duration based). Devices tap → recorded as their chosen child path. At window end: create N child lines, distribute choosers to the child line matching their tap, **auto-assign non-choosers** (balance/default), **hard-retire** the parent line (structural — not dormant). Each child then runs its own lifecycle.
4. **Track group.** When any line whose current frame is in group G starts voting, the server starts the voting window for **all** lines currently sitting on a frame in G (synchronized start/end). Tallies remain per-line.
5. **Hold-until (barrier).** On arrival at a `hold-until="X,Y"` frame, the line enters holding with `pendingHoldUntil={X,Y}`. The server marks targets satisfied as lines reach X and Y (and finish those holds). When the set is empty, release the hold and proceed.
6. **Rejoin (merge).** When a line navigates to a `rejoin-at` target frame, it merges with any other line already designated to rejoin there: pick/keep one surviving line, reassign the other lines' devices (`conn.lineId`, `deviceRegistry`) to it, **hard-retire** the absorbed lines (structural — not dormant/revivable). Collective voting resumes on the merged line.
7. **Sub-session (decoupled).** Entering a `session-sub-start="S"` frame: push `{score:S, returnHref:<frame's href>}` onto the line's `subStack`, load sub-score `S` frames on demand, set the line to `S/START`. The line runs isolated (own voting/holding; no cross refs). On reaching a `session-sub-end="S"` frame: pop the stack and set the line to `returnHref` in the main flow. Stack supports future nesting.
8. **Attrition & revival.** When a line's last device leaves (attrition → 0 devices) the line goes **dormant**: release any barrier/rejoin awaiting it (#11), clear its timers, but keep its `currentIndex`/history/`subStack`/pending coordination. `ensureLineAssignment` includes dormant lines as targets (count 0 ⇒ smallest ⇒ revived first, #13); assigning a device flips it back to **active**, resuming from its retained frame. (Split-parent and rejoin-absorbed lines are hard-retired instead — they never go dormant.)

---

## Sub-frame delivery

Main-score frames remain pre-inlined in `server_state/{id}.html` ([database.js:428-477](../database.js#L428-L477)). Sub-score frames are **fetched on demand** via a new route, e.g. `GET /session/:id/sub/:score/:frame` (mirrors the streaming approach of [routes/session.js:15-37](../routes/session.js#L15-L37) and `svgcontent.html`). Client injects fetched sub-frames into the DOM and shows them like inlined frames. Sub-score sounds load via the existing on-demand Howler path; sub-score sound list is exposed per sub-score.

---

## Session manager controls across lines

- **Pause / global refresh:** session-global, apply to all lines (as today, [bin/www:658-680](../bin/www#L658-L680)).
- **Hold:** SM hold needs a scope decision (all lines vs a chosen line) — TBD with SM-UI work.
- **History modal:** the FigJam "Session manager history modal behavior" table defines the rules: a track-grouped frame shows that device's line frame and jumps it back; **frames not in any track group make history "impossible" while any device sits on them** (lines are diverged/unsynced). Formalize: history/jump is available per track-group context and disabled when devices occupy non-grouped frames. *(Full SM-history UX — TBD, see Open items.)*
- **SM visibility (proposed enhancement):** show per-line device counts / frame occupancy on the dashboard so the operator can see the room's distribution and spot stalled lines.

---

## Client & display changes (verified against client code)

The client renders whatever frame/voting state the server addresses to it, so **most client code is line-agnostic** — the bulk of the work is server-side per-line addressing, plus these targeted client changes:

- **Per-line show needs no client change.** `parseMessage` ([session.js:56](../public/javascripts/session.js#L56)) handles `MSG_SHOW`→`showImageAtIndex` ([session.js:312](../public/javascripts/session.js#L312)), which shows `#MainContent svg[id="svgN"]` and hides the rest. The client just shows whatever index its line is told.
- **Stay/winning glow needs NO client change.** The glow follows the server's `winningVoteId` ([voting.js:111](../public/javascripts/voting.js#L111); [voting.js:201](../public/javascripts/voting.js#L201) already handles `winningVoteId==="stay"`). The whole stay rule is implemented server-side by setting each line's `winningVoteId`.
- **Device identity.** On session load, `ensureDeviceId()` generates+persists a UUID in **`localStorage`** (`did`, in-memory fallback if blocked) — created the moment the device reaches the session and reused for it thereafter. Add `did` to the `sendToServer` payload ([ws-client.js:148](../public/javascripts/ws-client.js#L148)); send on `MSG_PING`/`MSG_NEED_DISPLAY`. Generate it client-side (not baked into the shared, apicache-cached `${id}.html`). The reconnect path already re-pings ([ws-client.js:44](../public/javascripts/ws-client.js#L44), [ws-client.js:70](../public/javascripts/ws-client.js#L70)), and `localStorage` persists, so membership restores automatically.
- **Split tap** reuses `handleSelectLink`→`MSG_TAP` ([voting.js:33](../public/javascripts/voting.js#L33)); the server interprets taps as line choices during the split window (optional "choose your path" labeling).
- **Sub-frames.** Inject fetched sub-`<svg>` into `#MainContent` and extend `showImageAtIndex` to address them (sub-frame id scheme). Audio already lazy-loads (Howler `preload:false`); expose each sub-score's sound list per line.
- **SM live controls** (hold/pause/history/global-refresh) live in the **session page** admin UI ([session.js:28-41](../public/javascripts/session.js#L28-L41)), not `routes/sm.js`. The per-line **history modal** (FigJam rules) is the main new SM-side client work; basic per-line jump reuses `MSG_SELECT_HISTORY` ([session.js:198](../public/javascripts/session.js#L198)).

---

## Persistence & restart

Extend `saveSessionStateToFile` / `loadStoredSessionStates` ([database.js:519-536](../database.js#L519-L536), [database.js:629-648](../database.js#L629-L648)) to serialize `lines[]` (minus timers, like today's timer-nulling) and `deviceRegistry`. On restart, rebuild lines and graph; reconnecting devices restore their line via `deviceId`.

---

## Server message protocol changes

- New helper `sendToLine(line, time, payload)` (filter connections by `conn.lineId`); keep `sendToAllClients`/`sendToAllAdmins` for session-global messages.
- `MSG_PING` / `MSG_NEED_DISPLAY` carry `deviceId`; server resolves `lineId` and replies with that line's current frame/voting/holding state ([bin/www:585-629](../bin/www#L585-L629)).
- `MSG_TAP` handling becomes line-scoped, plus a split-choice path.
- Possible new messages: `MSG_LINE_ASSIGNED` (tell a device its new line on split/merge), `MSG_BEGIN_SPLIT` (open choice window).

---

## Open items (parked)

- **Vote-marker glow** follows the resolution rule (group stay-leader vs per-line link-leader); exact rendering to verify against client code.
- **SM hold scope** across lines (all vs chosen line) — with SM-UI work.
- **Multi-exit sub-scores** (several `sub-end` frames → different main landings) — extension to the decoupled href mapping.

---

## Critical files to modify

- [database.js](../database.js) — `BMSession` refactor → `BMSession` + `BMLine`; graph build in `buildSVGContent`; persistence; sub-frame/sub-sound listing.
- [bin/www](../bin/www) — per-line voting/holding/standby; `sendToLine`; split/rejoin/hold-until/sub-session orchestration; `messageHandle` line-scoping + device identity.
- [routes/session.js](../routes/session.js) — new on-demand sub-frame route.
- [routes/sm.js](../routes/sm.js) — admin console (create/update/stop session); **hook graph-build + validation** into create/update.
- `views/session.jade`, [public/javascripts/session.js](../public/javascripts/session.js), [public/javascripts/ws-client.js](../public/javascripts/ws-client.js), [public/javascripts/voting.js](../public/javascripts/voting.js), `public/javascripts/audio-player.js` — device id, sub-frame inject/show, split labeling, per-line SM history modal.
- [constants.js](../constants.js) — new `MSG_*` constants.
- New: `lib/session-lines/` (graph builder + validator + line orchestrator), keeping `BMSession` lean.

---

## Verification

- **Unit/graph:** feed synthetic scores (the FigJam a–z markup example) to the graph builder + validator; assert split counts, track-group sets, hold-until/rejoin/sub mappings.
- **Backward-compat:** run an existing score (Tesseract) with no `session-*` markup; confirm identical single-line behavior.
- **Manual E2E:** author a small score with one split + rejoin + one sub-session; run the server (`npm start`), join with 3+ browser tabs, verify: lines diverge on split, each votes independently, hold-until barrier waits for all, rejoin merges, sub-session dives and returns to the href landing, refresh restores line membership.
- **SM:** verify pause/global-refresh across lines and the history-modal availability rules.
