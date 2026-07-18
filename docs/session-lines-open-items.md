# Session Lines — Open-Item Conclusions (DECIDED)

> **Written:** 2026-07-04, after the S1 decision (rendezvous barriers) was implemented.
> **Decided by the requirement owner 2026-07-07** — every checklist item at the bottom
> is answered, and everything implementable without the modal UI landed the same day
> (see "Decisions & implementation status" below).
> **Purpose (original):** recommendations for the two remaining barrier/rejoin open
> items, informed by the FigJam **"Session manager history modal behavior"** section
> (node `174-419`): the 27-row a…a-prime table plus the owner-supplied PDF export,
> whose "sample markup graph 2" sketch shows the a…b′ score as alternating
> grouped/ungrouped segments and carries the notation legend (dashed oval =
> `session-track-group`, dotted pairing = "load at same time", curved arrow =
> `session-hold-until`).
>
> Status of related items: **S1 = decided + implemented** (rendezvous registry).
> **S2, S3-remainder, S6 = decided 2026-07-07.** S2 was revised and implemented
> on 2026-07-16 with target-aware hold-until reachability. The history modal UI
> itself is future work (its semantics are now fixed by these decisions).

---

## Decisions & implementation status (owner, 2026-07-07)

| # | Question | Decision | Status |
|---|---|---|---|
| 1 | "revert to track group" reading | **(i) fallback-checkpoint** — the modal/map is a room-wide rewind tool; when diverged it offers synchronized track groups as jump targets | **Implemented 2026-07-18 in the score map**: right-click a common checkpoint group frame → `MSG_SELECT_HISTORY {group}`; the server recomputes checkpoints and moves every non-retired line to its own landing in that group. Session-page modal UX can follow later. **2026-07-19: the implicit bound-line jump is retired (row 5); the same day an EXPLICIT line-targeted rewind was added (row 7)** — session-lines rewinds are now `{group}` (room) and `{lineId}` (one named line). |
| 2 | R2 terminal-frame hardening | **No.** Solve at score-authoring time instead: a sub-score frame must always keep an outgoing path to a sub-end | **Implemented**: validator error `sub-dead-end` (every landable sub frame must reach a `session-sub-end`). The broader hold-until deadlock guard was later revised in row 6. |
| 3 | Registry on rewind | **(b) generation counter**, with one carve-out: the barrier AT the rewind landing is already unlocked (the room passed it); every barrier met after the rewind — including ones satisfied before it — gates like a first pass | **Implemented**: SM jump bumps `session.reachedGeneration`, restarts `reachedTargets`, pre-satisfies the landing frame's own hold-until targets, and un-parks the jumped line (R4). |
| 4 | S3 "(with split)" pairing | ~~Option A designation~~ **WITHDRAWN 2026-07-08** — the owner clarified that the "(with split)" pairing **does not exist**: `session-rejoin-at` sits on the **pre-merge (source) frames** and announces "this line merges at the target on its next step"; it never pairs with `session-split` (the attributes are independent and may coexist — e.g. staged merges 3→2→1). | **Reverted + replaced**: designation code (`pendingRejoinAt` tagging in `applySplit`, arrival clearing) and the `split-rejoin-mismatch` rule removed. New validator error `rejoin-not-linked`: every rejoin-at target must be one of its frame's own links. Bare co-presence merge (unchanged) is the whole rejoin runtime. |
| 5 | S6 pre-divergence history | **Yes — history is available whenever the room is one populated line** (lines are git branches; initially there is always exactly one). | **Superseded 2026-07-19**: the IMPLICIT bound-line `{selectedIdx}` rewind was retired for session-lines rooms — rewinds are the room-wide track-group checkpoint rewind (row 1) and, since the same day, the explicit line-targeted rewind (row 7); neither is availability-gated. `historyAvailability` (and its S6 single-line reading) was deleted; the SM dropdown is now a read-only trail display (`available:false` always). Vanilla scores keep the per-step jump — their single playhead is the room. |
| 7 | Targeted per-line rewind (owner, 2026-07-19) | An admin may rewind ONE named line to an earlier entry of its own ACTIVE trail (undo, not teleport) — on the main flow, or within its current sub dive ("a sub is a session of its own"). Track-group rule: **passed ⇒ arrived** — a line whose trail already went through a group is never counted as "incoming" again, so a line rewound behind the group replays through it without waiting for the lines ahead (its own truncated trail makes it re-arrive for real). | **Implemented 2026-07-19**: `MSG_SELECT_HISTORY {lineId, selectedIdx, frame}` (admin-only; `frame` = race guard, refused if the trail entry moved) → `bin/www lineRewind` — resolves against the line's active frame list (sub-aware), cancels its timers, un-parks + banner-release, and deliberately does NOT restart the rendezvous registry nor touch `latestGroupArrival` (the ROOM did not rewind). The excusal is `hasPassed` in `orch.groupArrivalState`, wired to `mainTrailForLine` (on forward-only scores reachability already excluded the ahead lines; `hasPassed` makes the rule hold with loops). Map menu: "⏪ rewind L1 here" entries per past trail occurrence on main frames (main-flow lines) and sub frames (lines currently in that sub). Rewinding a line OUT of its sub is out of scope (room rewind force-exits subs). Known interaction (verified, accepted): the rewind itself leaves `latestGroupArrival` alone, but the line's NATURAL landings while replaying re-arm it (pre-existing #13 recording — every main-flow grouped landing is the room's newest of record), so a dormant line revived during the replay window fast-forwards to the replayer's group, not the front of the room. |
| 6 | S2 hold-until deadlock guard revision | A missing `session-hold-until` target only keeps a barrier parked while at least one active, device-bearing, unparked line can still reach that target. Dormant, retired, empty, or parked lines are not counted; the barrier releases once no still-missing target remains reachable. | **Implemented 2026-07-16**: `tryReleaseBarriers` uses target-aware reachability over main `graph.frameLinks` and sub-score `graph.frameLinks`; `holdUntilReachabilityState` records the pure rule. |

The un-answered spec question left in this file is **none**. The reading-(i)
**checkpoint-fallback offer** for the diverged case is implemented first in the
[score map](score-map.md)'s rewind menu; the implementation notes live in
[room-rewind-plan.md](room-rewind-plan.md). **L3 was resolved 2026-07-18**: an admin is a player with extra
tools — admin session-page connections count as line population everywhere; the
score-map page's connection is the exception (an observation tool that marks
itself `mapView` and is excluded from all population counting via
`performerLineConnections` — a line holding only map tabs goes dormant like an
empty one). Still parked: **L5/L6** (see
[session-lines-review.md](session-lines-review.md)). **S7** (split ∩ track-group
precedence) was **resolved 2026-07-17**: the group close delegates a grouped
split frame to the split path (choosers to their pick, stragglers balanced;
global stay brakes it un-split), and the group check now precedes the split
check at window close so resolution no longer depends on whose synchronized
window closes first.

