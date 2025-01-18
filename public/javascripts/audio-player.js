const SESSION_PLAY_MODES = { NOTE: "NOTE", CHORD: "CHORD", MUTE: "MUTE" };

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
      sound: s,
      name: s.name,
      volume: volumes[0] ?? DEFAULT_VOLUME,
    }));
  }

  if (volumes.length === sounds.length) {
    return sounds.map((s, idx) => ({
      sound: s,
      name: s.name,
      volume: volumes[idx],
    }));
  }

  console.warn(
    "Volume values mismatch with sound values, will fallback to default volume (80)"
  );

  return sounds.map((s) => ({
    sound: s,
    name: s.name,
    volume: DEFAULT_VOLUME,
  }));
}

class Note {
  isAutoplay = true;
  isPlaying = false;
  sounds = [];
  parent = null;

  constructor(sounds, isAutoplay = true) {
    this.isAutoplay = isAutoplay;
    this.sounds = sounds;

    sounds.forEach((sound) => sound.sound.notes.push(this));
  }

  play() {
    this.sounds.forEach((s) => {
      const { sound, volume } = s;

      sound.volume(volumeToGain(volume));
      sound.play();
    });

    this.isPlaying = true;
  }

  stop() {
    this.isPlaying = false;

    this.sounds.forEach((s) => {
      const { sound } = s;

      if (sound.notes.some((n) => n.isPlaying)) {
        return;
      }

      sound.stop();
    });
  }

  toggleSound() {
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

  constructor(id, frameElement, globalSoundMap) {
    this.notes = this.getFrameNotes(frameElement, globalSoundMap);
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
    Object.values(this.soundMap).forEach((s) => s.sound.load());
  }

  getSoundMap() {
    return this.notes.reduce((acc, curr) => {
      for (const s of curr.sounds) {
        acc[s.name] = s;
      }

      return acc;
    }, {});
  }

  getFrameNotes(frame, globalSoundMap) {
    const notes = [];

    const svgSoundNodes = frame.querySelectorAll("[sound]");
    for (const svgNode of svgSoundNodes) {
      const soundNames = svgNode.getAttribute("sound")?.split(",");
      if (!soundNames) {
        return;
      }

      const volumes = svgNode
        .getAttribute("volume")
        ?.split(",")
        .map(Number) ?? [DEFAULT_VOLUME];
      const autoPlay = JSON.parse(svgNode.getAttribute("autoplay") ?? true);
      const sounds = soundNames.map((name) => {
        const soundInstant = globalSoundMap[name];
        soundInstant.name = name;
        return soundInstant;
      });

      const note = new Note(mergeSoundsAndVolumes(sounds, volumes), autoPlay);

      note.parent = this;
      notes.push(note);
      svgNode.addEventListener("click", () => {
        note.toggleSound();
      });
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

  autoPlay = false;

  init() {
    const modeButton = document.getElementById("mode-btn");

    modeButton.addEventListener("click", () => {
      // 3 mode: NOTE, CHORD, MUTE
      // The cylce is: NOTE -> CHORD -> MUTE -> NOTE
      const currMode = modeButton.dataset.mode;
      switch (currMode) {
        case SESSION_PLAY_MODES.NOTE: {
          modeButton.dataset.mode = SESSION_PLAY_MODES.CHORD;
          this.frameMap[this.currFrameId]?.playAll();
          break;
        }
        case SESSION_PLAY_MODES.CHORD: {
          modeButton.dataset.mode = SESSION_PLAY_MODES.MUTE;
          this.frameMap[this.currFrameId]?.stopAll();
          break;
        }
        case SESSION_PLAY_MODES.MUTE:
        default: {
          modeButton.dataset.mode = SESSION_PLAY_MODES.NOTE;
          break;
        }
      }
    });

    this.loadSounds();
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
      const frameInstance = new Frame(frame.id, frame, this.soundMap);
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

    if (this.mode === SESSION_PLAY_MODES.CHORD) {
      const prevSoundData = this.frameMap[prevId].soundMap;
      const nextSoundData = this.frameMap[nextId].soundMap;

      const continueSound = {};
      Object.entries(prevSoundData).map(([key, val]) => {
        if (nextSoundData[key]) {
          continueSound[key] = volumeToGain(val.volume);
        } else {
          const { sound, volume } = val;
          sound.fade(volumeToGain(volume), 0, fadeDuration);

          setTimeout(() => {
            sound.unload();
          }, fadeDuration);
        }
      });

      console.log(
        "Common sounds between prev and current frame:",
        Object.keys(continueSound)
      );

      Object.entries(nextSoundData).map(([key, val]) => {
        const { sound, volume } = val;
        if (continueSound[key]) {
          sound.play();
          sound.fade(continueSound[key], volumeToGain(volume), fadeDuration);
        } else {
          sound.load();
          sound.fade(0, volumeToGain(volume), fadeDuration);
          sound.play();
        }
      });

      this.frameMap[prevId].notes.forEach((n) => {
        n.isPlaying = false;
      });

      this.frameMap[nextId].notes.forEach((n) => {
        n.isPlaying = true;
      });
    }

    if (this.mode === SESSION_PLAY_MODES.NOTE) {
      const prevSoundData = this.frameMap[prevId].soundMap;
      const nextSoundData = this.frameMap[nextId].soundMap;

      const continueSound = {};
      Object.entries(prevSoundData).map(([key, val]) => {
        if (nextSoundData[key]) {
          continueSound[key] = volumeToGain(val.volume);
        } else {
          const { sound, volume } = val;
          sound.fade(volumeToGain(volume), 0, fadeDuration);

          setTimeout(() => {
            sound.unload();
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
        const { sound, volume } = val;
        if (continueSound[key]) {
          sound.fade(continueSound[key], volumeToGain(volume), fadeDuration);

          const parentNote = sound.notes.find(
            (note) => note.parent === this.frameMap[nextId]
          );

          // Check if the note have all sounds play in next frame
          // => should mark as isPlaying, else assume as partial playing
          if (parentNote?.sounds.every((s) => s.sound.playing())) {
            parentNote.isPlaying = true;
          }
        } else {
          sound.load();
        }
      });
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
}

const audioPlayer = new AudioSession();

window.audioPlayer = audioPlayer;

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
  if (frameId === audioPlayer.currFrameId) {
    return;
  }

  audioPlayer.handleChangeFrame(frameId);
};

window.addEventListener("update-view", handleOnUpdateView);

document.addEventListener(
  "DOMContentLoaded",
  () => {
    audioPlayer.init();
  },
  false
);

window.onbeforeunload = () => {
  Howler.unload();
  window.audioPlayer = null;
  window.removeEventListener("update-view", handleOnUpdateView);
};
