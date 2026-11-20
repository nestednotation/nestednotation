/**
 * Rewind receipts and their persistence, through the production handlers
 * (review T3).
 *
 * The source checks this replaces found `recordRewind` and
 * `saveSessionStateToFile` anywhere in bin/www and `operationId` near each
 * report, without establishing that one operation does all of it. Here two
 * operator map tabs share a room: one rewinds a line, and the test follows
 * that one message to its log entry, its save, and the receipt each tab gets.
 */

const assert = require("node:assert");

const { loadWww, received, removeBuildOutputs } = require("./www-harness");
const { buildSessionLinesFixture } = require("./session-lines-fixture");
const { MESSAGES: M } = require("../constants");

const PLAYER = "player";
const ADMIN = "admin";

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

async function join(h, session, did, over = {}) {
  const conn = h.connect({ label: did });
  const sig = over.sig || PLAYER;
  await h.send(conn, M.MSG_PING, { sid: session.id, sig, did, clientTime: 0, mapView: over.mapView });
  await h.send(conn, M.MSG_NEED_DISPLAY, { sid: session.id, sig, did, mapView: over.mapView });
  return conn;
}

// START → Left → Barrier for the room's one performer.
async function walkToBarrier(h, session, conn) {
  const idx = (n) => session.listFilesInLowerCase.indexOf(n.toLowerCase());
  const line = session.lines[0];
  const step = async (from, to) => {
    await h.send(conn, M.MSG_TAP, {
      sid: session.id,
      sig: PLAYER,
      did: conn.label,
      cid: idx(from),
      selectedId: `${idx(to)}#${from}#0`,
      ctx: "",
    });
    for (let i = 0; i < 160 && line.currentIndex !== idx(to); i++) {
      await h.advance(250);
    }
    assert.strictEqual(session.listFiles[line.currentIndex], to);
  };
  await step("START.svg", "Left.svg");
  await h.advance(2000);
  await step("Left.svg", "Barrier.svg");
  return line;
}

module.exports = {
  "one rewind: one log entry, saved, and a receipt every operator can attribute": () =>
    withDemoRoom("__receipt_done__", async (h, session) => {
      const player = await join(h, session, "p1");
      const opA = await join(h, session, "opA", { sig: ADMIN, mapView: true });
      const opB = await join(h, session, "opB", { sig: ADMIN, mapView: true });
      const line = await walkToBarrier(h, session, player);

      const selectedIdx = line.history.lastIndexOf("Left.svg");
      assert.ok(selectedIdx >= 0, `Left.svg not in ${JSON.stringify(line.history)}`);

      let saves = 0;
      let savedLog = null;
      session.saveSessionStateToFile = async () => {
        saves++;
        savedLog = JSON.parse(JSON.stringify(session.toJSON().rewindLog));
      };
      const logBefore = session.rewindLog.length;
      const doneBefore = [opA, opB].map((c) => received(c, M.MSG_REWIND_DONE).length);

      await h.send(opA, M.MSG_SELECT_HISTORY, {
        sid: session.id,
        sig: ADMIN,
        lineId: line.id,
        selectedIdx,
        frame: "Left.svg",
        operationId: "opA-1",
      });

      assert.deepStrictEqual(received(opA, M.MSG_REWIND_REFUSED), []);
      assert.strictEqual(session.listFiles[line.currentIndex], "Left.svg");

      // Exactly one entry, for this line and frame, and it was saved.
      assert.strictEqual(session.rewindLog.length, logBefore + 1);
      const entry = session.rewindLog[0];
      assert.strictEqual(entry.kind, "line");
      assert.strictEqual(entry.frame, "Left.svg");
      assert.strictEqual(entry.lineId, line.id);
      assert.ok(saves >= 1, "the rewind was not saved");
      assert.deepStrictEqual(savedLog[0], entry, "the save did not include the new entry");

      // Both tabs hear it, both carry the clicking tab's id and the same entry.
      for (const [i, op] of [opA, opB].entries()) {
        const receipts = received(op, M.MSG_REWIND_DONE).slice(doneBefore[i]);
        assert.strictEqual(receipts.length, 1, `${op.label}: ${JSON.stringify(receipts)}`);
        assert.strictEqual(receipts[0].operationId, "opA-1");
        assert.strictEqual(receipts[0].kind, "line");
        assert.strictEqual(receipts[0].frame, "Left.svg");
        assert.deepStrictEqual(receipts[0].rewindEntry, entry);
      }
      // A performer is not an operator.
      assert.deepStrictEqual(received(player, M.MSG_REWIND_DONE), []);
    }),

  "a refused rewind answers only its sender, with its id, and records nothing": () =>
    withDemoRoom("__receipt_refused__", async (h, session) => {
      const player = await join(h, session, "p1");
      const opA = await join(h, session, "opA", { sig: ADMIN, mapView: true });
      const opB = await join(h, session, "opB", { sig: ADMIN, mapView: true });
      const line = await walkToBarrier(h, session, player);
      const selectedIdx = line.history.lastIndexOf("Left.svg");

      let saves = 0;
      session.saveSessionStateToFile = async () => {
        saves++;
      };
      const logBefore = JSON.stringify(session.rewindLog);
      const at = line.currentIndex;

      // A stale menu: the frame no longer matches that history slot.
      await h.send(opA, M.MSG_SELECT_HISTORY, {
        sid: session.id,
        sig: ADMIN,
        lineId: line.id,
        selectedIdx,
        frame: "Right.svg",
        operationId: "opA-2",
      });

      const refusals = received(opA, M.MSG_REWIND_REFUSED);
      assert.strictEqual(refusals.length, 1);
      assert.strictEqual(refusals[0].operationId, "opA-2");
      assert.strictEqual(refusals[0].moved, false);
      assert.deepStrictEqual(received(opB, M.MSG_REWIND_REFUSED), []);
      assert.deepStrictEqual(received(opA, M.MSG_REWIND_DONE), []);
      assert.strictEqual(line.currentIndex, at, "a refused rewind moved the line");
      assert.strictEqual(JSON.stringify(session.rewindLog), logBefore);
      assert.strictEqual(saves, 0, "a refusal wrote the state file");
    }),

  "an id longer than the protocol allows is answered without one": () =>
    withDemoRoom("__receipt_long_id__", async (h, session) => {
      const player = await join(h, session, "p1");
      const opA = await join(h, session, "opA", { sig: ADMIN, mapView: true });
      const line = await walkToBarrier(h, session, player);
      await h.send(opA, M.MSG_SELECT_HISTORY, {
        sid: session.id,
        sig: ADMIN,
        lineId: line.id,
        selectedIdx: line.history.lastIndexOf("Left.svg"),
        frame: "Left.svg",
        operationId: "x".repeat(129),
      });
      const receipts = received(opA, M.MSG_REWIND_DONE);
      assert.strictEqual(receipts.length, 1);
      assert.strictEqual(receipts[0].operationId, null);
    }),
};
