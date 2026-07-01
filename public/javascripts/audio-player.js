const SESSION_MODES = {
  PLAY: "PLAY",
  GUIDE: "GUIDE",
};

window.SESSION_MODES = SESSION_MODES;

const removeFileExt = (fileName) => {
  return fileName.replace(/\.[^/.]+$/, "");
};

// SOUND_FILE_LIST main purpose to cache the list of sound name and it's file name
// Usually soundName and fileName will be similiar, only different is fileName have
// additional .m4u3 as ext.
// But I cache the list just in case the score using different file ext like .mp3
window.SOUND_FILE_LIST = null;
// Session Lines: per-sub soundName→fileName maps (built lazily on first dive).
window.SUB_SOUND_FILE_LISTS = {};

const buildSoundFileMap = (soundFileList) =>
  (soundFileList || []).reduce((acc, soundFile) => {
    acc[removeFileExt(soundFile)] = soundFile;
    return acc;
  }, {});

// `soundContext` (Session Lines) routes sub-session sounds to the sub-score's own
// Sounds dir. Absent/main context behaves exactly as before.
const getSoundLink = (soundName, soundContext) => {
  const { scoreTitle } = window;

  if (soundContext && soundContext.type === "sub") {
    const sub = soundContext.subName;
    if (!window.SUB_SOUND_FILE_LISTS[sub]) {
      window.SUB_SOUND_FILE_LISTS[sub] = buildSoundFileMap(
        soundContext.soundList,
      );
    }
    const subFileName = window.SUB_SOUND_FILE_LISTS[sub][soundName];
    if (!subFileName) {
      console.error(`Sub sound file not found for ${soundName} in ${sub}`);
    }
    return `/data/${encodeURIComponent(scoreTitle)}/Subscores/${encodeURIComponent(
      sub,
    )}/Sounds/${encodeURIComponent(subFileName)}`;
  }

  const { soundFileList } = window;
  if (!window.SOUND_FILE_LIST) {
    window.SOUND_FILE_LIST = buildSoundFileMap(soundFileList);
  }

  const fileName = window.SOUND_FILE_LIST[soundName];
  if (!fileName) {
    console.error(`Sound file not found for ${soundName}`);
  }

  return `/data/${encodeURIComponent(scoreTitle)}/Sounds/${encodeURIComponent(
    fileName,
  )}`;
};

// Log all mismatch sounds found in the session
const logMismatchSound = () => {
  const soundSet = new Set();

  const { soundFileList } = window;
  for (const soundFile of soundFileList) {
    soundSet.add(removeFileExt(soundFile));
  }

  const mainSvgContainer = document.getElementById("MainSVGContent");
  if (!mainSvgContainer) {
    console.error("MainSVGContent not found");
    return;
  }

  const frameSvgNodes = mainSvgContainer.querySelectorAll("svg[id]");
  if (frameSvgNodes.length === 0) {
    console.error("No frame found");
    return;
  }

  for (const frame of frameSvgNodes) {
    const frameSvgSoundNodes = frame.querySelectorAll("[sound]");
    for (const svgSoundNode of frameSvgSoundNodes) {
      const soundNames = svgSoundNode.getAttribute("sound")?.split(",");
      if (!soundNames) {
        return;
      }

      for (const soundName of soundNames) {
        const isExist = soundSet.has(soundName);

        if (!isExist) {
          console.error(
            `Incorrect sound name: ${soundName} \n Found in file: ${frame.getAttribute(
              "file",
            )}`,
          );
        }
      }
    }
  }
};

/***************************************************************
 * Javascript function to convert log-scale volume control     *
 * on a scale from 0 to 100 to linear-scale gain on [0.0, 1.0] *
 * *************************************************************/

