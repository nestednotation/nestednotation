/**
 * End to end over a real WebSocket (review S5).
 *
 * Spawns the actual server (`node bin/www`) on free ports, with its state in a
 * temporary directory and its scores served from test/fixtures, and drives it
 * through real sockets with real timers: the transport, the boot loader and
 * the state files are the production ones, which the in-process handler
 * harness stubs out.
 *
 * The scenario is the review's split → merge → undo inside a sub-score,
 * followed by a server restart:
 *   - two performers split on the main flow, dive into the same sub the same
 *     way, and merge on its JOIN frame;
 *   - an operator undoes the merge from the map, and the room invariants hold
 *     (every device on exactly one live line, distinct line ids, each route on
 *     its own predecessor);
 *   - the server is killed and started again on the same state; the devices
 *     reconnect to the lines they left, at the frames they left them on.
 */

const assert = require("node:assert");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const WebSocketClient = require("websocket").client;

const { buildScore } = require("../bin/build-score.js");
const { MESSAGES: M } = require("../constants");

const REPO = path.join(__dirname, "..");
const FIXTURES = path.join(__dirname, "fixtures");
const ROOM = "e2e-room";
const ADMIN = "admin";
const PLAYER = "player";

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function until(check, what, timeoutMs = 15000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      let value;
      try {
        value = check();
      } catch (e) {
        reject(e);
        return;
      }
      if (value) {
        resolve(value);
      } else if (Date.now() - started > timeoutMs) {
        reject(new Error(`timed out waiting for ${what}`));
      } else {
        setTimeout(tick, 25);
      }
    };
    tick();
  });
}

// ── The server process ──────────────────────────────────────────────────────

