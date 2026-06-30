/**
 * Baseline guard.
 *
 * Rebuilds the vanilla score "-u- Hello" (no session-* markup) and proves the
 * generated `.content.svg` and `.html` match the snapshots in test/baseline/.
 * This is the no-regression net for every build/state change in the Session
 * Lines work: a vanilla score must always build exactly as it did before.
 *
 *   - `.content.svg` is compared BYTE-FOR-BYTE (it has no env-dependent bytes).
 *   - `.html` is compared byte-for-byte EXCEPT for the injected `wsPath`, which
 *     is deploy/env config (SERVER_IP, or a hardcoded dev IP in database.js) and
 *     orthogonal to session-lines output. It is normalized away so the guard
 *     stays portable across machines/CI instead of breaking on an IP change.
 *
 * If this fails after an intentional output change, re-capture with:
 *   node bin/build-score.js "-u- Hello" __baseline__
 *   cp server_state/__baseline__.content.svg test/baseline/
 *   cp server_state/__baseline__.html       test/baseline/
 */

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { buildScore } = require("../bin/build-score.js");

const BASELINE_ID = "__baseline__";
const BASELINE_FOLDER = "-u- Hello";
const baselineDir = path.join(__dirname, "baseline");

// Replace any ws://… / wss://… URL (the deploy-dependent wsPath) with a stable
// token so it cannot cause spurious diffs.
const stripWsPath = (s) => s.replace(/wss?:\/\/[^"'\s\\]+/g, "__WS_PATH__");

function assertMatchesBaseline(label, actualPath, expectedPath, normalize) {
  assert.ok(
    fs.existsSync(actualPath),
    `${label}: build did not produce ${actualPath}`,
  );
  assert.ok(
    fs.existsSync(expectedPath),
    `${label}: missing baseline snapshot ${expectedPath} (re-capture it)`,
  );
  const actual = fs.readFileSync(actualPath);
  const expected = fs.readFileSync(expectedPath);

  if (normalize) {
    assert.strictEqual(
      normalize(actual.toString("utf8")),
      normalize(expected.toString("utf8")),
      `${label}: output differs from baseline (after normalizing wsPath)`,
    );
  } else {
    assert.ok(
      actual.equals(expected),
      `${label}: output differs from baseline (${actual.length} vs ${expected.length} bytes)`,
    );
  }
}

module.exports = {
  "vanilla score builds byte-identical to baseline": async () => {
    const session = await buildScore(BASELINE_FOLDER, { id: BASELINE_ID });
    const { SERVER_STATE_DIR } = require("../database.js");

    // content.svg: strict byte-for-byte (no env-dependent content).
    assertMatchesBaseline(
      "content.svg",
      `${SERVER_STATE_DIR}/${BASELINE_ID}.content.svg`,
      path.join(baselineDir, `${BASELINE_ID}.content.svg`),
    );
    // html: byte-for-byte except the deploy-dependent wsPath.
    assertMatchesBaseline(
      "html",
      `${SERVER_STATE_DIR}/${BASELINE_ID}.html`,
      path.join(baselineDir, `${BASELINE_ID}.html`),
      stripWsPath,
    );

    // Vanilla score must NOT be flagged as having session lines.
    assert.ok(
      !session.hasSessionLines,
      "vanilla score should not set hasSessionLines",
    );
  },
};
