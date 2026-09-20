#!/usr/bin/env node

/**
 * Dependency-free test runner.
 *
 * Discovers every `test/*.test.js`, runs the tests it exports, and exits
 * non-zero if any fail. A test file may export:
 *   - a single async/sync function: `module.exports = async () => { ... }`
 *   - an object of named tests:     `module.exports = { "name": fn, ... }`
 *
 * Tests use `node:assert`. No external framework (jest/mocha/etc.).
 *
 * Guarantees a run either finishes or says it did not:
 *   - every case has a deadline (TEST_TIMEOUT_MS, default 30 s). The deadline
 *     timer is a live handle, so a case awaiting a promise nothing will settle
 *     fails by timeout instead of letting the process drain and exit early.
 *   - the last line of a finished run is COMPLETED_MARKER; a process that exits
 *     without printing it reports the run as incomplete and exits non-zero.
 *   - a case that leaves a global or fs function replaced (a mock not restored
 *     on its failure path) fails, and the original is put back so the cases
 *     after it run against the real thing.
 *   - two cases with the same name in one file fail the run: an object literal
 *     keeps only the last, so the first would silently never run.
 *   - tests never write into the real server_state or public/data, nor into a
 *     SERVER_STATE_DIR the caller already set: session state and baked score
 *     files always go to a per-run temporary directory the runner creates and
 *     removes afterwards, and a run that adds or removes anything in one of
 *     those real directories fails.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO_DIR = path.resolve(__dirname, "..");

// Directories the suite must leave as it found them. Session ids a live
// server mints are Date.now() strings; a server running alongside the suite
// may add those to server_state, so they are not the suite's doing.
// An inherited SERVER_STATE_DIR is guarded the same way: it is the caller's,
// possibly a running server's, and the run never writes there.
const LIVE_SESSION_FILE = /^\d{10,}\./;
const GUARDED_DIRS = [
  { dir: path.join(REPO_DIR, "server_state"), ignore: LIVE_SESSION_FILE },
  { dir: path.join(REPO_DIR, "public", "data"), ignore: null },
];
const callerStateDir = process.env.SERVER_STATE_DIR || null;
if (
  callerStateDir &&
  !GUARDED_DIRS.some((g) => path.resolve(g.dir) === path.resolve(callerStateDir))
) {
  GUARDED_DIRS.push({ dir: path.resolve(callerStateDir), ignore: LIVE_SESSION_FILE });
}

function listing(dir) {
  try {
    return new Set(fs.readdirSync(dir));
  } catch (e) {
    return new Set();
  }
}

function snapshotGuardedDirs() {
  return GUARDED_DIRS.map((g) => ({ ...g, before: listing(g.dir) }));
}

function guardedDirChanges(snapshots) {
  const changes = [];
  for (const { dir, ignore, before } of snapshots) {
    const after = listing(dir);
    const added = [...after].filter(
      (n) => !before.has(n) && !(ignore && ignore.test(n)),
    );
    const removed = [...before].filter(
      (n) => !after.has(n) && !(ignore && ignore.test(n)),
    );
    if (added.length || removed.length) {
      changes.push(
        `${path.relative(REPO_DIR, dir)}: ` +
          [
            added.length ? `added ${added.join(", ")}` : "",
            removed.length ? `removed ${removed.join(", ")}` : "",
          ]
            .filter(Boolean)
            .join("; "),
      );
    }
  }
  return changes;
}

// Session state and build output for this run. Always a directory the run
// creates and owns, even when the caller set SERVER_STATE_DIR: tests save
// snapshots under fixed ids and remove them afterwards, so sharing a caller's
// directory would overwrite and delete its files. Set before any test file
// loads database.js, which reads it once. The temporary parent follows
// TMPDIR / TEMP / TMP.
let tempStateDir = null;
function isolateStateDir() {
  tempStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nn-test-state-"));
  process.env.SERVER_STATE_DIR = tempStateDir;
}

// Removes only the directory isolateStateDir created, and hands the caller's
// setting back.
function removeTempStateDir() {
  if (!tempStateDir) return;
  fs.rmSync(tempStateDir, { recursive: true, force: true });
  tempStateDir = null;
  if (callerStateDir) process.env.SERVER_STATE_DIR = callerStateDir;
  else delete process.env.SERVER_STATE_DIR;
}

const COMPLETED_MARKER = "TEST RUN COMPLETE";
const DEFAULT_TIMEOUT_MS = 30000;

// Globals and fs functions tests replace. Captured once, before any test
// file loads, and compared after every case.
function patchableSurface() {
  const surface = [];
  for (const name of [
    "Date",
    "setTimeout",
    "clearTimeout",
    "setInterval",
    "clearInterval",
    "setImmediate",
    "clearImmediate",
    "fetch",
  ]) {
    surface.push([globalThis, name, `global ${name}`]);
  }
  for (const name of Object.keys(fs)) {
    if (typeof fs[name] === "function") surface.push([fs, name, `fs.${name}`]);
  }
  for (const name of Object.keys(fs.promises)) {
    if (typeof fs.promises[name] === "function") {
      surface.push([fs.promises, name, `fs.promises.${name}`]);
    }
  }
  return surface.map(([owner, name, label]) => ({
    owner,
    name,
    label,
    original: owner[name],
  }));
}

function restoreLeaks(surface) {
  const leaked = [];
  for (const entry of surface) {
    if (entry.owner[entry.name] !== entry.original) {
      leaked.push(entry.label);
      entry.owner[entry.name] = entry.original;
    }
  }
  return leaked;
}

/**
 * Test names declared more than once in a file's exported object. A
 * source-level check, because by the time the module is loaded the duplicate
 * has already replaced the original.
 */