async function startServer(env) {
  const child = spawn(process.execPath, [path.join("bin", "www")], {
    cwd: REPO,
    env: { ...process.env, ...env, NODE_ENV: "development" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  const exited = new Promise((resolve) => child.on("exit", resolve));
  // Ready once the stored room has been rebuilt from its state file.
  await until(
    () => {
      if (child.exitCode != null) {
        throw new Error(`server exited early:\n${log}`);
      }
      return log.includes(`with ID ${ROOM}`);
    },
    "the server to restore the room",
    20000,
  );
  return {
    log: () => log,
    async stop() {
      if (child.exitCode == null) child.kill();
      await exited;
    },
  };
}

// ── A device over a real socket ─────────────────────────────────────────────

async function openDevice(wsPort, did, { sig = PLAYER, mapView } = {}) {
  const client = new WebSocketClient();
  const connection = await new Promise((resolve, reject) => {
    client.on("connectFailed", reject);
    client.on("connect", resolve);
    client.connect(`ws://127.0.0.1:${wsPort}/`);
  });
  const device = {
    did,
    sig,
    messages: [],
    lineId: null,
    connection,
    send(msg, payload = {}) {
      connection.sendUTF(
        JSON.stringify({ msg, sid: ROOM, sig, did, mapView, ...payload }),
      );
    },
    of(m) {
      return device.messages.filter((p) => p.m === m);
    },
    last(m) {
      const all = device.of(m);
      return all[all.length - 1];
    },
    // The dive context this page was last told, as a page reports it on a tap.
    context() {
      const withCtx = device.messages.filter((p) => p.ctx !== undefined);
      return withCtx.length ? withCtx[withCtx.length - 1].ctx : "";
    },
    close() {
      connection.close();
    },
  };
  connection.on("message", (message) => {
    if (message.type !== "utf8") return;
    const payload = JSON.parse(message.utf8Data);
    device.messages.push(payload);
    if (payload.m === M.MSG_LINE_ASSIGNED && payload.lineId) {
      device.lineId = payload.lineId;
    }
  });
  device.send(M.MSG_PING, { clientTime: Date.now() });
  device.send(M.MSG_NEED_DISPLAY, {});
  if (!mapView) {
    await until(() => device.lineId, `${did} to be assigned a line`);
  }
  return device;
}

// ── The room ────────────────────────────────────────────────────────────────

// A saved room the spawned server restores at boot, on the sub-merge fixture,
// with short windows so the real clock is quick to walk.
async function seedRoom(stateDir) {
  const session = await buildScore("sub-merge", {
    id: ROOM,
    sessionName: ROOM,
    adminPassword: ADMIN,
    playerPassword: PLAYER,
    dataDir: FIXTURES,
    stateDir,
  });
  session.votingDuration = 1;
  session.preloadDuration = 100;
  session.standbyDuration = 1;
  await session.saveSessionStateToFile();
  return session;
}

function linesPush(op) {
  const pushes = op.of(M.MSG_SHOW_NUMBER_CONNECTION).filter((p) => Array.isArray(p.lines));
  return pushes[pushes.length - 1];
}

// The room's invariants, read from what the operator's map is told and what
// each device was told.
function assertRoomInvariants(op, devices) {
  const push = linesPush(op);
  assert.ok(push, "the operator never received the lines");
  const live = push.lines.filter((l) => l.status === "active");
  const ids = live.map((l) => l.id);
  assert.strictEqual(new Set(ids).size, ids.length, `duplicate line ids ${ids}`);
  for (const device of devices) {
    assert.ok(ids.includes(device.lineId), `${device.did} is on ${device.lineId}, not a live line (${ids})`);
  }
  const players = live.reduce((sum, l) => sum + l.players, 0);
  assert.strictEqual(players, devices.length, "a device was lost or counted twice");
  for (const l of live) {
    assert.ok(typeof l.frame === "string" && l.frame.length > 0, `${l.id} has no frame`);
  }
  return live;
}

module.exports = {
  "split, merge in a sub, undo, restart — over a real WebSocket": async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nn-e2e-"));
    const stateDir = path.join(root, "state");
    fs.mkdirSync(stateDir);
    const devices = [];
    let server = null;
    try {
      const seeded = await seedRoom(stateDir);
      const main = (name) => seeded.listFiles.indexOf(name);
      const sub = seeded.subFrames.Inner.frameList;
      const at = (name) => sub.indexOf(name);

      const env = {
        PORT: String(await freePort()),
        WS_PORT: String(await freePort()),
        SERVER_STATE_DIR: stateDir,
        SCORE_DATA_DIR: FIXTURES,
      };
      server = await startServer(env);

      const a = await openDevice(env.WS_PORT, "dA");
      const b = await openDevice(env.WS_PORT, "dB");
      const op = await openDevice(env.WS_PORT, "op", { sig: ADMIN, mapView: true });
      devices.push(a, b, op);
      const tap = (device, selectedId, cid) =>
        device.send(M.MSG_TAP, { selectedId, cid, ctx: device.context() });

      // Split on the main flow: dA takes P, dB takes Q.
      tap(a, `${main("P.svg")}#START.svg#0`, main("START.svg"));
      tap(b, `${main("Q.svg")}#START.svg#1`, main("START.svg"));
      await until(() => a.lineId !== b.lineId, "the split to resolve");
      await until(
        () => {
          const push = linesPush(op);
          if (!push) return false;
          const frames = push.lines.filter((l) => l.status === "active").map((l) => l.frame).sort();
          return frames.join() === "P.svg,Q.svg";
        },
        "both routes to land",
      );
      assertRoomInvariants(op, [a, b]);

      // Each dives into Inner — the same way, back to End.svg — and walks its
      // own branch to JOIN.svg, where one line per node merges them.
      for (const [device, from, branch, link] of [
        [a, "P.svg", "A.svg", 0],
        [b, "Q.svg", "B.svg", 1],
      ]) {
        tap(device, `${main("End.svg")}#${from}#0`, main(from));
        await until(() => device.context().startsWith("Inner"), `${device.did} to dive`);
        tap(device, `${at(branch)}#START.svg#${link}`, at("START.svg"));
        await until(
          () => (linesPush(op).lines.find((l) => l.id === device.lineId) || {}).frame === branch,
          `${device.did} to reach ${branch}`,
        );
      }
      tap(a, `${at("JOIN.svg")}#A.svg#0`, at("A.svg"));
      tap(b, `${at("JOIN.svg")}#B.svg#0`, at("B.svg"));
      await until(() => a.lineId === b.lineId, "the routes to merge on JOIN");
      assertRoomInvariants(op, [a, b]);

      // The operator undoes the merge from the map.
      const merge = await until(
        () => (linesPush(op).structuralEvents || []).find((e) => e.kind === "merge" && e.available),
        "the merge to be offered for undo",
      );
      op.send(M.MSG_SELECT_HISTORY, {
        mergeEventId: merge.eventId,
        frame: "JOIN.svg",
        operationId: "e2e-undo",
      });
      const receipt = await until(
        () => op.of(M.MSG_REWIND_DONE).find((p) => p.operationId === "e2e-undo") ||
          op.of(M.MSG_REWIND_REFUSED).find((p) => p.operationId === "e2e-undo"),
        "the undo to be answered",
      );
      assert.strictEqual(receipt.m, M.MSG_REWIND_DONE, JSON.stringify(receipt));
      await until(() => a.lineId !== b.lineId, "the devices to be separated again");
      await until(() => {
        const live = linesPush(op).lines.filter((l) => l.status === "active");
        return live.length === 2 && live.every((l) => l.sub === "Inner");
      }, "both routes back in the sub");
      const before = assertRoomInvariants(op, [a, b]);
      const frameOf = (lines, id) => lines.find((l) => l.id === id).frame;
      assert.strictEqual(frameOf(before, a.lineId), "A.svg");
      assert.strictEqual(frameOf(before, b.lineId), "B.svg");
      const linesBefore = { dA: a.lineId, dB: b.lineId };

      // Restart the server on the same state; the devices come back.
      for (const device of devices.splice(0)) device.close();
      await server.stop();
      server = await startServer(env);

      // In the opposite order to the first join: a late-join balancer handing
      // out lines in id order would otherwise give each device its old line by
      // coincidence.
      const b2 = await openDevice(env.WS_PORT, "dB");
      const a2 = await openDevice(env.WS_PORT, "dA");
      const op2 = await openDevice(env.WS_PORT, "op2", { sig: ADMIN, mapView: true });
      devices.push(a2, b2, op2);
      assert.strictEqual(a2.lineId, linesBefore.dA, "dA came back to a different line");
      assert.strictEqual(b2.lineId, linesBefore.dB, "dB came back to a different line");
      await until(() => linesPush(op2), "the restarted map to be told the lines");
      const after = assertRoomInvariants(op2, [a2, b2]);
      assert.strictEqual(frameOf(after, a2.lineId), "A.svg");
      assert.strictEqual(frameOf(after, b2.lineId), "B.svg");
      assert.ok(after.every((l) => l.sub === "Inner"), "a route lost its sub across the restart");
    } finally {
      for (const device of devices) device.close();
      if (server) await server.stop();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
};
