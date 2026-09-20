/**
 * The review's M1/M3/M4/M6 regressions, through the PRODUCTION handlers.
 *
 * Every test here sends real protocol messages into `bin/www`'s own
 * `messageHandle` (see www-harness.js) over real BMSession/BMLine state built
 * from fixture scores, lets the server's own timers run on a virtual clock, and
 * asserts on what the server did and what it sent. The component checks in
 * tap-authorization / split-vote-scope / display-protocol stay; these are the
 * ones that fail when a handler stops CALLING the right piece — drop the
 * authorization call from MSG_TAP, put the session-wide vote reset back in
 * `resolveSplit`, send a pause without a revision, and something here breaks.
 */

const assert = require("node:assert");
const path = require("node:path");

const { loadWww, received, removeBuildOutputs } = require("./www-harness");
const { harness: clientHarness } = require("./client-harness");
const { buildSessionLinesFixture } = require("./session-lines-fixture");
const { buildScore } = require("../bin/build-score.js");
const { validateTapTarget } = require("../lib/session-lines/orchestrator");
const { MESSAGES: M } = require("../constants");

const PLAYER = "player";
const ADMIN = "admin";

// Build a fixture room, serve it, run `fn`, and always clean up what the build
// wrote into server_state.
async function withRoom(build, fn) {
  const session = await build();
  let h = null;
  try {
    h = loadWww();
    h.addSession(session);
    await fn(h, session);
  } finally {
    if (h) h.dispose();
    removeBuildOutputs(session.id);
  }
}

const demoRoom = (id) => () => buildSessionLinesFixture({ id });
const fixtureRoom = (folder) => (id) => () =>
  buildScore(folder, { id, dataDir: path.join(__dirname, "fixtures") });
// A main score and its sub that both open on START.svg at index 0.
const collisionRoom = fixtureRoom("ctx-collision");
// A main-flow split into P | Q, each diving into the same sub the same way,
// whose routes then walk A and B to one JOIN.svg.
const subMergeRoom = fixtureRoom("sub-merge");

// A performer page: handshake + the display request every page opens with.
async function join(h, session, did, over = {}) {
  const conn = h.connect({ label: did });
  const sig = over.sig === undefined ? PLAYER : over.sig;
  await h.send(conn, M.MSG_PING, {
    sid: session.id,
    sig,
    did,
    clientTime: 0,
    mapView: over.mapView,
  });
  await h.send(conn, M.MSG_NEED_DISPLAY, {
    sid: session.id,
    sig,
    did,
    mapView: over.mapView,
  });
  return conn;
}

// The dive context this page was last told (what a real page reports on a tap).
function lastContext(conn) {
  const withCtx = conn.sent.filter((p) => p.ctx !== undefined);
  return withCtx.length ? withCtx[withCtx.length - 1].ctx : "";
}

function tap(h, session, conn, selectedId, over = {}) {
  return h.send(conn, M.MSG_TAP, {
    sid: session.id,
    sig: PLAYER,
    did: conn.label,
    cid: over.cid,
    selectedId,
    ctx: over.ctx === undefined ? lastContext(conn) : over.ctx,
    ...over.extra,
  });
}

// Feed what the server sent one device into a real page, in the order
// ws-client.js delivers it: immediate messages as they arrive, the rest at
// their `t`. PING is ws-client's own handshake, not the page's.
function replayInto(page, conn) {
  conn.sent
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p.m !== M.MSG_PING)
    .sort((x, y) => (x.p.t || 0) - (y.p.t || 0) || x.i - y.i)
    .forEach(({ p }) => page.sandbox.parseMessage(p));
}

// Everything about a line a refused tap must leave alone.
const lineState = (line) =>
  JSON.stringify({
    currentIndex: line.currentIndex,
    history: line.history,
    subStack: line.subStack,
    isVoting: line.isVoting,
    isHolding: line.isHolding,
  });

const dispMax = (conn) =>
  Math.max(-1, ...conn.sent.filter((p) => p.dr != null).map((p) => p.dr));