function duplicateCaseNames(source) {
  const seen = new Map();
  // Template literals are blanked first: a test's fixture source can itself
  // contain case-shaped lines.
  const code = source.replace(/`(?:\\[\s\S]|[^`\\])*`/g, "``");
  const pattern = /^ {2}(["'])((?:\\.|(?!\1).)*)\1\s*:\s*(?:async\s+)?(?:\(|function\b)/gm;
  let m;
  while ((m = pattern.exec(code)) !== null) {
    seen.set(m[2], (seen.get(m[2]) || 0) + 1);
  }
  return [...seen].filter(([, n]) => n > 1).map(([name]) => name);
}

function withDeadline(promise, ms, label) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out after ${ms} ms: ${label}`)),
      ms,
    );
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

async function main() {
  // TEST_DIR lets the runner's own tests point it at a scratch directory.
  const testDir = process.env.TEST_DIR || __dirname;
  const timeoutMs = Number(process.env.TEST_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const only = process.argv[2] ? new RegExp(process.argv[2]) : null;
  const files = fs
    .readdirSync(testDir)
    .filter((f) => f.endsWith(".test.js"))
    .filter((f) => !only || only.test(f))
    .sort();

  const surface = patchableSurface();
  isolateStateDir();
  const guarded = snapshotGuardedDirs();

  let passed = 0;
  let failed = 0;
  const failures = [];
  const fail = (label, err) => {
    failed++;
    failures.push({ label, err });
    console.error(`  FAIL ${label}`);
  };

  for (const file of files) {
    const filePath = path.join(testDir, file);
    for (const name of duplicateCaseNames(fs.readFileSync(filePath, "utf8"))) {
      fail(
        `${file} :: ${name}`,
        new Error("declared more than once; only the last declaration runs"),
      );
    }

    let mod;
    try {
      mod = require(filePath);
    } catch (err) {
      fail(`${file} (load)`, err);
      continue;
    }
    const cases =
      typeof mod === "function"
        ? [[file.replace(/\.test\.js$/, ""), mod]]
        : Object.entries(mod).filter(([, fn]) => typeof fn === "function");

    for (const [name, fn] of cases) {
      const label = `${file} :: ${name}`;
      let error = null;
      try {
        await withDeadline(Promise.resolve().then(fn), timeoutMs, label);
      } catch (err) {
        error = err;
      }
      const leaked = restoreLeaks(surface);
      if (!error && leaked.length > 0) {
        error = new Error(`left replaced after the case: ${leaked.join(", ")}`);
      }
      if (error) {
        fail(label, error);
      } else {
        passed++;
        console.log(`  ok   ${label}`);
      }
    }
  }

  const changes = guardedDirChanges(guarded);
  if (changes.length > 0) {
    fail(
      "real directories untouched",
      new Error(`the run changed real application data: ${changes.join(" | ")}`),
    );
  }
  removeTempStateDir();

  if (failures.length > 0) {
    console.error("\n--- Failures ---");
    for (const { label, err } of failures) {
      console.error(`\n${label}`);
      console.error(err && err.stack ? err.stack : err);
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  finished = true;
  console.log(COMPLETED_MARKER);
  process.exit(failed > 0 ? 1 : 0);
}

// Exported before main() runs: main requires the test files synchronously,
// and the runner's own test file imports these.
module.exports = { duplicateCaseNames, withDeadline, COMPLETED_MARKER };

let finished = false;

if (require.main === module) {
  process.on("exit", (code) => {
    removeTempStateDir();
    if (!finished) {
      console.error(
        "\nTEST RUN INCOMPLETE: the process exited before every case finished" +
          " (a case awaited something that can never settle).",
      );
      process.exitCode = code || 1;
    }
  });
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