//
// converts from volume on a scale of 0 to 100 to linear scale gain on [0.0,1.0]
// v=0   => gain = -inf    (0.0)
// v=1   => gain = -60dB (0.001)
// v=100 => gain =   0dB   (1.0)
function volumeToGain(v) {
  // Prototype copied from Mathematica:
  // volumeToGain[v_] := If[v < 1, 0, 0.001*Power[1000, (v - 1)/99.]]
  if (v < 1) return 0.0;
  const result = 0.001 * Math.pow(1000.0, (v - 1.0) / 99.0);
  return Math.round(result * 100) / 100;
}

function getDefaultVolume() {
  return window.defaultVolume ?? 80;
}

class Note {
  isAutoplay = true;
  isLoop = true;

  _playingCount = 0;

  soundNames = [];
  soundInstances = [];
  volumes = [getDefaultVolume()];

  id = null;
  frameInstance = null;
  domElement = null;

  // groupsound groups this note belongs to (see Frame.initialFrameGroups).
  // When empty, the note behaves as a normal standalone note.
  groups = [];

  get viewMode() {
    return this.frameInstance.sessionInstance.mode;
  }

  get playingCount() {
    return this._playingCount;
  }
  set playingCount(value) {
    this._playingCount = Math.max(value, 0);

    if (this._playingCount === this.soundInstances.length) {
      this.domElement.dataset.playing = true;
    }

    if (this._playingCount === 0) {
      this.domElement.dataset.playing = false;
    }

    // Let any groupsound group this note belongs to recompute its combined
    // playing state (and animation) whenever this note starts/stops.
    this.groups.forEach((group) => group.refresh());
  }

  get isPlaying() {
    return this._playingCount > 0;
  }

  constructor(frameInstance, svgSoundNode) {
    this.frameInstance = frameInstance;

    this.domElement = svgSoundNode;
    this.domElement.addEventListener("click", this.onNoteClicked.bind(this));

    this.initialSounds();
  }

  initialSounds() {
    const soundNames = this.domElement.getAttribute("sound")?.split(",");
    if (!soundNames) {
      console.error("[sound] attribute shouldn't be empty!");
      return;
    }

    soundNames.sort();

    this.id = soundNames.join("|");
    this.soundNames = soundNames;

    const nodeVolumns = this.domElement
      .getAttribute("volume")
      ?.split(",")
      .map(Number) ?? [getDefaultVolume()];

    const defaultVolPercentage = getDefaultVolume() / 100;
    this.volumes =
      nodeVolumns.length === this.soundNames.length
        ? nodeVolumns.map((v) => v * defaultVolPercentage)
        : [getDefaultVolume()];
    if (nodeVolumns.length !== soundNames.length) {
      console.warn(
        `Volume values mismatch with sound values, will fallback to default volume (${getDefaultVolume()})`,
      );
    }
    //? defaultAutoplay means that the note by default will be autoplay
    const defaultAutoplay = window.defaultAutoplay ?? true;
    this.isAutoplay = JSON.parse(
      this.domElement.getAttribute("autoplay")
        ? this.domElement.getAttribute("autoplay") === "true"
        : defaultAutoplay,
    );

    this.isLoop = JSON.parse(this.domElement.getAttribute("loop") ?? true);

    const isVolumeMismatch = this.volumes.length === this.soundInstances;
    this.soundInstances = soundNames.map((sn, idx) => {
      const { isHtml5 } = window;
      // If volume mismatch the number of sounds => this.volumes will be
      // an array with 1 element, which is the default vol value
      const volumeIdx = isVolumeMismatch ? idx : 0;

      const soundInst = new Howl({
        src: [getSoundLink(sn, this.frameInstance.soundContext)],
        loop: this.isLoop,
        preload: false,
        html5: isHtml5,
        volume: volumeToGain(this.volumes[volumeIdx]),
        onload: () => {
          const soundLoadedEvent = new CustomEvent("sound-loaded", {
            detail: {
              key: sn,
            },
          });
          window.dispatchEvent(soundLoadedEvent);
        },
      });

      soundInst.on("play", () => {
        this.playingCount++;
      });
      soundInst.on("stop", () => {
        this.playingCount--;
      });
      soundInst.on("end", () => {
        this.playingCount--;
      });
      let retryCount = 0;
      soundInst.on("loaderror", (...e) => {
        logMismatchSound();
        console.error(`Unable to load sound ${sn}`, ...e);
        if (retryCount < 1) {
          retryCount++;
          const retryDelay = 1000 + Math.random() * 4000;
          setTimeout(() => {
            soundInst.unload();
            soundInst.load();
          }, retryDelay);
        } else {
          window.sessionInstance?.markSoundLoadFailed(sn);
        }
      });

      return soundInst;
    });
  }

