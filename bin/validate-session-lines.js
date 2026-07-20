#!/usr/bin/env node

/**
 * Session Lines validator CLI.
 *
 * Builds the relationship graph for a score on disk and runs validateScore,
 * printing errors/warnings. Exit code is non-zero when there are errors — so it
 * can gate an upload/lint step. Read-only; does not touch session state.
 *
 * Usage: node bin/validate-session-lines.js <score-folder>
 */

const fs = require("fs");
const path = require("path");

const { DATA_DIR } = require("../database.js");
const { parseFrameAttrs } = require("../lib/session-lines/parse");
const { buildGraph } = require("../lib/session-lines/graph");
const { validateScore } = require("../lib/session-lines/validate");

function resolveFramesDir(scoreDir) {
  const entries = fs.readdirSync(scoreDir);
  if (entries.includes("Sounds") && entries.includes("Frames")) {
    return path.join(scoreDir, "Frames");
  }
  return scoreDir;
}

function loadFrames(framesDir) {
  return fs
    .readdirSync(framesDir)
    .filter((f) => f.toLowerCase().endsWith(".svg"))
    .map((name) => {
      const svg = fs.readFileSync(path.join(framesDir, name), "utf8");
      return { name, svg, attrs: parseFrameAttrs(svg) };
    });
}

function makeSubLoader(scoreDir) {
  const subsDir = path.join(scoreDir, "Subscores");
  return (subName) => {
    const subDir = path.join(subsDir, subName);
    if (!fs.existsSync(subDir)) {
      return null;
    }
    const frames = loadFrames(resolveFramesDir(subDir));
    return {
      frameNames: frames.map((f) => f.name),
      graph: buildGraph(frames),
    };
  };
}

function main() {
  const folder = process.argv[2];
  if (!folder) {
    console.error("Missing score name (folder), please specify one.");
    process.exit(2);
  }

  const scoreDir = path.join(DATA_DIR, folder);
  if (!fs.existsSync(scoreDir)) {
    console.error(`Score folder not found: ${scoreDir}`);
    process.exit(2);
  }

  const frames = loadFrames(resolveFramesDir(scoreDir));
  const graph = buildGraph(frames);
  const { errors, warnings } = validateScore(
    graph,
    frames.map((f) => f.name),
    makeSubLoader(scoreDir),
  );

  console.log(`\nValidating "${folder}" (${frames.length} frames)`);
  if (!graph.hasSessionLines) {
    console.log("  No session-* markup found — vanilla score.");
  }

  for (const w of warnings) {
    console.log(`  WARN  [${w.code}] ${w.message}`);
  }
  for (const e of errors) {
    console.log(`  ERROR [${e.code}] ${e.message}`);
  }

  console.log(`\n${errors.length} error(s), ${warnings.length} warning(s)`);
  process.exit(errors.length > 0 ? 1 : 0);
}

main();
