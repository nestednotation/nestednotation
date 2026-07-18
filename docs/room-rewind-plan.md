# Room-wide checkpoint rewind — implementation plan

Status: **IMPLEMENTED 2026-07-18**. Implements open-items
item 1 (decision ① of 2026-07-07: history "revert to track group" = reading (i)
fallback-checkpoint; the modal/map is a **room-wide rewind tool**). Companion
context: [score-map.md](score-map.md), [session-lines-open-items.md](session-lines-open-items.md).

**Revised 2026-07-19**: the IMPLICIT bound-line `{selectedIdx}` rewind was
retired for session-lines rooms ("keep the per-line entries" below is
superseded). The server refuses `{selectedIdx}` when `hasSessionLines`, always
pushes `available:false` (the SM dropdown is a read-only trail display), and
`historyAvailability` was deleted. Vanilla scores keep the per-step jump —
their single playhead is the room. **Later the same day an EXPLICIT
line-targeted rewind was added** (`{lineId, selectedIdx, frame}` →
`lineRewind`; registry + `latestGroupArrival` untouched; "passed ⇒ arrived"
group excusal; sub-aware) — see
[session-lines-open-items.md](session-lines-open-items.md) row 7.

## Problem

Rewind today is per-line: `MSG_SELECT_HISTORY {selectedIdx}` →
`jumpScoreForSession(session, lineForConn(conn), idx)` moves ONLY the
connection's bound line, and the map menu offers only that line's visited
frames. Live-room example (session 1784325634350, 2026-07-18): map tab bound to
L2 could rewind to T but **not to U** — U is in L1's trail. U and T are both in
track group `RTU`, i.e. "L1@U / L2@T" was a synchronized **room moment**; the
correct operation is "rewind the room to ⟨RTU⟩", moving every line to its own
frame there. That operation is now exposed from the score map's context menu
and handled server-side via `MSG_SELECT_HISTORY {group}`.

## Semantics (proposed defaults; owner may override the ⚠ ones)