  loadNoteSounds() {
    for (const soundInst of this.soundInstances) {
      soundInst.load();
    }
  }

  play() {
    this.loadNoteSounds();
    for (let idx = 0; idx < this.soundInstances.length; idx++) {
      this.soundInstances[idx].play();
    }
  }

  stop() {
    for (let idx = 0; idx < this.soundInstances.length; idx++) {
      this.soundInstances[idx].stop();
    }
  }

  fadeStop(fadeDuration = 1000) {
    this.soundInstances.forEach((s) => {
      const vol = s.volume();
      s.fade(vol, 0, fadeDuration);
      setTimeout(() => {
        s.stop();
        s.volume(vol);
      }, fadeDuration);
    });
  }

  fadeStart(fadeDuration = 1000) {
    this.loadNoteSounds();
    this.soundInstances.forEach((s) => {
      const vol = s.volume();
      s.fade(0, vol, fadeDuration);
      s.play();
    });
  }

  fadeInFrom(fromVolumes, { fadeDuration = 1000, seekTimestamp }) {
    this.loadNoteSounds();

    const finalVolumes =
      fromVolumes.length === this.soundInstances.length
        ? fromVolumes
        : [getDefaultVolume()];
    const isVolumeMismatch = finalVolumes.length === this.soundInstances;

    for (let idx = 0; idx < this.soundInstances.length; idx++) {
      const sound = this.soundInstances[idx];
      // If volume mismatch the number of sounds => this.volumes will be
      // an array with 1 element, which is the default vol value
      const volumeIdx = isVolumeMismatch ? idx : 0;
      sound.fade(
        volumeToGain(finalVolumes[volumeIdx]),
        sound.volume(),
        fadeDuration,
      );

      if (seekTimestamp && seekTimestamp[idx]) {
        sound.seek(seekTimestamp[idx]);
      }

      sound.play();
    }
  }

  getCurrTimestamp() {
    return this.soundInstances.map((s) => s.seek());
  }

  onNoteClicked(e) {
    // In GUIDE mode, sound can't be interacted
    if (this.viewMode === SESSION_MODES.GUIDE) {
      return;
    }

    e.preventDefault();

    // When this note is part of a groupsound, it is controlled as a unit by
    // the group click handler (which receives this click via bubbling), so
    // the individual note must not toggle itself.
    if (this.groups.length > 0) {
      return;
    }

    if (this.playingCount > 0) {
      this.stop();
    } else {
      this.play();
    }
  }

  updateDefaultVolume() {
    const nodeVolumns = this.domElement
      .getAttribute("volume")
      ?.split(",")
      .map(Number) ?? [getDefaultVolume()];

    const defaultVolPercentage = getDefaultVolume() / 100;
    this.volumes =
      nodeVolumns.length === this.soundNames.length
        ? nodeVolumns.map((v) => v * defaultVolPercentage)
        : [getDefaultVolume()];

    const isVolumeMismatch = this.volumes.length === this.soundInstances;
    this.soundInstances.forEach((s, idx) => {
      const volumeIdx = isVolumeMismatch ? idx : 0;
      s.volume(volumeToGain(this.volumes[volumeIdx]));
    });
  }
}

