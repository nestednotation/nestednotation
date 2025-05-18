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
let SOUND_FILE_LIST = null;
const getSoundLink = (soundName) => {
  const { scoreSlug, soundFileList } = window;

  if (!SOUND_FILE_LIST) {
    SOUND_FILE_LIST = soundFileList.reduce((acc, soundFile) => {
      const fileNameWithoutExt = removeFileExt(soundFile);
      acc[fileNameWithoutExt] = soundFile;
      return acc;
    }, {});
  }

  const fileName = SOUND_FILE_LIST[soundName];
  if (!fileName) {
    alert(`Sound file not found for ${soundName}`);
  }

  return `/audio/${scoreSlug}/${fileName}`;
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
              "file"
            )}`
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

const DEFAULT_VOLUME = 80;

class Note {
  isAutoplay = true;
  isLoop = true;

  _playingCount = 0;

  soundNames = [];
  soundInstances = [];
  volumes = [DEFAULT_VOLUME];

  id = null;
  frameInstance = null;
  domElement = null;

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
      alert("[sound] attribute shouldn't be empty!");
      return;
    }

    this.id = soundNames.sort().join("|");
    this.soundNames = soundNames;

    const nodeVolumns = this.domElement
      .getAttribute("volume")
      ?.split(",")
      .map(Number) ?? [DEFAULT_VOLUME];
    this.volumes =
      nodeVolumns.length === soundNames.length ? nodeVolumns : [DEFAULT_VOLUME];
    if (nodeVolumns.length !== soundNames.length) {
      console.warn(
        "Volume values mismatch with sound values, will fallback to default volume (80)"
      );
    }

    this.isAutoplay = JSON.parse(
      this.domElement.getAttribute("autoplay") ?? true
    );
    this.isLoop = JSON.parse(this.domElement.getAttribute("loop") ?? true);

    const isVolumeMismatch = this.volumes.length === this.soundInstances;
    this.soundInstances = soundNames.map((sn, idx) => {
      const { isHtml5 } = window;
      // If volume mismatch the number of sounds => this.volumes will be
      // an array with 1 element, which is the default vol value
      const volumeIdx = isVolumeMismatch ? idx : 0;

      const soundInst = new Howl({
        src: [getSoundLink(sn)],
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
          console.log(`Loaded sound: ${sn}`);
          window.dispatchEvent(soundLoadedEvent);
        },
      });

      soundInst.on("play", () => {
        console.log(`Start playing sound ${sn}`);
        this.playingCount++;
      });
      soundInst.on("stop", () => {
        console.log(`Stop playing sound ${sn}`);
        this.playingCount--;
      });
      soundInst.on("end", () => {
        console.log(`Sound ${sn} ended`);
        this.playingCount--;
      });
      soundInst.on("loaderror", (...e) => {
        logMismatchSound();
        console.error(`Unable to load sound ${sn}`, ...e);
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

  fadeInFrom(fromVolumes, fadeDuration = 1000) {
    this.loadNoteSounds();

    const finalVolumes =
      fromVolumes.length === this.soundInstances.length
        ? fromVolumes
        : [DEFAULT_VOLUME];
    const isVolumeMismatch = finalVolumes.length === this.soundInstances;

    for (let idx = 0; idx < this.soundInstances.length; idx++) {
      const sound = this.soundInstances[idx];
      // If volume mismatch the number of sounds => this.volumes will be
      // an array with 1 element, which is the default vol value
      const volumeIdx = isVolumeMismatch ? idx : 0;
      sound.fade(
        volumeToGain(finalVolumes[volumeIdx]),
        sound.volume(),
        fadeDuration
      );
      sound.play();
    }
  }

  onNoteClicked(e) {
    // In GUIDE mode, sound can't be interacted
    if (this.viewMode === SESSION_MODES.GUIDE) {
      return;
    }

    e.preventDefault();
    if (this.playingCount > 0) {
      this.stop();
    } else {
      this.play();
    }
  }
}

class Frame {
  id = null;

  notes = [];
  noteIds = [];
  noteMap = {};

  sessionInstance = null;
  frameElement = null;

  constructor(sessionInstance, frameElement) {
    this.frameElement = frameElement;
    this.sessionInstance = sessionInstance;
    this.id = frameElement.id;

    this.initialFrameNotes();
  }

  playAllAutoplayNotes() {
    this.notes.forEach((e) => {
      e.isAutoplay && e.play();
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
}

class AudioSession {
  currFrameId = null;

  // Map of frame id to Frame instance
  frameMap = {};

  _mode = SESSION_MODES.PLAY;
  guideLock = false;

  soundLoadSet = new Set();

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

  handleChangeFrame(nextFrameId) {
    const prevId = this.currFrameId;
    const nextId = nextFrameId;

    this.currFrameId = nextFrameId;
    if (!prevId) {
      const initialFrame = this.frameMap[nextId];
      initialFrame.loadFrameSounds();
      initialFrame
        .getAllSoundNameInFrame()
        .forEach((s) => this.markSoundAsLoading(s));
      Howler.stop();
      return;
    }

    const { fadeDuration = 1000 } = window;

    const prevSoundData = this.frameMap[prevId].noteMap;
    const nextSoundData = this.frameMap[nextId].noteMap;
    const continueNotes = {};
    for (const [noteId, note] of Object.entries(prevSoundData)) {
      if (nextSoundData[noteId] && note.playingCount > 0) {
        continueNotes[noteId] = note;
      } else {
        note.fadeStop(fadeDuration);
      }
    }

    console.log(
      "Common sound notes between prev and current frame:",
      Object.keys(continueNotes)
    );

    for (const [noteId, note] of Object.entries(nextSoundData)) {
      if (continueNotes[noteId]) {
        const prevNote = continueNotes[noteId];
        note.fadeInFrom(prevNote.volumes, fadeDuration);
        prevNote.fadeStop(fadeDuration);
      } else {
        note.soundNames.forEach((sn) => this.markSoundAsLoading(sn));
        note.loadNoteSounds();

        if (this.autoPlay && note.isAutoplay) {
          note.fadeStart(fadeDuration);
        }
      }
    }

    // Switch back to play mode after changing frame if not in guide lock
    if (!this.guideLock) {
      this.mode = SESSION_MODES.PLAY;
    }
  }

  getPlayingNotes() {
    return this.frameMap[this.currFrameId].notes.filter(
      (n) => n.playingCount > 0
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
  }

  markSoundAsLoading(soundKey) {
    this.soundLoadSet.add(soundKey);

    document.body.classList.toggle("loading-sound", true);
  }

  handleSoundLoaded(loadedSound) {
    this.soundLoadSet.delete(loadedSound.key);

    document.body.classList.toggle(
      "loading-sound",
      this.soundLoadSet.size !== 0
    );
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
}

const sessionInstance = new AudioSession();
window.sessionInstance = sessionInstance;

const handleOnUpdateView = ({ detail }) => {
  const { newIndex } = detail;

  // newIndex === -1 => pausing
  if (newIndex === -1) {
    Howler.mute(true);
    return;
  } else {
    Howler.mute(false);
  }

  const frameId = `svg${newIndex}`;
  if (frameId === sessionInstance.currFrameId) {
    return;
  }

  sessionInstance.handleChangeFrame(frameId);
};

window.addEventListener("update-view", handleOnUpdateView);

document.addEventListener(
  "DOMContentLoaded",
  () => {
    sessionInstance.init();

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
  false
);

window.onbeforeunload = () => {
  Howler.unload();
  window.sessionInstance = null;
  window.removeEventListener("update-view", handleOnUpdateView);
};

console.log("Session instance", sessionInstance);

function toggleSessionMode(mode) {
  if (!window.sessionInstance) {
    return;
  }

  window.sessionInstance.mode = mode;
}

function toggleAutoplay(element) {
  if (!window.sessionInstance) {
    return;
  }

  window.sessionInstance.toggleAutoplay();

  const togglerElement = element.querySelector(".autoplay-toggler");
  togglerElement.dataset.active = window.sessionInstance.autoPlay;
}