1. **Checkpoint** = a track group for which EVERY currently-populated line's
   trail (`history[0..historyIndex]`, case-insensitive) contains one of the
   group's frames. ⚠ Groups passed by only some lines (e.g. `IJK` in the live
   room — L1 went G→I→L while L2 went H→M) are NOT checkpoints (FigJam "every
   line passed" reading).
2. **Landing rule per line**: its own most recent trail occurrence of a frame
   of the target group (history truncation falls out of `setCurrIdxTo`).
   Lines with no such entry (child born later, no history): the group's
   **least-occupied frame** (reuse the occupancy logic of
   `orch.revivalLandingFrame`).
3. **Mid-sub lines**: force `exitSub` loop first (restores saved main history —
   same pattern as `fastForwardRevivedLine`), then apply the landing rule.
   Per-line rewind refuses in-sub; a room-wide rewind cannot skip one line.
4. **Dormant lines**: reposition like any line, stay dormant. (Revival
   fast-forward will land future joiners on the re-armed `latestGroupArrival`
   group anyway — keep both consistent.)
5. **Availability**: NOT gated on `historyAvailable` — rescuing a diverged /
   wedged room is the point. Only requirement: ≥1 common checkpoint. Admin-only
   (the `MSG_SELECT_HISTORY` branch already sits below the `isAdmin` guard in
   `messageHandle`).
6. ⚠ **Offered targets**: all common checkpoints, newest-first (the literal
   reading-(i) decision says only the LAST one — default to all, easy to
   restrict). Loops: count only each line's latest occurrence per group (v1).

## Protocol

- **No new message constant.** Extend `MSG_SELECT_HISTORY` inbound payload:
  `{group: "RTU"}` (presence of `group` ⇒ room-wide path; `{selectedIdx}` keeps
  the per-line path byte-identical). Server recomputes checkpoints on receipt —
  never trust the client's list.
- **No new server→client message needed**: the map computes the checkpoint list
  client-side from `lines[].mainTrail || lines[].trail` in the existing
  `MSG_SHOW_NUMBER_CONNECTION` payload + `graph.groups` (already in
  `GET /session/:id/graph`).

## Server changes (`bin/www` + `lib/session-lines/orchestrator.js`)

Implemented PURE orchestrator fns (unit-testable, no transport):

- `commonCheckpoints({lines: [{id, trail}], groups})` → ordered
  `[{group, byLine: {lineId: frameName}}]`, newest-first (order by each
  line's max trail index of its group entry). Excludes groups missing from any
  populated line's trail (rule 1); `byLine` omits no-entry lines (they take the
  fill rule).
- `roomRewindPlan(...)` → per-line `{lineId, frame,
  source: "history"|"fill"}` including the least-occupied fill.

New `bin/www` `roomRewind(session, group)` — mirrors `jumpScoreForSession`
but once-per-room where it matters:

1. Guard: `session.hasSessionLines`, group resolves, checkpoint exists.
2. Per line (active + dormant, skip retired): cancel voting/holding/standby
   timers (`cancelHoldingTimer`/`cancelVotingTimer`, clear `standbyTimer`);
   capture pre-jump parked frame; force-exit subs (rule 3).
3. **One** `orch.beginReachedGeneration(session, unionOfLandingTargets)` —
   union of `holdUntilTargets` of ALL landing frames (the per-line jump's
   carve-out, generalized: the room already passed the checkpoint, so barriers
   AT the landing frames stay unlocked; everything else gates as new).
4. Per line: `line.isGroupWaiting = false` + `orch.unparkLine`; if it was
   parked, `MSG_BARRIER_RELEASED {frame: parkedAtFrame}` to its devices (R4 —
   otherwise the "waiting…" banner sticks); `line._lastReachedRef = null`;
   `line.historyIndex` → its landing entry; `line.setCurrIdxTo(landingIdx)`;
   `recordArrival(session, line)`.
5. Re-arm `session.latestGroupArrival = {frame: <any landing frame of the
   group>, at: Date.now()}` (rewind is the room's newest position of record —
   same rationale as the per-line jump's re-arm).
6. Do NOT park at the landing group (SM jump is authoritative — mirrors the
   per-line carve-out); then `tryReleaseBarriers` + `tryReleaseGroupWaits`,
   `saveSessionStateToFile`, `notifyAdminsBarriers`, `pushAdminHistory`,
   `updateNumberOfConnectionForSession`, and per line (unless `isPause`)
   `sendToLine(..., MSG_SHOW, {showIdx})` with the preload delay.

`messageHandle` `MSG_SELECT_HISTORY` branch: `if (messageData.group &&
session.hasSessionLines) → await roomRewind(...)` BEFORE the existing in-sub /
`historyAvailable` refusals (those guards are per-line-path only; rule 5).

## Client changes (`public/javascripts/session-map.js`)

- Compute checkpoints from `lastLines` trails + the graph's groups (both
  already on the client).
- Context menu: on any frame of a group that is a common checkpoint, add a
  "⏪⏪ rewind ROOM to ⟨group⟩" button — enabled even when per-line entries are
  disabled (`available === false`) — with its own confirm dialog; sends
  `MSG_SELECT_HISTORY {group}`. Keep the per-line entries as-is (and fix their
  misleading confirm text "moves the room" → it moves one line).
  *[Superseded 2026-07-19: the per-line entries were removed — see the status
  note at the top.]*
- v1 is map-only; the session-page modal version of reading-(i) can come later
  (map is the natural home per score-map.md).

## Docs updated

`score-map.md` (menu + message table), `session-lines.md` (runtime + open-items
row), `session-lines-open-items.md` item 1 → implemented, this file's Status.

## Tests / verification

- Unit: `commonCheckpoints` against the live-room shape — trails
  `L1=[B,D,F,G,I,L,P,S,U,V]`, `L2=[C,E,H,M,Q,T,W]`, groups of
  `-test- Session lines 2` → checkpoints `[VWY?, RTU, LMO, GH, EF, BC]` (VWY
  only if current frames count), `IJK` excluded; a no-entry line takes the
  fill; loop → latest occurrence.
- Headless E2E (pattern proven in this repo, see memory / previous sessions):
  craft a throwaway session json cloned from a real one (⚠ RESET
  `isHolding`/`isStandby`/timers — a mid-hold snapshot restores a zombie hold
  with no timer that refuses taps), boot `node ./bin/www` with alt
  `PORT`/`WS_PORT` env, drive with `node_modules/websocket` W3CWebSocket as
  admin (`sig` = adminPassword, envelope `{sid,cid,sig,msg,did}`): PING →
  NEED_DISPLAY → `MSG_SELECT_HISTORY {group:"RTU"}` → assert the
  `MSG_SHOW_NUMBER_CONNECTION` push has L1@U + L2@T with truncated trails, and
  per-line MSG_SHOW showIdx. Kill the alt server + delete the throwaway
  `server_state/<id>.*` after.
- `npm test` stays green (117); no jade/built-HTML changes ⇒ baseline
  untouched.

## Gotchas for the implementing session

- `npm start` = plain node, NO watcher → restart the dev server to load server
  changes; session-map.js is a cached static asset → hard-refresh the map tab.
- `database.js` carries a local-only `wsPath` LAN-IP dev hack — do NOT commit.
- The per-line `jumpScoreForSession` stays; factor shared pieces (un-park +
  banner release, generation seeding) only if it stays readable — duplication
  is acceptable, silent behavior drift of the per-line path is not.
- This plan builds on the (currently uncommitted, 2026-07-18) `lines[]`
  `trail`/`checkpoint` payload fields and the voting/holding push points —
  land those first.