### Post-implementation review (same day, owner-clarified)

- **Bug found + fixed:** jumping a parked line left its devices' "waiting for other
  lines…" banner up forever — the client only hides it on `MSG_BARRIER_RELEASED`,
  which the un-park path never sent. `jumpScoreForSession` now sends it (with the
  frame the line was parked at) whenever the jump un-parks the line.
- **Split × rejoin counts (owner):** ~~1-or-N rule~~ **superseded 2026-07-08** — no
  pairing exists at all (see the S3 row above); the count rule was replaced by
  `rejoin-not-linked` (every rejoin-at target must be one of its frame's own links).
- **Main-score terminal frames (owner): no validator check.** A line finishing on a
  main-flow dead end (e.g. `END.svg`) still counts as "coming" for open barriers;
  END frames are normal authoring, so a warning would be noise. Recovery stays
  operator force-release + (future) history rewind.
- **Jump onto a `session-sub-start` frame (owner): reposition only.** A rewind never
  triggers orchestration reactions — the line sits on the frame un-dived and its next
  vote follows the frame's href (the sub's return landing), skipping the sub. This
  matches the "rewind-to-a-barrier stays unlocked" rule.
- **No-vote continuation fallback (implemented 2026-07-16):** a non-split Session
  Lines voting window that closes with no valid votes and no retained in-window
  tally no longer falls back to `line.currentIndex`. Session Lines considers only
  explicit `stay` or graph-derived current outgoing link ids valid; stale/malformed
  link ids are ignored. It synthesizes a default link winner from the current frame's
  ordered `frameLinks` (one link → take it; multiple valid links → random tie-break;
  no valid links → stay/no-op). Split windows keep their existing non-chooser
  balancing, explicit `stay` still stays, and track-group global `stay` still brakes
  the whole group; otherwise grouped lines with no local link winner use their own
  default outgoing link.
- **Noted, self-healing (no action):** after a rewind restarts the registry, other
  lines' *current* positions are not re-seeded into the fresh generation — a barrier
  whose target is a frame someone is already standing on sees it covered only when
  that line next moves (its departure marks the frame done).
