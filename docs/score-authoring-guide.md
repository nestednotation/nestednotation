# Building a Session Lines Score — Author's Guide

This guide is for **score builders**: people who design and assemble scores, without a
programming background. It explains what Session Lines does, what each `session-*`
attribute means, and how to check your score before using it in a real session.

(Developers: the precise technical spec is [session-lines.md](session-lines.md). If anything
here seems to disagree with it, the spec wins.)

---

## 1. The big idea

Normally, a session is **one room moving together**: everyone sees the same frame, votes
together, and advances together.

**Session Lines** lets your score split that room into several **lines** — independent
groups that each travel their own route through the score at their own pace, with their own
voting — and then brings them back together when you want. While separated, lines can wait
for each other, synchronize with each other, or detour into a small side-score and return.

You control all of this from inside the score itself, by adding special attributes to your
frames. No settings, no code — if your score has none of these attributes, the session
behaves exactly like it always has: one room, one path.

**Vocabulary used below:**

| Word | Meaning |
| --- | --- |
| **Frame** | One SVG file in your score — one "page" performers see. |
| **Link** | A tappable area in a frame that points at another frame. This is what performers vote on. |
| **Line** | An independent group of performers with their own current frame and voting. A session starts as one line containing everyone. |
| **Split** | One line dividing into several. |
| **Merge** | Several lines joining back into one. |
| **Barrier** | A frame where a line waits for something else to happen before moving on. |
| **Sub-score** | A small self-contained score-within-a-score that one line can dive into and come back from. |

---

## 2. How a score is put together (recap)

- A score is a folder of SVG frames (with optional sounds and sub-scores). Where each
  piece goes is spelled out in "Where the files live" just below.
- The frame whose name starts with **`START`** (or `PRE`) is where the session begins.
- A link is an `<a>` element wrapped around any shape or text in the frame:

  ```svg
  <a xlink:href="Left.svg">
    <rect x="150" y="1280" width="700" height="320" />
  </a>
  ```

- Performers tap links during a **voting window**; when it closes, the line moves to the
  winning link's frame, then sits in a **holding period** before the next window can open.
  Performers can also vote **stay** to remain on the current frame. (Window and holding
  lengths are session settings chosen when the session is created, not part of the score.)
- If a voting window closes and **nobody voted**, the line does not stall: it automatically
  continues through one of the current frame's links (if the frame has several, one is
  picked at random; an explicit winning "stay" vote still wins). A frame with **no links at
  all** is a dead end — the line stays there until an operator intervenes.

### Where the files live — the score folder

Every score is **one folder inside `public/data/`**. The folder's name *is* the score's
name: it's what you pick from the score dropdown when creating a session, and what shows on
the session page and the map. Name it whatever performers and operators should see. (The
`-test-` / `-u-` prefixes on the folders that ship with the app are just an author's naming
habit for sorting — they carry no special meaning.)

There are two ways to lay out a score folder.

**1. Frames only (no audio) — the simple case.** Drop the SVG frames straight into the
score folder:

```
public/data/
  My Score/
    START.svg          ← the entry frame (its name starts with START, or PRE)
    Left.svg
    Right.svg
    DONE.svg           ← …and the rest of your frames, right here
```

**2. With audio — frames and sounds in their own subfolders.** As soon as your score plays
sound, move every frame into a `Frames/` subfolder and put the audio in a `Sounds/`
subfolder beside it:

```
public/data/
  My Score/
    Frames/            ← all the SVG frames go in here
      START.svg
      Left.svg
      Right.svg
    Sounds/            ← all the audio goes in here (sub-folders inside are fine)
      intro.mp3
      Font/bell.mp3
```

The app treats a score as having sound **only when both a `Frames/` and a `Sounds/` folder
are present** — so audio always means layout 2. (A flat, frames-only folder is played
silent even if you drop audio into it; give it the `Frames/` + `Sounds/` shape instead.)
The frames themselves behave identically in either layout.

**Sub-scores — `Subscores/`.** A sub-score (section 3.5) is a small score-within-a-score.
It lives in a `Subscores/` folder next to your frames, and each one gets its **own folder,
named exactly as you reference it** in `session-sub-start="Name"`:

