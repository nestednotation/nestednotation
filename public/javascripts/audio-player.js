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

  constructor(id, notes) {
    this.notes = notes;
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
}

class SessionAudio {
  currFrameId = null;

  soundMap = {};
  frameMap = {};

  frames = [];

  mode = "note";
  noteModeEnabled = true;
  chordModeEnabled = false;

  soundEnabled = true;

  init() {
    const modeButton = document.getElementById("mode-btn");
    const modeStep = { note: "chord", chord: "mute", mute: "note" };

    modeButton.addEventListener("click", () => {
      // 3 mode: note, chord, mute
      const currMode = modeButton.dataset.mode;
      const nextMode = modeStep[currMode];

      modeButton.dataset.mode = nextMode;
      this.handleChangeMode(nextMode);
    });

    this.loadSounds();
  }

  handleChangeMode(mode) {
    switch (mode) {
      case "note": {
        this.mode = "note";
        break;
      }
      case "chord": {
        this.frameMap[this.currFrameId]?.playAll();
        this.mode = "chord";
        break;
      }
      case "mute": {
        this.mode = "mute";
        this.frameMap[this.currFrameId]?.stopAll();
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
    const frameSvg = mainSvgContainer.querySelectorAll("svg[id]");

    for (const frame of frameSvg) {
      const notes = this.extractFrameNotes(frame);
      const frameInstance = new Frame(frame.id, notes);
      this.frameMap[frame.id] = frameInstance;
      notes.forEach((n) => (n.parent = frameInstance));
    }
  }

  extractFrameNotes(frame) {
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
        const soundInstant = this.soundMap[name];
        soundInstant.name = name;
        return soundInstant;
      });

      const note = new Note(mergeSoundsAndVolumes(sounds, volumes), autoPlay);

      notes.push(note);
      svgNode.addEventListener("click", () => {
        note.toggleSound();
      });
    }

    return notes;
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

    if (this.mode === "chord") {
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

    if (this.mode === "note") {
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

const audioPlayer = new SessionAudio();

window.audioPlayer = audioPlayer;

const handleOnUpdateView = ({ detail }) => {
  const { newIndex } = detail;

  // newIndex === -1 => pausing
  if (newIndex === -1) {
    Howler.mute(true);
    return;
  } else {
    Howler.mute(!audioPlayer.soundEnabled);
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
