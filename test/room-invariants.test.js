/**
 * Room invariants across dormancy and revival, through the production
 * handlers on the virtual clock (review S5). The split → merge → undo and
 * restart scenario runs over a real socket in e2e-websocket.test.js; this one
 * needs the 8 s attrition grace, which the virtual clock makes instant.
 *
 * After every step: each connected device is on exactly one live line, no two
 * live lines share an id, every live line stands on a real frame, and the
 * registry agrees with where each device actually is.
 */

const assert = require("node:assert");

const { loadWww, removeBuildOutputs, settle } = require("./www-harness");
const { buildSessionLinesFixture } = require("./session-lines-fixture");
const { MESSAGES: M } = require("../constants");

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

async function join(h, session, did) {
  const conn = h.connect({ label: did });
  await h.send(conn, M.MSG_PING, { sid: session.id, sig: "player", did, clientTime: 0 });
  await h.send(conn, M.MSG_NEED_DISPLAY, { sid: session.id, sig: "player", did });
  return conn;
}

function assertInvariants(h, session, devices) {
  const live = session.lines.filter((l) => l.status !== "retired");
  const ids = live.map((l) => l.id);
  assert.strictEqual(new Set(ids).size, ids.length, `duplicate line ids: ${ids}`);
  for (const line of live) {
    const frames = line.subStack.length
      ? session.subFrames[line.subStack[line.subStack.length - 1].score].frameList
      : session.listFiles;
    assert.ok(
      Number.isInteger(line.currentIndex) && line.currentIndex >= 0 && line.currentIndex < frames.length,
      `${line.id} stands on index ${line.currentIndex}`,
    );
  }
  for (const conn of devices) {
    const line = session.lines.find((l) => l.id === conn.lineId);
    assert.ok(line && line.status === "active", `${conn.label} is on ${conn.lineId}, which is not active`);
    assert.strictEqual(session.deviceRegistry[conn.label], conn.lineId, `${conn.label}'s registry seat`);
  }
  const connected = h.www.wsServer.connections.filter((c) => c.sessionId === session.id);
  for (const line of live) {
    const here = connected.filter((c) => c.lineId === line.id).length;
    if (line.status === "dormant") {
      assert.strictEqual(here, 0, `dormant ${line.id} still has ${here} device(s)`);
    }
  }
}

module.exports = {
  "a line left empty goes dormant, and its device revives it": () =>
    withDemoRoom("__inv_revival__", async (h, session) => {
      const idx = (n) => session.listFilesInLowerCase.indexOf(n.toLowerCase());
      const p1 = await join(h, session, "p1");
      const p2 = await join(h, session, "p2");

      // Split: p1 to Left, p2 to Right.
      const tap = (conn, to, link) =>
        h.send(conn, M.MSG_TAP, {
          sid: session.id,
          sig: "player",
          did: conn.label,
          cid: idx("START.svg"),
          selectedId: `${idx(to)}#START.svg#${link}`,
          ctx: "",
        });
      await tap(p1, "Left.svg", 0);
      await tap(p2, "Right.svg", 1);
      for (let i = 0; i < 80 && p1.lineId === p2.lineId; i++) await h.advance(250);
      assert.notStrictEqual(p1.lineId, p2.lineId, "the split never resolved");
      await h.advance(5000);
      assertInvariants(h, session, [p1, p2]);
      const seat = p2.lineId;
      const line = session.lines.find((l) => l.id === seat);

      // p2 goes away: after the attrition grace its line is dormant, and the
      // room around it still holds together.
      h.disconnect(p2);
      await session.runExclusively(() => h.www.handleConnectionClose(session, p2));
      await h.advance(10000);
      assert.strictEqual(line.status, "dormant", `the empty line is ${line.status}`);
      assertInvariants(h, session, [p1]);
      assert.strictEqual(session.deviceRegistry.p2, seat, "the absent device lost its seat");

      // p2 comes back: its own line wakes up under it.
      const back = await join(h, session, "p2");
      await settle();
      assert.strictEqual(back.lineId, seat, "the device came back to another line");
      assert.strictEqual(line.status, "active", "its line did not revive");
      assertInvariants(h, session, [p1, back]);
    }),
};