module.exports = {
  // ── M1: who may tap, and what for ─────────────────────────────────────────
  "MSG_TAP: refused senders leave the line and every vote untouched": () =>
    withRoom(demoRoom("__www_tap_auth__"), async (h, session) => {
      const idx = (n) => session.listFilesInLowerCase.indexOf(n.toLowerCase());
      const start = idx("START.svg");
      const vote = `${idx("Left.svg")}#START.svg#0`;
      const line = session.lines[0];
      const performer = await join(h, session, "dP");
      const before = lineState(line);

      // A socket that never completed the handshake. Its message names the
      // room, the frame and a destination the frame really offers.
      const raw = h.connect({ label: "raw" });
      await h.send(raw, M.MSG_TAP, {
        sid: session.id,
        sig: PLAYER,
        cid: start,
        selectedId: vote,
        ctx: "",
      });
      assert.strictEqual(lineState(line), before, "a pre-handshake tap moved the line");

      // A rider (no staff credentials) and a /map tab (staff, but a tool).
      const rider = await join(h, session, "dR", { sig: "" });
      await tap(h, session, rider, vote, { cid: start, extra: { sig: "" } });
      const map = await join(h, session, "dM", { sig: ADMIN, mapView: true });
      await tap(h, session, map, vote, { cid: start, extra: { sig: ADMIN, mapView: true } });
      assert.strictEqual(lineState(line), before, "a spectator's tap moved the line");

      // A bound performer whose MESSAGE carries the wrong password.
      await tap(h, session, performer, vote, { cid: start, extra: { sig: "nope" } });
      assert.strictEqual(lineState(line), before);

      // A real performer asking for things the frame does not offer.
      for (const bad of [
        `${idx("DONE.svg")}#START.svg#0`, // a frame START does not link to
        "999#START.svg#0",
        "oops#START.svg#0",
        `${idx("Left.svg")}#Barrier.svg#0`, // authored on another frame
      ]) {
        await tap(h, session, performer, bad, { cid: start });
        assert.strictEqual(lineState(line), before, `accepted ${bad}`);
      }
      assert.ok(
        performer.currentVoteTo == null || performer.currentVoteTo === -1,
        "a refused tap was recorded as a vote",
      );

      // …and the legitimate tap goes through (the control).
      await tap(h, session, performer, vote, { cid: start });
      assert.strictEqual(line.isVoting, true);
      assert.strictEqual(performer.currentVoteTo, vote);
    }),

  // ── F3: the score context a tap was made in ───────────────────────────────
  "MSG_TAP: a delayed main-flow tap cannot drive the sub it collides with": () =>
    withRoom(collisionRoom("__www_tap_ctx__"), async (h, session) => {
      const line = session.lines[0];
      assert.strictEqual(session.listFiles[0], "START.svg");
      assert.strictEqual(session.subFrames.Inner.frameList[0], "START.svg");
      const performer = await join(h, session, "dP");
      assert.strictEqual(line.currentIndex, 0);

      // The dive: START's link is a zero-duration sub-start link. The same
      // payload is then delivered a second time — late — after the line is
      // standing on the SUB's START.svg at index 0.
      const mainTap = "1#START.svg#0";
      await tap(h, session, performer, mainTap, { cid: 0, ctx: "" });
      assert.strictEqual(line.subStack.length, 1, "the dive did not happen");
      assert.strictEqual(line.currentIndex, 0);
      const enter = received(performer, M.MSG_SUB_ENTER).pop();
      assert.strictEqual(enter.ctx, "Inner>tail.svg");

      // Without a context, the payload is indistinguishable from a sub tap:
      // same source name, same index, a destination the sub's START offers.
      const inner = session.subFrames.Inner;
      assert.strictEqual(
        validateTapTarget({
          selectedId: mainTap,
          frameName: "START.svg",
          frameList: inner.frameList,
          frameLinks: inner.graph.frameLinks,
          currentIndex: 0,
        }),
        1,
      );

      const inSub = lineState(line);
      await tap(h, session, performer, mainTap, { cid: 0, ctx: "" });
      assert.strictEqual(lineState(line), inSub, "a main-flow tap advanced the sub");
      // A page that reports no context at all is refused too.
      await tap(h, session, performer, mainTap, { cid: 0, ctx: null });
      assert.strictEqual(lineState(line), inSub);

      // The page that is SHOWING the sub reports its context, and the same
      // zero-duration navigation is legitimate there: into the sub end, and
      // back out onto the main flow's return landing.
      await tap(h, session, performer, mainTap, { cid: 0, ctx: enter.ctx });
      assert.strictEqual(line.subStack.length, 0);
      assert.strictEqual(session.listFiles[line.currentIndex], "Tail.svg");
      assert.strictEqual(received(performer, M.MSG_SUB_EXIT).pop().ctx, "");
    }),

  // ── M6 + F1: a split through resolveSplit ─────────────────────────────────
  "a split resolved by the voting timer leaves another line's votes standing": () =>
    withRoom(demoRoom("__www_split_scope__"), async (h, session) => {
      const idx = (n) => session.listFilesInLowerCase.indexOf(n.toLowerCase());
      const start = idx("START.svg");
      const barrier = idx("Barrier.svg");

      // An independent line standing on Barrier with two performers of its own.
      const { BMLine } = require("../lib/session-lines/line");
      const other = new BMLine(session, "L5");
      other.setCurrIdxTo(barrier);
      session.lines.push(other);
      // Seats are given, not balanced: a newcomer would otherwise be spread
      // onto the emptier line.
      Object.assign(session.deviceRegistry, { dA: "L0", dB: "L0", dC: "L5", dD: "L5" });

      const a = await join(h, session, "dA");
      const b = await join(h, session, "dB");
      const c = await join(h, session, "dC");
      const d = await join(h, session, "dD");
      assert.deepStrictEqual(
        [a, b, c, d].map((conn) => conn.lineId),
        ["L0", "L0", "L5", "L5"],
      );
      const beforeSplit = new Map([a, b].map((conn) => [conn, dispMax(conn)]));

      // L0 opens its split window; a second later L5 opens its own.
      await tap(h, session, a, `${idx("Left.svg")}#START.svg#0`, { cid: start });
      await tap(h, session, b, `${idx("Right.svg")}#START.svg#1`, { cid: start });
      await h.advance(1000);
      const toDone = `${idx("DONE.svg")}#Barrier.svg#0`;
      await tap(h, session, c, toDone, { cid: barrier });
      await tap(h, session, d, toDone, { cid: barrier });
      assert.strictEqual(other.isVoting, true);

      // Run the clock until the split window has closed — L5's is still open.
      for (let i = 0; i < 40 && a.lineId === b.lineId; i++) {
        await h.advance(250);
      }
      assert.notStrictEqual(a.lineId, b.lineId, "the split never resolved");
      assert.strictEqual(other.isVoting, true, "L5's window closed with the split");
      assert.strictEqual(c.currentVoteTo, toDone, "the split erased L5's votes");
      assert.strictEqual(d.currentVoteTo, toDone, "the split erased L5's votes");

      // F1: each device's assignment, and every display message after it, is
      // numbered above anything its previous line had sent it — whichever line
      // it landed on.
      for (const conn of [a, b]) {
        const assignment = received(conn, M.MSG_LINE_ASSIGNED).pop();
        assert.strictEqual(assignment.lineId, conn.lineId);
        assert.ok(
          assignment.dr > beforeSplit.get(conn),
          `${conn.label}: assignment rev ${assignment.dr} not above ${beforeSplit.get(conn)}`,
        );
        const after = conn.sent.slice(conn.sent.indexOf(assignment) + 1);
        const frame = after.find((p) => p.m === M.MSG_SHOW);
        assert.ok(frame && frame.dr > assignment.dr);
      }

      // And L5 then resolves to what its performers chose.
      for (let i = 0; i < 60 && other.currentIndex === barrier; i++) {
        await h.advance(250);
      }
      assert.strictEqual(session.listFiles[other.currentIndex], "DONE.svg");
    }),

  "the split's new line drives a real page that had applied a higher revision": () =>
    withRoom(demoRoom("__www_split_page__"), async (h, session) => {
      const idx = (n) => session.listFilesInLowerCase.indexOf(n.toLowerCase());
      const start = idx("START.svg");
      const a = await join(h, session, "dA");
      const b = await join(h, session, "dB");
      await tap(h, session, a, `${idx("Left.svg")}#START.svg#0`, { cid: start });
      await tap(h, session, b, `${idx("Right.svg")}#START.svg#1`, { cid: start });
      for (let i = 0; i < 60 && a.lineId === b.lineId; i++) {
        await h.advance(250);
      }
      const moved = a.lineId === "L0" ? b : a;
      assert.notStrictEqual(moved.lineId, "L0");

      // Replay what the server sent this device into the real page, in the
      // order ws-client.js delivers it (immediate first, then by `t`).
      const page = clientHarness();
      replayInto(page, moved);
      assert.strictEqual(page.sandbox.lineId, moved.lineId);
      assert.strictEqual(
        page.shown[page.shown.length - 1],
        session.lines.find((l) => l.id === moved.lineId).currentIndex,
        "the page did not show its new line's frame",
      );
    }),

  // ── F4: pause against a SHOW queued for the preload deadline ──────────────
  "an operator pause is not overwritten by the frame an advance queued": () =>
    withRoom(demoRoom("__www_pause__"), async (h, session) => {
      const idx = (n) => session.listFilesInLowerCase.indexOf(n.toLowerCase());
      const start = idx("START.svg");
      const a = await join(h, session, "dA");
      await tap(h, session, a, `${idx("Left.svg")}#START.svg#0`, { cid: start });
      for (let i = 0; i < 60 && session.lines[0].currentIndex === start; i++) {
        await h.advance(250);
      }
      const queued = received(a, M.MSG_SHOW).pop();
      // `t` and `now()` are readings of the same clock: the frame is due
      // within the preload window, not merely "some epoch time after zero".
      assert.ok(queued.t > h.now(), "the advance's frame is not preloaded");
      assert.ok(
        queued.t <= h.now() + session.preloadDuration,
        "the frame's deadline is not on the harness's timeline",
      );

      // The operator pauses before that frame's deadline.
      const op = await join(h, session, "op", { sig: ADMIN, mapView: true });
      await h.send(op, M.MSG_PAUSE, { sid: session.id, sig: ADMIN, isPause: true });
      const pause = received(a, M.MSG_PAUSE).pop();
      assert.ok(pause && pause.dr > queued.dr, "the pause carries no newer revision");

      const page = clientHarness();
      replayInto(page, a);
      assert.strictEqual(
        page.shown[page.shown.length - 1],
        -1,
        "the queued SHOW replaced the pause placeholder",
      );

      await h.send(op, M.MSG_PAUSE, { sid: session.id, sig: ADMIN, isPause: false });
      page.sandbox.parseMessage(received(a, M.MSG_PAUSE).pop());
      assert.strictEqual(page.shown[page.shown.length - 1], idx("Left.svg"));
    }),

  // ── M3: the reconnect snapshot, from the handler ──────────────────────────
  "a reconnect inside a sub is answered with one context-bearing snapshot": () =>
    withRoom(collisionRoom("__www_snapshot__"), async (h, session) => {
      const a = await join(h, session, "dA");
      await tap(h, session, a, "1#START.svg#0", { cid: 0, ctx: "" });
      assert.strictEqual(session.lines[0].subStack.length, 1);

      // Same device, new socket.
      h.disconnect(a);
      const again = await join(h, session, "dA");
      const snapshot = received(again, M.MSG_SHOW).find((p) => p.snapshot);
      assert.ok(snapshot, "no snapshot");
      assert.strictEqual(snapshot.sub, "Inner");
      assert.strictEqual(snapshot.ctx, "Inner>tail.svg");
      assert.strictEqual(snapshot.lineId, "L0");
      assert.strictEqual(snapshot.waiting, null);
      assert.strictEqual(snapshot.voting, null);
      assert.strictEqual(snapshot.isPause, false);
    }),

  // ── M7: a sub-score merge undone through the operator's real gesture ─────
  "a merge inside a sub is undone onto each route's own frame, and stays undone": () =>
    withRoom(subMergeRoom("__www_sub_merge_undo__"), async (h, session) => {
      const sub = session.subFrames.Inner.frameList;
      const at = (name) => sub.indexOf(name);
      const main = (name) => session.listFiles.indexOf(name);
      const a = await join(h, session, "dA");
      const b = await join(h, session, "dB");
      const lineOf = (conn) => session.lines.find((l) => l.id === conn.lineId);

      // Split on the main flow: dA takes P, dB takes Q.
      const start = main("START.svg");
      await tap(h, session, a, `${main("P.svg")}#START.svg#0`, { cid: start });
      await tap(h, session, b, `${main("Q.svg")}#START.svg#1`, { cid: start });
      for (let i = 0; i < 60 && a.lineId === b.lineId; i++) {
        await h.advance(250);
      }
      assert.notStrictEqual(a.lineId, b.lineId, "the split never resolved");
      await h.advance(2000);

      // Each dives into Inner — the same way, back to End.svg — one after the
      // other, and walks its own branch.
      const end = main("End.svg");
      await tap(h, session, a, `${end}#P.svg#0`, { cid: main("P.svg") });
      await tap(h, session, a, `${at("A.svg")}#START.svg#0`, { cid: at("START.svg") });
      await tap(h, session, b, `${end}#Q.svg#0`, { cid: main("Q.svg") });
      await tap(h, session, b, `${at("B.svg")}#START.svg#1`, { cid: at("START.svg") });
      assert.strictEqual(lineOf(a).currentIndex, at("A.svg"));
      assert.strictEqual(lineOf(b).currentIndex, at("B.svg"));
      assert.strictEqual(lineOf(a).subStack.length, 1);
      assert.strictEqual(lineOf(b).subStack.length, 1);
      const uidA = lineOf(a).uid;
      const uidB = lineOf(b).uid;

      // Both routes walk on to JOIN.svg — one line per node merges them there.
      await tap(h, session, a, `${at("JOIN.svg")}#A.svg#0`, { cid: at("A.svg") });
      await tap(h, session, b, `${at("JOIN.svg")}#B.svg#0`, { cid: at("B.svg") });
      await h.advance(2000);
      assert.strictEqual(a.lineId, b.lineId, "the routes did not merge on JOIN");
      const event = session.mergeEvents.find((e) => e.status === "active");
      assert.ok(event, "no merge event recorded");
      assert.strictEqual(event.sub, "Inner");

      // The operator undoes it from the map.
      const op = await join(h, session, "op", { sig: ADMIN, mapView: true });
      await h.send(op, M.MSG_SELECT_HISTORY, {
        sid: session.id,
        sig: ADMIN,
        mergeEventId: event.id,
        frame: "JOIN.svg",
        operationId: "undo-1",
      });
      assert.deepStrictEqual(received(op, M.MSG_REWIND_REFUSED), []);

      // Each route is back on its OWN predecessor, inside the sub — which is
      // also what keeps the gesture's final settlement from merging them
      // again on the spot.
      const live = session.lines.filter((l) => l.status === "active");
      assert.strictEqual(live.length, 2, "the settlement merged the routes again");
      const byUid = new Map(live.map((l) => [l.uid, l]));
      assert.strictEqual(byUid.get(uidA).currentIndex, at("A.svg"));
      assert.strictEqual(byUid.get(uidB).currentIndex, at("B.svg"));
      for (const line of live) {
        assert.deepStrictEqual(line.subStack, [{ score: "Inner", returnHref: "End.svg" }]);
      }
      assert.strictEqual(event.status, "undone");
      assert.strictEqual(
        session.mergeEvents.filter((e) => e.status === "active").length,
        0,
        "the undo stacked a fresh rejoin behind the one it removed",
      );

      // Devices and their durable seats followed their routes…
      assert.strictEqual(a.lineId, byUid.get(uidA).id);
      assert.strictEqual(b.lineId, byUid.get(uidB).id);
      assert.strictEqual(session.deviceRegistry.dA, a.lineId);
      assert.strictEqual(session.deviceRegistry.dB, b.lineId);

      // …and each device's page ends up showing its route's frame, in the sub.
      for (const [conn, name] of [[a, "A.svg"], [b, "B.svg"]]) {
        await h.advance(2000);
        const page = clientHarness();
        replayInto(page, conn);
        // The dive asked the page to fetch the sub's frames; serve them.
        const inner = session.subFrames.Inner;
        await page.releaseSub("Inner", {
          frameList: inner.frameList,
          framesHtml: inner.framesHtml,
          soundList: inner.soundList,
        });
        assert.strictEqual(page.sandbox.lineId, conn.lineId);
        assert.strictEqual(page.sandbox.frameContext.name, "Inner");
        assert.strictEqual(page.shown[page.shown.length - 1], at(name));
        assert.strictEqual(page.sandbox.displayContext, "Inner>end.svg");
      }

      // A later, ordinary landing does not quietly re-merge them either.
      await h.advance(10000);
      assert.strictEqual(
        session.lines.filter((l) => l.status === "active").length,
        2,
      );
    }),
};

