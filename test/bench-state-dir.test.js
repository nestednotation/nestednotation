/**
 * The map-payload benchmark owns its state directory (review F18, T4/T6).
 *
 * It must never remove a caller's SERVER_STATE_DIR, which may be a real
 * server's session snapshots and baked scores, and must remove the directory
 * it created itself, on success and when a measurement fails.
 *
 * Runs test/bench/map-payload.bench.js as a child process with the temporary
 * directory redirected to a scratch parent, so whatever the benchmark creates
 * there can be checked afterwards.
 */

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const BENCH = path.join(__dirname, "bench", "map-payload.bench.js");
const HARNESS = path.join(__dirname, "www-harness.js");

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

function runBench({ failMeasurement }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nn-bench-owner-"));
  try {
    const callerDir = path.join(root, "caller-state");
    fs.mkdirSync(path.join(callerDir, "baked"), { recursive: true });
    fs.writeFileSync(path.join(callerDir, "1726700000000.json"), '{"id":"live room"}');
    fs.writeFileSync(path.join(callerDir, "baked", "content.r3.json"), "baked score");
    const before = contentsOf(callerDir);

    const tmp = path.join(root, "tmp");
    fs.mkdirSync(tmp);
    const args = [];
    if (failMeasurement) {
      // Fails after buildScore has written into the state directory.
      const preload = path.join(root, "fail-measurement.js");
      fs.writeFileSync(
        preload,
        `require(${JSON.stringify(HARNESS)}).loadWww = () => {
  throw new Error("injected measurement failure");
};\n`,
      );
      args.push("-r", preload);
    }
    const out = spawnSync(
      process.execPath,
      [...args, BENCH, "1", "--devices", "1", "--trail", "1"],
      {
        env: { ...process.env, SERVER_STATE_DIR: callerDir, TMPDIR: tmp, TEMP: tmp, TMP: tmp },
        encoding: "utf8",
        timeout: 20000,
      },
    );
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

module.exports = {
  "a benchmark run leaves the caller's state directory untouched and removes its own": () => {
    const r = runBench({ failMeasurement: false });
    assert.strictEqual(r.status, 0, r.output);
    assert.match(r.output, /mapPushBytes/, r.output);
    assert.deepStrictEqual(r.callerAfter, r.callerBefore, "the caller's state directory changed");
    assert.deepStrictEqual(r.leftInTmp, [], "the benchmark left its own directories behind");
  },

  "a failed measurement leaves the caller's state directory untouched and removes the benchmark's": () => {
    const r = runBench({ failMeasurement: true });
    assert.strictEqual(r.status, 1, r.output);
    assert.match(r.output, /injected measurement failure/, r.output);
    assert.deepStrictEqual(r.callerAfter, r.callerBefore, "the caller's state directory changed");
    assert.deepStrictEqual(r.leftInTmp, [], "the benchmark left its own directories behind");
  },
};
