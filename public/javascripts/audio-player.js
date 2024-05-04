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

class SessionAudio {
  soundMap = {};

  constructor() {}

  loadSounds(soundList) {
    const { scoreSlug } = window;

    for (let soundFile of soundList) {
      const key = removeFileExt(soundFile);
      this.soundMap[key] = new Howl({
        src: [`/audio/${scoreSlug}/${soundFile}`],
        loop: true,
      });
    }

    this.initSoundEvents();
  }

  initSoundEvents() {
    const mainSvgContainer = document.getElementById("MainSVGContent");
    const soundNodes = mainSvgContainer.querySelectorAll("[sound]");

    for (const node of soundNodes) {
      this.attachSoundToSvg(node);
    }
  }

  attachSoundToSvg(node) {
    const soundNames = node.getAttribute("sound")?.split(",");
    if (!soundNames) {
      return;
    }

    const volume = Number(node.getAttribute("volume") ?? 70);
    const autoPlay = JSON.parse(node.getAttribute("autoplay") ?? "true");

    node.addEventListener("click", () => {
      soundNames.forEach((soundName) => {
        const sound = this.soundMap[soundName];

        if (!sound) {
          return;
        }
        const isPlaying = sound.playing();
        if (isPlaying) {
          sound.stop();
        } else {
          sound.volume(volumeToGain(volume));
          sound.play();
        }
      });
    });
  }

  stopAll() {
    Howler.stop();
  }
}

const audioPlayer = new SessionAudio();

window.addEventListener("update-view", () => {
  audioPlayer.stopAll();
});

document.addEventListener(
  "DOMContentLoaded",
  () => {
    audioPlayer.loadSounds(window.soundList);
  },
  false
);