// ── F8: one clock for the server, its timers and the policies it imports ────
const { landingHoldElapsed } = require("../lib/session-lines/line");

module.exports["the harness clock is the one the server and its policies read"] =
  () =>
    withRoom(demoRoom("__www_clock__"), async (h) => {
      const start = h.now();
      assert.strictEqual(Date.now(), start);
      await h.advance(1234);
      assert.strictEqual(h.now(), start + 1234);
      assert.strictEqual(Date.now(), h.now(), "advancing did not move Date.now");
      assert.strictEqual(new Date().getTime(), h.now());
      // The imported phase clock, called with its DEFAULT clock, sees the same
      // instant: a deadline one millisecond ahead is pending, and at it spent.
      const line = { isHolding: true, currentEndHoldTimeStamp: h.now() + 1 };
      assert.strictEqual(landingHoldElapsed(line), false);
      await h.advance(1);
      assert.strictEqual(landingHoldElapsed(line), true);
    });

module.exports["a frame's holding period ends at its deadline, not a tick early"] =
  () =>
    withRoom(demoRoom("__www_hold_deadline__"), async (h, session) => {
      const idx = (n) => session.listFilesInLowerCase.indexOf(n.toLowerCase());
      const line = session.lines[0];
      const a = await join(h, session, "dA");

      // START → Left → Barrier (authored `holding="19"`), one window at a time.
      const walk = async (from, to, vote) => {
        await tap(h, session, a, vote, { cid: idx(from) });
        for (let i = 0; i < 120 && line.currentIndex !== idx(to); i++) {
          await h.advance(250);
        }
        assert.strictEqual(session.listFiles[line.currentIndex], to);
      };
      await walk("START.svg", "Left.svg", `${idx("Left.svg")}#START.svg#0`);
      await h.advance(2000);
      await walk("Left.svg", "Barrier.svg", `${idx("Barrier.svg")}#Left.svg#0`);

      // The standby gap, then the hold starts on the server's clock.
      for (let i = 0; i < 40 && line.holdingTimer == null; i++) {
        await h.advance(50);
      }
      assert.ok(line.holdingTimer != null, "the barrier frame never began holding");
      const end = line.currentEndHoldTimeStamp;
      assert.strictEqual(end - h.now(), 19000 - (h.now() - line.currentBeginHoldTimeStamp));
      assert.ok(line.isBarrierWaiting, "the line did not park on the barrier");

      // One millisecond before the deadline: still holding, still parked.
      await h.advance(end - 1 - h.now());
      assert.strictEqual(line.isHolding, true, "the hold ended before its deadline");
      assert.strictEqual(landingHoldElapsed(line), false);
      assert.ok(line.isBarrierWaiting, "the barrier released during the hold");

      // At the deadline the hold ends, and with it the barrier's hold gate —
      // its missing targets are unreachable for a lone line, so it releases.
      await h.advance(1);
      assert.strictEqual(line.isHolding, false, "the hold outlived its deadline");
      assert.strictEqual(line.isBarrierWaiting, false, "the barrier did not release");
      assert.strictEqual(received(a, M.MSG_BARRIER_RELEASED).length, 1);
    });

