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
const os = require("node:os");
const path = require("node:path");

const {
  BMSession,
  BMSessionTable,
  SERVER_STATE_DIR,
} = require("../database.js");

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

  // ── Deterministic ordering and injected failures ─────────────────────────
  //
  // The overlap test above starts two real saves but cannot force their
  // filesystem calls into the old failing order. These hold a write open at a
  // gate and inject failures, so the ordering and the recovery are asserted
  // rather than hoped for.

  "a save waits for the one before it to finish renaming": async () => {
    const id = "__state_order_test__";
    const session = makeSession(id);
    const ops = [];
    const gate = deferred();
    const firstWriteStarted = deferred();

    try {
      await withFsPatches(
        {
          writeFile: async (original, file, ...rest) => {
            if (!String(file).includes(id)) return original(file, ...rest);
            const which = JSON.parse(rest[0]).sessionName;
            ops.push(`write ${which}`);
            if (which === "first") {
              firstWriteStarted.resolve();
              await gate.promise;
            }
            return original(file, ...rest);
          },
          rename: async (original, from, to) => {
            if (String(to).includes(id)) {
              ops.push(`rename ${JSON.parse(fs.readFileSync(from, "utf8")).sessionName}`);
            }
            return original(from, to);
          },
        },
        async () => {
          session.sessionName = "first";
          const first = session.saveSessionStateToFile();
          session.sessionName = "second";
          const second = session.saveSessionStateToFile();

          await firstWriteStarted.promise;
          // Let every other pending callback run: the second save must still
          // be queued behind the first, not writing alongside it.
          await new Promise((resolve) => setImmediate(resolve));
          assert.deepStrictEqual(ops, ["write first"]);

          gate.resolve();
          await Promise.all([first, second]);
        },
      );

      assert.deepStrictEqual(ops, [
        "write first",
        "rename first",
        "write second",
        "rename second",
      ]);
      assert.strictEqual(readState(id).sessionName, "second");
    } finally {
      await cleanup(id);
    }
  },

  "a failed write keeps the previous snapshot, and the next save still lands": async () => {
    const id = "__state_write_fail_test__";
    const session = makeSession(id);

    try {
      session.sessionName = "previous";
      await session.saveSessionStateToFile();

      let failNext = true;
      await withFsPatches(
        {
          writeFile: async (original, file, ...rest) => {
            if (failNext && String(file).includes(id)) {
              failNext = false;
              throw Object.assign(new Error("ENOSPC: injected"), { code: "ENOSPC" });
            }
            return original(file, ...rest);
          },
        },
        async () => {
          session.sessionName = "lost";
          const failing = session.saveSessionStateToFile();
          session.sessionName = "next";
          const next = session.saveSessionStateToFile();

          await assert.rejects(failing, /injected/);
          // The failure reached its own caller; on disk the old file is whole.
          assert.strictEqual(readState(id).sessionName, "previous");
          await next;
        },
      );

      assert.strictEqual(readState(id).sessionName, "next");
      assert.deepStrictEqual(tempLeftovers(id), []);
    } finally {
      await cleanup(id);
    }
  },

  "a failed rename removes its temp file and keeps the previous snapshot": async () => {
    const id = "__state_rename_fail_test__";
    const session = makeSession(id);

    try {
      session.sessionName = "previous";
      await session.saveSessionStateToFile();

      await withFsPatches(
        {
          rename: async (original, from, to) => {
            if (String(to).includes(id)) {
              throw Object.assign(new Error("EPERM: injected"), { code: "EPERM" });
            }
            return original(from, to);
          },
        },
        async () => {
          session.sessionName = "lost";
          await assert.rejects(session.saveSessionStateToFile(), /injected/);
        },
      );

      assert.strictEqual(readState(id).sessionName, "previous");
      assert.deepStrictEqual(tempLeftovers(id), []);

      session.sessionName = "after";
      await session.saveSessionStateToFile();
      assert.strictEqual(readState(id).sessionName, "after");
    } finally {
      await cleanup(id);
    }
  },

  "a delete issued while a save is mid-write still wins": async () => {
    const id = "__state_delete_midwrite_test__";
    const session = makeSession(id);
    const gate = deferred();
    const writing = deferred();

    try {
      await session.saveSessionStateToFile();
      await withFsPatches(
        {
          writeFile: async (original, file, ...rest) => {
            if (String(file).includes(id)) {
              writing.resolve();
              await gate.promise;
            }
            return original(file, ...rest);
          },
        },
        async () => {
          const save = session.saveSessionStateToFile();
          await writing.promise;
          const deletion = session.deleteStateFile();
          gate.resolve();
          await Promise.all([save, deletion]);
        },
      );

      assert.ok(!fs.existsSync(statePath(id)), "the delete must win");
      assert.deepStrictEqual(tempLeftovers(id), []);
    } finally {
      await cleanup(id);
    }
  },

  // ── Boot ───────────────────────────────────────────────────────────────────

  "boot restores every valid session around a corrupt file, a failing score and leftovers": async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nn-boot-"));
    const stateDir = path.join(root, "state");
    const dataDir = path.join(root, "data");
    fs.mkdirSync(stateDir);
    fs.cpSync(
      path.join(__dirname, "fixtures", "session-lines-demo"),
      path.join(dataDir, "Demo"),
      { recursive: true },
    );
    fs.cpSync(
      path.join(__dirname, "fixtures", "session-lines-demo"),
      path.join(dataDir, "Broken"),
      { recursive: true },
    );

    const snapshot = (id, folder) =>
      JSON.stringify({ ...makeSession(id).toJSON(), folder, sessionName: id });
    // Sorted listing order: a < b < c < d, so the failures sit between the
    // good ones and the loader has to carry on past each.
    fs.writeFileSync(path.join(stateDir, "a-good.json"), snapshot("a-good", "Demo"));
    fs.writeFileSync(path.join(stateDir, "b-corrupt.json"), '{"id": "b-corrupt", "lines": [');
    fs.writeFileSync(path.join(stateDir, "c-broken.json"), snapshot("c-broken", "Broken"));
    fs.writeFileSync(path.join(stateDir, "d-good.json"), snapshot("d-good", "Demo"));
    // Not sessions: an orphaned sub-frame cache and a crashed save's temp file.
    fs.writeFileSync(path.join(stateDir, "zz-orphan.subs.json"), '{"Tetra": {}}');
    fs.writeFileSync(path.join(stateDir, "a-good.json.123.tmp"), "{half");

    try {
      const table = new BMSessionTable();
      await withFsPatches(
        {
          readFile: async (original, file, ...rest) => {
            if (String(file).replace(/\\/g, "/").includes("/Broken/Frames/")) {
              throw Object.assign(new Error("EIO: injected"), { code: "EIO" });
            }
            return original(file, ...rest);
          },
        },
        () => table.loadStoredSessionStates({ stateDir, dataDir }),
      );

      assert.deepStrictEqual(table.data.map((s) => s.id), ["a-good", "d-good"]);
      for (const session of table.data) {
        assert.ok(session.listFiles.length > 0, `${session.id} has its score`);
        assert.strictEqual(session.stateDir, stateDir);
      }

      const files = fs.readdirSync(stateDir);
      assert.ok(
        files.some((f) => f.startsWith("b-corrupt.json.corrupt-")),
        "the unreadable file is quarantined",
      );
      assert.ok(!files.includes("b-corrupt.json"));
      assert.ok(files.includes("c-broken.json"), "a snapshot whose score failed to build is kept for the next boot");
      assert.ok(files.includes("zz-orphan.subs.json"), "the orphan cache is not treated as a session");
      assert.ok(files.includes("a-good.json.123.tmp"));

      // Built output went to the scratch state directory, nowhere else.
      for (const session of table.data) {
        assert.ok(
          files.includes(path.basename(session.bundleFile("html"))),
          `${session.id}'s page is not in the scratch state directory`,
        );
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },

  "boot deletes a session whose score folder is gone, and nothing when the data directory is": async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nn-boot-gone-"));
    const stateDir = path.join(root, "state");
    const dataDir = path.join(root, "data");
    fs.mkdirSync(stateDir);
    fs.cpSync(
      path.join(__dirname, "fixtures", "session-lines-demo"),
      path.join(dataDir, "Demo"),
      { recursive: true },
    );
    const snapshot = (id, folder) =>
      JSON.stringify({ ...makeSession(id).toJSON(), folder, sessionName: id });
    fs.writeFileSync(path.join(stateDir, "a-good.json"), snapshot("a-good", "Demo"));
    fs.writeFileSync(path.join(stateDir, "b-gone.json"), snapshot("b-gone", "Removed"));
    // Baked files the gone session left from earlier builds.
    fs.writeFileSync(path.join(stateDir, "b-gone.html"), "old page");
    fs.writeFileSync(path.join(stateDir, "b-gone.rev-abc123.content.svg"), "old content");

    try {
      // The data directory is unreachable: every snapshot is kept.
      const offline = new BMSessionTable();
      await offline.loadStoredSessionStates({
        stateDir,
        dataDir: path.join(root, "unmounted"),
      });
      assert.deepStrictEqual(offline.data, []);
      assert.ok(fs.existsSync(path.join(stateDir, "a-good.json")));
      assert.ok(fs.existsSync(path.join(stateDir, "b-gone.json")));

      const table = new BMSessionTable();
      await table.loadStoredSessionStates({ stateDir, dataDir });
      assert.deepStrictEqual(table.data.map((s) => s.id), ["a-good"]);
      const left = fs.readdirSync(stateDir).filter((f) => f.startsWith("b-gone"));
      assert.deepStrictEqual(left, [], "the gone session left files behind");
      assert.ok(fs.existsSync(path.join(stateDir, "a-good.json")));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },

  // F14: a lookup that fails is not a removal. Each case must keep the saved
  // session's snapshot and every baked file.
  "boot keeps sessions whose score storage cannot be read": async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nn-boot-unreadable-"));
    const stateDir = path.join(root, "state");
    const dataDir = path.join(root, "data");
    fs.mkdirSync(stateDir);
    fs.cpSync(
      path.join(__dirname, "fixtures", "session-lines-demo"),
      path.join(dataDir, "Demo"),
      { recursive: true },
    );
    fs.cpSync(
      path.join(__dirname, "fixtures", "session-lines-demo"),
      path.join(dataDir, "Kept"),
      { recursive: true },
    );
    const snapshot = (id, folder) =>
      JSON.stringify({ ...makeSession(id).toJSON(), folder, sessionName: id });
    const saved = ["b-kept.json", "b-kept.html", "b-kept.rev-abc123.content.svg"];
    fs.writeFileSync(path.join(stateDir, "b-kept.json"), snapshot("b-kept", "Kept"));
    fs.writeFileSync(path.join(stateDir, "b-kept.html"), "old page");
    fs.writeFileSync(path.join(stateDir, "b-kept.rev-abc123.content.svg"), "old content");

    const norm = (p) => String(p).replace(/\\/g, "/");
    const dataPrefix = norm(dataDir);
    const under = (p, sub) => norm(p).startsWith(`${dataPrefix}/${sub}`);
    const denied = () =>
      Object.assign(new Error("EACCES: permission denied (injected)"), {
        code: "EACCES",
        errno: -13,
      });
    const notFound = () =>
      Object.assign(new Error("ENOENT: injected"), { code: "ENOENT" });

    const bootWith = async (patches) => {
      const table = new BMSessionTable();
      await withFsPatches(patches, () =>
        table.loadStoredSessionStates({ stateDir, dataDir }),
      );
      const left = fs.readdirSync(stateDir).filter((f) => f.startsWith("b-kept"));
      for (const file of saved) {
        assert.ok(left.includes(file), `${file} was deleted`);
      }
      return table;
    };

    try {
      // The data directory exists but can no longer be traversed or listed:
      // every lookup under it fails with EACCES.
      await bootWith({
        stat: async (original, p, ...rest) => {
          if (under(p, "")) throw denied();
          return original(p, ...rest);
        },
        readdir: async (original, p, ...rest) => {
          if (norm(p) === dataPrefix || under(p, "")) throw denied();
          return original(p, ...rest);
        },
      });

      // The data directory lists, but this score folder's lookup fails.
      const table = await bootWith({
        stat: async (original, p, ...rest) => {
          if (under(p, "Kept")) throw denied();
          return original(p, ...rest);
        },
      });
      assert.deepStrictEqual(table.data.map((s) => s.id), [], "an unreadable score is not loaded");

      // A lookup that claims absence is contradicted by the directory listing.
      await bootWith({
        stat: async (original, p, ...rest) => {
          if (under(p, "Kept")) throw notFound();
          return original(p, ...rest);
        },
      });

      // An unmounted volume: the mount point is there but holds no scores.
      fs.renameSync(dataDir, path.join(root, "offline"));
      fs.mkdirSync(dataDir);
      try {
        await bootWith({});
      } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
        fs.renameSync(path.join(root, "offline"), dataDir);
      }

      // Control: with the folder genuinely removed, the session is deleted.
      fs.rmSync(path.join(dataDir, "Kept"), { recursive: true, force: true });
      const cleanup = new BMSessionTable();
      await cleanup.loadStoredSessionStates({ stateDir, dataDir });
      assert.deepStrictEqual(
        fs.readdirSync(stateDir).filter((f) => f.startsWith("b-kept")),
        [],
        "a genuinely removed score is still cleaned up",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
};

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

function readState(id) {
  return JSON.parse(fs.readFileSync(statePath(id), "utf8"));
}

function tempLeftovers(id) {
  return fs
    .readdirSync(SERVER_STATE_DIR)
    .filter((f) => f.startsWith(`${id}.json.`));
}

// Replace fs.promises functions for the duration of `work`; each replacement
// receives the original first. Restored even when `work` throws.
async function withFsPatches(patches, work) {
  const originals = {};
  for (const [name, replacement] of Object.entries(patches)) {
    originals[name] = fs.promises[name];
    fs.promises[name] = (...args) => replacement(originals[name], ...args);
  }
  try {
    return await work();
  } finally {
    Object.assign(fs.promises, originals);
  }
}
