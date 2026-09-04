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
const { buildSessionLinesFixture } = require("./session-lines-fixture");
const { SERVER_STATE_DIR } = require("../database.js");
const { BMLine } = require("../lib/session-lines/line");
const {
  subReturnIndex,
  markReached,
  registryCoveredTargets,
} = require("../lib/session-lines/orchestrator");

module.exports = {
  "build: demo produces a Tetra sub-frame cache (memory + .subs.json)": async () => {
    const session = await buildSessionLinesFixture({ id: "__sub_test__" });

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
    const session = await buildSessionLinesFixture({ id: "__sub_rt__" });
    const idx = (n) => session.listFilesInLowerCase.indexOf(n.toLowerCase());

    // Right.svg carries the sub-start <a> link; its href is the return landing.
    assert.deepStrictEqual(session.graph.subLinks["Right.svg"], [
      { score: "Tetra", returnHref: "Barrier.svg" },
    ]);

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

  "runtime: an operator eject pops a line out mid-dive onto the return landing": async () => {
    const session = await buildSessionLinesFixture({ id: "__sub_eject_rt__" });
    const idx = (n) => session.listFilesInLowerCase.indexOf(n.toLowerCase());

    const line = new BMLine(session, "L1");
    line.setCurrIdxTo(idx("Right.svg"));
    session.lines.push(line);
    const preDive = line.history.slice(0, line.historyIndex + 1);

    // Dive, and stop SHORT of the sub-end: nothing inside the sub will pop this
    // line back out on its own, which is the stall the eject exists for.
    const sub = session.subFrames.Tetra;
    line.enterSub("Tetra", "Barrier.svg");
    line.setCurrIdxTo(sub.frameList.indexOf("START.svg"));
    assert.ok(
      !sub.graph.subEnd["START.svg"],
      "the line must be parked short of the sub-end",
    );
    assert.strictEqual(line.activeFrameList(), sub.frameList);

    // The eject, as bin/www's ejectLineFromSub performs it: resolve the
    // OUTERMOST dive's return landing against the live frame list, pop the
    // stack, land there.
    const returnIdx = subReturnIndex(
      line.subStack[0].returnHref,
      session.listFilesInLowerCase,
    );
    assert.ok(returnIdx >= 0, "the dive's return landing must still exist");
    line.exitSub();
    line.setCurrIdxTo(returnIdx);

    assert.strictEqual(line.subStack.length, 0);
    assert.strictEqual(line.currentIndex, idx("Barrier.svg"));
    assert.strictEqual(line.activeFrameList(), session.listFiles);
    // The main-flow trail comes back with it, pre-dive frames included — which
    // is what lets the map offer this line a rewind to before it ever dived,
    // so "eject, then rewind" replaces the rewind-out-of-a-sub nobody has.
    assert.deepStrictEqual(
      line.history.slice(0, line.historyIndex + 1),
      preDive.concat(["Barrier.svg"]),
    );

    // Guard: a dive whose return landing is no longer in the score resolves to
    // nothing, and the eject is refused rather than dropping the line nowhere
    // (the map's node menu prints the reason in place of the button).
    line.enterSub("Tetra", "Removed.svg");
    assert.strictEqual(
      subReturnIndex(line.subStack[0].returnHref, session.listFilesInLowerCase),
      -1,
    );
  },

  "runtime: an ejected line lands HOLDING, so its arrival is not done yet": async () => {
    const session = await buildSessionLinesFixture({ id: "__sub_eject_hold__" });
    const idx = (n) => session.listFilesInLowerCase.indexOf(n.toLowerCase());

    const line = new BMLine(session, "L1");
    line.setCurrIdxTo(idx("Right.svg"));
    session.lines.push(line);
    line.enterSub("Tetra", "Barrier.svg");
    line.setCurrIdxTo(session.subFrames.Tetra.frameList.indexOf("START.svg"));

    // The eject as bin/www performs it: leave the sub, land on the dive's own
    // return frame, and start THAT frame's holding period before the arrival is
    // recorded (startArrivalHoldForOperatorLanding).
    line.exitSub();
    line.setCurrIdxTo(
      subReturnIndex("Barrier.svg", session.listFilesInLowerCase),
    );
    const landing = session.listFiles[line.currentIndex];

    // Where the duration comes from: no tap carried `nextFrameHoldingDur` into
    // an operator move, so the runtime reads the frame's own `holding` value
    // off the graph. The key must exist for every frame (null ⇒ take the
    // session default) or the landing silently stops holding.
    assert.ok(
      Object.hasOwn(session.graph.byFrame[landing], "holding"),
      "the graph must carry each frame's holding attribute for operator landings",
    );

    line.isHolding = true; // the landing's holding period is now running

    // recordArrival's rule: a landing whose hold is still running is "arrived",
    // never "done". That is what keeps a barrier AT the landing closed
    // (bin/www holdPendingAtFrame) instead of releasing in the same tick and —
    // Barrier.svg carries a single paired rejoin-at — advancing the line
    // straight off the frame its device was only just told to show.
    const reg = {};
    markReached(reg, landing, !line.isHolding);
    assert.strictEqual(reg[landing.toLowerCase()], "arrived");
    assert.deepStrictEqual([...registryCoveredTargets(reg, [landing])], []);

    // …and the hold ending is the edge that completes it (recordHoldEnded).
    line.isHolding = false;
    assert.strictEqual(markReached(reg, landing, true), true);
    assert.strictEqual(reg[landing.toLowerCase()], "done");
    assert.deepStrictEqual([...registryCoveredTargets(reg, [landing])], [
      landing,
    ]);
  },

  "runtime: a rollback puts a line back on the frame it dived from": async () => {
    const session = await buildSessionLinesFixture({ id: "__sub_rollback__" });
    const idx = (n) => session.listFilesInLowerCase.indexOf(n.toLowerCase());

    const line = new BMLine(session, "L1");
    line.setCurrIdxTo(idx("START.svg"));
    line.setCurrIdxTo(idx("Right.svg")); // the frame carrying the sub-start link
    session.lines.push(line);
    const preDive = line.history.slice(0, line.historyIndex + 1);

    const sub = session.subFrames.Tetra;
    line.enterSub("Tetra", "Barrier.svg");
    line.setCurrIdxTo(
      sub.frameList.findIndex((f) => f.toUpperCase().startsWith("START")),
    );

    // The rollback's destination needs no rule to choose it: savedHistories[0]
    // is the main trail exactly as it stood at the dive, so its current entry
    // is the frame the line left (bin/www subOriginFrameForLine).
    const saved = line.savedHistories[0];
    const origin = saved.history[saved.historyIndex];
    assert.strictEqual(origin, "Right.svg");

    line.exitSub();
    line.setCurrIdxTo(idx(origin));

    assert.strictEqual(line.subStack.length, 0);
    assert.strictEqual(line.currentIndex, idx("Right.svg"));
    assert.strictEqual(line.activeFrameList(), session.listFiles);
    // Landing on the trail's OWN current entry: setCurrIdxTo's trailing-dup
    // guard leaves the trail exactly as the dive found it — no "(visit 2)".
    assert.deepStrictEqual(
      line.history.slice(0, line.historyIndex + 1),
      preDive,
    );
    // And the line sits un-dived on a sub-start frame: dives are navigation-
    // triggered, so it can take the sub again — or take another link.
    assert.ok(session.graph.subLinks["Right.svg"].length > 0);
  },

  "runtime: a rollback can pick any frame the line already visited": async () => {
    const session = await buildSessionLinesFixture({ id: "__sub_rollback_any__" });
    const idx = (n) => session.listFilesInLowerCase.indexOf(n.toLowerCase());

    const line = new BMLine(session, "L1");
    line.setCurrIdxTo(idx("START.svg"));
    line.setCurrIdxTo(idx("Right.svg"));
    session.lines.push(line);

    const sub = session.subFrames.Tetra;
    line.enterSub("Tetra", "Barrier.svg");
    line.setCurrIdxTo(
      sub.frameList.findIndex((f) => f.toUpperCase().startsWith("START")),
    );

    // The whole main trail is a menu of destinations, not just its last entry:
    // the saved history is what bin/www's mainHistoryStateForLine reads, and
    // `selectedIdx` picks an entry of it.
    const saved = line.savedHistories[0];
    assert.deepStrictEqual(saved.history, ["START.svg", "Right.svg"]);
    const selectedIdx = 0; // back past the fork, to START

    line.exitSub();
    line.historyIndex = selectedIdx;
    line.setCurrIdxTo(idx(saved.history[selectedIdx]));

    assert.strictEqual(line.subStack.length, 0);
    assert.strictEqual(line.currentIndex, idx("START.svg"));
    assert.strictEqual(line.activeFrameList(), session.listFiles);
    // A rewind drops what came after it, exactly as lineRewind does on the main
    // flow: the fork it dived from is no longer in the trail.
    assert.deepStrictEqual(
      line.history.slice(0, line.historyIndex + 1),
      ["START.svg"],
    );
    assert.ok(!line.history.includes("Right.svg"));
  },
};
