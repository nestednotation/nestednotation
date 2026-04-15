# Nested Notation

Nested Notation is a notation system, performance platform, and compositional tool for interactive, non-linear music. It replaces the two-axis format of traditional notation — where the vertical axis encodes pitch and the horizontal axis encodes time — with a fundamentally different paradigm: harmonic relationships are encoded in geometric ring structures visible within SVG frames, and time relationships emerge from the branching syntax of these interconnected files. This allows each moment (frame) in a piece to contain multimedia (sounds, images), and for the temporal structure of a composition to be highly variable in ways that are difficult or impossible to express in traditional notation.

In a Nested Notation performance, musicians read SVG frames as notation while audience members interact on their devices — playing sounds and navigating the score, by voting to collectively determine where the music goes next. The result is a live, collaborative musical experience where every performance follows a unique path through the composition.

## Table of Contents

- [How It Works](#how-it-works)
- [The Notation System](#the-notation-system)
  - [Ring Structure Anatomy](#ring-structure-anatomy)
  - [Tesseract: A Canonical Example](#tesseract-a-canonical-example)
  - [Serotonin: Molecular Structure as Musical Topology](#serotonin-molecular-structure-as-musical-topology)
- [The Session Experience](#the-session-experience)
  - [Musicians](#musicians)
  - [Audience Members](#audience-members)
  - [Event Host](#event-host)
  - [Session Manager](#session-manager)
- [Interaction Modes](#interaction-modes)
  - [Play Mode](#play-mode) and [Guide Mode](#guide-mode)
  - [UI Side Menu](#ui-side-menu)
  - [Session Manager Controls](#session-manager-controls)
  - [Countdown Timer](#countdown-timer)
  - [Gallery Mode](#gallery-mode)
- [Score Library](#score-library)
  - [Canonical Scores](#canonical-scores)
  - [Unhinged Scores](#unhinged-scores)
  - [Nonconforming Scores](#nonconforming-scores)
  - [Hoops Winter: Rhythm from Harmony](#hoops-winter-rhythm-from-harmony)
- [Score Data Format](#score-data-format)
- [Composing Scores](#composing-scores)
  - [Checking Markup](#checking-markup)
- [Architecture](#architecture)
  - [Load Behavior at Frame Transitions](#load-behavior-at-frame-transitions)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration](#configuration)
- [Running the Server](#running-the-server)
- [User Roles and Workflow](#user-roles-and-workflow)
  - [Admin Console](#admin-console-sm)
- [WebSocket Protocol](#websocket-protocol)
- [API Routes](#api-routes)
- [Deployment](#deployment)
- [Project Structure](#project-structure)
- [Troubleshooting](#troubleshooting)
- [Changelog](#changelog)
- [License](#license)

## How It Works

A Nested Notation composition is a network of SVG frames. In canonical examples, each frame contains geometric ring structures that encode harmonic relationships and embed links to other frames. During a live session:

1. An **admin** logs in at `/setup`, selects a score, and creates a session with configurable parameters (voting duration, hold timers, passwords).
2. **Musicians** read the SVG frames as notation, interpreting the geometric structures on their instruments. Additionally, they launch samples in **Play** mode to help sculpt the environmental sound, and vote on navigation in **Guide** mode.
3. **Audience Members** connect on their devices and participate in Play and Guide modes alongside the musicians, often defining session flow due to their greater numbers.
4. When musicians and audience members tap links in Guide mode, a real-time vote begins. After the voting window closes, every connected device advances to the winning frame simultaneously.
5. A **session manager** — anyone connected with the manager password — can pause, resume, jump through the navigation history, force a global refresh of all client devices, or end the session at any time.

## The Notation System

### Replacing the Axes of Traditional Notation

Traditional Western notation uses a two-axis system: vertical position indicates pitch, horizontal position indicates time. Nested Notation reimagines both axes:

- **Harmonic relationships** are encoded in the **ring structures** within each SVG frame. Each frame contains a meta-ring in the form of a 12-position clockface. Any of these positions may contain child rings, whose 12 positions map to the chromatic scale (0=C, 1=C♯/D♭, 2=D, 3=D♯/E♭, 4=E, 5=F, 6=F♯/G♭, 7=G, 8=G♯/A♭, 9=A, 10=A♯/B♭, 11=B). Notes in child rings are connected to each other with connecting curves, which show shared identity across the meta-ring. Child rings define harmonic possibilities, however actual sounding harmony emerges probabilistically from audience interaction — clients may or may not be playing any given ring at any moment, so the sounding harmony at any point in a performance is highly variable.

- **Time relationships** are encoded in the **syntax of SVG files** — the branching, networked graph of frames that the audience navigates through voting. Where traditional notation presents music as a linear sequence, Nested Notation presents it as a graph of possibilities, with each performance tracing a unique path.

This paradigm enables multimedia at every node (sounds, images) and temporal structures of arbitrary complexity — features that are extremely difficult to encode in traditional notation.

### Ring Structure Anatomy

The following elements are common to all canonical Nested Notation scores:

**Meta-ring** — The large outer ring that provides a syntactically consistent structural relationship between the graphical and harmonic elements of a frame. Child rings are placed at positions on the meta-ring's 12-position clockface to mirror chromatic pitch positions on the **refocus ring**.

**Child rings** — Smaller 12-position rings placed at specific meta-ring positions. Each child ring contains notes (colored ellipses or circles with colored stroke) representing pitches. One child ring in each vertex frame is a "refocus" ring — its chord structure mirrors the meta ring of its node, and its link points back to a refocus frame (e.g., `Arefocus.svg`) that serves as a navigation anchor. The refocus ring is not otherwise qualitatively distinct from other child rings; it is simply a child ring whose structure mirrors its larger context, and whose link destination serves a practical purpose.

**Notes** — The colored elements within child rings. A note's color and position encode its pitch. Both solid colored ellipses and circles with a colored stroke are considered notes, where a stroked circle designates the highest voiced (or 'treble') note in the chord structure.

**Root markers** — Triangular indicators within a child ring that mark which note should sound lowest, identifying the chord's bass note.

**Connecting curves** — Curves drawn between child rings that indicate shared notes. At least one connecting curve is required to touch each child ring; beyond that minimum, additional curves are at the composer's discretion.

**Self-similarity** — A defining structural principle of grammatically correct Nested Notation. The positions of child rings on the meta-ring correspond to the note positions in the refocus ring. For example, if a frame has child rings at meta-ring positions 0, 3, 5, and 8, the refocus ring will contain notes at those same four positions. This quasi-fractal relationship between parent structure and child content holds across all vertices of a well-formed score.

### Tesseract: A Canonical Example

The score **Tesseract** demonstrates canonical grammar clearly. Its SVG frames are named after the vertices of a cube (A, B, C, D, W, X, Y, Z), connected by bidirectional transition frames (A2B, B2A, A2D, D2A, etc.). The title is metaphorical — the cube-shaped piece is experienced as "changing throughout time," giving it a tesseract-like quality. Vertex frames carry the full ring structure (meta-ring, child rings, notes, root markers, and connecting curves); transition frames guide performer and audience between harmonic contexts; refocus frames (e.g., `Arefocus.svg`) serve as navigation anchors.

Beyond the common ring elements, Tesseract's vertex frames carry four score-specific element groups. **Fields** and **Songs** are named SVG groups wired to the Field and Song audio layers described in the next section — Field elements provide an atmospheric backdrop, while Song elements move in harmonic lockstep with the frame's child rings (whose notes are played with audio from the **Font** layer). **Map** is a miniature diagram of the Tesseract cube in the upper corner of each SVG, showing the current frame's position; tapping it triggers a sound from the Map audio layer. **Composite Scale ring** is a ring that combines the notes of all child rings into a single harmonic structure; this element can also blend harmony from past or future frames with the present frame in a polychord, serving as a courtesy to musicians at moments of high complexity.

### Audio Layers in Tesseract

Tesseract's `Sounds/` folder organizes audio into five simultaneous layers:

- **Field** — Textural layers (e.g., "Zen", "Grooves", "Arrows", "Petals")
- **Font** — Pitched notes in three registers (Low, Mid, High) across the chromatic scale, in three timbral "fonts"
- **Map** — Each frame has its own audio position signature
- **Scale** — Ascending-descending scalar melodies available at vertices and moments of harmonic complexity
- **Song** — Melodic layers which match Fields in groove and vibe, using harmony specific to each frame (e.g., `06-Tubular-A.m4a`, `06-Tubular-A2B.m4a`)

These layers can play simultaneously from a single frame, creating rich, asynchronous polyphonic textures from simple visual interactions.

Tesseract's ideal session configuration is `autoplay default = false`, `gallery mode = true` (see [Admin Console](#admin-console-sm)). Under this pairing, transition frames (A2B, A2D, etc.) autoplay three elements — Field, Song, and the Map signature — while vertex frames (A, B, C, D, W, X, Y, Z) autoplay only Map. The Field and Song initiated at a transition continue seamlessly into the arriving vertex, because sound IDs shared across consecutive frames continue looping. The vertex's remaining Fields and Songs are present in the frame but silent on arrival; the room voices them as audience members and musicians tap additional elements, each tap adding layers. The result is a layered polyphony constructed socially at each vertex rather than dumped onto the room by autoplay.

### Serotonin: Molecular Structure as Musical Topology

**Serotonin** is the largest composition in the library (162 frames, 176 audio files). Its navigable topology maps directly onto the molecular structure of the serotonin (5-hydroxytryptamine) molecule. Frame names correspond to molecular components: C2 through C9 represent carbon atoms in the indole ring system and ethylamine chain, N and N1 represent the nitrogen atoms, O represents the hydroxyl group, and NH2 represents the terminal amine.

The H-PRE chains of SVG frames — linear sequences of progressive frames connecting the molecular nodes — are suggestive of potential electron journeys through the pi-electron bonding system expected in the indole structure. While the composition remains a work of musical inspiration rather than a literal scientific model, the degree to which physical molecular structure is mapped onto musical structure may represent a unique capability of Nested Notation as a form of musical expression.

## The Session Experience

### Musicians

In a Nested Notation session, a musician's role is improvisatory realization within a pitch set, not sight-reading. The ring specifies which pitches are available; it does not prescribe which pitch to play first, which pitch to progress to next, or at what tempo. Macro-level time is handled by the graph of frames and by the group vote that advances from one frame to the next. Within any given frame, note-to-note timing is the musician's own.

This relationship to the score is closer to figured bass or jazz changes-realization than to Western classical sight-reading. Performance is realization, not fidelity. There is no "wrong pitch" within the available ring set or larger auditory environment, no "wrong order" through it, no "wrong tempo." Musical decisions are aesthetic rather than evaluative.

**Ensemble attunement.** What replaces fidelity-to-score is attentive listening. The auditory environment is itself being produced by other musicians making their own improvisatory choices, by vocalists realizing the ring, and — perhaps most surprisingly — by dozens of audience phones firing pre-recorded samples asynchronously, functioning as a kind of distributed instrument. There is no downbeat to lock onto and no chord root to anchor against. The listening posture is different from conventional ensemble practice: the sampled pitched and rhythmic content is a springboard, other musicians may be conversational partners, and the musician's inner ear is the arbiter of fit.

**Asynchronicity.** Nested Notation embraces asynchronicity. Musicians are welcome to play or rest at any time, and there is no "wrong" time to make or cease making a sound. The aesthetic principle above the grammar is simple: what sounds good, is good.

**Different musicians carry different loads.** Vocalists read the notation directly but do not manipulate a physical instrument; sight-singing is already challenging in familiar notation, and Nested Notation's novel appearance compounds this. Instrumental musicians carry the heaviest combined load: they must adapt the notation's pitch set to the idiosyncrasies of their instrument's physical nature, and they must take a hand off their instrument to interact with their device. Some scores — Serotonin and Hey-Bob, for example — use hybrid notation, co-presenting melodies and rhythms in Western notation alongside the Nested Notation harmony, adding a parallel reading stream. Hoops Winter introduces its own novel graphic convention for rhythm (see [Hoops Winter: Rhythm from Harmony](#hoops-winter-rhythm-from-harmony)).

**What to bring.**

- A **tablet** is preferred to a phone for the larger screen.
- A **Bluetooth speaker** is preferred to a device's built-in speaker for greater volume.
- A **wire music stand** or a **mic stand with tablet clip** enables hands-free operation, which matters especially for instrumentalists.
- Musicians using amps, electronic instruments, or effects/synth/mixing rigs on device output should plan for **power**: an extension cord if AC is available at the venue, or a battery-powered option if not. Feel free to bring a small table if you need one. Don't be shy about "moving in".
- Be prepared to **refresh your device** if you suspect it has fallen out of sync with the server. Session stability is an active area of improvement and is not always perfect.

**Autoplay as an entry point.** Instrumentalists often want **autoplay** on (via the UI side menu toggle), because it's an easier way to hold an instrument and still contribute to the distributed samplework — the composer's authored material triggers on frame load and the musician keeps their hands and attention on playing.

### Audience Members

Audience members are full participants in a Nested Notation session. They interact with the score on their devices, and those interactions shape the session in two ways: by firing pre-recorded audio samples into the room, and by voting on the paths the score takes.

**The distributed instrument.** Each audience member's device is a node in a large, asynchronous sampler. When many phones fire pitched and rhythmic samples at once, the collective sound is the harmonic and rhythmic bed that musicians are listening and playing to. Audience members don't need to read notation to contribute meaningfully — they shape the room simply by engaging with the visual score in front of them.

**Voting is mostly yours.** Any session-authenticated client may open a voting period at any time, in Guide Mode, by tapping any SVG element with color. Once a vote is open, everyone in the session can cast a ballot. In practice, audience members cast the majority of votes: musicians tend to take a passive stance at voting time because they are busy making music, even though their intuition about the score's paths may be greater. Audience members should vote freely and according to their own criteria — which graphic they are drawn to, which link corresponds to the sound they're most enjoying, or, if they love what is happening in the room exactly as it is, the **stay** option, which keeps the session on its current frame. Don't be shy about voting to stay.

**Movement and etiquette.** Audience members are welcome to move through the space during a session — to let in a friend, use the restroom, or change position within the venue. Please move calmly and with intention. Coming and going as necessary is fine; milling is not encouraged.

**Asynchronicity applies to you too.** There is no wrong time to tap, fire a sample, or stop participating for a while. The aesthetic principle that governs the musicians' practice governs yours: what sounds good, is good.

**What to bring.**

- A **phone** is fine; a **tablet** is welcome if you have one and prefer the larger screen.
- A **Bluetooth speaker** is encouraged if you have one, for greater volume than a device's built-in speaker.
- Be prepared to **refresh your device** if you suspect it has fallen out of sync with the server.
- If you are feeling adventurous, you are welcome to **bring an instrument** and cross into the musicians' role.

**If you're unsure how to participate, turn on autoplay.** The **autoplay** toggle in the UI side menu lets your device contribute sound on every frame load, without any action from you. You are already part of the distributed instrument — your phone is voicing its share of the room. As the sonic landscape becomes familiar, tapping and voting become inviting rather than intimidating. Autoplay is the low-stakes entry point into any session.

### Event Host

The event host produces and runs the event itself — selecting and preparing the venue, onboarding arriving participants, and serving as the on-site point of contact for anything that comes up. A capable host understands their venue's quirks: Wi-Fi capacity, how to reset the network if it stalls, where power outlets live, and how the room's acoustics might interact with a crowd of phones and Bluetooth speakers.

**Venue.** Large, open spaces "in the round" are preferred, with enough seating for those who want it and enough open floor for standing instrumentalists to have room to move. High ceilings and natural light are always a plus. A Nested Notation session can take place in a traditional proscenium hall, but open, flexible, quiet spaces are the preferred alternative — they support the distributed, local auditory field the format produces.

**Space preparation.** Aisles or walkways may be delineated with gaff tape prior to the event to encourage purposeful movement (see the etiquette note in *Audience Members* above) and to keep instrumentalists' playing areas clear. The event host may also decide how much time to allow for musician setup in the venue prior to opening the doors to the audience.

**Wi-Fi capacity.** The venue's network is the practical ceiling on how large a session can be. Sessions have run successfully with simultaneous connections in the high dozens; the ideal headcount for Nested Notation is still an open question and depends heavily on the local network. The host should know how to reset the router or access point if things stall. Technical readers can find a summary of the server-side mitigations in [Load Behavior at Frame Transitions](#load-behavior-at-frame-transitions). Clients need not all be on the same Wi-Fi network; using cellular data (if there's reception), expect a per-device download rate of 65-95 MB per hour.

**House sound.** If the venue has a PA system, a designated operator may a client device through it at low volume. House sound should never overwhelm the crowdsourced sound energy — the point of the session is the distributed instrument that participants are collectively producing.

**Additional display.** A projector or large screen, if available, can serve as a beneficial additional display of the current frame, letting anyone in the room follow the score even if they are momentarily not looking at their own device.

**Onboarding.** The host shares the session QR code with arriving participants. The QR code encodes the full session URL and password together, so scanning it joins the participant with no additional sign-in. Any logged-in client can share the QR code forward from the UI side menu's QR share, so the host does not need to be a single point of contact for new arrivals — anyone already in the session can help an incoming friend join. The host also gives announcements, introduces the format briefly for first-timers, and provides hands-on help as needed.

### Session Manager

The session manager is the platform operator during a live event. The role can be filled by the composer, a technically-inclined assistant, or a collaborator distinct from the event host. The **primary session manager** receives an admin credential from the developer or composer, which grants access to the `/setup` login and, from there, the full admin-level dashboard. With that credential the primary session manager chooses the score, configures the session parameters — voting duration, holding duration, fade duration, audio level (%), passwords — and places the session on **hold** or **pause** until the event is ready to begin.

**Multiple session managers.** Nested Notation allows any number of clients to serve as session managers simultaneously by connecting with the session's manager password. This effectively distributes live-session responsibilities across collaborators within the `/sm` interface: hold, pause, history scroll-back, global refresh, and end. Manager-password-only clients are *barred* from hot-swapping the score, adjusting voting or holding durations, or adjusting audio level (%) — those remain with the primary (admin-credentialed) session manager. (**Note for a future version:** the **end** control should be removed from the manager-password `/sm` interface, as ending a session is a drastic action that should not be exposed to every session manager. God forbid a mis-tap. Likewise, tapping **Stop Session** from the setup console should invoke a modal dialog box for confirmation in a future version.)

**Posture.** The session manager's role can be active or passive, depending on the individual and the session. In the main, they are closer to a stage manager than a conductor — keeping the mechanism running so the music can happen, rather than actively shaping the arc. Client count on the admin dashboard is a resource but need not be watched closely. Config and pacing are adjusted only when clearly warranted.

**Pacing.** The session manager can adjust voting and holding durations live during a session, lengthening or shortening the windows as the room's energy shifts. Shorter voting windows mean quicker transitions; longer holding windows give musicians more settling time within each frame.

**Crowd sound volume.** The audio level (%) dialog in the setup console controls the volume of the distributed audience sound. This is one of the session manager's most expressive levers: it can be used to encourage musicians to play louder or quieter, to boost the crowd field when musicians are playing loudly, or to fade the room out gracefully at the close of a piece or concert.

**Navigation nuances.** The session manager cannot advance the score any differently than an audience member — they vote like anyone else. They can, however, invoke **hold** at the moment their preferred vote is winning, effectively freezing a favorable outcome in place. They can also jump through the navigation history via the History dropdown in `/sm`.

**Disruption protocol.** When something goes wrong, the session manager's options are **hold** and **pause**. Pause removes the SVG content from view for all clients, which is effectively stopping the session flow and is therefore reserved for ending a piece or handling something serious. Hold gives the session manager a moment to address a situation without dropping the room out of the piece.

**Hot-swapping scores.** If an event calls for more than one score — much like a concert flowing from piece to piece — the primary (admin-credentialed) session manager can select a different score in the setup console and tap **update**. Sometimes **global refresh** in `/sm` is also required. Participants remain logged into the same session throughout, so there is no need to redo QR sharing or re-authenticate. This turns a Nested Notation event into a multi-piece program, whether that means Tesseract to Serotonin in a concert setting or a rapid, unceremonious swap in a classroom.

**Closing.** When a piece or the event is winding down, the session manager typically tapers the crowd sound first, then places the session on pause to clear the SVG from view and bring the piece to rest.

## Interaction Modes

The session interface features a tab bar at the bottom of the screen with two modes:

### Play Mode

In Play mode, the user interacts with sound-making SVG elements. Tapping a colored element starts its associated sound and the element begins a slow opacity fluctuation — a breathing animation that indicates the sound is active. Tapping again stops both the sound and the animation. Multiple elements can play simultaneously — in effect, each device becomes a simple sampler, with users triggering and layering pre-recorded audio in real time. When dozens of audience members each trigger different samples simultaneously, the collective result is a distributed instrument whose mix emerges from the crowd rather than from any single performer.

To de-emphasize navigation-only elements, CSS applies a grayscale filter to all <a> tagged SVG elements which do not play sound. These elements become black, white, and grey, while soundmaking elements and other graphic elements without SVG markup retain their full color.

Sound playback uses [Howler.js](https://howlerjs.com/) on the client. Each sound-making SVG element has a `sound` attribute referencing one or more audio files (comma-separated for chords and other multiple consonances). Sounds are loaded on demand and can be configured for looping, fade duration, and volume.

While audio assets are loading, the score enters a loading state: in Play mode, the entire SVG goes grayscale and all tap interaction is disabled, and a "loading audio..." indicator with an animated progress bar appears near the bottom of the screen. Once all sounds for the frame have loaded, the grayscale filter lifts, interaction is restored, and the loading indicator disappears.

### Guide Mode

In Guide mode, the user can tap navigation links to cast votes for where the music should go next. SVG elements without <a> tags are grayed out, and the link structure either gains or retains its full color. Any session-authenticated client can open a voting round by tapping a link, provided the session is not paused and no hold period is active. The first tap starts the round; subsequent taps from other clients register as votes within that round.

During voting, circular indicators appear on each link showing the current vote count. The client's own vote is highlighted as a solid orange circle with white text, while votes for other options appear as white circles with an orange border and orange text. The option currently in the lead pulses with an orange glow. Clients who are in Play mode during a vote see only the winning marker — a radial orange glow on the leading link — without the full tally, keeping the Play interface uncluttered. A "Stay" button in the upper-left corner allows voting to remain on the current frame.

After the configurable voting duration expires, the platform navigates all connected clients to the winning frame. In the event of a tie, the server selects randomly among the tied options, with a stabilization rule: if the current leader is among the tied options and the number of tied options hasn't changed, the server holds with the current leader rather than re-randomizing.

By default, every client returns to Play mode after each frame transition. Double-tapping the Guide button activates **guide lock**, which keeps the interface in Guide mode across transitions. This is especially useful for instrumentalists who prioritize voting — with guide lock enabled, they can vote on navigation with a single tap and immediately return their attention to reading and playing, without needing to switch modes after every transition. In guide lock, sound interaction is disabled; the client acts purely as a navigator.

Guide lock is a per-client, self-activated toggle — it grants no special voting power. A participant's vote while in guide lock is still one vote among many. Guide mode does however offer an emergent and extreme-outlier mode of *consensual conducting*: if a single participant enters guide lock and the rest of the ensemble chooses not to cast votes, that person's taps drive navigation uncontested. The mechanism does not silence anyone else; the conducting is only possible by the consent of those who remain passive.

### UI Side Menu

A side menu is accessible from the upper-right corner of the session interface. It contains the following items:

**Score title** — Displayed at the top of the menu. If the score includes a `Documentation/` folder, tapping the title opens an overlay with navigable SVG pages authored by the composer. These serve as program notes, how-to-play guides, credits, and other score-specific documentation. For example, Tesseract includes 29 documentation pages (FAQ, Fields, Map, Songs, Notes, Scales, Webapp guides, and more), while Serotonin includes 10 (About, Basics, Form, Philosophy, How-To-Play, Credits, and others). Scores without a Documentation folder do not show the title as a tappable link.

**Refresh session** — Reloads the session page.

**Autoplay** — A toggle switch that controls automatic sound playback on this client. When enabled, sounds marked with `autoplay="true"` (or defaulting to the session's autoplay setting) begin playing as soon as a frame loads. When disabled, frames load silently and all sounds must be triggered manually by tapping. Autoplay is the natural posture for instrumentalists whose hands are on their instruments, and the gentlest entry point for anyone unsure how to begin participating — with autoplay on, the device contributes sound to the distributed instrument without the participant having to tap.

**About** — Opens an overlay with navigable SVG pages that explain the basics of the Nested Notation platform — how Play and Guide modes work, how voting works, and how to interact with the interface. These pages are platform-level (not score-specific) and are available in every session, distinct from the per-score documentation accessed via the score title.

**QR share** — Generates a QR code containing the session URL with the player password embedded, which can be scanned by audience members to join the session directly as players. The QR share is available to any logged-in client, including riders — a consequence of which is that a rider (who does not themselves hold voting privileges) can share the QR code and grant player access to whoever scans it. This is an architectural quirk flagged for consideration in a future version.

### Session Manager Controls

When connected with the manager password, additional controls appear in the session interface. A header bar above the score provides real-time session controls:

**Hold** — A checkbox that manually triggers or releases a hold period, preventing navigation while musicians settle into the current frame.

**Pause** — A checkbox that pauses the session for all connected clients. While paused, no voting or navigation can occur, all SVG content is hidden from view, and the word "paused" is visible on client displays.

**History** — A dropdown of previously visited frames. Selecting a frame jumps all connected clients to that point in the navigation history.

A footer bar below the score displays status and provides additional actions:

**Player / Rider counts** — Live connection counts showing how many players and riders are connected to the session.

**Global refresh** — Forces every connected client device to refresh simultaneously. This is especially useful when the admin has updated session parameters or changed the score folder and needs all clients to pick up the changes immediately.

**End** — Ends the session for all connected clients. This is deprecated and scheduled for removal in a future version.

**Wake lock** — Attempts to prevent the session manager's device from sleeping during a session. This uses the NoSleep.js library (v0.9.0); however, its functionality is limited on modern devices and browsers that have restricted the underlying APIs. This is deprecated and scheduled for removal in a future version.

### Countdown Timer

During voting and hold periods, a row of up to 10 small circles appears in the upper-right area of the interface on all connected devices — session managers, players, and riders alike. The circles fill in progressively as time elapses, giving everyone a visual indication of how much time remains.

A holding (or cooldown) timer appears during the standby period after a vote resolves, and a lock-shaped icon appears for its duration. When the hold icon activates, it also adds a `holding` class to the page body. In Guide mode, this triggers a full grayscale filter on the entire SVG content — a visual signal that navigation is locked. In Play mode, however, the SVG retains its full color during a hold, so players can still see and interact with sound elements even though navigation is temporarily blocked.

### Gallery Mode

Gallery mode, enabled via the admin console's "gallery mode" checkbox, automatically activates all clients' autoplay toggle when the session connects. This is designed for unattended installations or exhibition settings where devices should begin playing sounds immediately without any user interaction. Combined with the "autoplay default" setting, gallery mode allows a session to run without direct interaction on each device, although user input is still required for navigation to occur. There is not yet any feature which auto-navigates a score.

## Score Library

The library contains scores ranging from short etudes to large-scale compositions. Scores are divided into three categories by how they relate to canonical Nested Notation grammar: **Canonical**, **Unhinged**, and **Nonconforming**. Each category is defined below, followed by the scores that belong to it.

### Canonical Scores

Canonical scores follow the rigorous grammar described earlier in this document. Three requirements hold together:

- **Rotation-locked child rings.** Within each child ring, position is a direct readout of chromatic pitch: position 0 (noon) = C, position 1 = C♯/D♭, and so on clockwise around the twelve internal positions. A note's location within its child ring is therefore sufficient to identify its pitch, independent of context.
- **Isotonal connecting curves.** Curves link like-named positions across child rings, asserting that the same pitch is shared across distinct harmonic contexts. A G at position 7 in one ring connects to the G at position 7 in another; the curve declares pitch-identity.
- **Structural/harmonic self-similarity.** The arrangement of child rings on the meta-ring mirrors the arrangement of notes in the refocus ring. The score's large-scale structure recapitulates the pitch content of its constituent rings — the part echoes the whole and vice versa.

| Score | Frames | Audio | Description |
|-------|--------|-------|-------------|
| Tesseract | 65 | 276 | Cube-shaped navigation with 5 simultaneous audio layers (Field, Font, Map, Scale, Song) |
| Serotonin | 162 | 176 | Molecular structure of serotonin mapped onto navigable score topology (see below) |
| Barber's Adagio Test | 24 | 121 | Barber's Adagio for Strings transcribed in both Western and Nested notation; participants may traverse the piece forward or backward |
| Hoops Winter | 19 | 90 | Excerpt of a cosmology, with libretto, in progress: Night circles the North and Winter, Day circles the South and Summer; Dawn-East-Spring, Dusk-West-Fall |
| 3F Response | 34 | 50 | Narrative choice tree about a threat to your survival. Do you fight, flee, or freeze? |
| Zoomorph Test | 23 | 40 | Narrative choice tree about becoming different animals |
| Rigid Die (rotation locked) | 16 | — | Cube-shaped navigation |
| Chromatic Intervals (etude) | 24 | — | All dyad intervals within an octave, presented as ring positions against a tonic pitch at position 0 |
| Diatonic Tetrachords (etude) | 20 | — | Four-note scale segments (DO-RE-MI-FA, RE-MI-FA-SOL, etc.) |

### Unhinged Scores

Unhinged scores (marked with the `-u-` prefix in folder names) deliberately relax canonical grammar in order to produce kinds of harmonic motion that canonical scores cannot express. The flavor is defined by two independent tenets, either or both of which may be in effect in a given score.

The first tenet is **free rotation**: child rings are no longer locked to a noon C (position 0 no longer means only the pitch C) in the chromatic clockface. Each child ring may be oriented freely, so the pitch at a given position within the ring is no longer read off the clockface directly. A musician may inherit a given pitch, arbitrarily choose it, or respond to a clear auditory association in the acoustic environment. The second tenet is **breaking isotonal grammar**: connecting curves may bridge notes at *any* ring positions, not just positions that reinforce isotonality. A curve still asserts pitch-sameness in the moment the musician reads it, but because it now links positions that don't uphold a harmonic equilibrium, the sameness it declares is local rather than global.

The consequence of the second tenet — and, importantly, it holds whether or not any rings have actually been rotated — is that each non-matching curve becomes a **metastatic hinge**. It is a local sameness-claim that seeds a modulation as the reader traverses the figure repeatedly. Following such a curve carries a pitch from one ring's context into another, and the accumulated offsets over successive readings produce a **growth cycle**: a pitch-space trajectory analogous to a Bach sequence, but encoded geometrically in the graph rather than described procedurally. The notation *generates* the modulation; it does not *narrate* it. The reader's journey through the score enacts the modulation that the graph quietly prescribes.

There are eleven distinct growth cycles, corresponding to the non-zero signed semitone offsets mod 12: ±1, ±2, ±3, ±4, ±5, and the self-inverse tritone (6). Direction is kept distinct for each interval pair, which is why there are eleven rather than six. Each cycle inscribes a regular polygon in the 12-position clockface — dodecagon for ±1, hexagon for ±2, square for ±3, equilateral triangle for ±4, 12-pointed star for ±5, and digon for the tritone — with cycle length equal to 12 / gcd(|interval|, 12). Where Canonical scores uphold harmonic stability (allowing rich audio content), Unhinged scores capture harmonic motion — the notation pulling the musician through key space. Careful, you might break something.

Unhinged scores currently carry no audio. Pre-recorded samples assume the canonical fixed mapping from ring position to pitch, which growth cycles disrupt: the same visual position sounds at a different pitch on each repetition. A future audio pathway using Howler's `rate()` for tape-style transposition is under consideration, which would let Unhinged scores drive sample playback at the shifting pitch each reading demands.

The Unhinged scores currently in the library:

| Score | Description |
|-------|-------------|
| `-u- Choice Box` | Cube-shaped navigation under free rotation |
| `-u- Fuzzy Die (7-note)` | Cube-shaped navigation under free rotation, with 7-note diatonic clockface |
| `-u- Happy Birthday` | Familiar melody re-encoded with growth-cycle modulation |
| `-u- Hello` (deprecated) | Legacy beginner tutorial |
| `-u- Merkaba` | Counter-rotating Tetrahetra with primitive song paths |
| `-u- Short Braid` | Interwoven frame paths |
| `-u- The Reactor` | Jack-and-cube inscribed in vertices of an octahedron with central reactor node |
| `-u- Twelve Ring` | Linear navigation through twelve nodes |
| `-u- Two Moths` | Two connected halves of a network, each with a moth outline shape |

### Nonconforming Scores

Nonconforming scores have no notational specification, but make use of the Nested Notation app's vote-based navigation and audio playback capability. This includes hybrid scores featuring Western notation, purely visual compositions, audio installations, and simple instruments.

| Score | Frames | Audio | Description |
|-------|--------|-------|-------------|
| Hey-Bob | 55 | — | Humorous app primer with text and rich SVG imagery |
| Rigid Fuzzy Die (rotation locked 7-note) | 16 | — | Cube-shaped navigation, noon=C, with 7-note diatonic clockface |
| Tetra-blocks | 10 | 36 | Polychordal drone jamming in four related key areas |

### Hoops Winter: Rhythm from Harmony

**Hoops Winter** introduces a novel rhythmic notation that derives its figures directly from the harmonic content of a frame. In Nested Notation, harmonic structure is independent of octave disposition: one C is all Cs, one G is all Gs. Range is handled separately by the root marker and treble note stroke, leaving the ring to specify pitch classes alone.

**From pitch-class set to interval tally.** For any ring, count the intervals between every pair of pitch classes, including each pitch class's unison with itself. Then unfold the count across the full octave — unison, minor second, major second, minor third, major third, perfect fourth, tritone, perfect fifth, minor sixth, major sixth, minor seventh, major seventh, octave — thirteen positions in all. Because unison and octave are the same pitch class under "one C is all Cs," the count at each end equals the cardinality of the set.

A C major triad (C, E, G) yields:

```
3 | | 1 1 1 | 1 1 1 | | 3
```

— three unisons (one per note paired with itself), one minor third (E–G), one major third (C–E), one perfect fourth/fifth (C–G), and, mirrored around the tritone axis, the same tallies on the upper side of the octave. The pipe `|` is a placeholder that holds an empty grid position open for the eye; it carries no rhythmic duration and is not sounded.

**Every pitch-class set produces a palindrome.** For any unordered pair of pitch classes, the interval from A to B is *k* semitones and from B to A is *12 − k*, so every non-unison pair contributes symmetrically to positions *k* and *12 − k*. The tritone axis is self-complementary. The unison/octave endpoints both equal the set's cardinality. The resulting thirteen-position string is always palindromic — and because interval classes fold inversions together, mirror-related chords (a major triad and a minor triad, for example) share the same graph.

**The glyph alphabet.** Hoops Winter renders each position as a note-head shape whose visual grammar echoes Western duration notation while extending it for counts Western notation cannot cleanly express:

- `|` — empty position, no sound, no time
- `1` — filled diamond notehead with stem; adjacent 1s beam together with a single horizontal flag, like eighth notes
- `2` — filled diamond, no stem
- `3` — filled diamond with a dot above (dotted-Western logic: +half)
- `4` — open diamond with stem (no beaming, reminiscent of a half note)
- `5` — open diamond with stem and a dot inside (logic: +1)
- `6` — open diamond with stem and a dot above (dotted-Western logic: +half)
- `7` — open diamond with stem, a dot inside, and a dot above (logic: +half, +1)
- `8` — open diamond, no stem (reminiscent of a whole note)
- `9` — open diamond with one dot inside (logic: +1)
- `10` — open diamond with two dots inside (side by side, like eyes; the doubling mirrors the single inside-dot of 5, since 10 = 2 × 5)
- `11` — open diamond with three dots inside in an equilateral triangle (rare in practice)
- `12` — open diamond with a dot above (dotted-Western logic applied to the stemless open diamond: 8 +half = 12)

The filled/open distinction alludes to the Western convention that filled noteheads carry shorter durations than open ones, although the stem conventions for `1` and `2` break the literality of a consistent 2× doubling. Dots above follow the Western dotted-note convention; dots inside are bespoke additive marks for counts that Western notation cannot render as a single duration.

**Performance.** A musician reads the figure from one end to the other and back again, as many times as they wish. Because the string is palindromic, the forward and backward passes are identical, and the two endpoint glyphs meet seamlessly at each turnaround — the C major triad loops as "dotted quarter, six eighth notes, dotted quarter, six eighth notes…" indefinitely. The rhythm is both literal and improvisatory: the notation is structurally fixed, but a musician is always encouraged to respond to the sounds of their environment following their own intuition. What sounds good, is good.

## Score Data Format

Scores live under `public/data/`. There are two structural patterns:

### Simple Scores (SVGs at root level)

For scores without audio, SVG frames sit directly in the score folder:

```
public/data/Rigid Die (slated for multimedia rework)/
├── START.svg
├── PRE-1.svg
├── PRE-2.svg
├── 1.svg
├── 2.svg
└── ...
```

### Multimedia Scores (Frames/Sounds/Documentation subfolders)

For scores with audio and documentation:

```
public/data/Tesseract/
├── Frames/              # SVG frames
│   ├── START.svg
│   ├── A.svg
│   ├── A2B.svg
│   ├── Arefocus.svg
│   └── ...
├── Sounds/              # Audio files (m4a)
│   ├── Field/
│   ├── Font/
│   ├── Map/
│   ├── Scale/
│   └── Song/
└── Documentation/       # SVG-based program notes (also navigable)
    ├── START.svg
    ├── MAP.svg
    ├── FAQ1.svg
    └── ...
```

### Frame Naming Conventions which affect app functionality:

- **`START`** prefix — Entry point candidates. The server randomly selects one `START`-prefixed file as the initial frame.
- **`PRE`** prefix — Pre-frames (fallback entry points if no `START` files exist). Links in `PRE` frames are not counted as multi-choice for voting purposes. This feature has been marked as deprecated and scheduled for removal in a future version.

### Frame Naming Conventions (arbitrary) which may help composers organize their networks clearly:

- **Transition frames** — May be named with a `2` separator indicating directionality (e.g., `A2B.svg` and `B2A.svg`).
- **Refocus frames** — Named with `refocus` suffix (e.g., `Arefocus.svg`), serving as navigation anchors.
- **Transit frames** — Named with `TRANSIT` (e.g., `C2-TRANSIT-N1.svg`), indicating passage between sections.

### SVG Structure

Each SVG frame uses named `<g>` (group) tags to organize its content. Common structural groups include `Meta-Ring-and-Background`, `Child-Rings`, `Ring-Backers`, `Notes`, and `Root-Markers` (see [Ring Structure Anatomy](#ring-structure-anatomy) for a detailed explanation of these elements). Score-specific groups such as `Fields`, `Songs`, and `Map` appear in compositions that use additional audio layers.

Navigation links are `<a>` elements with `href` attributes pointing to other frame filenames.

### Score Markup Attributes

The following attributes are authored by the composer directly in SVG elements. They control sound playback and session timing when the score is performed.

#### Sound Attributes

| Attribute | Values | Description |
|-----------|--------|-------------|
| `sound` | File reference(s) | Which audio file(s) to play when the element is tapped in Play mode. Three patterns are used: a simple name (`sound="0"`), a comma-separated list for chords and other consonances (`sound="3F-Low-Ab,3F-Mid-F,3F-Mid-C,3F-High-G"`), or a folder path for scores with organized audio layers (`sound="Field/01-Zen"`, `sound="Font/1-High-Ab"`). All paths are relative to the score's `Sounds/` folder. |
| `autoplay` | `"true"` or `"false"` | Whether the sound starts automatically when the frame is displayed. If this attribute is omitted, the element inherits the session's "autoplay default" setting from the admin console. When "autoplay default" is checked, all sounds without an explicit `autoplay` attribute will autoplay; only elements marked `autoplay="false"` are excluded. When "autoplay default" is unchecked, no sounds autoplay unless explicitly marked `autoplay="true"`. |
| `loop` | `"false"` | When present, the sound plays once and stops. If this attribute is omitted, sounds loop by default. |
| `volume` | `"0"` – `"100"` | Playback volume for the element, on a 0–100 scale. Values used in practice include `30`, `40`, `50`, `80`, and `100`. If omitted, uses the session default. |

#### Timing Attributes

| Attribute | Values | Description |
|-----------|--------|-------------|
| `voting` | Percentage (e.g., `"400%"`, `"50%"`) or seconds (e.g., `"5"`) | Overrides the session's default voting duration for this frame. A percentage multiplies the session default (e.g., `"400%"` on a 10-second default = 40 seconds). A raw number sets an absolute duration in seconds. Longer voting windows give the audience more time to deliberate on complex frames. |
| `holding` | Percentage (e.g., `"200%"`, `"400%"`) or seconds (e.g., `"5"`) | Overrides the session's default hold duration for this frame. The hold period is a cooldown after a vote resolves, giving musicians time to settle into the new frame before the next vote can begin. Works the same as `voting` — percentages multiply the session default, raw numbers set absolute seconds. |

#### Visual Classes

| Class | Applied To | Description |
|-------|-----------|-------------|
| `votemagnet` | Any SVG element (typically a `<g>` group) | Controls where the orange vote indicator circle appears for a navigable link. When a client votes in Guide mode, the platform looks for a `.votemagnet` element inside the voted link's container. If found, the vote indicator is positioned at the center of that element's bounding rectangle. If no `votemagnet` is present, the indicator falls back to the container element's center. This gives the composer precise control over where vote markers appear — useful when the visual center of a ring or link group isn't the ideal place for the indicator. Used extensively across both Serotonin (162 frames) and Tesseract scores. |

## Composing Scores

Composing for Nested Notation is a multi-stage process that integrates network design (macrostructure), harmonic planning (microstructure), visual authoring, and audio production.

### 1. Network Design (macrostructure)

A composer begins by searching for a network graph that promises narrative potential — typically sketched with pencil and paper. The graph defines the topology of the piece: how many nodes exist, which nodes connect to which, and what multiple paths are available at each node. This graph becomes the branching structure that audiences will navigate.

### 2. Harmonic Plotting (microstructure)

Once the network paths are understood, the composer plots the harmonic content across its nodes, also typically with pencil and paper. Since the visual signatures of canonical Nested Notation match the harmonic content (child ring positions in meta-rings match note positions in the refocus ring, and note positions in child rings correspond to chromatic pitches), the composer carefully designs the harmonies and relationships that carry across nodes. Transition frames between nodes without meta-ring structure require less careful attention, as they bridge harmonic contexts through voice leading (a less rigid relationship).

### 3. Audio Production

Concurrently, the composer records or otherwise generates the audio assets that will play when users tap elements in Play mode. These assets should be musically (harmonically, texturally) consistent with the ring content of each frame. For example, in Tesseract, the audio file `Song/06-Tubular-D2A.m4a` contains notes that match the pitches available in the corresponding ring (Low-G♭, Mid-D♭, Mid-F, High-A♭), ensuring a consonant musical experience whether a user is tapping individual notes or hearing the Song layer. The composer also considers potential graphical elements — such as Tesseract's Song, Field, Map, and Scale elements — that will map to these audio assets. Naming conventions (e.g., `06-Tubular-D2A`) help the composer keep the visual, harmonic, and audio layers aligned.

### 4. SVG Authoring

With the network, harmonies, and audio planned, the composer opens an SVG editor such as **Affinity Designer** to author the visual frames. Each `<g>` tag is carefully named during design (e.g., `Meta-Ring-and-Background`, `Child-Rings`, `Notes`, `Root-Markers`, `Fields`, `Songs`) to provide clarity in the subsequent markup step. The visual layout encodes the harmonic structure: ring positions, note colors, root markers, and connecting curves are all drawn to reflect the compositional plan. The visual layout also provides a unified design for the cueing of audio assets, and presentation of any hybrid content such as Western notation or purely graphic imagery.

### 5. Markup

If SVG authoring is like drawing a flipbook frame by frame, markup is like arranging the pages in the correct order. After exporting from the SVG editor, the composer opens the raw SVG files in a code editor and hand-edits the XML to add the interactive layer:

- **Navigation links** — Wrapping drawn elements with `<a href="...">` tags to wire frames together according to the network graph.
- **Sound mapping** — Adding `sound` attributes to graphical elements, connecting them to the corresponding audio files in the `Sounds/` folder.
- **Playback behavior** — Adding `autoplay="true"`, `loop="false"`, and `volume` attributes to control how individual sounds behave.
- **Timing overrides** — Adding `voting` and `holding` attributes to control pacing at nodes if necessary. These values are planned in advance and reflect the composer's intent about how long the audience should dwell at each point in the network. For example, in Serotonin, a vertex frame like `C2.svg` — with rich harmonic content and multiple navigation options — carries longer voting and holding periods than a transit frame like `C2-TRANSIT-C3.svg`, which serves as a passageway between nodes and needs less deliberation time.
- **Vote indicator placement** — If necessary, adding the `votemagnet` class to an element within each navigable link to control where the orange vote indicator circle appears in Guide mode. Without it, the indicator defaults to the center of the link's container element.

The markup must display consistent behavior across the network: timing values, autoplay settings, and sound mappings are all extensions of the compositional plan, not afterthoughts.

**Autoplay as a compositional choice.** The `autoplay` attribute on individual SVG elements makes use of the session's `autoplay default` setting in a useful way: `autoplay default` governs the *posture of the unmarked majority* of notes, while explicit `autoplay="true"` or `autoplay="false"` attributes are the composer's per-element exceptions. Rather than annotating every soundmaking element by hand, the composer picks a default that matches the piece's overall disposition — *ready to sound* or *waiting to be voiced* — and then marks only the elements that deviate from it. Tesseract, for example, sets `autoplay default = false` and marks exactly three elements per transition frame (Field, Song, Map) as `autoplay="true"`; every other element at the transition, and nearly every element at each vertex, is left unmarked and therefore silent on arrival, available for tap. The default captures the piece's restraint; the explicit markup names its exceptions.

**Cross-frame continuity.** When the same `sound` value appears on an element in both the outgoing and incoming frame, that sound continues seamlessly across the transition — same volume, same seek position, rather than restarted (see [Load Behavior at Frame Transitions](#load-behavior-at-frame-transitions) for the matching logic). Composers use this to author continuous threads that bridge the group vote: a Field that spans a transition, a Song that carries across a boundary. Conversely, changing the sound ID at the boundary is indicative of change, as new sound replaces what came before. The graph advances; whether or not a given sound does is a function of the graph's structure.

### Checking Markup

The browser's developer console serves as the composer's error-checking tool. The client-side code validates markup at load time and reports problems including: sound references that don't match any file in the `Sounds/` folder (logged with the incorrect name and the frame it was found in), empty `sound` attributes, mismatches between the number of volume values and sound values, individual sound files that fail to load, and navigation links that point to missing frames. Opening a session and watching the console will surface most markup errors.

## Architecture

Nested Notation runs two servers from a single Node.js process:

1. **HTTP server (Express)** — Serves the web UI, session manager dashboard, and pre-rendered session HTML. Uses Jade (Pug) for server-side templating and `apicache` for response caching.

2. **WebSocket server** — Handles all real-time communication: voting rounds, hold timers, frame navigation, pause state, and connection tracking.

The in-memory database (`BMDatabase`) holds all session and admin state. Session state is periodically persisted to JSON files in a `server_state/` directory so sessions survive restarts. SVG content is pre-built at session creation time — the server reads each SVG, injects metadata attributes, replaces `href` links with JavaScript handlers, and writes the result as static HTML.

```
Client (browser)
  │
  ├── HTTP GET  →  Express routes  →  Pre-rendered session HTML
  │
  ├── Play mode →  Howler.js       →  Client-side audio from Sounds/
  │
  └── WebSocket →  Message handler  →  Voting / navigation / sync
                        │
                        ▼
                  BMDatabase (in-memory)
                    ├── BMAdminTable
                    └── BMSessionTable
                          └── BMSession (per active session)
                                ├── SVG content (server_state/*.svg)
                                ├── Session HTML (server_state/*.html)
                                └── State JSON (server_state/*.json)
```

### Load Behavior at Frame Transitions

The session has been tested with simultaneous connections in the high dozens. The ideal headcount for a Nested Notation session is still unknown and will vary with venue network capacity.

At a frame transition, every client device simultaneously needs the new frame's SVG and audio assets, which produces a characteristic load spike. Several mitigations reduce that spike:

- **HTTP response caching.** SVG content routes and session HTML routes are cached with `apicache` (30-minute TTL, see `routes/session.js`), so repeated identical requests across clients are served from cache rather than rebuilt per-request.
- **Lazy audio loading.** Howler.js instances are initialized with `preload: false` in `public/javascripts/audio-player.js`; audio files are fetched only when the client actually needs them, not when a session page is first loaded.
- **Smart asset reuse across transitions.** When a frame transition occurs, `handleChangeFrame()` loads only the sounds that are new to the next frame. Any note whose sound ID appears in both the previous and next frame continues playing through a crossfade rather than being re-downloaded.
- **Staggered WebSocket dispatch.** The server's `sendToAllClientsWithDelay()` (`bin/www`) spreads frame-change notifications across clients using timestamped offsets, avoiding a simultaneous burst of identical asset requests.
- **Streaming SVG delivery.** SVG content is sent to clients as a file stream rather than being buffered in memory.

No CDN, gzip middleware, or reverse-proxy asset hints are currently configured. Large sessions should expect some turbulence at transitions; if a client's view or audio falls out of sync, a page refresh will re-subscribe it to the current frame state.

## Prerequisites

- **Node.js** (v14 or later recommended)
- **npm**
- **PM2** (for production process management): `npm install -g pm2`

## Installation

```bash
# Clone the repository
git clone https://github.com/nestednotation/nestednotation.git
cd nestednotation

# Switch to the develop branch
git checkout develop

# Install dependencies
npm install
```

## Configuration

The application uses environment variables loaded from `.env.development` or `.env.production` depending on `NODE_ENV`.

| Variable    | Description                          | Dev Default                    | Prod Default        |
|-------------|--------------------------------------|--------------------------------|---------------------|
| `PORT`      | HTTP server port                     | `3001`                         | `3005`              |
| `WS_PORT`   | WebSocket server port                | `2382`                         | `2811`              |
| `SERVER_IP` | Public hostname for WebSocket URL    | `proapi.nestednotation.com`    | *(server IP)*       |

The PM2 ecosystem config (`ecosystem.config.js`) also defines these values and can override the `.env` files:

```bash
# Development
pm2 start ecosystem.config.js

# Production
pm2 start ecosystem.config.js --env production
```

### Admin Credentials

On first run, if no `account/admin.dat` file exists, a default admin account is created:

- **Username:** `kip`  /  **Password:** `123`

> **Important:** Change these credentials before deploying to a public server.

## Running the Server

```bash
# Development (direct)
npm start

# Development (with PM2)
pm2 start ecosystem.config.js

# Production (with PM2)
pm2 start ecosystem.config.js --env production
```

The HTTP server starts on the configured `PORT` and the WebSocket server on `WS_PORT`.

## User Roles and Workflow

### Roles

1. **Developer** — Creates admin accounts directly in the codebase. Manages server deployment and configuration.
2. **Primary Session Manager / Admin** (`/setup` → `/sm`) — Receives an admin credential from the developer or composer. Authenticates with username and password at `/setup` and is redirected to the `/sm` dashboard. Creates and configures performance sessions (score folder, voting duration, holding duration, voting size, fade duration, audio level (%), passwords), hot-swaps the score during an event, and exercises all live controls below.
3. **Additional Session Manager** (`/sm`) — Any client connected with a session's manager password. Nested Notation allows multiple simultaneous session managers, distributing live-session responsibilities across collaborators: **hold**, **pause**, history scroll-back, **global refresh**, and **end**. Manager-password-only clients are barred from hot-swapping the score, adjusting voting or holding durations, and adjusting audio level (%); those remain with the primary (admin-credentialed) session manager. (**Future-version note:** the **end** control should be removed from this interface — ending a session is too drastic to expose to every manager.)
4. **Player** (`/session`) — Connects to an active session with the player password (typically shared via the QR code). Uses Play mode to trigger sounds and Guide mode to vote on navigation. Both musicians and audience members are players.
5. **Rider** (`/session`) — Connects to an active session via a valid session name *without* entering a password. Riders can fire audio samples in Play mode but cannot vote. This is a somewhat vestigial status from a previous version of the platform, retained for audience members who want to participate passively without affecting navigation.

### Typical Performance Workflow

1. The developer creates admin accounts in the codebase.
2. An admin logs in at `/setup` → redirected to `/sm`.
3. From the `/sm` dashboard, the admin creates a session, selecting a score and configuring timing parameters (including a manager password).
4. Audience members join via the session URL or QR code.
5. Musicians read the SVG frames on their devices (or a projected display) and play along on their instruments.
6. Audience members switch between Play mode (triggering sounds on their devices) and Guide mode (voting on which frame comes next).
7. Votes are tallied in real time. After the voting window, all devices advance to the winning frame.
8. The session manager (anyone connected with the manager password) can pause, jump through history, force a global refresh of all client devices, change scores, or end the session.

### Admin Console (`/sm`)

When creating or updating a session, the admin console exposes the following options:

**name** — A human-readable session name. Read-only after creation.

**folder** — The score to perform, selected from a dropdown of all score folders under `public/data/`. This is hot-swappable during a live session: changing the folder and clicking "Update session" reloads the score on the server, clears all active timers, resets the navigation history, and forces every connected client to refresh with the new score.

**sm password** — The manager password. Anyone who connects with this password gains session manager controls (pause, hold, history navigation, end session). Defaults to `"managerpassword"`.

**player password** — Required for session creation. This password is embedded in the session URL and QR code, so arriving participants who receive the link or scan the code join automatically as players without needing to enter it manually. The server distinguishes players (who connected with this password) from riders (who did not) — see [Roles](#roles). Both counts are displayed to any session managers.

**voting duration** — Duration of each voting round in seconds (default: 10). Individual frames can override this with the `voting` markup attribute.

**holding duration** — Hold period after a vote resolves in seconds (default: 10). Prevents further navigation while musicians settle into the new frame. Individual frames can override this with the `holding` markup attribute.

**fade duration (ms)** — Audio crossfade duration in milliseconds (default: 1000). On frame transitions, this value controls three behaviors via Howler.js: sounds that do not continue to the next frame fade out from their current volume to silence over this duration; new sounds in the incoming frame (with autoplay enabled) fade in from silence to their target volume; and sounds that are common between the outgoing and incoming frames receive a seamless crossfade — the new instance picks up the previous instance's volume levels and seek position, creating a continuous handoff. Setting this to 0 produces abrupt cuts; higher values create smoother, more gradual transitions.

**voting size (%)** — Display size of vote indicator circles as a percentage (default: 100).

**audio level (%)** — Default playback volume for all sound elements (default: 80). Individual elements can override this with the `volume` markup attribute.

**autoplay default** — The fallback for notes without an explicit `autoplay` attribute. When checked, unmarked sound elements are treated as `autoplay="true"` (and will autoplay on frame load whenever a client has its UI autoplay toggle enabled); only elements marked `autoplay="false"` are excluded. When unchecked, unmarked sound elements are treated as `autoplay="false"`, so only elements explicitly marked `autoplay="true"` can autoplay. Composers use this setting to decide how much of their markup they need to annotate by hand: set the default to match the posture of the majority of notes, then mark the exceptions.

**gallery mode** — When checked, each client's autoplay toggle flips on automatically once the session's initial sounds finish loading. This is the only mechanism that auto-enables the client UI toggle — **autoplay default** does not. Pair `autoplay default` (the per-note fallback) with `gallery mode` (the client-toggle initial state) to shape the room's posture: `default=false, gallery mode=true` yields a room that's *sounds together some of the time* (Tesseract's ideal — the composer marks transitions explicitly and lets vertices wait for the room); `default=true, gallery mode=true` yields a fully self-playing room, appropriate for unattended installations; `default=false, gallery mode=false` yields a tap-only room where silence somewhat more common.

**html5** — Toggles Howler.js between HTML5 Audio mode and Web Audio API mode. HTML5 Audio does not support certain Howler features (like fade) but can be more stable in certain situations.

For running sessions, the admin console also provides three actions: **Update session** (apply parameter changes to the live session), **Stop session** (end the session for all clients), and **Manage** (join the session as a session manager).

## WebSocket Protocol

All real-time communication uses JSON messages over WebSocket. Each message includes a session ID (`sid`), client index (`cid`), password (`sig`), and a message type (`msg`).

### Message Types

| Code | Constant                    | Direction        | Description                                        |
|------|-----------------------------|------------------|----------------------------------------------------|
| 0    | `MSG_PING`                  | Client ↔ Server  | Latency check; server responds with timestamps     |
| 1    | `MSG_TAP`                   | Client → Server  | Audience member taps a link to cast a vote          |
| 2    | `MSG_SHOW`                  | Server → Client  | Navigate all clients to a specific frame            |
| 3    | `MSG_NEED_DISPLAY`          | Client → Server  | Client requests current display state on connect    |
| 4    | `MSG_UPDATE_VOTING`         | Server → Client  | Broadcast updated vote tallies during voting        |
| 5    | `MSG_BEGIN_VOTING`          | Server → Client  | Signal start of a voting round with end timestamp   |
| 6    | `MSG_BEGIN_STANDBY`         | Server → Client  | Signal standby period after voting ends             |
| 7    | `MSG_CHECK_HOLD`            | Both directions  | Toggle or query hold state                          |
| 8    | `MSG_BEGIN_HOLDING`         | Server → Client  | Signal start of hold timer with end timestamp       |
| 9    | `MSG_FINISH`                | Both directions  | End the session for all clients                     |
| 10   | `MSG_PAUSE`                 | Both directions  | Toggle pause state                                  |
| 11   | `MSG_SELECT_HISTORY`        | Both directions  | Jump to a frame in the navigation history           |
| 12   | `MSG_SHOW_NUMBER_CONNECTION`| Server → Admin   | Report player and rider connection counts           |
| 13   | `MSG_CHANGE_FOLDER`         | Server → Client  | Reload session with a different score folder        |
| 14   | `MSG_CHANGE_VOLUME`         | Server → Client  | Update playback volume for all clients              |
| 15   | `MSG_GLOBAL_REFRESH`        | Server → Client  | Force all clients to refresh                        |

### Voting Flow

1. In Guide mode, a client taps a navigation link, sending `MSG_TAP` with the link ID and timing metadata (`frameVotingDur`, `nextFrameHoldingDur`).
2. If no vote is in progress, the server starts a voting round (`MSG_BEGIN_VOTING`) with the configured duration. Per-frame `voting` attributes can override the default duration (e.g., `voting="400%"` = 4× the session default).
3. During voting, the server periodically broadcasts `MSG_UPDATE_VOTING` with current tallies. Clients display circular vote indicators on each option.
4. When the timer expires, the server selects the winning frame. In the event of a tie, the server selects randomly among the tied options, with a stabilization rule: if the current leader is among the tied options and the number of tied options hasn't changed, the server holds with the current leader rather than re-randomizing. The server then enters a brief standby and sends `MSG_SHOW` to navigate all clients.
5. If a hold timer is configured (or the next frame has a `holding` attribute), `MSG_BEGIN_HOLDING` follows, preventing further navigation until the hold expires.

## API Routes

| Route        | Method | Description                                                                 |
|--------------|--------|-----------------------------------------------------------------------------|
| `/`          | GET    | Homepage; redirects to a session if auto-redirect is enabled                |
| `/setup`     | GET    | Login page for admins                                                       |
| `/sm`        | GET    | Admin and session manager dashboard — create, configure, and control sessions |
| `/session`   | GET    | Session entry point; validates password and redirects to the session view   |
| `/session/:id/` | GET | Serves the pre-rendered session HTML for a specific session                |
| `/session/:id/svgcontent.html` | GET | Serves cached SVG content for a session (30-min cache) |
| `/finish`    | GET    | End-of-session page                                                         |

## Deployment

The project uses GitHub Actions for CI/CD with two workflows:

**Development** (`develop` branch) — Pushing to `develop` triggers automated deployment: SSH into the dev server, pull latest code, `npm install`, restart PM2. Telegram notifications on start/success/failure.

**Production** (`main` branch) — Same flow against the production server with separate credentials.

### Required GitHub Secrets

| Secret              | Description                       |
|---------------------|-----------------------------------|
| `HOST`              | Dev server hostname/IP            |
| `HOST_PRO`          | Production server hostname/IP     |
| `SSH_USERNAME`      | Dev server SSH username           |
| `SSH_USERNAME_PROD` | Production server SSH username    |
| `SSH_PASSWORD`      | Dev server SSH password           |
| `SSH_PASSWORD_PRO`  | Production server SSH password    |
| `TELEGRAM_RECEIVER` | Telegram chat ID for notifications|
| `TELEGRAM_TOKEN`    | Telegram bot token                |
| `RELEASE_TOKEN`     | GitHub token for release-please   |

### Manual Deployment

```bash
ssh user@your-server
cd nestednotation
git pull origin develop   # or main
npm install
pm2 start ecosystem.config.js --env production
```

## Project Structure

```
nestednotation/
├── account/                  # Persistent admin/config data (.dat files)
│   ├── admin.dat             # Admin accounts
│   └── db.dat                # Auto-redirect configuration
├── bin/
│   └── www                   # Entry point — HTTP server, WebSocket server, message handling
├── public/
│   ├── data/                 # Score library (SVG frames, sounds, documentation)
│   ├── javascripts/          # Client-side JS (audio-player.js, voting.js, session.js)
│   ├── stylesheets/          # CSS (style.css — Play/Guide mode styling, grayscale filters)
│   ├── svg/                  # UI icons
│   └── images/               # Static images
├── routes/
│   ├── index.js              # Homepage / auto-redirect
│   ├── session.js            # Session entry and SVG content serving
│   ├── setup.js              # Login / authentication
│   ├── admin.js              # Admin account management (developer access)
│   ├── sm.js                 # Session manager dashboard
│   └── finish.js             # End-of-session page
├── utils/
│   └── sessionCache.js       # apicache configuration
├── views/                    # Jade (Pug) templates
│   ├── base.jade             # Base layout
│   ├── session.jade          # Main session view (Play/Guide UI, Howler.js integration)
│   ├── sm.jade               # Session manager dashboard
│   ├── admin.jade            # Developer-only admin account management view
│   ├── setup.jade            # Login page
│   ├── index.jade            # Homepage
│   ├── finish.jade           # End-of-session page
│   └── error.jade            # Error page
├── .github/workflows/        # CI/CD pipeline definitions
├── app.js                    # Express application setup
├── constants.js              # WebSocket message codes and form messages
├── database.js               # In-memory database, session/admin models, SVG builder
├── utils.js                  # Utility functions (slugify)
├── ecosystem.config.js       # PM2 process manager configuration
├── package.json              # Dependencies and scripts
├── .env.development          # Development environment variables
├── .env.production           # Production environment variables
├── .prettierrc               # Code formatting configuration
├── release-please-config.json # Automated release configuration
└── LICENSE                   # MIT License
```

## Troubleshooting

**Server won't start / "Port already in use"**
Check that the configured `PORT` and `WS_PORT` are not already in use. Stop any existing PM2 processes with `pm2 stop all` before restarting.

**"Session not found" when connecting**
Ensure the session has been created from the SM dashboard and that the session ID in the URL matches an active session. Sessions are removed from memory when stopped.

**SVG frames not displaying**
Verify that the score folder exists under `public/data/` and contains SVG files in a `Frames/` subdirectory (or at the root level for scores without sounds). Check the server logs for "Finish building svg content" messages.

**WebSocket connection failures**
Confirm that `SERVER_IP` in your `.env` file points to a reachable hostname or IP. The client connects to `wss://<SERVER_IP>`, so ensure your server has a valid SSL certificate for the domain.

**No sound in Play mode**
Verify that the score folder contains a `Sounds/` subdirectory with audio files, and that the SVG elements have `sound` attributes referencing valid file paths within that folder. Check the browser console for Howler.js errors.

**Voting doesn't start**
Voting triggers in Guide mode when a client taps a link and `votingDuration` is greater than 0. Only a single link is necessary. Per-frame `voting` attributes can override the session default. If `votingDuration` is 0 (or the frame's `voting` attribute is `"false"`), taps navigate directly without voting. Also ensure the session is not paused and no hold period is active.

**Session state not restoring after restart**
Session state is saved to `server_state/*.json`. Ensure the server has write permissions to this directory.

## Changelog

This project uses [Release Please](https://github.com/googleapis/release-please) for automated changelog generation and semantic versioning. See the [Releases](https://github.com/nestednotation/nestednotation/releases) page for version history.

## License

This project is licensed under the [MIT License](LICENSE).

Copyright (c) 2026 nestednotation
