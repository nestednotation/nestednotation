const SESSION_PLAY_MODES = { NOTE: "NOTE", CHORD: "CHORD", MUTE: "MUTE" };
const NEW_SESSION_MODES = {
  PLAY: "PLAY",
  GUIDE: "GUIDE",
};

const removeFileExt = (fileName) => {
  const splitted = fileName.split(".");

  return splitted.slice(0, splitted.length - 1).join(".");
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
  return 0.001 * Math.pow(1000.0, (v - 1.0) / 99.0);
}

const DEFAULT_VOLUME = 80;

function mergeSoundsAndVolumes(sounds, volumes) {
  if (volumes.length === 1) {
    return sounds.map((s) => ({
      soundInstance: s,
      name: s.name,
      volume: volumes[0] ?? DEFAULT_VOLUME,
    }));
  }

  if (volumes.length === sounds.length) {
    return sounds.map((s, idx) => ({
      soundInstance: s,
      name: s.name,
      volume: volumes[idx],
    }));
  }

  console.warn(
    "Volume values mismatch with sound values, will fallback to default volume (80)"
  );

  return sounds.map((s) => ({
    soundInstance: s,
    name: s.name,
    volume: DEFAULT_VOLUME,
  }));
}

class Note {
  isAutoplay = true;
  _isPlaying = false;

  sounds = [];
  frameInstance = null;

  domElement = null;

  get viewMode() {
    return this.frameInstance.sessionInstance.newMode;
  }

  get isPlaying() {
    return this._isPlaying;
  }
  set isPlaying(value) {
    this._isPlaying = value;

    this.domElement.dataset.playing = value;
  }

  constructor(frameInstance, svgElement, sounds, isAutoplay = true) {
    this.frameInstance = frameInstance;
    this.isAutoplay = isAutoplay;
    this.sounds = sounds;

    sounds.forEach((sound) => sound.soundInstance.notes.push(this));

    this.domElement = svgElement;
    this.domElement.dataset.playing = "false";
    this.domElement.addEventListener("click", this.onNoteClicked.bind(this));
  }

  play() {
    this.sounds.forEach((s) => {
      const { soundInstance, volume } = s;

      soundInstance.volume(volumeToGain(volume));
      soundInstance.play();
    });

    this.isPlaying = true;
  }

  stop() {
    this.isPlaying = false;

    this.sounds.forEach((s) => {
      const { soundInstance } = s;

      if (soundInstance.notes.some((n) => n.isPlaying)) {
        return;
      }

      soundInstance.stop();
    });
  }

  onNoteClicked(e) {
    // In GUIDE mode, sound should not be toggle
    if (this.viewMode === NEW_SESSION_MODES.GUIDE) {
      return;
    }

    e.preventDefault();
    if (this.isPlaying) {
      this.stop();
    } else {
      this.play();
    }
  }
}

class Frame {
  id = null;
  notes = [];
  soundMap = {};

  sessionInstance = null;

  constructor(sessionInstance, id, frameElement) {
    this.sessionInstance = sessionInstance;
    this.notes = this.getFrameNotes(frameElement);
    this.id = id;
    this.soundMap = this.getSoundMap();
  }

  playAll() {
    this.notes.forEach((e) => {
      e.isAutoplay && e.play();
    });
  }

  stopAll() {
    this.notes.forEach((e) => {
      e.stop();
    });
  }

  loadSounds() {
    Object.values(this.soundMap).forEach((s) => s.soundInstance.load());
  }

  getSoundMap() {
    return this.notes.reduce((acc, curr) => {
      for (const s of curr.sounds) {
        acc[s.name] = s;
      }

      return acc;
    }, {});
  }

