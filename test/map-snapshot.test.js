/**
 * What an operator tab is sent, through the production snapshot path
 * (review S2/T6). Sizes and counts, never wall-clock time: the timing lives in
 * test/bench/map-payload.bench.js.
 *
 *   - calls within one turn of the event loop become one push;
 *   - a map tab gets a line's trails only when they changed since its last
 *     push, and a newly opened tab gets all of them;
 *   - ordinary count pushes carry no structural detail bodies, and ordinary
 *     admin session tabs carry no trails at all;
 *   - the details come once, on the map's request.
 */

const assert = require("node:assert");

const { loadWww, received, removeBuildOutputs, settle } = require("./www-harness");
const { buildSessionLinesFixture } = require("./session-lines-fixture");
const { MESSAGES: M } = require("../constants");

const ADMIN = "admin";
const PLAYER = "player";

async function withDemoRoom(id, fn) {
  const session = await buildSessionLinesFixture({ id });
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

async function join(h, session, did, sig = PLAYER, mapView = undefined) {
  const conn = h.connect({ label: did });
  await h.send(conn, M.MSG_PING, { sid: session.id, sig, did, clientTime: 0, mapView });
  await h.send(conn, M.MSG_NEED_DISPLAY, { sid: session.id, sig, did, mapView });
  return conn;
}

const counts = (conn) =>
  received(conn, M.MSG_SHOW_NUMBER_CONNECTION).filter((p) => !p.structuralDetails);
const lastCount = (conn) => counts(conn).pop();

async function walkToLeft(h, session, conn) {
  const idx = (n) => session.listFilesInLowerCase.indexOf(n.toLowerCase());
  await h.send(conn, M.MSG_TAP, {
    sid: session.id,
    sig: PLAYER,
    did: conn.label,
    cid: idx("START.svg"),
    selectedId: `${idx("Left.svg")}#START.svg#0`,
    ctx: "",
  });
  const line = () => session.lines.find((l) => l.id === conn.lineId);
  for (let i = 0; i < 160 && session.listFiles[line().currentIndex] !== "Left.svg"; i++) {
    await h.advance(250);
  }
  assert.strictEqual(session.listFiles[line().currentIndex], "Left.svg");
}

module.exports = {
  "calls within one turn become one push, taken afterwards": () =>
    withDemoRoom("__snap_coalesce__", async (h, session) => {
      await join(h, session, "p1");
      const map = await join(h, session, "map", ADMIN, true);
      const before = counts(map).length;

      for (let i = 0; i < 5; i++) h.www.updateNumberOfConnectionForSession(session);
      assert.strictEqual(counts(map).length, before, "a push went out synchronously");
      // Whatever changes before the push goes out is in it.
      const late = h.connect({ label: "late" });
      await h.send(late, M.MSG_PING, { sid: session.id, sig: PLAYER, did: "late", clientTime: 0 });
      await settle();

      const after = counts(map);
      assert.ok(after.length - before >= 1);
      assert.ok(after.length - before <= 2, `${after.length - before} pushes for one burst`);
      assert.strictEqual(after[after.length - 1].playerCount, 2);
    }),

  "a map tab is sent trails only when they change, a new tab all of them": () =>
    withDemoRoom("__snap_trails__", async (h, session) => {
      const player = await join(h, session, "p1");
      const map = await join(h, session, "map", ADMIN, true);
      const line = session.lines[0];

      const first = lastCount(map).lines.find((l) => l.id === line.id);
      assert.deepStrictEqual(first.trail, ["START.svg"]);
      assert.strictEqual(first.trailKept, undefined);

      // Nothing moved: the line keeps its trails.
      h.www.updateNumberOfConnectionForSession(session);
      await settle();
      const same = lastCount(map).lines.find((l) => l.id === line.id);
      assert.strictEqual(same.trailKept, true);
      assert.strictEqual(same.trail, undefined);
      assert.strictEqual(same.mainTrail, undefined);
      assert.strictEqual(same.frame, "START.svg", "live fields still ride every push");

      // It moves: fresh trails for the line that moved.
      await walkToLeft(h, session, player);
      const moved = lastCount(map).lines.find((l) => l.id === player.lineId);
      assert.ok(Array.isArray(moved.trail) && moved.trail.includes("Left.svg"), JSON.stringify(moved));

      // A tab opened now has nothing yet: it is sent every trail.
      const fresh = await join(h, session, "map2", ADMIN, true);
      for (const l of lastCount(fresh).lines) {
        assert.ok(Array.isArray(l.trail), `${l.id} reached a new tab without its trail`);
        assert.strictEqual(l.trailKept, undefined);
      }
    }),

  "count pushes carry no detail bodies; the details come on request": () =>
    withDemoRoom("__snap_details__", async (h, session) => {
      const player = await join(h, session, "p1");
      await join(h, session, "p2");
      const map = await join(h, session, "map", ADMIN, true);
      const tab = await join(h, session, "tab", ADMIN);
      await walkToLeft(h, session, player); // a split: structural topology

      for (const push of counts(map)) {
        for (const body of ["splitRewinds", "mergeRewinds", "absorbedLines"]) {
          assert.strictEqual(push[body], undefined, `a count push carried ${body}`);
        }
      }
      const version = lastCount(map).structuralVersion;
      assert.ok(version, "no structural version announced");

      for (const push of counts(tab)) {
        assert.strictEqual(push.rewindLog, undefined, "the session tab got the map's log");
        for (const l of push.lines || []) {
          assert.strictEqual(l.trail, undefined, "the session tab got trails");
          assert.strictEqual(l.mainTrail, undefined);
        }
      }

      await h.send(map, M.MSG_NEED_DISPLAY, {
        sid: session.id,
        sig: ADMIN,
        did: "map",
        mapView: true,
        structuralDetails: true,
      });
      const details = received(map, M.MSG_SHOW_NUMBER_CONNECTION).filter((p) => p.structuralDetails);
      assert.strictEqual(details.length, 1);
      assert.strictEqual(details[0].structuralVersion, version);
      assert.ok(Array.isArray(details[0].splitRewinds) && details[0].splitRewinds.length > 0);
      assert.strictEqual(details[0].lines, undefined, "details carry no lines of their own");
      assert.deepStrictEqual(received(tab, M.MSG_SHOW_NUMBER_CONNECTION).filter((p) => p.structuralDetails), []);
    }),
};