```
  My Score/
    Frames/ …
    Subscores/
      Tetra/                 ← the folder name matches session-sub-start="Tetra"
        START.svg            ← a sub-score is just a small score of its own…
        Echo.svg             ← …with a START frame and at least one session-sub-end exit
```

A sub-score folder follows all the same rules as a top-level score: it can be flat (frames
directly inside) **or** use its own `Frames/` + `Sounds/` (a sub-score may carry its own
sounds), and it needs a `START` frame plus at least one `session-sub-end` exit frame.

**Documentation — `Documentation/` (optional).** If you add a `Documentation/` folder, its
SVG (any filename, e.g. `ABOUT.svg`) becomes the "about this score" panel performers can
open during the session. It is optional and purely informational. Sub-scores may carry
their own `Documentation/` too.

Putting it together, a fully-featured score looks like:

```
public/data/
  My Score/
    Frames/          START.svg  Left.svg  Right.svg  Barrier.svg  DONE.svg
    Sounds/          …audio…
    Subscores/
      Tetra/
        Frames/      START.svg  Echo.svg
        Sounds/      …audio…
    Documentation/   ABOUT.svg
```

Everything below is added on top of this, by writing attributes into a frame's opening
`<svg ...>` tag:

```svg
<svg width="100%" height="100%" viewBox="0 0 1801 1801" version="1.1"
     xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
     session-split="2">
```

The one exception is `session-sub-start` (section 3.5), which goes on an `<a>` link tag
instead of the `<svg>` tag — because there it marks a *choice*, not the whole frame.

**Referencing other frames inside an attribute:** use the file name **including `.svg`**,
e.g. `session-rejoin-at="DONE.svg"`. Capitalization doesn't matter (`done.svg` works), but
the spelling must match. Several names are separated with commas. A frame inside a
sub-score is written `SubScoreName/FrameName.svg`.

---

## 3. The six attributes

### 3.1 `session-split="N"` — divide one line into N

```svg
<svg ... session-split="2">   <!-- frame must contain exactly 2 links -->
```

When a line reaches this frame, a **choice window** opens (same length as a voting window).
Each performer taps the path they personally want. When the window closes, the line divides
into N new lines — one per link. Performers who tapped go where they chose; performers who
didn't tap are distributed automatically so the resulting lines come out **balanced in
size** (no path is left empty just because nobody picked it).

Rules:

- `N` must be **2 or more**, and the frame must contain **exactly N links** — one per path.
- A line that came from a split can split again later. Nesting is fine.
- Splitting is one-way: the original line is gone, replaced by its children. Bring them
  back together with `session-rejoin-at` (below).

### 3.2 `session-rejoin-at="X.svg"` — merge lines back into one

```svg
<svg ... session-rejoin-at="DONE.svg">   <!-- DONE.svg must be one of this frame's links -->
```

Put this on the **frame just before the meeting point** (not on the meeting point itself).
It announces: "a line standing here will merge at `DONE.svg` when it moves there." When two
or more lines that made this announcement are on the meeting frame together, they become
one line — one voting pool again.

Rules:

- The target **must be one of that frame's own links** — the merge point is somewhere the
  line can actually step to next. (The validator enforces this.)
- Typically you put `session-rejoin-at="X.svg"` on the last frame of *each* branch, all
  naming the same `X.svg`.
- A frame with several links can name **several merge targets** (comma-separated) — the
  line merges at whichever one it navigates to.
- It can share a frame with `session-split` — the announcements are independent. This
  enables **staged merges**: e.g. a frame where incoming lines merge, that then splits
  again, or 3 lines merging into 2 and later into 1.
- **Merging only happens if the lines are actually there at the same time.** A line that
  arrives, votes, and moves on before the other line shows up will *not* merge. If you need
  a guaranteed merge, make the meeting frame also **wait** — see the barrier pattern in
  section 4.

### 3.3 `session-track-group="name"` — travel in sync

```svg
<svg ... session-track-group="converge">
```

Frames sharing the same group name form a **synchronized section**. Two things happen:

1. **Everyone waits for everyone.** A line arriving on any frame of the group **parks**
   there — the frame is shown, but taps are ignored and a "waiting for other lines…"
   notice appears — until every line that is still on its way to the group has arrived on
   one of the group's frames **and each arrived line has finished playing its own holding
   period**. In other words the group doesn't unlock the moment the last line lands — it
   unlocks when the **last held frame in the group is released**, so all the lines leave
   the section together. Lines with no performers in them, and lines whose route can no
   longer reach the group, are not waited for. (A lone populated line on a grouped frame
   never shows the notice — there is no one to sync with.)
2. **Voting runs in lockstep.** Once everyone has arrived and every held frame has been
   released, the group's voting windows open and close **together** across all its frames.
   Each line still counts its own votes and follows its own winning link — *except*
   **stay**: if the single most popular vote anywhere in the whole group is "stay",
   **every** line in the group stays. Stay acts as a group-wide brake.

Rules and notes:

- A group needs **at least 2 frames** to be meaningful (a 1-frame group earns a validator
  warning).
- Every frame in a group must use the same `voting` and `holding` attributes. If one
  frame uses an override, repeat that exact override on every other frame in the group;
  otherwise omit the attribute from every member to use the session default.
- The same group can be passed through multiple times (loops are fine).
- A split frame can be in a track group: when the group advances, that frame still splits
  its line as usual (a group-wide "stay" holds it un-split like everyone else).
- Track groups are also the **checkpoints** the operator can rewind the whole room back to
  from the live map, so placing a group at each meaningful section boundary of your piece
  makes live rescue much easier.

### 3.4 `session-hold-until="X.svg,Y.svg"` — wait here until other frames have been played

```svg
<svg ... session-hold-until="Left.svg,Tetra/Echo.svg">
```

A line reaching this frame **holds** there (with a "waiting" notice) until **every** listed
frame has been reached — by *any* line, anywhere in the session — and has finished its own
holding period. The waiting line stays on its own frame; nobody has to physically converge.
Think of it as: "don't go on until the room has heard X and Y."

Rules and notes:

- List one or more frames, comma-separated. A frame inside a sub-score is written
  `SubScoreName/FrameName.svg`.
- **It does not deadlock.** If a listed frame becomes unreachable — every line that could
  still get there has gone empty or moved past it — the wait dissolves by itself rather
  than freezing the room forever.
- **Frames may wait on each other.** A mutual rendezvous — two or three barrier frames
  each listing the others — is legal and releases them all together once each has been
  reached; a circular wait does not freeze.
- **Careful with dead ends anyway:** a line sitting on a final frame (say `END.svg`) with
  no links still *counts as possibly coming* for other people's barriers. If one branch
  can finish while another still waits on it, the waiting line will keep waiting until the
  operator steps in. Prefer routes where every branch eventually passes the frames others
  wait for, or reaches a merge.
- On a frame that is also in a **track group**, the listed frames must be **outside** that
  group — the group already waits for its own frames (the validator enforces this). An
  outside target simply adds an extra condition on top of the group wait.
- Naming the frame itself is pointless (only satisfied by its own arrival) and earns a
  validator warning.

### 3.5 `session-sub-start="SubScoreName"` — a link that dives into a sub-score…

Unlike the other attributes, this one goes on an **`<a>` link tag**, not the `<svg>` tag:

```svg
<a session-sub-start="Tetra" xlink:href="Barrier.svg">
  <rect x="150" y="1280" width="700" height="320" />   <!-- the tappable "door" -->
</a>
```

