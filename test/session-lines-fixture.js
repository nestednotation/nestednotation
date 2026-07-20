const path = require("node:path");

const { buildScore } = require("../bin/build-score.js");

const FIXTURES_DIR = path.join(__dirname, "fixtures");

function buildSessionLinesFixture(opts = {}) {
  return buildScore("session-lines-demo", {
    ...opts,
    dataDir: FIXTURES_DIR,
  });
}

module.exports = { buildSessionLinesFixture };
