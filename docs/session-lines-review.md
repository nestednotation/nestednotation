# Session Lines — Code Review vs Requirements (local ↔ develop)

> **Scope:** working tree of `feat/session-lines-v2` (commits `568e59e`…`b0f34e8` + uncommitted Chunk-M work) diffed against `develop` (merge-base `75196ee`), verified against [session-lines.md](session-lines.md) and [session-lines-implementation.md](session-lines-implementation.md).
> **Test status at review time:** `npm test` → **75 passed, 0 failed** (incl. the vanilla baseline byte-diff guard).
> **Reviewed:** `lib/session-lines/*` (parse, graph, validate, routing, line, orchestrator), `database.js`, `bin/www`, `routes/session.js`, `constants.js`, `views/session.jade`, `public/javascripts/{session,ws-client,audio-player}.js`, tests, CLI tools.

---

## ⚡ Fix status (updated 2026-07-03)

All findings below have been **fixed in the working tree** except:
- **H1** — left in place per instruction (revert manually before commit).
- **S2, S6, L3, L5, L6** — deliberately NOT changed; they are spec-interpretation / design questions for the requirement owner, not clear-cut bugs. **S7** — ✅ DECIDED + implemented 2026-07-17 (grouped split divides balanced; see S7 row).
- **S1** — ✅ DECIDED by the requirement owner (2026-07-04): **rendezvous**. Implemented same day (see S1 row); tests updated (80 pass). **S3** — partially addressed by the same change (multi-target rejoin = route vote on barrier release).

Post-fix verification: `npm test` → **78 passed, 0 failed** (3 new tests: split registry sweep, barrier sub-ref coverage, sub history preservation); vanilla baseline still byte-identical; server boot smoke test (alt ports) → HTTP 200, state reload + validation hook clean. Each fixed item below is tagged **✅ FIXED** with what was done.

---

## Verdict in one paragraph

The implementation matches the spec's architecture faithfully: lines are first-class (`BMLine`), everything is gated on `hasSessionLines`, vanilla scores are provably byte-identical (baseline guard), device identity / late-join / dormancy-revival follow decisions #11–#13, split auto-balance, group-wide STAY, and the decoupled sub-session `href` return all follow the locked decisions. However, I found **4 high-severity bugs** (one is a must-fix dev leftover that breaks every deployment), **6 medium issues**, and a handful of spec deviations/gaps that need either a fix or a sign-off from the requirement owner before Phase 4 close-out.

---

## 🔴 High severity

### H1. ⚠️ NOT FIXED (per instruction) — Hardcoded LAN WebSocket URL — breaks every real deployment
`database.js:108` — `develop` has `` const wsPath = `wss://${serverIp}` ``; the branch replaced it with:

