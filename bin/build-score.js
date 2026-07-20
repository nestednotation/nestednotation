#!/usr/bin/env node

/**
 * Offline score build tool.
 *
 * Constructs a BMSession, runs buildSVGContent, and prints the output paths —
 * letting us build/inspect a score's `.content.svg` + `.html` without booting
 * the websocket server. Used by the test harness (baseline guard) and for
 * manual inspection of session-lines graph building.
 *
 * Usage: node bin/build-score.js <folder> [id]
 */

const { BMSession, SERVER_STATE_DIR } = require("../database.js");

// Deterministic defaults so repeated builds of the same score are byte-stable.
const DEFAULTS = {
  id: "__build_score__",
  adminId: "0",
  sessionName: "__build_score__",
  adminPassword: "admin",
  playerPassword: "player",
  isHtml5: false,
  fadeDuration: 1000,
  defaultVolume: 80,
  defaultAutoplay: true,
  enableAutoplayByDefault: false,
  dataDir: null,
};

async function buildScore(folder, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const session = new BMSession();
  if (o.dataDir) {
    session.scoreDataDir = o.dataDir;
  }
  await session.initState(
    o.id,
    o.adminId,
    folder,
    o.sessionName,
    o.adminPassword,
    o.playerPassword,
    o.isHtml5,
    o.fadeDuration,
    o.defaultVolume,
    o.defaultAutoplay,
    o.enableAutoplayByDefault,
  );
  return session;
}

module.exports = { buildScore, DEFAULTS, SERVER_STATE_DIR };

if (require.main === module) {
  const folder = process.argv[2];
  if (!folder) {
    console.error("Usage: node bin/build-score.js <folder> [id]");
    process.exit(1);
  }
  const id = process.argv[3];
  buildScore(folder, id ? { id } : {})
    .then((session) => {
      console.log(`\nBuilt score "${folder}" (id=${session.id})`);
      console.log(`  ${SERVER_STATE_DIR}/${session.id}.content.svg`);
      console.log(`  ${SERVER_STATE_DIR}/${session.id}.html`);
      if (session.hasSessionLines) {
        console.log(`  hasSessionLines=true`);
      }
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
