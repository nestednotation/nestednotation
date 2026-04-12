# Nested Notation

Nested Notation is a notation system, performance platform, and compositional tool for interactive, non-linear music. It replaces the two-axis format of traditional notation — where the vertical axis encodes pitch and the horizontal axis encodes time — with a fundamentally different paradigm: harmonic relationships are encoded in geometric ring structures within each SVG frame, and time relationships emerge from the branching syntax of interconnected SVG files. This allows each moment in a piece to contain multimedia (sounds, images), and for the temporal structure of a composition to be highly variable in ways that are difficult or impossible to express in traditional notation.

In a Nested Notation performance, musicians read SVG frames as notation while audience members interact on their devices — playing sounds, navigating the score, and voting to collectively determine where the music goes next. The result is a live, collaborative musical experience where every performance follows a unique path through the composition.

## Table of Contents

- [How It Works](#how-it-works)
- [The Notation System](#the-notation-system)
  - [Ring Structure Anatomy](#ring-structure-anatomy)
  - [Tesseract: A Canonical Example](#tesseract-a-canonical-example)
- [Interaction Modes](#interaction-modes)
  - [UI Side Menu](#ui-side-menu)
  - [Session Manager Controls](#session-manager-controls)
  - [Countdown Timer](#countdown-timer)
  - [Gallery Mode](#gallery-mode)
- [Score Library](#score-library)
  - [Serotonin: Molecular Structure as Musical Topology](#serotonin-molecular-structure-as-musical-topology)
- [Score Data Format](#score-data-format)
- [Composing Scores](#composing-scores)
  - [Checking Markup](#checking-markup)
- [Architecture](#architecture)
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

A Nested Notation composition is a network of SVG frames. Each frame contains geometric ring structures that encode harmonic relationships and embed links to other frames. During a live session:

1. An **admin** logs in at `/setup`, selects a score, and creates a session with configurable parameters (voting duration, hold timers, passwords).
2. **Musicians** read the SVG frames as notation, interpreting the geometric structures on their instruments.
3. **Audience members** connect on their devices and interact in two modes: **Play** mode for triggering sounds, and **Guide** mode for voting on navigation.
4. When audience members tap links in Guide mode, a real-time vote begins. After the voting window closes, every connected device advances to the winning frame simultaneously.
5. A **session manager** — anyone connected with the manager password — can pause, resume, jump through the navigation history, force a global refresh of all client devices, or end the session at any time.

## The Notation System

### Replacing the Axes of Traditional Notation

Traditional Western notation uses a two-axis system: vertical position indicates pitch, horizontal position indicates time. Nested Notation reimagines both axes:

- **Harmonic relationships** are encoded in the **ring structures** within each SVG frame. Each frame contains a meta-ring whose positions map to the chromatic scale on a 12-position clockface (0=C, 1=C♯/D♭, 2=D, 3=D♯/E♭, 4=E, 5=F, 6=F♯/G♭, 7=G, 8=G♯/A♭, 9=A, 10=A♯/B♭, 11=B), plus child rings placed at specific positions on that clockface. The child rings define harmonic possibilities, but actual sounding harmony emerges probabilistically from audience interaction — clients may or may not be playing any given ring at any moment, so the harmony at any point in a performance is highly variable.

- **Time relationships** are encoded in the **syntax of SVG files** — the branching, networked graph of frames that the audience navigates through voting. Where traditional notation presents music as a linear sequence, Nested Notation presents it as a graph of possibilities, with each performance tracing a unique path.

This paradigm enables multimedia at every node (sounds, images) and temporal structures of arbitrary complexity — features that are extremely difficult to encode in traditional notation.

### Ring Structure Anatomy

The following elements are common to all Nested Notation scores:

**Meta-ring** — The large outer ring that provides a syntactically consistent structural relationship between the graphical and harmonic elements of a frame. Child rings are placed at positions on the meta-ring corresponding to chromatic pitch positions on the 12-position clockface.

**Child rings** — Smaller rings placed at specific meta-ring positions. Each child ring contains notes (colored ellipses or circles with colored stroke) representing pitches. One child ring in each vertex frame is a "refocus" ring — its link points back to a refocus frame (e.g., `Arefocus.svg`) that serves as a navigation anchor. The refocus ring is not harmonically distinct from other child rings; it is simply a child ring whose link destination serves a structural purpose.

**Notes** — The colored elements within child rings. A note's color and position encode its pitch. Both solid colored ellipses and circles with a colored stroke are considered notes.

**Root markers** — Triangular indicators within a child ring that mark which note should sound lowest, identifying the chord's bass note.

**Connecting curves** — Curves drawn between child rings that indicate shared notes. At least one connecting curve is required to touch each child ring; beyond that minimum, additional curves are at the composer's discretion.

**Self-similarity** — A defining structural principle of grammatically correct Nested Notation. The positions of child rings on the meta-ring correspond to the note positions in the refocus ring. For example, if a frame has child rings at meta-ring positions 0, 3, 5, and 8, the refocus ring will contain notes at those same four positions. This quasi-fractal relationship between parent structure and child content holds across all vertices of a well-formed score.

### Tesseract: A Canonical Example

The score **Tesseract** demonstrates these principles clearly. Its SVG frames are named after the vertices of a cube (A, B, C, D, W, X, Y, Z), with bidirectional transition frames connecting them (A2B, B2A, A2D, D2A, etc.). The title is metaphorical — the cube-shaped piece is experienced as "changing throughout time," giving it a tesseract-like quality. Each vertex frame contains the full ring structure with meta-ring, child rings, notes, root markers, and connecting curves. Each transition frame guides the performer and audience between harmonic contexts. Refocus frames (e.g., `Arefocus.svg`) serve as navigation anchors that reorient the performer within the structure.

In addition to the common elements, Tesseract vertex frames contain several score-specific sound-making elements:

**Fields** — Ambient and textural sound layers (e.g., "Zen", "Grooves", "Arrows", "Petals") that provide atmospheric backdrop.

**Songs** — Melodic layers with base and transition variants (e.g., `06-Tubular-A.m4a`, `06-Tubular-A2B.m4a`) that follow the navigation path.

**Map** — A miniature diagram of the Tesseract cube in the upper corner of the SVG, showing the current frame's position. Tapping it plays a spatial reference sound from the `Sounds/Map` folder.

**Composite Scale ring** — A ring that combines the notes of all child rings into a single harmonic structure. In other scores, this element may function as a "melisma ring" that blends harmony from past or future frames with the present frame in a polychord, serving as a courtesy to musicians at moments of high complexity.

## Interaction Modes

The session interface features a tab bar at the bottom of the screen with two modes:

### Play Mode

In Play mode, the user interacts with sound-making SVG elements. Tapping a colored element starts its associated sound and the element begins a slow opacity fluctuation — a breathing animation that indicates the sound is active. Tapping again stops both the sound and the animation. Multiple elements can play simultaneously — in effect, each device becomes a simple sampler, with users triggering and layering pre-recorded audio in real time. When dozens of audience members each trigger different samples simultaneously, the collective result is a distributed instrument whose mix emerges from the crowd rather than from any single performer.

To emphasize the sound-making elements, CSS applies a grayscale filter to all non-sound elements — links and structural geometry become black, white, and grey, while sound elements retain their full color.

Sound playback uses [Howler.js](https://howlerjs.com/) on the client. Each sound-making SVG element has a `sound` attribute referencing one or more audio files (comma-separated for chords). Sounds are loaded on demand and can be configured for looping, fade duration, and volume.

While audio assets are loading, the score enters a loading state: in Play mode, the entire SVG goes grayscale and all tap interaction is disabled, and a "loading audio..." indicator with an animated progress bar appears near the bottom of the screen. Once all sounds for the frame have loaded, the grayscale filter lifts, interaction is restored, and the loading indicator disappears.

### Guide Mode

In Guide mode, the user can tap navigation links to cast votes for where the music should go next. Sound elements are grayed out, and the link structure is highlighted in full color. Any connected client can open a voting round by tapping a link, provided the session is not paused and no hold period is active. The first tap starts the round; subsequent taps from other clients register as votes within that round.

During voting, circular indicators appear on each link showing the current vote count. The client's own vote is highlighted as a solid orange circle with white text, while votes for other options appear as white circles with an orange border and orange text. The option currently in the lead pulses with an orange glow. Clients who are in Play mode during a vote see only the winning marker — a radial orange glow on the leading link — without the full tally, keeping the Play interface uncluttered. A "Stay" button in the upper-left corner allows voting to remain on the current frame.

After the configurable voting duration expires, the platform navigates all connected clients to the winning frame. In the event of a tie, the server selects randomly among the tied options, with a stabilization rule: if the current leader is among the tied options and the number of tied options hasn't changed, the server holds with the current leader rather than re-randomizing.

By default, every client returns to Play mode after each frame transition. Double-tapping the Guide button activates **guide lock**, which keeps the interface in Guide mode across transitions. This is especially useful for musicians playing a physical instrument — with guide lock enabled, they can vote on navigation with a single tap and immediately return their attention to reading and performing, without needing to switch modes after every transition. In guide lock, sound interaction is disabled; the client acts purely as a navigator.

### UI Side Menu

A side menu is accessible from the upper-right corner of the session interface. It contains the following items:

**Score title** — Displayed at the top of the menu. If the score includes a `Documentation/` folder, tapping the title opens an overlay with navigable SVG pages authored by the composer. These serve as program notes, how-to-play guides, credits, and other score-specific documentation. For example, Tesseract includes 29 documentation pages (FAQ, Fields, Map, Songs, Notes, Scales, Webapp guides, and more), while Serotonin includes 10 (About, Basics, Form, Philosophy, How-To-Play, Credits, and others). Scores without a Documentation folder do not show the title as a tappable link.

**Refresh session** — Reloads the session page.

**Autoplay** — A toggle switch that controls automatic sound playback. When enabled, sounds marked with `autoplay="true"` (or defaulting to the session's autoplay setting) begin playing as soon as a frame loads. When disabled, frames load silently and all sounds must be triggered manually by tapping.

**About** — Opens an overlay with navigable SVG pages that explain the basics of the Nested Notation platform — how Play and Guide modes work, how voting works, and how to interact with the interface. These pages are platform-level (not score-specific) and are available in every session, distinct from the per-score documentation accessed via the score title.

**QR share** — Generates a QR code containing the session URL with the player password embedded, which can be scanned by audience members to join the session directly as players.

### Session Manager Controls

When connected with the manager password, additional controls appear in the session interface. A header bar above the score provides real-time session controls:

**Hold** — A checkbox that manually triggers or releases a hold period, preventing navigation while musicians settle into the current frame.

**Pause** — A checkbox that pauses the session for all connected clients. While paused, no voting or navigation can occur.

**History** — A dropdown of previously visited frames. Selecting a frame jumps all connected clients to that point in the navigation history.

A footer bar below the score displays status and provides additional actions:

**Player / Rider counts** — Live connection counts showing how many players and riders are connected to the session.

**Global refresh** — Forces every connected client device to refresh simultaneously. This is especially useful when the admin has updated session parameters or changed the score folder and needs all clients to pick up the changes immediately.

**End** — Ends the session for all connected clients.

**Wake lock** — Attempts to prevent client devices from sleeping during a session. This uses the NoSleep.js library (v0.9.0); however, its functionality is limited on modern devices and browsers that have restricted the underlying APIs.

### Countdown Timer

During voting and hold periods, a row of up to 10 small circles appears in the upper-right area of the interface on all connected devices — session managers, players, and riders alike. The circles fill in progressively as time elapses, giving everyone a visual indication of how much time remains.

A cooldown icon appears during the standby period after a vote resolves, and a hold icon appears during hold periods. When the hold icon activates, it also adds a `holding` class to the page body. In Guide mode, this triggers a full grayscale filter on the entire SVG content — a visual signal that navigation is locked. In Play mode, however, the SVG retains its full color during a hold, so players can still see and interact with sound elements even though navigation is temporarily blocked.

### Gallery Mode

Gallery mode, enabled via the admin console's "gallery mode" checkbox, automatically activates the client's autoplay toggle when the session connects. This is designed for unattended installations or exhibition settings where devices should begin playing sounds immediately without any user interaction. Combined with the "autoplay default" setting, gallery mode allows a session to run as a self-playing ambient experience.

## Score Library

The included scores range from educational tutorials to full-length compositions:

### Tutorial Scores (01–11)

These numbered scores form a progressive curriculum that teaches the Nested Notation system while also serving as performable compositions:

| Score | Description |
|-------|-------------|
| 01. Chromatic Intervals | All semitones within an octave, presented as ring positions |
| 02. Diatonic Tetrachords | Four-note scale segments (DO-RE-MI-FA, SOL-LA-TI-DO, etc.) |
| 03. Hello | A beginner interactive tutorial with 46 frames |
| 04. Happy Birthday | A familiar melody encoded in Nested Notation |
| 05. Rigid Die (rotation locked) | Six-sided geometric structure as musical navigation |
| 06. Twelve Ring | A 12-note chromatic ring system |
| 07. Choice Box | Branching choice structures |
| 08. Short Braid | Interwoven frame paths |
| 09. Two Moths | A dual-agent composition with two "moth" navigators |
| 10. The Reactor | Complex reactive navigation structure |
| 11. Merkaba | Sacred geometry (3D star shape) mapped to musical navigation |

### Compositions

| Score | Frames | Audio Files | Description |
|-------|--------|-------------|-------------|
| Tesseract | 94 | 276 | Cube-shaped navigation with 5 simultaneous audio layers (Field, Font, Map, Scale, Song) |
| Serotonin | 172 | 176 | Molecular structure of serotonin mapped onto navigable score topology (see below) |
| Barber's Adagio Test | 26 | 121 | Polyphonic layering (~4.6 sounds per frame) |
| Hoops Winter | 21 | 90 | Seasonal narrative (Dawn, Day, Dusk cycles) |
| Baskets | 23 | — | Visual-only composition with hub-and-spoke navigation |
| Fuzzy Die (7-note) | 15 | — | 7-note die structure with probabilistic navigation |

### Audio Layers in Tesseract

Tesseract's `Sounds/` folder organizes audio into five simultaneous layers:

- **Field** — Ambient/textural layers (e.g., "Zen", "Grooves", "Arrows", "Petals")
- **Font** — Pitched notes in three registers (Low, Mid, High) across the chromatic scale, in three timbral "fonts"
- **Map** — Spatial reference sounds tied to navigation positions
- **Scale** — Harmonic/tonal anchor tones
- **Song** — Melodic layers with base and transition variants (e.g., `06-Tubular-A.m4a`, `06-Tubular-A2B.m4a`)

These layers can play simultaneously from a single frame, creating rich polyphonic textures from simple visual interactions.

### Serotonin: Molecular Structure as Musical Topology

**Serotonin** is the largest composition in the library (172 frames, 176 audio files). Its navigable topology maps directly onto the molecular structure of the serotonin (5-hydroxytryptamine) molecule. Frame names correspond to molecular components: C2 through C9 represent carbon atoms in the indole ring system and ethylamine chain, N and N1 represent the nitrogen atoms, O represents the hydroxyl group, and NH2 represents the terminal amine.

The H-PRE chains of SVG frames — linear sequences of progressive frames connecting the molecular nodes — are suggestive of potential electron journeys through the pi-electron bonding system expected in the indole structure. While the composition remains a work of musical inspiration rather than a literal scientific model, the degree to which physical molecular structure is mapped onto musical structure may represent a unique capability of Nested Notation as a form of musical expression.

## Score Data Format

Scores live under `public/data/`. There are two structural patterns:

### Simple Scores (SVGs at root level)

For scores without audio, SVG frames sit directly in the score folder:

```
public/data/Baskets/
├── START.svg
├── PRE-101.svg
├── PRE-102.svg
├── 101.svg
├── 102.svg
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

### Frame Naming Conventions

- **`START`** prefix — Entry point candidates. The server randomly selects one `START`-prefixed file as the initial frame.
- **`PRE`** prefix — Pre-frames (fallback entry points if no `START` files exist). Links in `PRE` frames are not counted as multi-choice for voting purposes.
- **Transition frames** — Named with a `2` separator indicating bidirectional edges (e.g., `A2B.svg` and `B2A.svg`).
- **Refocus frames** — Named with `refocus` suffix (e.g., `Arefocus.svg`), serving as navigation anchors.
- **Transit frames** — Named with `TRANSIT` (e.g., `C2-TRANSIT-N1.svg`), indicating passage between sections.

### SVG Structure

Each SVG frame uses named `<g>` (group) tags to organize its content. The common structural groups include `Meta-Ring-and-Background`, `Child-Rings`, `Ring-Backers`, `Notes`, and `Root-Markers` (see [Ring Structure Anatomy](#ring-structure-anatomy) for a detailed explanation of these elements). Score-specific groups such as `Fields`, `Songs`, and `Map` appear in compositions that use additional audio layers.

Navigation links are `<a>` elements with `href` attributes pointing to other frame filenames.

### Score Markup Attributes

The following attributes are authored by the composer directly in SVG elements. They control sound playback and session timing when the score is performed.

#### Sound Attributes

| Attribute | Values | Description |
|-----------|--------|-------------|
| `sound` | File reference(s) | Which audio file(s) to play when the element is tapped in Play mode. Three patterns are used: a simple name (`sound="0"`), a comma-separated list for chords (`sound="3F-Low-Ab,3F-Mid-F,3F-Mid-C,3F-High-G"`), or a folder path for scores with organized audio layers (`sound="Field/01-Zen"`, `sound="Font/1-High-Ab"`). All paths are relative to the score's `Sounds/` folder. |
| `autoplay` | `"true"` or `"false"` | Whether the sound starts automatically when the frame is displayed. If this attribute is omitted, the element inherits the session's "autoplay default" setting from the admin console. When "autoplay default" is checked, all sounds without an explicit `autoplay` attribute will autoplay; only elements marked `autoplay="false"` are excluded. When "autoplay default" is unchecked, no sounds autoplay unless explicitly marked `autoplay="true"`. |
| `loop` | `"false"` | When present, the sound plays once and stops. If this attribute is omitted, sounds loop by default. |
| `volume` | `"0"` – `"100"` | Playback volume for the element, on a 0–100 scale. Values used in practice include `30`, `40`, `50`, `80`, and `100`. If omitted, uses the session default. |

#### Timing Attributes

| Attribute | Values | Description |
|-----------|--------|-------------|
| `voting` | Percentage (e.g., `"400%"`, `"50%"`) or seconds (e.g., `"5"`) | Overrides the session's default voting duration for this frame. A percentage multiplies the session default (e.g., `"400%"` on a 10-second default = 40 seconds). A raw number sets an absolute duration in seconds. Longer voting windows give the audience more time to deliberate on complex frames. |
| `holding` | Percentage (e.g., `"200%"`, `"400%"`) or seconds (e.g., `"5"`) | Overrides the session's default hold duration for this frame. The hold period is a cooldown after a vote resolves, giving musicians time to settle into the new frame before the next vote can begin. Works the same as `voting` — percentages multiply the session default, raw numbers set absolute seconds. |

## Composing Scores

Composing for Nested Notation is a multi-stage process that integrates network design, harmonic planning, visual authoring, and audio production.

### 1. Network Design

A composer begins by searching for a network graph that promises narrative potential — typically sketched with pencil and paper. The graph defines the topology of the piece: how many nodes exist, which nodes connect to which, and what multiple paths are available at each node. This graph becomes the branching structure that audiences will navigate.

### 2. Harmonic Plotting

Once the network is established, the composer plots the harmonic content across its nodes. Since the visual signatures of canonical Nested Notation match the harmonic content (ring positions correspond to chromatic pitches), the composer carefully designs the harmonies and relationships that carry across nodes. Transition frames between nodes with meta-ring structure require particular attention, as they must bridge the harmonic contexts of adjacent vertices.

### 3. Audio Production

Concurrently, the composer records or otherwise generates the audio assets that will play when users tap elements in Play mode. These assets must be harmonically consistent with the ring content of each frame. For example, in Tesseract, the audio file `Song/06-Tubular-D2A.m4a` contains notes that match the pitches available in the corresponding ring (Low-G♭, Mid-D♭, Mid-F, High-A♭), ensuring a consonant musical experience whether a user is tapping individual notes or hearing the Song layer. The composer also designs networks of graphical elements — such as Tesseract's Song elements (Tubular, Eyeral) and Field elements (Zen, Grooves, Arrows, Petals) — that will map to these audio assets. Naming conventions (e.g., `06-Tubular-D2A`) help the composer keep the visual, harmonic, and audio layers aligned.

### 4. SVG Authoring

With the network, harmonies, and audio planned, the composer opens an SVG editor such as **Affinity Designer** to author the visual frames. Each `<g>` tag is carefully named during design (e.g., `Meta-Ring-and-Background`, `Child-Rings`, `Notes`, `Root-Markers`, `Fields`, `Songs`). The visual layout encodes the harmonic structure: ring positions, note colors, root markers, and connecting curves are all drawn to reflect the compositional plan.

### 5. Markup

If SVG authoring is like drawing a flipbook frame by frame, markup is like arranging the pages in the correct order. After exporting from the SVG editor, the composer opens the raw SVG files in a code editor and hand-edits the XML to add the interactive layer:

- **Navigation links** — Wrapping drawn elements with `<a href="...">` tags to wire frames together according to the network graph.
- **Sound mapping** — Adding `sound` attributes to graphical elements, connecting them to the corresponding audio files in the `Sounds/` folder.
- **Playback behavior** — Adding `autoplay="true"`, `loop="false"`, and `volume` attributes to control how individual sounds behave.
- **Timing overrides** — Adding `voting` and `holding` attributes to control pacing at each node. These values are planned in advance and reflect the composer's intent about how long the audience should dwell at each point in the network. For example, in Serotonin, a vertex frame like `C2.svg` — with rich harmonic content and multiple navigation options — carries longer voting and holding periods than a transit frame like `C2-TRANSIT-C3.svg`, which serves as a passageway between nodes and needs less deliberation time.

The markup must display consistent behavior across the network: timing values, autoplay settings, and sound mappings are all extensions of the compositional plan, not afterthoughts.

### Checking Markup

The browser's developer console serves as the composer's error-checking tool. The client-side code validates markup at load time and reports problems including: sound references that don't match any file in the `Sounds/` folder (logged with the incorrect name and the frame it was found in), empty `sound` attributes, mismatches between the number of volume values and sound values, individual sound files that fail to load, and navigation links that point to missing frames. Opening a session and watching the console will surface most markup errors.

## Architecture

Nested Notation runs two servers from a single Node.js process:

1. **HTTP server (Express)** — Serves the web UI, admin panel, session manager dashboard, and pre-rendered session HTML. Uses Jade (Pug) for server-side templating and `apicache` for response caching.

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
2. **Admin** (`/setup` → `/sm`) — Authenticates with a username and password at `/setup`, then is redirected to the `/sm` dashboard. Creates and configures performance sessions: selects a score folder, sets voting duration, hold duration, voting size, fade duration, volume, and passwords.
3. **Session Manager** (`/sm`) — Any individual (or group of individuals) connected with the manager password for a session. Can control the live session: pause, resume, navigate through history, hold, force a global refresh of all connected client devices, and end the session. Does not require an admin account.
4. **Musician / Audience** (`/session`) — Connects to an active session. Uses Play mode to trigger sounds and Guide mode to vote on navigation.

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

**player password** — Required for session creation. This password is embedded in the session URL and QR code, so audience members who receive the link or scan the code join automatically as "players" without needing to enter it manually. The server distinguishes between **players** (clients who connected with the player password or admin password) and **riders** (clients who reached the session without either password). Riders can observe the session and play sounds in Play mode, but cannot vote — the client-side tap handler checks for a valid password before sending any vote to the server. This distinction is preserved for potential future use — for example, accommodating passive observers when the number of voting connections exceeds what the server can handle. Both counts are displayed to the session manager.

**voting duration** — Duration of each voting round in seconds (default: 10). Individual frames can override this with the `voting` markup attribute.

**holding duration** — Hold period after a vote resolves in seconds (default: 10). Prevents further navigation while musicians settle into the new frame. Individual frames can override this with the `holding` markup attribute.

**fade duration (ms)** — Audio crossfade duration in milliseconds (default: 1000). On frame transitions, this value controls three behaviors via Howler.js: sounds that do not continue to the next frame fade out from their current volume to silence over this duration; new sounds in the incoming frame (with autoplay enabled) fade in from silence to their target volume; and sounds that are common between the outgoing and incoming frames receive a seamless crossfade — the new instance picks up the previous instance's volume levels and seek position, creating a continuous handoff. Setting this to 0 produces abrupt cuts; higher values create smoother, more gradual transitions.

**voting size (%)** — Display size of vote indicator circles as a percentage (default: 100).

**audio level (%)** — Default playback volume for all sound elements (default: 80). Individual elements can override this with the `volume` markup attribute.

**autoplay default** — When checked, all sound elements without an explicit `autoplay` attribute will autoplay on frame load; only elements marked `autoplay="false"` are excluded. When unchecked, no sounds autoplay unless explicitly marked `autoplay="true"`. This setting also determines the initial state of the autoplay toggle in the client's UI side menu.

**gallery mode** — When checked, the client's autoplay toggle is automatically enabled on connection. Useful for unattended installations or exhibition settings where sounds should begin immediately without user interaction.

**html5** — Toggles Howler.js between HTML5 Audio mode and Web Audio API mode. HTML5 Audio may provide better compatibility on some devices.

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
│   ├── admin.jade            # Admin panel
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

Copyright (c) 2024 nestednotation