```js
const wsPath = `ws://192.168.0.2:2382`;
```

Obvious local-testing leftover baked into every generated session page. **Must be reverted before commit/merge.**

### H2. ✅ FIXED — A reconnecting device can be bound to a hard-retired line → repeated splits

> **Fix:** `ensureLineAssignment` now discards retired lines from the registry lookup and its final fallback prefers non-retired lines; `lineForConn` never resolves to a retired line; `applySplit` sweeps offline `deviceRegistry` entries off the parent onto the smallest child (new unit test).
- `ensureLineAssignment` (`bin/www:253-258`) resolves `deviceRegistry[did]` with `session.lines.find(l => l.id === lineId)` and **never checks `line.status`**.
- `applySplit` (`lib/session-lines/orchestrator.js:349-355`) re-registers only the *currently-connected* members; unlike `applyRecombine` (`orchestrator.js:392-397`) it does **not** sweep `deviceRegistry` for offline devices still pointing at the parent.

So a device that is offline during a split reconnects onto the **retired parent line** — spec #13 explicitly says "never assigned to a retired start/parent line". Worse: the parent still sits on the split frame, so the device's tap opens voting on the retired line → `stopVotingForSession` → `isSplitFrame` → `resolveSplit` runs **again** on the retired parent and spawns a fresh set of child lines every time this happens.

Same family: `lineForConn`'s fallback (`bin/www:242`) is `|| session.lines[0]` — after L0 splits and retires, an unassigned connection falls back to the retired L0.

**Fix:** skip `status === "retired"` lines in both `ensureLineAssignment` and the `lineForConn` fallback (fall through to `smallestLineId`), and/or sweep `deviceRegistry` in `applySplit` the way `applyRecombine` does.

### H3. ✅ FIXED — A page refresh can permanently force-release a barrier

> **Fix:** attrition is debounced by an 8 s grace timer (`ATTRITION_GRACE_MS`): dormancy/barrier-release only finalize if no device reclaims the line within the window; `ensureLineAssignment` cancels the timer on any (re)assignment; `finalizeAttrition` re-verifies session/line/connection state before acting.
`handleConnectionClose` (`bin/www:669-706`) marks a line **dormant the instant its last socket closes** and calls `tryReleaseBarriers`. A refresh (or a mobile network blip — the reconnect backoff is 1–5 s) is a close followed by a reconnect seconds later. During that gap:

- the line is dormant, so `someoneComing` (`bin/www:581-586`) no longer counts it → any barrier the *other* lines are parked at is **force-released**;
- per spec #11 the release is deliberately irreversible ("revival … never re-arms a dependency"), so when the device reconnects 2 s later the coordination is already gone.

**Fix:** debounce attrition — start a short grace timer (5–10 s) on last-device-close and only go dormant/release if no reconnect claims the line in time.

### H4. ✅ FIXED — Returning from a sub-session shows the wrong frame and then blocks taps

> **Fix:** new `isSubEndFrame(session, line)` guard; the delayed plain `MSG_SHOW` is now suppressed on sub-end arrivals in both `stopVotingForSession` and the `MSG_TAP` instant-advance path (mirroring the existing `isSubStartFrame` guards) — the display is driven solely by `MSG_SUB_EXIT`.
When a vote lands a sub line on its `session-sub-end` frame, `stopVotingForSession` sends a **delayed** `MSG_SHOW` (`bin/www:1182-1188`, +`preloadDuration` = 1100 ms) carrying the **sub-list index** — the guard there only checks `isSubStartFrame`, not sub-end. Then `afterLineArrived → exitSubSession` (`bin/www:476-496`) sends `MSG_SUB_EXIT` at `t=0` with the main landing index. Client order (see `onWsMessage` scheduling, `ws-client.js:115-122`):

1. `MSG_SUB_EXIT` — exits sub view, shows the landing frame ✅
2. 1.1 s later the stale delayed `MSG_SHOW` fires, now in **main** context, with the **sub** index → wrong main frame is displayed, and `window.currentIndex` is set to a value that no longer matches `line.currentIndex` → **every subsequent tap is rejected** by the server's `cid !== line.currentIndex` check (`bin/www:1362`).

**Fix:** add an `isSubEndFrame` guard next to `isSubStartFrame` so the plain SHOW is suppressed when the landed frame is a sub-end (the display is driven by `MSG_SUB_EXIT`).

---

## 🟠 Medium severity

### M1. ✅ FIXED — Barrier state does not survive a server restart

> **Fix:** `isBarrierWaiting` added to `LINE_FIELDS` (persists); new lazy `rehydrateBarriers(session)` rebuilds `_barrier.byFrame` from persisted line state on the session's first message after a restart, then schedules a deferred `tryReleaseBarriers` after the grace window (immediate evaluation would see zero reconnected devices and force-release).
`session._barrier` is transient and never rebuilt on load; `isBarrierWaiting` is not in `LINE_FIELDS` (`lib/session-lines/line.js:21-50`) so it serializes away. After a restart, lines that were parked at a barrier resume un-parked (taps allowed, barrier forgotten) while their persisted `pendingHoldUntil` sits stale. The spec's Persistence section says lines *and pending coordination* must be restored. **Fix:** rebuild `_barrier.byFrame` from `line.pendingHoldUntil` + current frame in `loadStoredSessionStates` (or on first arrival after load).

### M2. ✅ FIXED — Cross-line state leaks in `MSG_NEED_DISPLAY` / `MSG_PAUSE` broadcasts

> **Fix:** on session-lines scores, the `MSG_NEED_DISPLAY` tail sends `MSG_CHECK_HOLD`/`MSG_PAUSE` to the requesting device's line only, and admin pause/unpause sends each active line its **own** `currentIndex`. Vanilla path is untouched (still `sendToAllClients`, byte-identical).
Pre-existing session-wide broadcasts now carry **one line's** state to **all lines**:
- `bin/www:1493-1501` — every `MSG_NEED_DISPLAY` broadcasts `MSG_CHECK_HOLD {isHold: thatLine.isHolding}` and `MSG_PAUSE {showIdx: thatLine.currentIndex}` to the whole session. The client's pause handler (`session.js:187-192`) calls `showImageAtIndex(showIdx)` — so **any device reconnecting anywhere yanks every other line's display to its own frame index** (and devices inside a sub get a main-flow index applied in sub context).
- `bin/www:1540-1550` — admin pause/unpause broadcasts the *admin's* line index to all lines the same way.

Harmless with one line (why the baseline stays green), actively wrong once diverged. **Fix:** scope these per line (send each line its own `showIdx`), or per connection.

### M3. ✅ FIXED — Two sub-scores can be visible at once

> **Fix:** `showImageAtIndex`'s sub path now matches on the full DOM id (`sub-<name>-<idx>`), so frames of any other injected sub stay hidden.
`showImageAtIndex` sub path (`session.js:569-575`) selects `#SubSVGContent svg[id^="sub-"]` and unhides by **trailing index only** — after a device has visited sub A and later enters sub B (both stay injected), `sub-A-2` and `sub-B-2` are both unhidden. **Fix:** scope the query to `` `svg[id^="sub-${ctx.name}-"]` ``.

