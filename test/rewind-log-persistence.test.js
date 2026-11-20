/** Persisted, session-wide rewind audit. */

const assert = require("node:assert");
const fs = require("node:fs");

const { BMSession, SERVER_STATE_DIR } = require("../database.js");

module.exports = async () => {
  const id = "__state_rewind_log_test__";
  const statePath = `${SERVER_STATE_DIR}/${id}.json`;
  const session = new BMSession();
  session.id = id;
  session.sessionName = id;
  session.folder = "__none__";

  try {
    for (let i = 0; i < 23; i++) {
      session.recordRewind({
        kind: i % 2 ? "line" : "merge",
        frame: `frame-${i}.svg`,
        lineId: i % 2 ? "L1" : undefined,
      });
    }
    await session.saveSessionStateToFile();

    const state = JSON.parse(await fs.promises.readFile(statePath, "utf8"));
    assert.strictEqual(state.rewindLog.length, 20);
    assert.strictEqual(state.rewindLog[0].frame, "frame-22.svg");
    assert.strictEqual(state.rewindLog[19].frame, "frame-3.svg");

    const restored = new BMSession();
    await restored.patchState(state);
    assert.deepStrictEqual(restored.rewindLog, state.rewindLog);

    // The log is SESSION state, not page state, which is what makes it survive
    // the reloads that used to erase the browser-local one — a refresh, a
    // reconnect, a restart all read it back out of the file above.
    //
    // Replacing the SCORE is the one thing it does not survive (owner): every
    // entry names a frame of the score being replaced, so carrying it over
    // leaves the map listing rewinds at frames the new score does not have.
    restored.resetForScoreChange();
    assert.deepStrictEqual(restored.rewindLog, []);
  } finally {
    await fs.promises.rm(statePath, { force: true });
  }
};
