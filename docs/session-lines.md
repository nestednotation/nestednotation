# Session Lines — Requirements & Implementation Plan

## Context

**Why:** Today a Nested Notation session has exactly **one shared playhead** (`BMSession.currentIndex`). Every connected device votes together and advances to the same frame at the same time ([bin/www:332](../bin/www#L332), [database.js:311](../database.js#L311)). **Session Lines** breaks that single-playhead assumption so that, within one session, the flow can **split into multiple parallel "lines"** through the score — each with its own playhead, voting, and holding — then coordinate and re-merge them. Goal: a diverse, simultaneous experience where different participants traverse different routes (and even different sub-scores) instead of everyone being forced down one path.

**Source of truth:** the FigJam "Nested Notation – Session lines" (exported PDF), plus the locked decisions below. The existing `feat/session-lines` branch is **explicitly ignored** — fresh start.

**Out of scope:** "Solving the Sound Transition Problem" (FigJam Section 1) — confirmed not part of this work.

---

## Locked design decisions

1. **Lines are first-class objects.** Each line has its own playhead, voting/holding state, and history. **Every device is bound to exactly one line** at a time.
2. **Split = personal choice with a bounded choice window** (confirmed). At a `session-split="N"` frame a choice window opens (= voting duration). Each device taps its path and joins that child line. **Non-choosers are auto-assigned at window end to BALANCE line sizes** — keeps lines populated and minimizes empty lines.
3. **`session-track-group` = an ARRIVAL barrier + synchronized timing + independent link tallies + a global STAY override.** **Arrival barrier (decided 2026-07-16):** grouped frames don't just vote together — they *wait for each other*. A line landing on a grouped frame **parks** (frame shown, taps ignored — the hold-until banner protocol is reused) until **every populated line that can still reach a group frame has arrived on one** and every arrived line has cleared its own (out-of-group) hold-until. Empty (0-device) lines neither occupy nor are waited for. **"Device" counts every connection — admin included (L3 decided by owner, 2026-07-18): an admin is a player with extra session controls,** so a line occupied only by an admin/SM/map tab is populated and IS waited for, exactly like any idle player's line; the admin's own tools (tapping the line forward, force-release, or closing the tab so attrition dissolves the wait) are the remedy. The wait dissolves **timeout-free via reachability** (a line that goes dormant or navigates off every path to the group stops being "incoming" — same philosophy as #11); the SM force-release valve covers group waits too (panel entry `group:<name>`). A **late arrival** (e.g. a line revived mid-round) is not parked once the group stopped waiting — it joins the running round truncated (decided 2026-07-16: lowest-complexity option). SM jumps never park at the landing (authoritative override, like the landing-barrier carve-out). Once released, grouped frames begin/end voting together (first tap opens all windows). Each line tallies independently; for **links**, each line advances to its **own** local winner. **Exception — STAY is group-wide:** at window end take the single largest count anywhere in the group; if it is a *stay*, **all grouped lines stay**; otherwise each line proceeds to its own link winner. (Stay = group-wide brake. Glow marker follows this.) **Tiebreak:** reuse today's random tie-break with leader-stabilization ([bin/www:236](../bin/www#L236)).
4. **Sub-session return is decoupled via `href`.** The return target is the `href` on the **main-flow `session-sub-start` frame**. The sub-score only marks its own exit (`session-sub-end`) and never references main-score frames. All rejoin/hold orchestration after a sub-session lives on the main-flow landing frame.
5. **Sub-score location:** `public/data/[main-score]/Subscores/[sub-score]/` with its own `Frames/ Sounds/ Documentation/`. Owned by the main score (not a shared library score). **Sub-frames fetched on demand**; main-score frames stay inlined as today.
6. **`session-hold-until` = ALL named frames must be reached** (and each named frame's own holding period ended) before this frame's hold releases. **Rendezvous semantics (decided 2026-07-04):** a target counts once **any** line has reached that frame anywhere in the session and that frame's own holding period there has ended — tracked in a persisted session-global `reachedTargets` registry. The waiting line stays parked at its own frame; lines never need to converge on the barrier frame. **Reachability guard (decided 2026-07-16):** a missing target keeps the barrier parked only while at least one active, device-bearing, unparked line can still reach it. Dormant, retired, empty, or already-parked lines do not hold a `session-hold-until` target open; once no still-missing targets remain reachable under the current active lines, the barrier releases instead of deadlocking.
7. **`session-rejoin-at` = merge** converging lines into a single line (shared playhead, collective voting resumes) at the target frame. Normally paired with `hold-until` to act as a barrier.
8. **No reciprocal attributes.** Server builds the relationship graph at session-create / score-update; a validation pass runs before a score is used.
9. **v1 sub-sessions are plain** (no nested lines), but the data model + runtime must not preclude nested lines later (high-likelihood future).
10. **Backward compatible.** A score with no `session-*` markup behaves exactly as today: one line = the whole room.
11. **Empty lines go dormant & are revivable.** A line that loses its last device through **attrition** (→ 0 devices) goes **dormant**, not destroyed: it immediately **releases any barrier/rejoin waiting on it** (the awaited frame can no longer be reached — this timeout-free release is the primary deadlock guard) and clears its timers/voting, but **retains its frame, history, `subStack`, and pending coordination** so a later joiner can revive it (see #13). Revival is independent — it brings the line back into circulation (landing per the #13 fast-forward rule; the retained frame is the fallback) and **never re-arms a dependency that was already released**. *Structural* removals are different: the parent line at a split and lines absorbed into a survivor at a rejoin are **hard-retired** (gone, not revivable).
12. **Rider-only lines** (people present, none able to vote) are folded into the nearest votable line (confirmed). A lightweight SM **force-release** remains as a defensive valve.
13. **Late join & path revival.** A device joining (or an unknown `did` arriving) after the room has diverged is assigned via `smallestLineId` over **live votable ∪ dormant** lines (ties → earliest id). A dormant line has 0 devices so it is always the smallest ⇒ newcomers **revive dead paths first**, then balance across live lines. **Revival fast-forward (revised 2026-07-18):** a revived line does **not** resume its frozen (stale) position — it fast-forwards to the **latest track-group frame the room has reached** (tracked in a persisted `latestGroupArrival` record, updated on every main-flow grouped landing, cleared on SM-jump rewind), landing on that group's **least-occupied frame** so revivals fill missing track slots instead of doubling covered ones (ties → the recorded arrival frame, then group order). Leaving the frozen frame follows normal departure semantics (it is marked "done" in the reached registry); the landing re-evaluates the group's arrival barrier as usual. Fallbacks to the retained-frame revival of old: no grouped landing recorded yet, the recorded frame no longer resolves/is no longer grouped, or the line froze on a frame of that same group (it already holds a slot — it revives in place). Never assigned to a retired start/parent line. Dormancy already released a line's barriers (#11), so revival is **opportunistic, never a hold** — nothing ever waits for a revive.
14. **No-vote continuation fallback.** When a non-split Session Lines voting window closes with **no valid votes** and no retained in-window vote tally, the line is treated like a line of non-choosers and auto-continues by taking a default outgoing link from its current frame. For Session Lines, a valid vote is either explicit `stay` or one of the current frame's graph-derived outgoing vote ids; stale, malformed, or unresolved link ids are ignored. The default is chosen from the score graph's ordered `frameLinks` for that frame: one valid outgoing link is taken directly; multiple valid outgoing links are tie-broken randomly; no valid outgoing link means no synthetic winner is created and the line remains where it is (terminal/dead-end authoring is handled by validation/operator recovery). Explicit `stay` votes are preserved: if `stay` wins, the line stays. Split windows keep their existing child-line balancing behavior. Track-group windows keep the global STAY brake; if global `stay` does **not** win, a grouped line with no local link winner uses this same default outgoing-link fallback.

---

## Glossary

- **Line (flow):** an independent path through the score with its own playhead/voting/holding/history. A session has ≥1 lines.
- **Split:** a frame that divides one line into N child lines.
- **Rejoin / merge:** N lines converging into one at a named frame.
- **Track group:** a named set of frames that wait for each other's lines to arrive (arrival barrier), then run time-synchronized voting windows (tallied independently).
- **Hold-until (barrier):** a frame that pauses its line until other named frames have been reached by their lines.
- **Sub-session:** a line temporarily diving into a separate sub-score, isolated, then returning to the main flow.
- **Device:** one connected client (player or rider), identified persistently (see Device Identity).

---

## Markup reference (attributes live on the `<svg>` root of each frame)

| Attribute | Placement | Semantics (locked) |
|---|---|---|
| `session-split="N"` | main frame | Frame divides its line into N child lines; frame must expose N hrefs. Choice window → personal choice → auto-assign stragglers. A line may split again (nesting allowed). |
| `session-track-group="name"` | any frame | Frames sharing a name **wait for each other's lines to arrive** (arrival barrier — every populated line that can still reach a group frame must land on one; empty lines excluded), then begin/end voting windows together. Each line still tallies/resolves independently. |
| `session-hold-until="X,Y"` | any frame | This line holds at its current frame until **all reachable missing targets** among X and Y have been reached and ended those frames' holds. Supports sub refs like `Tetra2/E` only on the end node. A missing target is ignored only when no active, device-bearing, unparked line can still reach it, so dormant/empty/retired paths do not force a permanent hold. On a track-grouped frame, targets **must lie outside the frame's own group** (the arrival barrier already waits for those — validated); an out-of-group hold-until composes with the group wait (the group also waits for the blocked line). |
| `session-rejoin-at="X"` | source frame | Announces that the line standing here merges into one at frame X on its **next step** — X must be one of this frame's own links (validated, owner 2026-07-08). Multiple lines naming the same X merge there (on co-presence). May list multiple targets when several of the frame's links are merge frames — the line merges at whichever it navigates to. **Independent of `session-split`** (owner, 2026-07-08): the attributes may coexist on one frame with no count relationship — e.g. staged merges, 3 lines → 2 → 1. |
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

**Device identity (NEW requirement):** the server currently has no stable per-device id — a refresh creates a fresh connection and today just re-reads the session's single `currentIndex` ([bin/www:585](../bin/www#L585)). With lines, a refreshed device must rejoin **its** line. Plan: the moment a tab reaches the session, the client assigns it a UUID and persists it in **`sessionStorage`** (`did`), with an in-memory fallback if storage is blocked; from that point the tab is associated with that UUID. The `did` rides on every message (incl. `MSG_PING`/`MSG_NEED_DISPLAY`); the server keeps `deviceRegistry[deviceId] = lineId` so reconnects restore membership. (An unknown `did` is assigned per #13 — the smallest live-or-dormant line.) `sessionStorage` is per-tab (each tab of one browser is its own performer — `localStorage` would collapse them into one line) and survives refresh and mobile tab-eviction restore; a closed tab mints a new `did` and re-enters via #13. It also keeps the id off every HTTP request.

**Relationship graph** (built in `buildSVGContent` / on reload, [database.js:345](../database.js#L345)): while reading each frame, additionally parse the `<svg>` root for `session-*` attributes and record: split nodes (+N + their hrefs), track-group membership, hold-until targets, rejoin targets, sub-start (→ score + return href) and sub-end (→ score) mappings. Produce a normalized model the runtime consults (no reciprocal attributes needed). *As built:* the graph is **not persisted** — it is re-derived on every build/boot (the `toJSON` allowlist drops it), and since 2026-07-11 it is assigned for **every** score, vanilla included (the [score map](score-map.md) presents a vanilla score as a single-line session); orchestration still gates on `hasSessionLines`, which is set only when `session-*` markup exists.

---

## Validation (pre-use)

A validator runs before a score is used in a session (and is the basis for a future upload/lint check). Checks: split node's `N` matches its href count; every `hold-until`/`rejoin-at`/`sub-start` reference resolves to an existing frame/sub-score; **every `rejoin-at` target is one of its frame's own links** (the merge is the frame's next step — owner, 2026-07-08; no split×rejoin pairing rule exists, the attributes are independent); each `sub-start` score has a `START`, at least one `sub-end`, **and every landable sub frame keeps a path to a sub-end** (no stranded lines — decided 2026-07-07, in lieu of a runtime terminal-frame hardening); track-group consistency; **a `hold-until` on a track-grouped frame must not target frames of the frame's own group** (`hold-until-in-track-group`, error — the group's arrival barrier already waits for those; out-of-group targets are valid and compose — decided 2026-07-16); no obviously unsatisfiable barriers (best-effort). Surface results to the admin console (proposed "Validate score" action) and the dev console, mirroring today's console-based markup checking. **Hook points:** `initState`/`buildSVGContent` ([database.js:240](../database.js#L240), [database.js:345](../database.js#L345)) and `reloadScore` ([database.js:279](../database.js#L279)), invoked from session create/update in [routes/sm.js](../routes/sm.js).

---

## Runtime lifecycle

All voting/holding functions in [bin/www](../bin/www) currently take a `session`; they become **per-line** (take a `line` within a `session`). Messaging helpers gain a per-line variant.

1. **Session start.** One line `L0` at a `START`/`PRE` frame ([database.js:294](../database.js#L294)). All devices join `L0`. Identical to today until a split occurs.
2. **Line-scoped voting.** `countVoteForSession` → `countVoteForLine`: tally `conn.currentVoteTo` only over connections with `conn.lineId === line.id` ([bin/www:213-252](../bin/www#L213-L252)). `startVoting/stopVoting/holding` operate on the line; `MSG_BEGIN_VOTING`, `MSG_UPDATE_VOTING`, `MSG_SHOW`, `MSG_BEGIN_HOLDING` are sent only to that line's connections via a new `sendToLine()` (filter on `conn.lineId`). Session Lines only counts `stay` or link ids matching the line's current outgoing links; stale/malformed link ids are ignored. If a non-split Session Lines line closes with no valid votes and no retained `_lastVoteCounts`, `countVoteForLine` synthesizes a `winningVoteId` from the current frame's ordered outgoing links (`graph.frameLinks[frameNameForLine(session,line)]`) so the line auto-continues instead of falling back to `currentIndex`; no valid outgoing link leaves it in place.
3. **Split.** Line reaches a `session-split="N"` frame → open a choice window (voting-duration based). Devices tap → recorded as their chosen child path. At window end: create N child lines, distribute choosers to the child line matching their tap, **auto-assign non-choosers** (balance/default), **hard-retire** the parent line (structural — not dormant). Each child then runs its own lifecycle.
4. **Track group.** *(a) Arrival barrier (decided 2026-07-16):* a line landing on a frame in group G parks (`isGroupWaiting`, hold-until banner reused) while any populated line that can still reach a G frame hasn't arrived, or any arrived line is still hold-until-blocked. The wait is re-checked on every landing, dormancy, hold-until release and SM jump (reachability over `graph.frameLinks`; empty lines excluded) and releases all parked G lines together — no timers. First device joining an empty/dormant line on a G frame re-parks it (`ensureLineAssignment`); a line arriving after the group released joins the running round truncated. *(b) Synchronized voting:* when any unparked line whose current frame is in G starts voting, the server starts the voting window for **all** lines currently sitting on a frame in G (synchronized start/end; parked lines excluded). Tallies remain per-line. At close, a global-max `stay` still makes every grouped line stay; otherwise each line takes its own link winner, falling back to its own default outgoing link when it has no local link winner. *(c) Split composition (decided 2026-07-17):* a grouped `session-split` frame still **divides** its line when the group advances — the group close delegates it to the split path (choosers land on their tapped child, stragglers are balanced across the children), never a whole-line link/default advance; a global `stay` brakes it un-split like any other grouped line. The group check runs before the split check at window close, so the outcome does not depend on whose synchronized window closes first.
5. **Hold-until (barrier).** On arrival at a `hold-until="X,Y"` frame, the line enters holding with `pendingHoldUntil={X,Y}`. The server marks targets satisfied as lines reach X and Y (and finish those holds). When the set is empty, release the hold and proceed. If a target remains missing but no active, device-bearing, unparked line can still reach it (main-flow reachability, or qualified sub-score reachability via `Subscore/Frame.svg`), it no longer keeps the barrier open; the barrier releases once no still-missing targets are reachable. *(Rendezvous, decided 2026-07-04: "reached" lives in the persisted session-global `reachedTargets` registry — `arrived` on landing, `done` when that frame's own hold ends; barriers release on `done`. On release, a single paired `rejoin-at` target auto-advances + merges the released lines there; multiple targets are left to the line's route vote, with the merge happening on arrival.)*
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
- **History / rewind:** the FigJam "Session manager history modal behavior" table defines the rules: a track-grouped frame shows that device's line frame and jumps it back; **frames not in any track group make per-line history "impossible" while 2+ populated lines sit diverged on them**. Decided 2026-07-07 (details in [session-lines-open-items.md](session-lines-open-items.md)): the FigJam's "revert to track group" phrase means **reading (i) — a fallback checkpoint**. The score map now implements that as a **room-wide checkpoint rewind**: `MSG_SELECT_HISTORY {group}` recomputes common checkpoints server-side and moves every non-retired line to its own most recent frame in the target track group (lines with no such entry take the group's least-occupied frame; dormant lines move but stay dormant; sub lines first exit back to their saved main history). A **single populated line is an undiverged room** (S6): per-line history is available anywhere on the main flow (lines are git branches; one branch always rewinds safely). Every SM jump/room rewind on a session-lines score starts a **new reached generation** (registry restarted, so barriers met after the rewind gate like first passes — except barriers at the landing frames, which stay unlocked) and **un-parks** moved lines.
- **SM visibility (implemented):** per-line device counts / frame occupancy ship two ways: the line-distribution panel on the session page (admin-only, `payload.lines` on `MSG_SHOW_NUMBER_CONNECTION`, refreshed on every line landing), and the standalone **live score map** (`/session/:id/map` — full score DAG with per-line badges, barrier/sub state, history trail and a right-click rewind menu; works for vanilla scores as a single line). See [score-map.md](score-map.md).

---

## Client & display changes (verified against client code)

The client renders whatever frame/voting state the server addresses to it, so **most client code is line-agnostic** — the bulk of the work is server-side per-line addressing, plus these targeted client changes:

- **Per-line show needs no client change.** `parseMessage` ([session.js:56](../public/javascripts/session.js#L56)) handles `MSG_SHOW`→`showImageAtIndex` ([session.js:312](../public/javascripts/session.js#L312)), which shows `#MainContent svg[id="svgN"]` and hides the rest. The client just shows whatever index its line is told.
- **Stay/winning glow needs NO client change.** The glow follows the server's `winningVoteId` ([voting.js:111](../public/javascripts/voting.js#L111); [voting.js:201](../public/javascripts/voting.js#L201) already handles `winningVoteId==="stay"`). The whole stay rule is implemented server-side by setting each line's `winningVoteId`.
- **Device identity.** On session load, `ensureDeviceId()` generates+persists a UUID in **`sessionStorage`** (`did`, in-memory fallback if blocked) — created the moment the tab reaches the session and reused for it thereafter (per-tab, so multiple tabs on one browser are distinct performers). Add `did` to the `sendToServer` payload ([ws-client.js:148](../public/javascripts/ws-client.js#L148)); send on `MSG_PING`/`MSG_NEED_DISPLAY`. Generate it client-side (not baked into the shared, apicache-cached `${id}.html`). The reconnect path already re-pings ([ws-client.js:44](../public/javascripts/ws-client.js#L44), [ws-client.js:70](../public/javascripts/ws-client.js#L70)), and `sessionStorage` persists across refresh/eviction restore, so membership restores automatically.
- **Split tap** reuses `handleSelectLink`→`MSG_TAP` ([voting.js:33](../public/javascripts/voting.js#L33)); the server interprets taps as line choices during the split window (optional "choose your path" labeling).
- **Sub-frames.** Inject fetched sub-`<svg>` into `#MainContent` and extend `showImageAtIndex` to address them (sub-frame id scheme). Audio already lazy-loads (Howler `preload:false`); expose each sub-score's sound list per line.
- **SM live controls** (hold/pause/history/global-refresh) live in the **session page** admin UI ([session.js:28-41](../public/javascripts/session.js#L28-L41)), not `routes/sm.js`. *(2026-07-19: the implicit bound-line jump was retired for session-lines rooms — the history dropdown is a read-only trail display there (`available:false` always); rewinds live in the [score map](score-map.md): room-wide by track-group checkpoint (`{group}`) or one targeted line within its own trail (`{lineId, selectedIdx, frame}`, main flow or its current sub dive). Vanilla scores keep the `MSG_SELECT_HISTORY {selectedIdx}` jump.)*

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
- **History-modal checkpoint UX:** the reading-(i) fallback-checkpoint operation is implemented in the [score map](score-map.md) first (right-click a checkpoint group frame → room-wide rewind); since 2026-07-19 the implicit bound-line jump is retired and the map also offers an explicit line-TARGETED rewind (open-items row 7: within the line's own trail, sub-aware, registry untouched, "passed ⇒ arrived" group excusal). The session-page version — offering the same operations from the dropdown — can still be designed later.
- **Admins populate lines (L3) — DECIDED 2026-07-18:** an admin is a **player with extra tools** — admin session-page connections count as line population everywhere (they can tap/vote; remedies for an idle admin's line are the admin's own tools: tap forward, force-release, close the tab). **Exception (same day): the score-map page's connection is an observation tool, never population** — it announces itself (`mapView` on the ws envelope → `conn.isMapView`) and is excluded via `performerLineConnections` from player/rider counts, group/hold-until waits, attrition, dormant revival, adoption parking, split membership and `smallestLineId` balancing (it keeps a line binding only so history/graph payloads can be addressed). A line holding only map tabs goes dormant like an empty one.

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
- **SM:** verify pause/global-refresh across lines and that session-lines rooms rewind only from the map — room-wide by checkpoint or one targeted line (dropdown read-only, implicit `{selectedIdx}` refused server-side).