### M4. ✅ FIXED — Admin history jump while a line is inside a sub → crash risk

> **Fix:** `MSG_SELECT_HISTORY` is refused server-side while `line.subStack.length > 0`; `jumpScoreForSession` bails on unknown/unresolvable history entries; the `messageHandle(...)` invocation now has a `.catch()` so no message error can become a fatal unhandled rejection.
`jumpScoreForSession` (`bin/www:1248-1251`) resolves the history entry against the **main** `listFilesInLowerCase`, but a sub line's history holds sub frame names → `indexOf` = -1, or `history[value]` is `undefined` → `TypeError` inside the un-caught async `messageHandle` (`bin/www:151-153`) → **unhandled rejection, which kills the process on Node ≥ 15**. The client disables the select via `available:false`, but that's not server-enforced and races exist. **Fix:** reject `MSG_SELECT_HISTORY` when `line.subStack.length > 0`, and wrap the `messageHandle(...)` call in a `.catch()`.

### M5. ✅ FIXED — `session-hold-until` sub refs (`Tetra/E`) are never satisfiable at runtime

> **Fix:** `BMLine` records qualified `score/frame` visits in a new persisted `visitedSubFrames` list while inside a sub; `barrierCoveredTargets` matches `/`-qualified targets against those visits (bare targets still match main-flow history). New unit test.
Spec markup table says hold-until "supports sub refs like `Tetra2/E`" and the validator resolves them (`lib/session-lines/validate.js:100-121`) — but the runtime coverage check `barrierCoveredTargets` (`orchestrator.js:111-121`) matches targets against `line.history`, which only ever holds **bare frame filenames** (and sub history is wiped on exit, see M6). A barrier naming `Sub/Frame` therefore waits until the attrition force-release fires. Authors will write it because the validator passes it. **Fix:** record qualified names (or track sub-frame arrivals separately), or reject sub refs until supported.

### M6. ✅ FIXED — `enterSub`/`exitSub` wipe the line's main-flow history

> **Fix:** `enterSub` saves `{history, historyIndex}` onto a new persisted `savedHistories` stack (parallel to `subStack`, so it nests); `exitSub` restores it and the return landing is appended on top. New unit test covers the round-trip.
`lib/session-lines/line.js:147-160` — both transitions do `this.history = []`. After one sub round-trip the line's entire pre-sub history is gone: barrier targets travelled through *before* the dive are no longer covered (`barrierCoveredTargets`), and the SM history modal loses everything. Spec #11 expects lines to retain history. **Fix:** stash main history on `enterSub` and restore it on `exitSub` (append the landing).

---

## 🟡 Spec deviations / gaps to confirm with the requirement owner