  getFrameNotes(frame) {
    const notes = [];

    const frameSvgSoundNodes = frame.querySelectorAll("[sound]");
    for (const svgSoundNode of frameSvgSoundNodes) {
      const soundNames = svgSoundNode.getAttribute("sound")?.split(",");
      if (!soundNames) {
        return;
      }

      const nodeVolums = svgSoundNode
        .getAttribute("volume")
        ?.split(",")
        .map(Number) ?? [DEFAULT_VOLUME];
      const autoPlay = JSON.parse(
        svgSoundNode.getAttribute("autoplay") ?? true
      );
      const nodeSounds = soundNames.map((name) => {
        const soundInstant = this.sessionInstance.soundMap[name];
        soundInstant.name = name;
        return soundInstant;
      });

      const note = new Note(
        this,
        svgSoundNode,
        mergeSoundsAndVolumes(nodeSounds, nodeVolums),
        autoPlay
      );

      notes.push(note);
    }

    return notes;
  }
}

class AudioSession {
  currFrameId = null;

  // Map of sound name to Howl instance
  soundMap = {};
  // Map of frame id to Frame instance
  frameMap = {};

  mode = SESSION_PLAY_MODES.NOTE;

  _newMode = NEW_SESSION_MODES.PLAY;
  guideLock = false;

  autoPlay = false;

  get newMode() {
    return this._newMode;
  }
  set newMode(value) {
    // Prevent enable play mode when guide lock
    if (this.guideLock && value === NEW_SESSION_MODES.PLAY) {
      return;
    }

    // Toggle guide lock after switching to guide mode
    if (
      this._newMode === NEW_SESSION_MODES.GUIDE &&
      value === NEW_SESSION_MODES.GUIDE
    ) {
      this.guideLock = !this.guideLock;
    }

    // Unlock guide mode when switching to play mode
    if (this._newMode === NEW_SESSION_MODES.PLAY) {
      this.guideLock = false;
    }

    this._newMode = value;

    document.body.classList.toggle(
      "guide-mode",
      value === NEW_SESSION_MODES.GUIDE
    );
    document.body.classList.toggle(
      "play-mode",
      value === NEW_SESSION_MODES.PLAY
    );

    document.getElementById("change-mode-container").dataset.mode = value;
    document.getElementById("change-mode-container").dataset.guideLock =
      this.guideLock;
  }

  init() {
    this.loadSounds();
  }

  onPlayModeChange() {
    // 3 mode: NOTE, CHORD, MUTE
    // The cylce is: NOTE -> CHORD -> MUTE -> NOTE
    switch (this.mode) {
      case SESSION_PLAY_MODES.NOTE: {
        this.mode = SESSION_PLAY_MODES.CHORD;
        this.frameMap[this.currFrameId]?.playAll();
        break;
      }
      case SESSION_PLAY_MODES.CHORD: {
        this.mode = SESSION_PLAY_MODES.MUTE;
        this.frameMap[this.currFrameId]?.stopAll();
        break;
      }
      case SESSION_PLAY_MODES.MUTE:
      default: {
        this.mode = SESSION_PLAY_MODES.NOTE;
        break;
      }
    }
  }

