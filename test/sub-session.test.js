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
    // recorded (startArrivalHoldForLanding).
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
    // (bin/www holdPendingAtFrame) instead of releasing in the same tick as the
    // arrival — opening the rendezvous before the frame its device was only
    // just told to show has been held at all.
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

  "runtime: a sub-end is ARRIVED on arrival, whatever its holding says": async () => {
    const session = await buildSessionLinesFixture({ id: "__sub_end_pass__" });

    // The shape that breaks it, pinned: the sub-end is a marker no device ever
    // displays, so the fixture authors it `holding="false"` — the honest value,
    // and the one the guide tells authors to write. Barrier, the return
    // landing, waits on that very frame and carries a single paired rejoin-at.
    const echo = session.subFrames.Tetra.graph.byFrame["Echo.svg"];
    assert.strictEqual(echo.holding, "false");
    assert.strictEqual(session.subFrames.Tetra.graph.subEnd["Echo.svg"], "Tetra");
    assert.ok(
      session.graph.holdUntilTargets["Barrier.svg"].includes("Tetra/Echo.svg"),
      "Barrier must wait on the sub-end for this test to mean anything",
    );
    assert.deepStrictEqual(session.graph.rejoinTargets["Barrier.svg"], [
      "DONE.svg",
    ]);

    const line = new BMLine(session, "L1");
    session.lines.push(line);
    line.enterSub("Tetra", "Barrier.svg");
    line.setCurrIdxTo(session.subFrames.Tetra.frameList.indexOf("Echo.svg"));

    // `holding="false"` ⇒ the landing gate says no hold, so `isHolding` is
    // false here and cannot be what keeps the frame open. It used to be: the
    // ordinary advance set the flag on any non-zero session default, whatever
    // the frame said, and the sub-end rode along on that.
    line.isHolding = false;

    // recordArrival's rule. A sub-end is passing THROUGH — handleSubTransitions
    // pops the line two statements later — so it is "arrived" here and
    // completed by that departure, exactly like any other frame a line leaves.
    const isSubEnd = true; // bin/www isSubEndFrame(session, line)
    const passingThrough = line.isHolding || isSubEnd;
    const reg = {};
    markReached(reg, "Tetra/Echo.svg", !passingThrough);
    assert.strictEqual(reg["tetra/echo.svg"], "arrived");

    // …so Barrier's wait is still shut while the line stands on the sub-end.
    // Marked `done` here instead, it opens one frame short of where the release
    // expects to find the line — before the return landing has started its own
    // holding period — so the parked lines are freed by a rendezvous that has
    // not happened. That is the skipped target after a sub-score exit.
    markReached(reg, "Left.svg", true); // the wait's other target, met
    assert.deepStrictEqual(
      [
        ...registryCoveredTargets(
          reg,
          session.graph.holdUntilTargets["Barrier.svg"],
        ),
      ],
      ["Left.svg"],
      "the sub-end must NOT count as met while the line is still inside the sub",
    );

    // The departure completes it — and by then the line is standing on the
    // return landing with that frame's own hold running (exitSubSession:
    // clearLinePhase → startArrivalHoldForLanding → afterLineArrived).
    line.exitSub();
    line.setCurrIdxTo(
      subReturnIndex("Barrier.svg", session.listFilesInLowerCase),
    );
    assert.strictEqual(markReached(reg, "Tetra/Echo.svg", true), true);
    assert.deepStrictEqual(
      [
        ...registryCoveredTargets(
          reg,
          session.graph.holdUntilTargets["Barrier.svg"],
        ),
      ].sort(),
      ["Left.svg", "Tetra/Echo.svg"],
    );
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

  "runtime: a dive holds by the frame LANDED on, not the one the tap named": async () => {
    const session = await buildSessionLinesFixture({ id: "__sub_hold_src__" });
    const sub = session.subFrames.Tetra;

    // A tap carries the `holding` of the frame its LINK names, read off the
    // device's active frame list (voting.js getFrameHoldingDur). Neither end of
    // a dive lands on that frame:
    //   · diving, the link is Right.svg's session-sub-start <a> and its href is
    //     the RETURN landing, so the tap speaks for Barrier.svg while the line
    //     lands on the sub's START;
    //   · exiting, the link named the sub-end frame Echo.svg, so the tap speaks
    //     for Echo while the line lands — one hop later, popped back to the
    //     main flow — on Barrier.svg.
    // The fixture gives all three frames different values so a landing timed by
    // the wrong one is visible.
    assert.strictEqual(sub.graph.byFrame["START.svg"].holding, "7");
    assert.strictEqual(sub.graph.byFrame["Echo.svg"].holding, "false");
    assert.strictEqual(session.graph.byFrame["Barrier.svg"].holding, "19");

    // So both landings read their own frame's value off the graph instead
    // (bin/www landingHoldSeconds → startArrivalHoldForLanding): the SUB's
    // graph while dived, the main graph once popped.
    const holdingAttrForLine = (l) => {
      const top = l.subStack[l.subStack.length - 1];
      const info = top ? session.subFrames[top.score] : null;
      const graph = info ? info.graph : session.graph;
      const list = info ? info.frameList : session.listFiles;
      return (graph.byFrame[list[l.currentIndex]] || {}).holding || null;
    };

    const line = new BMLine(session, "L1");
    session.lines.push(line);
    line.setCurrIdxTo(session.listFilesInLowerCase.indexOf("right.svg"));

    line.enterSub("Tetra", "Barrier.svg");
    line.setCurrIdxTo(sub.frameList.indexOf("START.svg"));
    assert.strictEqual(
      holdingAttrForLine(line),
      "7",
      "the dive holds by the sub START, not by the return landing its link names",
    );

    line.setCurrIdxTo(sub.frameList.indexOf("Echo.svg"));
    line.exitSub();
    line.setCurrIdxTo(
      subReturnIndex("Barrier.svg", session.listFilesInLowerCase),
    );
    assert.strictEqual(
      holdingAttrForLine(line),
      "19",
      "the exit holds by the return landing, not by the sub-end frame it taps",
    );

    // The sub-end deliberately carries `holding="false"` — the one value that
    // starts no hold at all (parseCustomDur). A return landing that took the
    // tap's value would land phase-less and be registered done on the spot,
    // releasing the hold-until parked on Barrier.svg in the same tick as the
    // arrival: the eject's defect, reached by the score's own route.
  },
};
