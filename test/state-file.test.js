/**
 * Session state file durability.
 *
 * The state file is the only thing that survives a restart, and it is written
 * from more than one place (SM settings saves, session creation, score
 * reloads). fs.writeFile truncates at open and writes afterwards, so two
 * overlapping saves used to interleave and leave the longer payload's tail
 * glued past the end of the shorter one's JSON — a file the next boot could
 * not parse, taking every other session down with it.
 */

const assert = require("node:assert");
const fs = require("node:fs");

const { BMSession, SERVER_STATE_DIR } = require("../database.js");

// A session that needs no score on disk: these tests only exercise the write
// path, never buildSVGContent.
const makeSession = (id) => {
  const session = new BMSession();
  session.id = id;
  session.sessionName = id;
  session.folder = "__none__";
  return session;
};

const statePath = (id) => `${SERVER_STATE_DIR}/${id}.json`;

const cleanup = async (id) => {
  await fs.promises.rm(statePath(id), { force: true });
};

module.exports = {
  "overlapping saves leave one whole, parseable snapshot": async () => {
    const id = "__state_race_test__";
    const session = makeSession(id);

    try {
      // Long payload first, short one second: under an unqueued writeFile the
      // short write lands on top of the long one and its tail survives.
      session.sessionName = "L".repeat(5000);
      const first = session.saveSessionStateToFile();
      session.sessionName = "short";
      const second = session.saveSessionStateToFile();

      await Promise.all([first, second]);

      const raw = await fs.promises.readFile(statePath(id), "utf8");
      const state = JSON.parse(raw); // throws on a spliced file
      assert.strictEqual(
        state.sessionName,
        "short",
        "the last save queued must be the one left on disk",
      );
      assert.strictEqual(
        raw.length,
        JSON.stringify(state).length,
        "no bytes past the end of the JSON",
      );
    } finally {
      await cleanup(id);
    }
  },

  "saves keep their own snapshot, not the state at write time": async () => {
    const id = "__state_snapshot_test__";
    const session = makeSession(id);

    try {
      session.sessionName = "first";
      const write = session.saveSessionStateToFile();
      // Mutating before the queued write runs must not rewrite its payload.
      session.sessionName = "mutated-after";
      await write;

      const state = JSON.parse(
        await fs.promises.readFile(statePath(id), "utf8"),
      );
      assert.strictEqual(state.sessionName, "first");
    } finally {
      await cleanup(id);
    }
  },

  "a queued save cannot resurrect a deleted state file": async () => {
    const id = "__state_delete_test__";
    const session = makeSession(id);

    try {
      await session.saveSessionStateToFile();
      assert.ok(fs.existsSync(statePath(id)), "state file written");

      // Queue a save, then delete without letting it drain first.
      const pending = session.saveSessionStateToFile();
      await session.deleteStateFile();
      await pending;

      assert.ok(
        !fs.existsSync(statePath(id)),
        "the delete must win over an in-flight save",
      );
    } finally {
      await cleanup(id);
    }
  },

  "no temp file is left behind after a save": async () => {
    const id = "__state_tmp_test__";
    const session = makeSession(id);

    try {
      await session.saveSessionStateToFile();
      const leftovers = fs
        .readdirSync(SERVER_STATE_DIR)
        .filter((f) => f.startsWith(`${id}.json.`));
      assert.deepStrictEqual(leftovers, [], "temp file renamed, not orphaned");
    } finally {
      await cleanup(id);
    }
  },
};