class Frame {
  id = null;

  notes = [];
  noteIds = [];
  noteMap = {};

  // groupsound groups in this frame (see initialFrameGroups).
  groups = [];

  sessionInstance = null;
  frameElement = null;

  // Session Lines: null on the main flow; { type:"sub", subName, soundList } for
  // a sub-session frame so its notes resolve sounds to the sub-score Sounds dir.
  soundContext = null;

  constructor(sessionInstance, frameElement, soundContext = null) {
    this.frameElement = frameElement;
    this.sessionInstance = sessionInstance;
    this.id = frameElement.id;
    this.soundContext = soundContext;

    this.initialFrameNotes();
    this.initialFrameGroups();
  }

  playAllAutoplayNotes() {
    this.notes.forEach((e) => {
      e.isAutoplay && !e.isPlaying && e.play();
    });
  }

  stopAllNotes() {
    this.notes.forEach((e) => {
      e.stop();
    });
  }

  loadFrameSounds() {
    for (const note of this.notes) {
      note.loadNoteSounds();
    }

    return this.noteIds;
  }

  getAllSoundNameInFrame() {
    return this.notes.map((n) => n.soundNames).flat();
  }

  initialFrameNotes() {
    const frameSvgSoundNodes = this.frameElement.querySelectorAll("[sound]");
    for (const svgSoundNode of frameSvgSoundNodes) {
      const note = new Note(this, svgSoundNode);
      this.notes.push(note);
      this.noteIds.push(note.id);
      this.noteMap[note.id] = note;
    }

    return this.notes;
  }

  // A groupsound element (`<g groupsound="true">`) bundles every [sound] note
  // nested inside it so they play, stop and animate together as a single unit.
  initialFrameGroups() {
    const groupNodes = this.frameElement.querySelectorAll(
      '[groupsound="true"]',
    );
    for (const groupNode of groupNodes) {
      const groupNotes = this.notes.filter((note) =>
        groupNode.contains(note.domElement),
      );
      if (groupNotes.length === 0) {
        continue;
      }

      const group = {
        element: groupNode,
        notes: groupNotes,
        // The group reflects the "playing" animation only when *every* member
        // note is playing (e.g. all sounds carried over from the previous
        // frame). The animation itself is driven by CSS via [data-playing].
        refresh() {
          this.element.dataset.playing = this.notes.every((n) => n.isPlaying);
        },
      };

      // NOTE: groupsound currently ignores its own playback attributes
      // (volume, autoplay, loop, ...) — member notes keep their individual
      // settings. Group-level attribute handling can be added here later.

      groupNode.addEventListener("click", (e) =>
        this.onGroupClicked(e, group),
      );
      groupNotes.forEach((note) => note.groups.push(group));
      this.groups.push(group);
    }

    return this.groups;
  }

  onGroupClicked(e, group) {
    // In GUIDE mode, sound can't be interacted with (let link navigation run)
    if (this.sessionInstance.mode === SESSION_MODES.GUIDE) {
      return;
    }

    e.preventDefault();

    // Toggle the whole group as a unit. The group animates as a box only when
    // *every* member is playing, so that fully-playing state is treated as
    // "on": tapping a fully-playing group stops it, while tapping a group that
    // is off OR only partially playing (a partial assemble) fills in the rest
    // so the whole group plays and animates. Already-playing members are left
    // alone to avoid starting a second, overlapping instance of their sound.
    const allPlaying = group.notes.every((note) => note.isPlaying);
    group.notes.forEach((note) => {
      if (allPlaying) {
        note.stop();
      } else if (!note.isPlaying) {
        note.play();
      }
    });
  }
}

class AudioSession {
  currFrameId = null;

  // Map of frame id to Frame instance
  frameMap = {};

  _mode = SESSION_MODES.PLAY;
  guideLock = false;