  loadSounds() {
    const { scoreSlug, soundList, isHtml5 } = window;

    for (const soundFile of soundList) {
      const key = removeFileExt(soundFile);
      this.soundMap[key] = new Howl({
        src: [`/audio/${scoreSlug}/${soundFile}`],
        loop: true,
        preload: false,
        html5: isHtml5,
      });

      this.soundMap[key].notes = [];
    }

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
      const frameInstance = new Frame(this, frame.id, frame);
      this.frameMap[frame.id] = frameInstance;
    }
  }

  handleChangeFrame(nextFrameId) {
    const prevId = this.currFrameId;
    const nextId = nextFrameId;

    this.currFrameId = nextFrameId;
    if (!prevId) {
      this.frameMap[nextId].loadSounds();
      Howler.stop();
      return;
    }

    const { fadeDuration = 1000 } = window;

    if (this.autoPlay) {
      const prevSoundData = this.frameMap[prevId].soundMap;
      const nextSoundData = this.frameMap[nextId].soundMap;

      const continueSound = {};
      Object.entries(prevSoundData).map(([key, val]) => {
        if (nextSoundData[key]) {
          continueSound[key] = volumeToGain(val.volume);
        } else {
          const { soundInstance, volume } = val;
          soundInstance.fade(volumeToGain(volume), 0, fadeDuration);

          setTimeout(() => {
            soundInstance.unload();
          }, fadeDuration);
        }
      });

      console.log(
        "Common sounds between prev and current frame:",
        Object.keys(continueSound)
      );

      Object.entries(nextSoundData).map(([key, val]) => {
        const { soundInstance, volume } = val;
        if (continueSound[key]) {
          soundInstance.play();
          soundInstance.fade(
            continueSound[key],
            volumeToGain(volume),
            fadeDuration
          );
        } else {
          soundInstance.load();
          soundInstance.fade(0, volumeToGain(volume), fadeDuration);
          soundInstance.play();
        }
      });

      this.frameMap[prevId].notes.forEach((n) => {
        n.isPlaying = false;
      });

      this.frameMap[nextId].notes.forEach((n) => {
        n.isPlaying = true;
      });
    } else {
      const prevSoundData = this.frameMap[prevId].soundMap;
      const nextSoundData = this.frameMap[nextId].soundMap;

      const continueSound = {};
      Object.entries(prevSoundData).map(([key, val]) => {
        if (nextSoundData[key]) {
          continueSound[key] = volumeToGain(val.volume);
        } else {
          const { soundInstance, volume } = val;
          soundInstance.fade(volumeToGain(volume), 0, fadeDuration);

          setTimeout(() => {
            soundInstance.unload();
          }, fadeDuration);
        }
      });

      this.frameMap[prevId].notes.forEach((n) => {
        n.isPlaying = false;
      });

      console.log(
        "Common sounds between prev and current frame:",
        Object.keys(continueSound)
      );

      Object.entries(nextSoundData).map(([key, val]) => {
        const { soundInstance, volume } = val;
        if (continueSound[key]) {
          soundInstance.fade(
            continueSound[key],
            volumeToGain(volume),
            fadeDuration
          );

          const parentNote = soundInstance.notes.find(
            (note) => note.frameInstance === this.frameMap[nextId]
          );

          // Check if the note have all sounds play in next frame
          // => should mark as isPlaying, else assume as partial playing
          if (parentNote?.sounds.every((s) => s.soundInstance.playing())) {
            parentNote.isPlaying = true;
          }
        } else {
          soundInstance.load();
        }
      });
    }

    // Switch back to play mode after changing frame if not in guide lock
    if (!this.guideLock) {
      this.newMode = NEW_SESSION_MODES.PLAY;
    }
  }

  getPlayingSound() {
    return Object.values(this.soundMap).filter((s) => s.playing());
  }

  getPlayingSoundName() {
    return this.getPlayingSound()
      .map((s) => s.name)
      .sort();
  }

  getCurrentFrameSound() {
    return this.frameMap[this.currFrameId].soundMap;
  }

  toggleAutoplay() {
    this.autoPlay = !this.autoPlay;

    if (this.autoPlay) {
      this.frameMap[this.currFrameId]?.playAll();
    } else {
      this.frameMap[this.currFrameId]?.stopAll();
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

  window.sessionInstance.newMode = mode;
}

function refreshSession() {}

function toggleAutoplay(element) {
  if (!window.sessionInstance) {
    return;
  }

  window.sessionInstance.toggleAutoplay();

  const togglerElement = element.querySelector(".autoplay-toggler");
  togglerElement.dataset.active = window.sessionInstance.autoPlay;
}

function toggleSideMenu(e) {
  e.stopPropagation();

  if (e.target !== e.currentTarget) {
    return;
  }

  const sideMenu = document.getElementById("side-menu-container");
  if (sideMenu.dataset.show === "true") {
    sideMenu.dataset.show = "false";
    setTimeout(() => (sideMenu.style.display = "none"), 200);
  } else {
    sideMenu.style.display = "block";
    setTimeout(() => (sideMenu.dataset.show = "true"), 0);
  }
}

function refreshSession() {
  window.location.reload();
}