| # | Where | Deviation |
|---|-------|-----------|
| S1 | ✅ DECIDED + FIXED (2026-07-04) | Owner decision: **rendezvous** is the requirement. Implemented: persisted session-global `session.reachedTargets` registry (`arrived` on landing → `done` when that frame's own holding period ends — the "holds ended" clause is now enforced); `recordArrival`/`recordHoldEnded` in bin/www feed it (sub frames as qualified `score/frame` refs); `orchestrator.registryCoveredTargets` replaces the convergence-based `barrierCoveredTargets`. Barriers release wherever the reaching lines are — parked lines never need to converge; mutual barriers (FigJam E⇄F⇄G) now release instead of deadlocking. |
| S2 | ✅ FIXED (2026-07-16) | Hold-until's deadlock guard is now target-aware: a missing target keeps the barrier parked only while it is reachable by at least one active, device-bearing, unparked line. Dormant, retired, empty, and parked lines do not keep a target open; qualified sub refs use the sub-score graph. |
| S3 | partially fixed (2026-07-04) | Barrier-paired rejoin now keeps the FULL target list (`entry.rejoinAll`): a single target auto-advances + merges on release (Barrier→DONE pattern); **multiple targets release without advancing — the line votes its route and merges on arrival at the chosen target** (bare rejoin). Remaining: the "with split" pairing (children distributed across listed targets) is still not implemented. |
| S4 | ✅ FIXED (partially) | Validation now runs inside `buildSVGContent` (i.e. on every session create/update/reload) and logs errors/warnings to the server console, non-blocking. Remaining (UI work): surfacing results in the admin console. |
| S5 | ✅ FIXED | `buildSVGContent` now clears `this.graph`/`this.hasSessionLines` when a reloaded score has dropped its `session-*` markup. |
| S6 | `bin/www:715-724` | `historyAvailable` returns `false` for a single, never-split line sitting on any non-grouped frame — on a session-lines score, admin history is disabled from the very first frame even though nothing has diverged. Literal FigJam reading; confirm intent. |
| S7 | ✅ FIXED (2026-07-17) | A frame that is both `session-split` and in a track group used to resolve differently depending on whose synchronized window closed first (another grouped line's close moved the split line whole to a default link — no split, no balancing). Now: `stopVotingForSession` checks the group before the split, and `resolveGroupVoting` delegates split-frame lines to `resolveSplit` (choosers to their pick, stragglers balanced) unless a global `stay` brakes the group. |

---

## 🔵 Low / minor

- **L1.** ✅ FIXED — split choice window now falls back to `DEFAULT_SPLIT_CHOICE_DUR` (10 s) whenever the resolved duration would be 0, including when `session.votingDuration === 0`.
- **L2.** ✅ FIXED — sub sound listing now normalizes **all** path separators (`/\\/g`). (Directory entries in the listing mirror the main `getSoundList` behavior and were left as-is; `readdir recursive`'s Node ≥ 18.17 requirement still worth noting in the README.)
- **L3.** Line balancing counts **admin connections as devices** (`routing.js:44-72`, `resolveSplit` members, attrition check): an admin tab parked on a line skews `smallestLineId`, gets split into child lines, and keeps a player-less line from ever going dormant. *(Not changed — needs a decision on how admins should ride lines.)*
- **L4.** ✅ FIXED — `resolveGroupVoting` tallies each line once (`countsByLine` map) and reuses the same counts for the group-stay decision and the per-line link winner.
- **L5.** Grouped lines that were *not* voting when the group resolves get forced into standby + a stay-glow `MSG_UPDATE_VOTING` (`resolveGroupVoting` doesn't skip `!isVoting` lines); and a line arriving at a grouped frame mid-window opens its own later window, so the group can resolve twice. Acceptable approximation of "begin/end together", but worth knowing.
- **L6.** `public/data/Session Lines Demo (broken)/` ships broken fixture frames at the top level (no `Frames/` folder) — fine for validator testing, but confirm it's meant to be committed to `public/data`.

---

## ✅ What checks out (verified, no action)

- **Backward compatibility:** every runtime branch is gated on `session.hasSessionLines`; baseline test byte-diffs a vanilla build — green. Single-line invariant holds through the `BMLine` refactor (shim + delegation).
- **Persistence:** v2 allowlist `toJSON` + `migrateState` v1→v2 + `patchState` rehydration of `BMLine[]` are correct (round-trip covered by `test/line.test.js`); timers/`isVoting` correctly never serialize.
- **Device identity:** `ensureDeviceId` (localStorage + in-memory + non-secure-context UUID fallbacks) matches the plan; `did` rides every envelope; reconnect restores line membership.
- **Split (#2):** choice window forced even on zero-vote frames, choosers honored, stragglers balanced into the smallest bucket, parent hard-retired, votes reset — matches the locked decision (modulo H2's offline-device hole).
- **Track group + STAY (#3):** synchronized windows with the initiator's duration, per-line link tallies, single global-max stay override, glow driven purely by `winningVoteId` server-side — matches.
- **Sub-sessions (#4, #5):** decoupled `href` return, `Subscores/<sub>/` layout, on-demand `${id}.subs.json` + cached route, `subStack` nesting-ready, sub sounds routed to the sub's `Sounds/` dir.
- **Rejoin (#7):** lowest-id survivor keeps history; absorbed lines hard-retired; `deviceRegistry` swept (for rejoin — see H2 for split).
- **Dormancy/revival (#11, #13):** dormant lines stay in `lines[]`, are always smallest for newcomers, revive on assignment; structural retirements are distinct.
- **SM (Chunk M):** global hold across active lines, per-line history modal with room-wide availability flag, barrier force-release valve, per-line device distribution panel — all present and covered by `test/sm-controls.test.js`.

---

## Remaining actions

1. **H1** — revert the `wsPath` hack (one line; deliberately left unfixed — do this before any commit).
2. Take the remaining open **S-table** items to the requirement owner: **S3 remainder** (rejoin-at "with split" pairing), **S6** (history disabled pre-split on non-grouped frames), plus **L3** (should admin tabs count as line devices?) and **L5/L6**. **S2 is fixed** by target-aware hold-until reachability. **S7 is fixed** (grouped split divides balanced, 2026-07-17).
3. Admin-console surfacing of validation results (S4's UI half).
4. Manual multi-tab E2E (Chunk N): split → track-group → barrier → rejoin → sub round-trip → refresh-restores-line, now incl. the fixed paths (refresh during a barrier, reconnect after a split, sub exit taps).