  soundLoadSet = new Set();
  failedSounds = new Set();

  autoPlay = false;

  get mode() {
    return this._mode;
  }
  set mode(value) {
    // Toggle guide lock after switching to guide mode
    if (this._mode === SESSION_MODES.GUIDE && value === SESSION_MODES.GUIDE) {
      this.guideLock = !this.guideLock;
    }

    // Unlock guide mode when switching to play mode
    if (value === SESSION_MODES.PLAY) {
      this.guideLock = false;
    }

    this._mode = value;

    document.body.classList.toggle("guide-mode", value === SESSION_MODES.GUIDE);
    document.body.classList.toggle("play-mode", value === SESSION_MODES.PLAY);

    document.getElementById("change-mode-container").dataset.mode = value;
    document.getElementById("change-mode-container").dataset.guideLock =
      this.guideLock;
  }

  init() {
    window.addEventListener("sound-loaded", (e) => {
      this.handleSoundLoaded(e.detail);
    });

    const allSoundLoadedListener = () => {
      //? enableAutoplayByDefault means that autoplay button will be enable by default
      if (window.enableAutoplayByDefault) {
        this.toggleAutoplay();
      }

      window.removeEventListener("all-sound-loaded", allSoundLoadedListener);
    };

    window.addEventListener("all-sound-loaded", allSoundLoadedListener);

    this.generateSoundMap();
  }

  generateSoundMap() {
    const mainSvgContainer = document.getElementById("MainSVGContent");
    if (!mainSvgContainer) {
      console.error("MainSVGContent not found");
      return;
    }

    const frameSvg = mainSvgContainer.querySelectorAll("svg[id]");
    if (frameSvg.length === 0) {
      console.error("No frame found");
      return;
    }

    for (const frame of frameSvg) {
      const frameInstance = new Frame(this, frame);
      // frameInstance.loadFrameSounds();
      this.frameMap[frame.id] = frameInstance;
      this.markToGrayscaleNonLinkSvg(frame);
    }
  }

  // Session Lines: register a sub-score's injected frames (ids "sub-<name>-<idx>")
  // so the playhead can show + play them; their sounds resolve to the sub's dir.
  registerSubFrames(subName, soundList) {
    const container = document.getElementById("SubSVGContent");
    if (!container) {
      return;
    }
    const frames = container.querySelectorAll(`svg[id^="sub-${subName}-"]`);
    for (const frameEl of frames) {
      if (this.frameMap[frameEl.id]) {
        continue;
      }
      const frameInstance = new Frame(this, frameEl, {
        type: "sub",
        subName,
        soundList,
      });
      this.frameMap[frameEl.id] = frameInstance;
      this.markToGrayscaleNonLinkSvg(frameEl);
    }
  }

