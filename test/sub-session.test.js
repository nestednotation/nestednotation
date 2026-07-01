/**
 * Chunk K — sub-session build + runtime (real BMSession + BMLine, no ws boot).
 *
 *  - build: the demo produces an in-memory + on-disk sub-frame cache for Tetra
 *    (rewritten ids, frame/sound lists, per-sub graph); a vanilla score produces
 *    NONE (and removes any stale file).
 *  - runtime: a line dives into Tetra (cursor follows the sub frame list via
 *    activeFrameList), reaches the sub-end, and pops back to the main return
 *    landing (Barrier.svg) — all on the real BMLine.
 */

const assert = require("node:assert");
const fs = require("node:fs");

const { buildScore } = require("../bin/build-score.js");
const { SERVER_STATE_DIR } = require("../database.js");
const { BMLine } = require("../lib/session-lines/line");
const { subReturnIndex } = require("../lib/session-lines/orchestrator");

module.exports = {
  "build: demo produces a Tetra sub-frame cache (memory + .subs.json)": async () => {
    const session = await buildScore("Session Lines Demo", { id: "__sub_test__" });

    const tetra = session.subFrames && session.subFrames.Tetra;
    assert.ok(tetra, "session.subFrames.Tetra must exist");
    assert.ok(tetra.frameList.includes("START.svg"));
    assert.ok(tetra.frameList.includes("Echo.svg"));
    assert.ok(
      tetra.framesHtml.includes('id="sub-Tetra-'),
      "sub frames are rewritten with sub-<name>-<idx> ids",
    );
    // The per-sub graph carries the sub-end mapping the runtime reads.
    assert.strictEqual(tetra.graph.subEnd["Echo.svg"], "Tetra");

    // The on-disk file mirrors the served payload.
    const subsPath = `${SERVER_STATE_DIR}/__sub_test__.subs.json`;
    assert.ok(fs.existsSync(subsPath), "__sub_test__.subs.json must be written");
    const payload = JSON.parse(fs.readFileSync(subsPath, "utf8"));
    assert.ok(payload.Tetra);
    assert.deepStrictEqual(payload.Tetra.frameList, tetra.frameList);
  },

  "build: a vanilla score produces NO .subs.json": async () => {
    const session = await buildScore("-u- Hello", { id: "__sub_vanilla__" });
    assert.ok(!session.hasSessionLines);
    assert.deepStrictEqual(session.subFrames, {});
    assert.ok(
      !fs.existsSync(`${SERVER_STATE_DIR}/__sub_vanilla__.subs.json`),
      "vanilla score must not write a subs file",
    );
  },

  "runtime: a line dives into Tetra and pops back to the return landing": async () => {
    const session = await buildScore("Session Lines Demo", { id: "__sub_rt__" });
    const idx = (n) => session.listFilesInLowerCase.indexOf(n.toLowerCase());

    // Right.svg is the sub-start; its return landing is Barrier.svg.
    assert.deepStrictEqual(session.graph.subStart["Right.svg"], {
      score: "Tetra",
      returnHref: "Barrier.svg",
    });

    const line = new BMLine(session, "L1");
    line.setCurrIdxTo(idx("Right.svg"));
    session.lines.push(line);

    // Dive: push the sub, seed at the sub START.
    const sub = session.subFrames.Tetra;
    line.enterSub("Tetra", "Barrier.svg");
    const subStart = sub.frameList.findIndex((f) =>
      f.toUpperCase().startsWith("START"),
    );
    line.setCurrIdxTo(subStart);

    assert.strictEqual(line.subStack.length, 1);
    assert.strictEqual(line.activeFrameList(), sub.frameList);
    assert.strictEqual(line.history[line.history.length - 1], "START.svg");

    // Traverse to the sub-end frame (Echo.svg).
    const echoIdx = sub.frameList.indexOf("Echo.svg");
    line.setCurrIdxTo(echoIdx);
    assert.strictEqual(line.history[line.history.length - 1], "Echo.svg");
    assert.strictEqual(sub.graph.subEnd["Echo.svg"], "Tetra");

    // Pop: return to the main landing (Barrier.svg).
    const popped = line.exitSub();
    assert.deepStrictEqual(popped, { score: "Tetra", returnHref: "Barrier.svg" });
    const returnIdx = subReturnIndex("Barrier.svg", session.listFilesInLowerCase);
    line.setCurrIdxTo(returnIdx);

    assert.strictEqual(line.subStack.length, 0);
    assert.strictEqual(line.currentIndex, idx("Barrier.svg"));
    assert.strictEqual(line.activeFrameList(), session.listFiles);
    assert.strictEqual(line.history[line.history.length - 1], "Barrier.svg");
  },
};