The marked link is a **door into the sub-score**. The frame itself plays normally —
performers see it, a voting window runs — and *choosing that link* (it wins the vote, or
it's the no-vote auto-continue pick) makes the line dive into the sub-score instead of
moving, starting at the sub-score's own `START` frame. Inside, the line plays completely
independently — its own votes, its own pace.

**The link's `href` is not where the line goes — it's where the line lands when it comes
back out** of the sub-score (the *return landing*).

Rules:

- The marked `<a>` **must have an `href`** pointing at a real main-score frame — the
  return landing. A marked link without one is a validator error.
- The named sub-score must exist (in `Subscores/`, see below) and must contain a `START`
  frame and at least one exit frame (`session-sub-end`, next section).
- A frame may mix normal links and sub links — the dive is just one of the choices — and
  may even offer doors into **different** sub-scores. But **every link on the frame needs
  its own target frame.** A door is recognized by *where it points*, not by which shape was
  tapped, so if a marked and an unmarked link share a target, both behave as the door —
  tapping the plain link dives too. Two doors sharing a target are just as bad: only the
  first is reachable. The validator refuses either (`ambiguous-sub-link-target`).
- A **split frame's links can't be doors** (validator error): give the split path an
  ordinary in-between frame and put the sub link there.
- If the frame's *only* link is a sub link, a round with no votes auto-continues into the
  dive — the sub-score always gets played, just after one voting round on the frame.

Sub-scores live inside your score folder:

```
MyScore/
  Frames/            (or frames at the top level)
  Sounds/
  Subscores/
    Tetra/
      START.svg
      Echo.svg       (the exit — see below)
      Sounds/        (optional; sub-scores can have their own sounds)
```

### 3.6 `session-sub-end="SubScoreName"` — …and come back

```svg
<svg ... session-sub-end="Tetra">    <!-- placed on a frame INSIDE the Tetra sub-score -->
```

Placed on the `<svg>` tag of a frame **inside the sub-score**, this marks its exit. When
the line reaches it, the line pops back to the main flow, landing on the `href` of the
sub-start link it dived through. The sub-score never needs to know anything about the
main score.

Rules:

- The sub-score must have a `START` frame and **at least one** exit frame.
- **The exit frame itself needs no link** — reaching it *is* the exit; the return to the
  main flow is automatic. (In the demo, `Tetra/Echo.svg` is just the attribute on an
  otherwise bare frame.)
- **Every frame inside the sub-score must have some route to an exit.** A frame with no way
  out would strand a line in the sub-score forever, holding up the rest of the room — the
  validator treats this as an error.
- Frames played inside a sub-score can satisfy other lines' `session-hold-until` waits via
  the `SubScoreName/FrameName.svg` form.

---

## 4. Putting them together — a complete example

The test fixture `test/fixtures/session-lines-demo` uses every attribute in five main frames:

```
                      ┌─ Left.svg  [track-group "converge"] ──────────────┐
START.svg ── split 2 ─┤                                                   ├─ Barrier.svg ── DONE.svg
                      └─ Right.svg [track-group "converge"]               │
                              │            [hold-until "Left, Tetra/Echo"]
                              dive into Tetra sub-score    [rejoin-at "DONE"]
                              (START → … → Echo = exit)
                              then return to Barrier.svg
```

- `START.svg` — `session-split="2"` with two links (`Left.svg`, `Right.svg`): the room
  divides into two lines by personal choice.
- `Left.svg` and `Right.svg` — both `session-track-group="converge"`: whichever line
  arrives first parks and waits for the other; then their voting runs in sync.
- `Right.svg` — its link to `Barrier.svg` carries `session-sub-start="Tetra"`: when the
  right-hand line chooses that link, it dives into the Tetra sub-score, plays it, and
  lands on `Barrier.svg` (the link's `href`) when it reaches `Echo.svg`
  (`session-sub-end="Tetra"`).
- `Barrier.svg` — `session-hold-until="Left.svg,Tetra/Echo.svg"`: nobody proceeds until
  both `Left.svg` and the sub-score's `Echo.svg` have been played somewhere in the room.
  It also carries `session-rejoin-at="DONE.svg"`: since both lines end up held on this
  same frame, the wait guarantees co-presence, and they merge into one line on `DONE.svg`.

That last frame shows the two most useful **patterns**:

- **Guaranteed merge** = `session-rejoin-at` on a frame that also *waits* (a hold-until
  barrier, or a track-group frame). The wait ensures the lines are there together; the
  rejoin makes them one.
- **Rendezvous without travel** = `session-hold-until` alone. Lines pause in their own
  place until the material they depend on has happened elsewhere.

Two richer studies ship with the application (both validate clean — open them on the live
map and play them with a few tabs):

- **`-test- Session lines`** — a 3-way split where each line dives into its own sub-score,
  a **mutual** barrier (three frames waiting on each other), a multi-target rejoin, and a
  staged merge chain: two lines merge at `J.svg`, which immediately splits in two again,
  and the branches re-merge at `M.svg`.
- **`-test- Session lines 2`** — a long chain of two- and three-frame track groups (the
  room repeatedly re-synchronizes), including a frame that is both grouped **and** a split
  (`H.svg`), and merges happening out of synchronized groups.

---

## 5. Things that are good to know (safety nets)

You do not have to handle every emergency in the score — the system and the session
operator have tools:

- **Empty lines don't block anyone.** If everyone leaves a line (closed tabs, network),
  it goes *dormant*: any wait that was pending on it is released. If a new performer
  joins later, dormant lines are refilled first, and the revived line is placed at the
  room's most recent synchronized section (track group) — not at its old stale position.
- **Waits dissolve when they can't be met.** Both track-group waits and hold-until waits
  watch whether the awaited thing can still happen, and let go if it can't.
- **The operator can always intervene**: rewind the whole room to a track-group
  checkpoint, rewind a single line along its own trail, or undo a split — all from the
  live score map (section 7) — or force-release a stuck wait from the session page's
  admin panel.
- **Late joiners** are placed automatically on the line that needs people most.

One consequence worth designing around: because rewinds land on track groups, a score with
**no track groups has no room-wide rewind points**. Even if you don't need synchronization
musically, a track group at each big section boundary gives the operator somewhere to go
back to.

---

## 6. Check your score before using it

The validator reads your score and reports problems **before** you run a session. The
server does **not** check scores when they load — an unchecked mistake shows up live, as a
room mysteriously stuck at a barrier. So make this a habit after every edit.

In a terminal, in the application folder:

```
npm run validate-score -- "My Score Folder Name"
```

(The folder name is the score's folder inside `public/data` — the same name that shows in
the session's score dropdown. Keep the `--`, and keep the quotes whenever the name has
spaces.)

### Reading the output

The report opens with a header line confirming which score was read and how many frames it
found — a quick check that you pointed it at the right folder:

```
Validating "My Score Folder Name" (7 frames)
```

If the score uses **no** `session-*` attributes at all, the next line reads
`No session-* markup found — vanilla score.` That is not a problem — just confirmation there
is nothing Session-Lines-specific to check.

Then comes one line per issue — warnings first, then errors — each tagged with its code in
brackets:

```
  WARN  [track-group-singleton] track-group "converge" has only 1 frame — nothing to synchronize
  ERROR [rejoin-not-linked] rejoin-at on Barrier.svg names "DONE.svg" but the frame has no link to it — the merge frame must be one of the frame's own next steps
```

The bracketed word (`rejoin-not-linked`, `track-group-singleton`, …) is the code you look
up in the table below; the rest of the line names the frame and describes the problem. The
final line is the tally:

```
1 error(s), 1 warning(s)
```

A clean score prints `0 error(s), 0 warning(s)` — that is your green light. Otherwise, each
line tells you the frame and the problem. What the messages mean:

| Message contains | In plain words | Fix |
| --- | --- | --- |
| `link-unresolved` | A normal frame link points to a frame that doesn't exist in the same score. | Fix the filename or add the missing frame. This also checks links inside loaded sub-scores. |
| `split-n-too-small` | `session-split` is less than 2. | Use 2 or more, or remove it. |
| `split-href-mismatch` | The split number doesn't match the number of links in the frame. | Make the frame contain exactly N links. |
| `hold-until-unresolved` | A `session-hold-until` names a frame that doesn't exist. | Fix the spelling (remember `.svg`). |
| `hold-until-sub-missing` | A `Sub/Frame.svg` wait names a sub-score that doesn't exist. | Check the `Subscores/` folder name. |
| `hold-until-in-track-group` | A grouped frame's hold-until names a frame of its own group. | Target frames outside the group — the group already waits for its own. |
| `hold-until-self` (warning) | The frame waits for itself. | Remove it — it does nothing useful. |
| `barrier-target-unreachable` (warning) | The awaited frame isn't linked from anywhere, so it may never be played. | Link to it from some route, or expect the wait to dissolve unmet. |
| `rejoin-unresolved` | A `session-rejoin-at` names a frame that doesn't exist. | Fix the spelling. |
| `rejoin-not-linked` | The merge target isn't one of the frame's own links. | Put the rejoin on the frame(s) that actually link to the meeting point. |
| `sub-start-missing-score` | The named sub-score folder doesn't exist. | Check `Subscores/<Name>/`. |
| `sub-missing-start` / `sub-missing-end` | The sub-score has no `START`, or no exit (`session-sub-end`) frame. | Add them. |
| `sub-dead-end` | A frame inside the sub-score has no route to an exit — a line reaching it would be stranded. | Give every sub-score frame a way out. |
| `sub-start-no-return` / `sub-start-return-unresolved` | The marked `<a>` has no `href`, or its `href` points at a nonexistent frame. | The sub-start link needs an `href` to a real main-score frame — that's the return landing. |
| `sub-start-on-root` | `session-sub-start` is on the `<svg>` tag (the old markup style). | Move it onto the `<a>` link whose `href` is the return landing (section 3.5). |
| `split-sub-link` | A split frame's link carries `session-sub-start`. | Split paths can't be doors — land the path on an in-between frame and put the sub link there. |
| `ambiguous-sub-link-target` | Two of the frame's links point at the **same** target frame, and at least one of them is a `session-sub-start` door. | Give the door a target frame of its own. The app routes by target and never sees which shape was tapped, so every advance to that frame would dive — even a tap on the plain link. (Two doors on one target: only the first sub-score is ever reachable.) |
| `track-group-voting-mismatch` / `track-group-holding-mismatch` | Frames in one track group use different timing overrides. | Give every group member the same attribute values, or omit the attributes from all members to use the session defaults. |
| `track-group-singleton` (warning) | A track group has only one frame. | Add the other frame(s), or remove the group. |

**Errors** will genuinely misbehave in a session — fix them. **Warnings** are "are you
sure?" — the score will run, but check the intent.

One thing the validator deliberately does **not** flag: ordinary ending frames (a final
frame with no links). Those are normal authoring — just remember the dead-end caution from
section 3.4 if other branches wait on frames past that point.

### Using it as a gate

The command's exit status matches the result — **`0` when there are no errors, non-zero
when there are** (warnings on their own do not fail it). If you ever wire scores into an
upload step, a commit hook, or a CI job, that lets the check block a broken score
automatically. For everyday hand-authoring you don't need any of that — running the command
and reading the tally is the whole routine.

---

## 7. The live score map — watching the room, history, and rewinding

The score map is a separate page that draws your **whole score as a diagram** — every
frame, every link, sub-scores in their own boxes — and shows, live, where each line is.
It is also where all rewinding happens during a session. Open it from the **"map ↗" link
in the session page's admin footer** (the link carries the admin password; without it the
page shows only the bare diagram, with no live positions). It needs an internet
connection to draw itself, and it is view-only in the safest sense: a map tab never
counts as a performer, so you can leave it open without affecting waits or voting.

### Reading the picture

Every frame is a **box**, every link an **arrow** between boxes, and each sub-score sits in
its own dashed box. Shapes and colors all come straight from your attributes.

**Frames — the boxes.** Shape and outline tell you a frame's *role* (fixed by your score):

| Look | Meaning |
| --- | --- |
| Round box, grey outline | An ordinary frame |
| Green outline | The `START` frame (where the session begins) |
| Orange outline | A `session-split` frame |
| Red **octagon** | A `session-hold-until` barrier frame |
| Blue **diamond** | A frame with a `session-sub-start` door (dives into a sub-score) |
| Double outline | A `session-sub-end` exit frame (inside a sub-score) |
| Dashed box wrapping several frames | A sub-score, holding its own frames |
| Pastel fill + a `⟨group⟩` name under the frame name | Frames of one `session-track-group` (each group gets its own tint) |

As lines run, a frame's **fill and outline change to show live state**. These take over
while a line is on the frame (the role shapes above stay, the colors are replaced):

| Look | Meaning |
| --- | --- |
| Amber fill, orange outline | A line is **here** right now |
| Purple **dashed** outline | A voting window is **open** here (also shown by ✅ on the badge) |
| Teal outline | A **holding** period is running here (✋ on the badge) |
| Red outline | The line here is **parked / waiting** — a barrier or group wait (⏳ on the badge) |
| Grey fill | A **dormant** (empty) line is here |
| Light-green fill | Part of a line's **trail** — a frame it has visited (paler green = a step it was rewound back past) |
| Blue **halo** | A line's current end-of-trail, and rewind **checkpoints** |

**Arrows — the links.** Color and line style tell you what kind of link it is:

| Arrow | Meaning |
| --- | --- |
| Grey, solid | An ordinary link between frames |
| Orange, solid | A link *out of* a `session-split` frame (one of the split paths) |
| **Purple**, solid | A link *into* a **merge point** — this frame carries `session-rejoin-at` naming that target |
| Blue, **dashed** | A **dive** into a sub-score (through a `session-sub-start` door) |
| Blue, **dotted** | The **return** out of a sub-score, back to the door's landing frame |
| Red, **dotted** | A barrier's "waits-for" pointer — from a `session-hold-until` frame to a frame it waits on |
| Grey, **dotted** | A `session-sub-start` door's return-landing (`href`) — the real path runs through the sub-score first, so it is dotted to stay out of the way |

**Line badges.** Each line appears as a badge on the frame it currently occupies — e.g.
`L0·3p+1r` means line L0 with 3 players and 1 rider. The glyphs match the live outlines
above: **⏳** parked at a barrier or group wait, **✅** voting window open, **✋** in its
holding period; a grey badge is a dormant (empty) line.

You can drag frames around to arrange the picture; your arrangement is remembered in that
browser. The **re-layout** button in the header discards it and redraws.

### History: every line leaves a trail

As a line moves, the frames it has visited are tinted green — its **trail** — and a blue
halo marks each line's current end-of-trail. A dive into a sub-score keeps its own trail
inside the sub's box (which is discarded when the line exits the sub). Loops are fine:
passing the same frame twice simply records two visits.

The one rule to internalize: **history is an undo trail, not a teleporter.** You can send
a line (or the room) back along where it has actually been — never sideways to an
arbitrary frame it skipped.

### Rewinding

Click (on touch: tap) a frame to open the rewind menu. Depending on the
frame, it offers up to three operations — each asks for confirmation before acting:

1. **Rewind the ROOM to a track group.** Offered on a frame of a track group that every
   populated line has already passed — a **common checkpoint**. The whole room jumps
   back: each line returns to its own frame of that group (a line born after the group,
   e.g. by a later split, is placed on the group's least-crowded frame). Because the room
   genuinely replays from there, barrier waits it meets again will **gate again**, like a
   first pass. This is the "rescue the session" tool — and the reason section 5 advises
   putting a track group at each big section boundary: no track groups, no room-wide
   checkpoints.
2. **Rewind one line.** Offered for each *past* visit in a single line's trail: "rewind
   L2 here" moves **only that line** back along its own path — on the main flow, or
   within the sub-score it is currently inside. The rest of the room is untouched, and
   the rewound line replays forward without re-triggering group waits the room has
   already passed (it won't drag everyone into waiting for it again). Useful for "that
   one line skipped ahead — send it back two frames."
3. **Undo a split.** Offered on a split frame that has actually divided lines: it
   collapses all the lines that came out of that split (including later nested splits)
   back into the single original line, standing on the split frame; every performer
   follows automatically. One permanent limitation: if some of those lines have since
   **merged with lines from outside** that split's family, the populations can't be
   separated any more and the undo is refused — the menu explains why.

When no rewind applies, the menu says why (e.g. "not a room checkpoint yet — some line
hasn't passed this group", or "no line trail through here").

Two notes: rewinding in a Session Lines room happens **only on the map** — the history
dropdown on the session page is just a read-only display there. And on a score with no
`session-*` attributes, the map still works: the room is shown as one line, and the menu
offers a simple "rewind here" for each visited frame.

## 8. Trying it out

- Open the session in **several browser tabs** — each tab counts as its own performer, so
  you can play all the lines of a split yourself. (Exception: duplicating a tab with the
  browser's "duplicate" command copies its identity; open fresh tabs instead.)
- Keep the **score map** (section 7) open beside them: watching the badges park at your
  barriers, sync at your track groups, and dive into sub-boxes is the fastest way to see
  your attributes doing their job.