  handleChangeFrame(nextFrameId) {
    const prevId = this.currFrameId;
    const nextId = nextFrameId;

    this.currFrameId = nextFrameId;
    if (!prevId) {
      const initialFrame = this.frameMap[nextId];
      initialFrame.loadFrameSounds();
      if (this.autoPlay) {
        initialFrame.playAllAutoplayNotes();
      }
      initialFrame.getAllSoundNameInFrame().forEach((s) => {
        if (!this.failedSounds.has(s)) {
          this.markSoundAsLoading(s);
        }
      });
      Howler.stop();
      return;
    }

    const { fadeDuration = 1000 } = window;

    const prevFrame = this.frameMap[prevId];
    const nextFrame = this.frameMap[nextId];

    // Sound continuity is per-note and NOT gated by groups: a note that is
    // playing in the previous frame carries its sound into the next frame
    // wherever a note with the same sound id appears. Dissolve (group -> loose
    // notes) and assemble (loose notes -> group) are therefore the *same* rule
    // applied in opposite directions — whether either side is grouped, and
    // whether the match is full or partial, no longer affects carry-over.
    //
    // This leaves a groupsound responsible for only two things: toggling
    // play/stop on click (onGroupClicked) and animating when *all* of its
    // members are playing (group.refresh + the [groupsound] CSS rules). A
    // partial match keeps just the matching member notes ringing/animating;
    // a full match additionally lights up the group as a whole.

    // A sound id can repeat within a frame (the same sound placed in several
    // notes/groups). Iterate the notes arrays — not noteMap, which collapses
    // duplicate ids to a single entry — so every occurrence is handled and the
    // right SVG elements light up (e.g. a group reassembling that shares a
    // sound with a decoy note elsewhere on the page).
    const playingPrevById = {};
    for (const note of prevFrame.notes) {
      if (note.playingCount > 0 && !playingPrevById[note.id]) {
        playingPrevById[note.id] = note;
      }
    }

    const nextHasNoteId = new Set(nextFrame.noteIds);

    // Fade out every previously-playing note whose sound does not continue.
    for (const note of prevFrame.notes) {
      if (note.playingCount > 0 && !nextHasNoteId.has(note.id)) {
        note.fadeStop(fadeDuration);
      }
    }

    // Sweep all frames other than prev (handled above) and next (about to
    // start) to stop any sounds that leaked from earlier frames.
    for (const [frameId, frame] of Object.entries(this.frameMap)) {
      if (frameId === prevId || frameId === nextId) continue;
      for (const note of frame.notes) {
        if (note.playingCount > 0) {
          note.fadeStop(fadeDuration);
        }
      }
    }

    const continuingIds = Object.keys(playingPrevById).filter((id) =>
      nextHasNoteId.has(id),
    );
    console.log(
      "Continuing sound notes between prev and current frame:",
      continuingIds,
    );

    // Start (or carry over) every next-frame note.
    for (const note of nextFrame.notes) {
      const prevNote = playingPrevById[note.id];
      if (prevNote) {
        note.fadeInFrom(prevNote.volumes, {
          fadeDuration,
          seekTimestamp: prevNote.getCurrTimestamp(),
        });
      } else {
        note.soundNames.forEach((sn, idx) => {
          if (this.failedSounds.has(sn)) return;
          if (note.soundInstances[idx].state() !== "loaded") {
            this.markSoundAsLoading(sn);
          }
        });
        note.loadNoteSounds();

        if (this.autoPlay && note.isAutoplay) {
          note.fadeStart(fadeDuration);
        }
      }
    }

    // Hard-stop the carried-over previous notes now that the next frame's
    // copies have taken over the sound (handoff complete).
    for (const id of continuingIds) {
      playingPrevById[id].stop();
    }

    // Switch back to play mode after changing frame if not in guide lock
    if (!this.guideLock) {
      this.mode = SESSION_MODES.PLAY;
    }

    // Clear voting indicators when changing frames
    if (window.clearVotingIndicator) {
      window.clearVotingIndicator();
    }
  }

  getPlayingNotes() {
    return this.frameMap[this.currFrameId].notes.filter(
      (n) => n.playingCount > 0,
    );
  }

  getPlayingSoundName() {
    return this.frameMap[this.currFrameId].getAllSoundNameInFrame();
  }

  getCurrentPlayingFrame() {
    return this.frameMap[this.currFrameId];
  }

  toggleAutoplay() {
    this.autoPlay = !this.autoPlay;

    if (this.autoPlay) {
      this.frameMap[this.currFrameId]?.playAllAutoplayNotes();
    } else {
      this.frameMap[this.currFrameId]?.stopAllNotes();
    }

    const togglerElement = document.querySelector("#autoplay-toggler");
    togglerElement.dataset.active = this.autoPlay;
  }

  preloadFrameAudio(frameIdx) {
    console.log("preload");
    const frame = this.frameMap[`svg${frameIdx}`];
    if (!frame) return;
    for (const note of frame.notes) {
      note.loadNoteSounds();
    }
  }

