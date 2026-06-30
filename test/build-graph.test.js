/**
 * Chunk D wiring test.
 *
 * Drives a session-lines fixture score through the REAL database.js build path
 * (buildSVGContent) and asserts the graph is populated + the session is flagged.
 * The fixture is created under public/data for the build, then torn down.
 *
 * The byte-identical guarantee for vanilla scores is covered by baseline.test.js.
 */

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { buildScore } = require("../bin/build-score.js");
const { DATA_DIR, SERVER_STATE_DIR } = require("../database.js");

const FIXTURE_FOLDER = "__session_lines_fixture__";
const FIXTURE_ID = "__sl_fixture__";

function frameSvg(attrs = {}, hrefs = []) {
  const attrStr = Object.entries(attrs)
    .map(([k, v]) => `${k}="${v}"`)
    .join(" ");
  const aTags = hrefs
    .map((h) => `<a xlink:href="${h}"><rect x="0" y="0" width="10" height="10"/></a>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="100%" height="100%" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ${attrStr}>
${aTags}
</svg>`;
}

function writeFixture() {
  const dir = path.join(DATA_DIR, FIXTURE_FOLDER);
  fs.mkdirSync(dir, { recursive: true });
  const frames = {
    "START.svg": frameSvg({ "session-split": "2" }, ["B.svg", "C.svg"]),
    "B.svg": frameSvg({ "session-track-group": "g" }, ["D.svg"]),
    "C.svg": frameSvg({ "session-track-group": "g" }, ["D.svg"]),
    "D.svg": frameSvg({ "session-hold-until": "B.svg,C.svg", "session-rejoin-at": "DONE.svg" }, ["DONE.svg"]),
    "DONE.svg": frameSvg({}, []),
  };
  for (const [name, svg] of Object.entries(frames)) {
    fs.writeFileSync(path.join(dir, name), svg);
  }
  return dir;
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {}
  for (const ext of [".content.svg", ".html", ".about.svg"]) {
    try {
      fs.rmSync(path.join(SERVER_STATE_DIR, `${FIXTURE_ID}${ext}`), { force: true });
    } catch (_) {}
  }
}

module.exports = {
  "session-lines fixture populates session.graph through the real build": async () => {
    const dir = writeFixture();
    try {
      const session = await buildScore(FIXTURE_FOLDER, { id: FIXTURE_ID });

      assert.strictEqual(session.hasSessionLines, true, "hasSessionLines should be set");
      assert.ok(session.graph, "session.graph should be populated");
      assert.strictEqual(session.graph.splits["START.svg"].n, 2);
      assert.deepStrictEqual(session.graph.splits["START.svg"].hrefs, ["B.svg", "C.svg"]);
      assert.deepStrictEqual(session.graph.groups["g"], ["B.svg", "C.svg"]);
      assert.deepStrictEqual(session.graph.holdUntilTargets["D.svg"], ["B.svg", "C.svg"]);
      assert.deepStrictEqual(session.graph.rejoinTargets["D.svg"], ["DONE.svg"]);
    } finally {
      cleanup(dir);
    }
  },
};
