/**
 * The test runner's own guarantees (review T7): a stuck case fails by its
 * deadline instead of hanging or silently ending the run, a mock left in place
 * fails its case and is restored, duplicate case names are reported, and a run
 * that ends early says so and exits non-zero.
 *
 * The end-to-end cases run test/run.js as a child process against a scratch
 * directory of deliberately broken test files.
 */

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  duplicateCaseNames,
  withDeadline,
  COMPLETED_MARKER,
} = require("./run.js");

// Every file under `dir` with its contents, keyed by relative path; null if
// the directory is gone.
function contentsOf(dir) {
  if (!fs.existsSync(dir)) return null;
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = fs.readFileSync(p, "utf8");
    }
  };
  walk(dir);
  return out;
}

/**
 * Runs test/run.js with SERVER_STATE_DIR already set to a caller directory
 * holding a snapshot under a test's fixed id and a nested baked file, and the
 * temporary directory redirected to an empty scratch parent. Without `files`
 * it runs the real test files, `args` selecting among them.
 */
function runWithCallerStateDir({ args = [], files = null }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nn-runner-owner-"));
  try {
    const callerDir = path.join(root, "caller-state");
    fs.mkdirSync(path.join(callerDir, "baked"), { recursive: true });
    fs.writeFileSync(
      path.join(callerDir, "__state_race_test__.json"),
      '{"id":"caller snapshot"}',
    );
    fs.writeFileSync(path.join(callerDir, "1726700000000.json"), '{"id":"live room"}');
    fs.writeFileSync(path.join(callerDir, "baked", "content.r3.json"), "baked score");
    const before = contentsOf(callerDir);

    const tmp = path.join(root, "tmp");
    fs.mkdirSync(tmp);
    const env = { ...process.env, SERVER_STATE_DIR: callerDir, TMPDIR: tmp, TEMP: tmp, TMP: tmp };
    if (files) {
      const testDir = path.join(root, "tests");
      fs.mkdirSync(testDir);
      for (const [name, source] of Object.entries(files)) {
        fs.writeFileSync(path.join(testDir, name), source);
      }
      env.TEST_DIR = testDir;
    }
    const out = spawnSync(process.execPath, [path.join(__dirname, "run.js"), ...args], {
      env,
      encoding: "utf8",
      timeout: 60000,
    });
    return {
      status: out.status,
      output: `${out.stdout}${out.stderr}${out.error ? out.error.message : ""}`,
      callerBefore: before,
      callerAfter: contentsOf(callerDir),
      leftInTmp: fs.readdirSync(tmp),
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// A case that writes where the runner points it, under the same fixed id the
// state-file tests use, and reports that directory.
const WRITES_STATE = `const fs = require("fs");
const path = require("path");
const write = () => {
  const dir = process.env.SERVER_STATE_DIR;
  fs.mkdirSync(path.join(dir, "baked"), { recursive: true });
  fs.writeFileSync(path.join(dir, "__state_race_test__.json"), "overwritten");
  fs.writeFileSync(path.join(dir, "baked", "content.r3.json"), "overwritten");
  console.log("STATE DIR " + dir);
};`;

function runOn(files, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nn-runner-"));
  try {
    for (const [name, source] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), source);
    }
    const out = spawnSync(process.execPath, [path.join(__dirname, "run.js")], {
      env: { ...process.env, TEST_DIR: dir, TEST_TIMEOUT_MS: "300", ...env },
      encoding: "utf8",
      timeout: 20000,
    });
    return {
      status: out.status,
      stdout: out.stdout,
      output: `${out.stdout}${out.stderr}`,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = {
  "duplicate case names are found at the top level only": () => {
    const source = [
      "module.exports = {",
      '  "same": () => {},',
      '  "other": async () => {},',
      '  "same": async () => {},',
      "  'quoted \\' name': function () {},",
      "  helper: () => ({",
      '    "same": () => {},',
      "  }),",
      "};",
    ].join("\n");
    assert.deepStrictEqual(duplicateCaseNames(source), ["same"]);
  },

  "a deadline rejects a promise that never settles": async () => {
    await assert.rejects(withDeadline(new Promise(() => {}), 20, "stuck"), /timed out after 20 ms: stuck/);
    assert.strictEqual(await withDeadline(Promise.resolve(7), 20, "fine"), 7);
  },

  "a stuck case fails by timeout and the run still completes": () => {
    const { status, output, stdout } = runOn({
      "a.test.js": `module.exports = {
  "hangs": () => new Promise(() => {}),
  "passes": () => {},
};`,
    });
    assert.strictEqual(status, 1, output);
    assert.match(output, /FAIL a\.test\.js :: hangs/);
    assert.match(output, /timed out after 300 ms/);
    assert.match(output, /ok {3}a\.test\.js :: passes/);
    assert.match(output, /1 passed, 1 failed/);
    assert.ok(stdout.trimEnd().endsWith(COMPLETED_MARKER), output);
  },

  "a mock left in place fails its case and is restored for the next": () => {
    const { status, output } = runOn({
      "a.test.js": `const fs = require("fs");
module.exports = {
  "leaks": () => { fs.promises.readFile = async () => "fake"; },
  "sees the real readFile": async () => {
    const text = await fs.promises.readFile(__filename, "utf8");
    if (!text.includes("sees the real readFile")) throw new Error("still mocked");
  },
};`,
    });
    assert.strictEqual(status, 1, output);
    assert.match(output, /FAIL a\.test\.js :: leaks/);
    assert.match(output, /left replaced after the case: fs\.promises\.readFile/);
    assert.match(output, /ok {3}a\.test\.js :: sees the real readFile/);
  },

  "a duplicate case name fails the run": () => {
    const { status, output } = runOn({
      "a.test.js": `module.exports = {
  "twice": () => {},
  "twice": () => {},
};`,
    });
    assert.strictEqual(status, 1, output);
    assert.match(output, /a\.test\.js :: twice[\s\S]*declared more than once/);
  },

  "a run that ends early reports itself incomplete": () => {
    const { status, output } = runOn({
      "a.test.js": `module.exports = { "exits": () => process.exit(0) };`,
    });
    assert.strictEqual(status, 1, output);
    assert.match(output, /TEST RUN INCOMPLETE/);
    assert.ok(!output.includes(COMPLETED_MARKER), output);
  },

  // Review F19: an inherited SERVER_STATE_DIR is the caller's, never the run's.
  "the state-file tests leave an inherited state directory untouched": () => {
    const r = runWithCallerStateDir({ args: ["^state-file\\.test\\.js$"] });
    assert.strictEqual(r.status, 0, r.output);
    assert.match(r.output, /ok {3}state-file\.test\.js :: overlapping saves/, r.output);
    assert.deepStrictEqual(r.callerAfter, r.callerBefore, "the caller's state directory changed");
    assert.deepStrictEqual(r.leftInTmp, [], "the run left its own state directory behind");
  },

  "a failing run leaves an inherited state directory untouched and removes its own": () => {
    const r = runWithCallerStateDir({
      files: {
        "a.test.js": `${WRITES_STATE}
module.exports = { "writes then fails": () => { write(); throw new Error("injected failure"); } };`,
      },
    });
    assert.strictEqual(r.status, 1, r.output);
    assert.match(r.output, /injected failure/, r.output);
    assert.match(r.output, /STATE DIR .*nn-test-state-/, r.output);
    assert.deepStrictEqual(r.callerAfter, r.callerBefore, "the caller's state directory changed");
    assert.deepStrictEqual(r.leftInTmp, [], "the run left its own state directory behind");
  },

  "a run that ends early still removes its own state directory": () => {
    const r = runWithCallerStateDir({
      files: {
        "a.test.js": `${WRITES_STATE}
module.exports = { "writes then exits": () => { write(); process.exit(0); } };`,
      },
    });
    assert.strictEqual(r.status, 1, r.output);
    assert.match(r.output, /TEST RUN INCOMPLETE/, r.output);
    assert.deepStrictEqual(r.callerAfter, r.callerBefore, "the caller's state directory changed");
    assert.deepStrictEqual(r.leftInTmp, [], "the run left its own state directory behind");
  },
};