  markSoundAsLoading(soundKey) {
    this.soundLoadSet.add(soundKey);

    document.body.classList.toggle("loading-sound", true);
  }

  markSoundLoadFailed(soundKey) {
    this.failedSounds.add(soundKey);
    this.soundLoadSet.delete(soundKey);

    document.body.classList.toggle(
      "loading-sound",
      this.soundLoadSet.size !== 0,
    );
    document.body.classList.add("loading-sound-error");

    const indicator = document.getElementById("loading-sound-indicator");
    if (indicator) {
      indicator.textContent = "please refresh your browser";
    }
  }

  handleSoundLoaded(loadedSound) {
    this.soundLoadSet.delete(loadedSound.key);

    document.body.classList.toggle(
      "loading-sound",
      this.soundLoadSet.size !== 0,
    );

    if (this.soundLoadSet.size === 0) {
      const allSoundLoadedEvent = new CustomEvent("all-sound-loaded");
      window.dispatchEvent(allSoundLoadedEvent);
    }
  }

  markToGrayscaleNoneSoundLinkSvg(linkElement) {
    const soundElements = linkElement.querySelector("[sound]");

    if (soundElements === null) {
      linkElement.classList.add("grayscale-on-play");
    }
  }

  markToGrayscaleNonLinkSvg(element) {
    const isContainLink = !!element.querySelector("a");
    if (!isContainLink || element.children.length === 0) {
      element.classList.add("grayscale-on-guide");
      return;
    }

    for (const child of element.children) {
      if (child.tagName === "a") {
        this.markToGrayscaleNoneSoundLinkSvg(child);
        continue;
      } else {
        this.markToGrayscaleNonLinkSvg(child);
      }
    }
  }

  updateDefaultVolume() {
    for (const frame of Object.values(this.frameMap)) {
      for (const node of frame.notes) {
        node.updateDefaultVolume();
      }
    }
  }
}

window.sessionInstance = new AudioSession();

const handleOnUpdateView = ({ detail }) => {
  const { sessionInstance } = window;
  const { newIndex } = detail;

  // newIndex === -1 => pausing
  if (newIndex === -1) {
    Howler.mute(true);
    return;
  } else {
    Howler.mute(false);
  }

  // Session Lines: the playhead carries an explicit DOM id so sub frames
  // ("sub-<name>-<idx>") route correctly; falls back to the main "svg<idx>".
  const frameId = detail.frameDomId || `svg${newIndex}`;
  if (frameId === sessionInstance.currFrameId) {
    return;
  }

  sessionInstance.handleChangeFrame(frameId);
};

window.addEventListener("update-view", handleOnUpdateView);

document.addEventListener(
  "DOMContentLoaded",
  () => {
    window.sessionInstance.init();

    // For some reason in iOS if I register these event in ui.js file, it will not work
    // so I have to register here, it will work fine
    document.querySelectorAll('[id$="-about-nn"] a').forEach((aEl) => {
      aEl.addEventListener("click", (e) => {
        e.preventDefault();
        onChangeAboutNNPage(e.currentTarget.getAttribute("href"));
      });
    });

    document.querySelectorAll('[id$="-about-score"] a').forEach((aEl) => {
      aEl.addEventListener("click", (e) => {
        e.preventDefault();
        onChangeAboutChordPage(e.currentTarget.getAttribute("href"));
      });
    });
  },
  false,
);

window.addEventListener("pagehide", () => {
  Howler.unload();
  window.sessionInstance = null;
  window.removeEventListener("update-view", handleOnUpdateView);
});

console.log("Session instance", window.sessionInstance);

function toggleSessionMode(mode) {
  if (!window.sessionInstance) {
    return;
  }

  window.sessionInstance.mode = mode;
}

function toggleAutoplay() {
  if (!window.sessionInstance) {
    return;
  }

  window.sessionInstance.toggleAutoplay();
}