// A line restored mid-hold is flagged holding with no timer behind it; the
// barrier gate reads its recorded deadline. It used to be handed the array
// index as its clock (`parkedLines.some(holdPendingAtFrame)`) and threw.
module.exports["a barrier gate reads a restored hold's deadline on the shared clock"] =
  () =>
    withRoom(demoRoom("__www_restored_hold__"), async (h, session) => {
      const idx = (n) => session.listFilesInLowerCase.indexOf(n.toLowerCase());
      const line = session.lines[0];
      await join(h, session, "dA");
      line.setCurrIdxTo(idx("Barrier.svg"));
      line.isHolding = true;
      line.holdingTimer = null;
      line.currentEndHoldTimeStamp = h.now() + 5000;
      line.isBarrierWaiting = true;
      session._barrier = {
        byFrame: {
          "Barrier.svg": {
            frame: "Barrier.svg",
            targets: ["Left.svg", "Tetra/Echo.svg"],
            parked: new Set([line.id]),
          },
        },
      };
      const check = () => session.runExclusively(() => h.www.tryReleaseBarriers(session));

      await check();
      assert.ok(session._barrier.byFrame["Barrier.svg"], "released during the hold");
      await h.advance(4999);
      await check();
      assert.ok(session._barrier.byFrame["Barrier.svg"], "released a millisecond early");
      await h.advance(1);
      await check();
      assert.strictEqual(session._barrier.byFrame["Barrier.svg"], undefined);
      assert.strictEqual(line.isBarrierWaiting, false);
    });