- **Noted (L3, decided 2026-07-18):** admin *session-page* tabs count as line
  devices by design (an admin is a player with extra tools), so an idle admin tab
  bound to an otherwise-empty line makes it "populated" — which can flip the room
  from the single-line always-available rule to the 2+-lines grouped-frames rule.
  Score-*map* tabs no longer do: they are observation tools excluded from all
  population counting (`performerLineConnections`).

## Decisions (owner, 2026-07-16) — track-group ARRIVAL barrier

`session-track-group` no longer only synchronizes voting windows — grouped frames
**wait for each other** before the first window opens.

| # | Question | Decision | Status |
|---|---|---|---|
| 1 | What must the group wait for? | **All incoming lines arrived** — every populated line that can still reach a group frame must have landed on one (not merely one occupant per frame). Empty (0-device) lines neither occupy nor are waited for. | **Implemented**: `line.isGroupWaiting` park on landing (`maybeParkAtGroup`), reusing the hold-until banner protocol (`MSG_BARRIER_WAITING`/`RELEASED` — zero client change). |
| 2 | Deadlock guard | **Reachability release** (timeout-free, #11 philosophy): a line stops being "incoming" the moment no link path leads from its main-flow position to a group frame (dormant lines drop out; sub lines project to their return landing). Re-checked on every landing, dormancy, hold-until release, SM jump, post-restart rehydration. | **Implemented**: `canReachFrames` BFS over `graph.frameLinks` + `groupArrivalState` (pure, orchestrator.js); `tryReleaseGroupWaits` in bin/www. SM force-release valve covers group waits (`group:<name>` panel entries). |
| 3 | Track-group × hold-until | **They compose, with a validation rule**: a hold-until on a grouped frame may only target frames **outside** the frame's own group (in-group targets are redundant — the arrival barrier already waits for those). A blocked (hold-until-parked) occupant keeps the whole group waiting until its out-of-group barrier releases. | **Implemented**: validator error `hold-until-in-track-group`; `groupArrivalState` counts barrier-parked occupants as blockers; `releaseBarrier` re-parks freed lines at a still-waiting group. |
| 4 | Late arrival while a round runs | **Join truncated (today's behavior)** — chosen for lowest code complexity: once the group stopped waiting, a newcomer (e.g. a revived line) just taps into the running round and is cut at the group close. Group-parked lines are excluded from a round's resolution sweep. | **Implemented**: no re-arm after release; `resolveGroupVoting`/`openCoGroupWindows` skip `isGroupWaiting` lines; first device adopting an empty/dormant line on a group frame re-parks it (`ensureLineAssignment`). |
| 5 | SM jump onto a grouped frame | **Never parks** — a jump is authoritative, mirroring the landing-barrier carve-out; the jump also un-parks a group-parked line (banner dismissed) and re-checks group waits it was incoming to. | **Implemented** in `jumpScoreForSession`. |

---

## What the history-modal FigJam actually specifies (verified)

- **`a.svg` (before any divergence): "global history"** — while the room is still one
  line, plain history is available.
- **Frames in a track group** (`BC`, `EF`, `GH`, `IJK`, `LMO`, `RTU`, `VWY`, `ZAprime`):
  history **possible**; each device's history shows the frame *its own line* sat on
  within that group ("either b.svg or c.svg"), and jumping goes **back to that frame**
  per line. Track groups therefore act as **synchronized checkpoints**.
- **Frames in no track group** (`d`, `n`, `p`, `q`, `s`, `x`): "history **impossible**
  if any devices are on [that frame]".
- **The `e.svg` row carries the key rule:** *"if 'd.svg, e.svg' history impossible.
  **revert to track group 'BC'**. If 'e.svg, f.svg' history possible with track group
  'EF'."*

That "revert to track group BC" phrase is load-bearing and has two readings:

| Reading | Meaning | Consequence |
|---|---|---|
| **(i) Fallback-checkpoint** | When current positions make history impossible, the modal stays usable but only offers the **last synchronized checkpoint** (the most recent track group every line passed) as the jump target. | The modal is a **room-wide rewind tool** — it can rescue a wedged room even when lines sit on non-grouped frames (e.g. parked at a barrier). |
| **(ii) Plain disable** | History is simply unavailable; "revert" only describes what the *entries list* shows. | The modal can never rescue a room whose lines sit on non-grouped frames — barrier frames included. |

**Decided 2026-07-07: reading (i).** The evidence pointed there: the phrase "revert
**to** track group BC" describes a fallback target, not a disabled control, and the PDF
sketch shows the score alternating grouped and ungrouped segments — under reading (ii)
history would be dead for a large fraction of any performance. *(The `a.svg` "global
history" row also settled S6 — history is AVAILABLE while the room is one populated
line; implemented 2026-07-07 in `historyAvailability`. Both the predicate and the
implicit bound-line jump it gated were retired 2026-07-19; the same day rewinds were
rebuilt as the room-wide checkpoint rewind plus an explicit line-TARGETED rewind
(decisions table rows 1/5/7).)*

---

## Open item 1 — S2: the barrier deadlock guard

**Update 2026-07-16:** this section is historical. The earlier conservative
recommendation was superseded by the target-aware reachability guard in the
decisions table above. The current runtime ignores a missing hold-until target
when no active, device-bearing, unparked line can still reach it, and releases
the barrier once no still-missing target remains reachable. Qualified sub refs
are checked against the referenced sub-score graph.

### Where things stand

Historical behavior: the guard (`someoneComing`, bin/www `tryReleaseBarriers`) force-released a barrier only
when **no active, device-bearing line exists outside its parked set**. Rendezvous (S1)
removed the worst deadlock class (mutual barriers). What remains stuck is the
**too-patient** direction: a device-bearing line that can never actually reach an
uncovered target keeps the barrier open forever —

1. **Vote-lost path:** target sits on a route the only capable line voted away from,
   with no back link (e.g. a barrier targeting `Tetra2/Ripple.svg` after that line chose
   Pulse).
2. **Finished line:** a line on a terminal frame (no outgoing `<a>` links, e.g. `END.svg`)
   can never advance, yet counts as "coming".

### How the history modal changes the picture

The modal is a **second recovery tool** alongside admin force-release — and under
reading (i) it is the *better* one: instead of amputating the wait (force-release skips
the barrier; per #11 a released barrier never re-arms), the operator **rewinds the room
to the last checkpoint and lets it re-vote**, possibly taking the path to the missed
target this time. Two consequences:

- **"Unreachable" is never permanent.** A history jump re-opens closed paths. Any
  automatic reachability-based release could fire at exactly the moment the operator
  intends to rewind — and since release is irreversible, it would destroy the wait the
  rewind was trying to satisfy. Automation and the rewind tool are in direct conflict.
- The two tools split cleanly: **force-release = skip the wait; modal rewind = replay
  and satisfy the wait properly.**

### Historical Recommendation

- **R1 — Keep the guard as-is.** Conservative is correct: it only force-releases when
  every populated line is parked (the room is provably wedged), which is what an
  operator would do anyway.
- **R2 — One cheap hardening (optional, 3 lines):** a device-bearing line on a frame
  with **zero outgoing links** should not count as "coming". It cannot advance by
  voting, and today it cannot be history-jumped either (per-line jump is gated on
  availability, and a non-grouped terminal frame kills availability). This fixes stuck
  class 2 soundly. Caveat: if the modal later implements reading (i), a checkpoint
  rewind *could* move such a line — but the guard only matters when everyone else is
  already parked, so releasing remains the operator-equivalent action. Low risk.
- **R3 — Do NOT build graph-reachability (BFS) analysis.** *(Superseded 2026-07-16.)* It cannot detect behavioral
  deadlock (a line that stay-votes forever), it is invalidated by history jumps and
  dormant-line revival, and per the above it actively conflicts with the rewind tool.
  The heuristic guard + two operator tools cover the space. Revisit only if real
  sessions produce stuck class 1 regularly.
- **R4 — NEW requirement the modal work must answer (this is the real finding):
  rewind × rendezvous registry.** `session.reachedTargets` is **monotonic** — once a
  frame is `done` it stays done. A checkpoint rewind that replays a section will find
  every barrier in that section **pre-satisfied** and nothing will gate on the replay.
  Options:
  - **(a) Accept it** — a rewind is a recovery, not a fresh performance; replayed
    barriers shouldn't re-block the room. *(Cheapest; recommended default.)*
  - **(b) Generation counter** — bump `session.reachedGeneration` on every SM jump;
    barriers only count registry marks from the current generation ⇒ replayed sections
    gate again. *(Choose this if replays should feel like first passes.)*
  - **(c) Selective invalidation** — clear only refs "ahead of" the rewind point;
    ill-defined on a nonlinear score, **not recommended**.
  Additionally, jumping a **parked** line must clear its barrier state (un-park, clear
  `isBarrierWaiting`/`pendingHoldUntil`, drop from `entry.parked`, delete the entry if
  emptied) — today nothing does this because jumps are refused… which itself follows
  from reading (ii). Under reading (i) this becomes mandatory.

**Decided 2026-07-07:** ① **reading (i)**; ② **R2 rejected** — replaced by the
`sub-dead-end` validator check (score-authoring-time fix); ③ **option (b)**, with the
rewind-landing barrier pre-satisfied (see the decisions table at the top).

---

## Open item 2 — S3 remainder: `session-rejoin-at` multiple targets *"(with split)"*

*(The history-modal section does not bear on this item — it is orchestration-only.)*

### Where things stand

- **Implemented (2026-07-04):** a barrier releasing with **multiple** rejoin targets no
  longer auto-advances to the first one — the line votes its route and merges on
  arrival at the winner (bare rejoin). Single target keeps the auto-advance + merge
  (Barrier→DONE pattern). This makes `rejoin-at="H.svg,I.svg"` on frame F fully
  functional in the `-test- Session lines` score.
- **Not implemented:** the spec's *"(with split)"* pairing — a frame carrying **both**
  `session-split="N"` **and** `session-rejoin-at` listing N targets, meaning: divide the
  line and route each child to its listed merge point. Today split children are simply
  seeded at the frame's hrefs; the rejoin-at list plays no routing role, and no child is
  *designated* for a target. When hrefs and targets coincide it works by accident of
  composition; the designation semantics (`line.pendingRejoinAt` — the field exists and
  is persisted, but nothing ever writes it) does not exist.
- **Also not implemented (by design so far):** *waiting* merges. Bare rejoin merges on
  **co-presence** — if line A passes through H before line B arrives, they never merge
  there. The orchestrator's `rejoinSatisfied(expected, arrived)` helper anticipates
  designation-based waiting but is unused by the runtime.

### Recommendation

- **Option A (recommended):** implement **designation without waiting** when (and only
  when) a frame declares both attributes: at split resolution, tag child *k* with
  `pendingRejoinAt = targets[k]` and seed it toward that target; on arrival, merge with
  any co-present line (as today). Validator addition: `split N` + `rejoin-at` list ⇒
  counts must match. Small, uses existing persisted state, no UX change.
- **Option B (not recommended):** designation **with waiting** (first designated line
  waits at the target until the rest arrive, via `rejoinSatisfied`). Rejected reasoning:
  it duplicates `hold-until` — a frozen line with none of the barrier's messaging/UX.
  The spec already says rejoin is "normally paired with hold-until to act as a barrier";
  waiting should remain the barrier's job. If a score needs a guaranteed merge, pair the
  target with `session-hold-until` (rendezvous makes near-simultaneous arrivals the
  common case anyway).
- **Priority: low.** No existing score pairs split with rejoin-at; the FigJam hybrid
  example is fully served by what's implemented. Do Option A when a real score needs it.

**Decided 2026-07-07, then SUPERSEDED 2026-07-08:** the Option A designation and the
count rule were implemented and later **withdrawn** when the owner clarified the actual
semantics: `session-rejoin-at` lives on the **pre-merge frames** (e.g. C and F in
A→B→C→D / A→E→F→D, both carrying `rejoin-at="D.svg"`) and announces "this line merges
at the target on its next step." It **never pairs with `session-split`** — the
attributes are independent and may coexist (staged merges, 3 lines → 2 → 1). The
"(with split)" phrase in the original spec table was a misreading and has been removed.
What stands: bare co-presence merge at any named target (unchanged runtime), plus a new
validator rule `rejoin-not-linked` — every rejoin-at target must be one of its frame's
own links, since the merge is by definition the frame's next step. `pendingRejoinAt`
returns to being an unused, reserved line field (persisted, never written).

---

## Decision checklist (answered by owner, 2026-07-07)

- [x] S2/modal: history "revert to track group" = **fallback-checkpoint (i)** ✅
- [x] S2: adopt the terminal-frame "not coming" hardening (R2)? **No** — enforce at score creation instead: validator requires every sub-score frame to keep a path to a sub-end (`sub-dead-end`).
- [x] S2/modal: registry on rewind = **(b) generation counter** ✅ — with the carve-out that the barrier at the rewind landing is already unlocked; every later barrier (even one met before the rewind) gates as new.
- [x] S3: ~~Option A (designation, no waiting)~~ **superseded 2026-07-08** — rejoin-at is a pre-merge-frame announcement, never paired with split; designation withdrawn, `rejoin-not-linked` validator rule added instead.
- [x] S6: make history available pre-divergence? **Yes — available whenever the room is a single populated line** (git-branch model: initially there is always one line).
