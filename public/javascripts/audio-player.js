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

class SessionAudio {
  currFrameId = null;

  soundMap = {};
  frameMap = {};

  noteModeEnabled = true;
  chordModeEnabled = false;

  soundEnabled = true;

  init() {
    const soundButton = document.getElementById("sound-btn");
    const noteButton = document.getElementById("note-mode-btn");
    const chordButton = document.getElementById("chord-mode-btn");

    soundButton.addEventListener("click", () => {
      this.soundEnabled = !this.soundEnabled;

      soundButton.dataset.sound = this.soundEnabled ? "true" : "false";
      Howler.mute(!this.soundEnabled);
    });

    noteButton.addEventListener("click", () => {
      this.noteModeEnabled = !this.noteModeEnabled;

      noteButton.dataset.enabled = this.noteModeEnabled ? "true" : "false";
      if (!this.noteModeEnabled && !this.chordModeEnabled) {
        this.stopAll();
      }
    });

    chordButton.addEventListener("click", () => {
      this.chordModeEnabled = !this.chordModeEnabled;

      chordButton.dataset.enabled = this.chordModeEnabled ? "true" : "false";
      if (this.chordModeEnabled) {
        this.playAllFrameSound(this.currFrameId);
      } else {
        this.stopAll();
      }
    });

    this.loadSounds();
  }

  loadSounds() {
    const { scoreSlug, soundList } = window;

    for (let soundFile of soundList) {
      const key = removeFileExt(soundFile);
      this.soundMap[key] = new Howl({
        src: [`/audio/${scoreSlug}/${soundFile}`],
        loop: true,
      });
    }

    this.generateSoundMap();
  }

  generateSoundMap() {
    const mainSvgContainer = document.getElementById("MainSVGContent");
    const frameSvg = mainSvgContainer.querySelectorAll("svg[id]");

    for (const frame of frameSvg) {
      const frameSound = this.extractSoundFromFrame(frame);
      this.frameMap[frame.id] = frameSound;
    }
  }

  extractSoundFromFrame(frame) {
    const frameSoundMap = {};

    const svgSoundNode = frame.querySelectorAll("[sound]");
    for (const node of svgSoundNode) {
      const soundData = this.extractSoundFromNode(node);
      frameSoundMap[soundData.id] = soundData;

      node.addEventListener("click", () => {
        this.toggleSound(frame.id, soundData.id);
      });
    }

    return frameSoundMap;
  }

  extractSoundFromNode(node) {
    const soundNames = node.getAttribute("sound")?.split(",");
    if (!soundNames) {
      return;
    }

    const volume = Number(node.getAttribute("volume") ?? DEFAULT_VOLUME);
    const autoPlay = JSON.parse(node.getAttribute("autoplay") ?? true);
    const sounds = soundNames.map((name) => this.soundMap[name]);

    return { sounds, autoPlay, volume, id: soundNames };
  }

  toggleSound(frameId, soundId) {
    const soundData = this.frameMap[frameId][soundId];
    if (!soundData) {
      console.error("Sound combination not found");
      return;
    }

    if (!this.noteModeEnabled) {
      console.log("Note mode disabled");
      return;
    }

    const { sounds, volume } = soundData;
    const isPlaying = soundData.sounds.some((s) => s.playing());
    if (isPlaying) {
      sounds.forEach((s) => this.fadeOut(s, volume));
    } else {
      sounds.forEach((s) => {
        this.fadeIn(s, volume);
      });
    }
  }

  handleChangeFrame(nextFrameId) {
    const prevId = this.currFrameId;
    const nextId = nextFrameId;

    this.currFrameId = nextFrameId;
    if (!prevId) {
      this.stopAll();
      return;
    }

    if (this.chordModeEnabled) {
      const prevSoundData = this.frameMap[prevId];
      const nextSoundData = this.frameMap[nextId];
      const continueSoundSet = {};
      for (const [soundId, sound] of Object.entries(prevSoundData)) {
        const soundInNext = nextSoundData[soundId];
        const { sounds, autoPlay, volume } = sound;

        if (!soundInNext) {
          sounds.forEach((s) => {
            this.fadeOut(s, volume);
          });
          continue;
        }

        if (!autoPlay) {
          sounds.forEach((s) => {
            s.stop();
          });
          continue;
        }

        continueSoundSet[soundId] = sounds.some((s) => s.playing());
      }

      for (const [soundId, sound] of Object.entries(nextSoundData)) {
        const { sounds, volume, autoPlay } = sound;

        if (continueSoundSet[soundId] || !autoPlay) {
          continue;
        }

        sounds.forEach((s) => {
          this.fadeIn(s, volume);
        });
      }

      return;
    }

    if (this.noteModeEnabled) {
      const prevSoundData = this.frameMap[prevId];
      const nextSoundData = this.frameMap[nextId];
      for (const [soundId, sound] of Object.entries(prevSoundData)) {
        const soundInNext = nextSoundData[soundId];
        const { sounds, volume, autoPlay } = sound;

        if (!soundInNext) {
          sounds.forEach((s) => {
            this.fadeOut(s, volume);
          });
          continue;
        }

        if (!autoPlay) {
          sounds.forEach((s) => {
            s.stop();
          });
          continue;
        }

        const { volume: nextVolume } = soundInNext;
        sounds.forEach((s) => {
          s.fade(volumeToGain(volume), volumeToGain(nextVolume), 1000);
        });
      }
    }
  }

  playAllFrameSound(frameId) {
    const frameData = this.frameMap[frameId];
    for (const soundData of Object.values(frameData)) {
      const { sounds, volume, autoPlay } = soundData;
      const isPlaying = sounds.some((s) => s.playing());
      if (!autoPlay || isPlaying) {
        continue;
      }

      sounds.forEach((s) => {
        this.fadeIn(s, volume);
      });
    }
  }

  stopAll() {
    Howler.stop();
  }

  fadeOut(sound, currVolume) {
    console.log("Fade out ", sound._src);

    sound.fade(volumeToGain(currVolume), 0, 1000);
    setTimeout(() => sound.stop(), 1000);
  }

  fadeIn(sound, volume) {
    console.log("Fade in ", sound._src);

    sound.volume(0);
    sound.play();
    sound.fade(0, volumeToGain(volume), 1000);
  }
}

const audioPlayer = new SessionAudio();

window.audioPlayer = audioPlayer;

window.addEventListener("update-view", ({ detail }) => {
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
});

document.addEventListener(
  "DOMContentLoaded",
  () => {
    audioPlayer.init();
  },
  false
);
