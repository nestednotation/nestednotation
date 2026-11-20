#!/usr/bin/env node
/**
 * Score-map update cost, measured on the real snapshot path (review T6/S2).
 *
 *   node test/bench/map-payload.bench.js [cycles...] [--devices N] [--trail N]
 *
 * Builds a looping score (START splits two ways, both routes meet again on J
 * and merge, J leads back to START) and drives it through the production
 * `bin/www` handlers (test/www-harness.js): real taps, real split and merge
 * events, trails that grow every lap. Then it times the real
 * `updateNumberOfConnectionForSession` — structural projection, latecomer
 * counts, checkpoint options, per-line trails, serialization and fan-out to
 * every admin tab — cold (projection cache dropped) and warm, and records
 * what each kind of tab receives.
 *
 * Not part of `npm test`: the numbers depend on the host. The handler cases in
 * test/map-snapshot.test.js pin the size behaviour that must not regress.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Build output goes to a state directory the benchmark creates and owns, even
// when the caller has SERVER_STATE_DIR set: that may be a real server's state,
// and cleanup removes the owned directory recursively. Set before database.js
// loads, which reads it once.
const callerStateDir = process.env.SERVER_STATE_DIR;
const benchStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nn-bench-state-"));
process.env.SERVER_STATE_DIR = benchStateDir;

const { loadWww, settle } = require("../www-harness");
const { buildScore } = require("../../bin/build-score.js");
const { MESSAGES: M } = require("../../constants");

const ADMIN = "admin";
const PLAYER = "player";

function frame(attrs, links) {
  const a = links.map((h) => `<a xlink:href="${h}"><rect width="9" height="9"/></a>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ${attrs}>${a}</svg>`;
}

function writeLoopScore(dataDir) {
  const dir = path.join(dataDir, "Loop", "Frames");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "START.svg"), frame('voting="1" holding="false" session-split="2"', ["P.svg", "Q.svg"]));
  fs.writeFileSync(path.join(dir, "P.svg"), frame('voting="0" holding="false"', ["J.svg"]));
  fs.writeFileSync(path.join(dir, "Q.svg"), frame('voting="0" holding="false"', ["J.svg"]));
  fs.writeFileSync(path.join(dir, "J.svg"), frame('voting="0" holding="false"', ["START.svg", "W1.svg"]));
  // A structure-free loop for growing one long trail.
  fs.writeFileSync(path.join(dir, "W1.svg"), frame('voting="0" holding="false"', ["W2.svg"]));
  fs.writeFileSync(path.join(dir, "W2.svg"), frame('voting="0" holding="false"', ["W1.svg"]));
}

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { cycles: [], devices: 40, trail: 300 };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--devices") out.devices = Number(args[++i]);
    else if (args[i] === "--trail") out.trail = Number(args[++i]);
    else out.cycles.push(Number(args[i]));
  }
  if (out.cycles.length === 0) out.cycles = [10, 25, 50];
  return out;
}

async function join(h, session, did, sig = PLAYER, mapView = undefined) {
  const conn = h.connect({ label: did });
  await h.send(conn, M.MSG_PING, { sid: session.id, sig, did, clientTime: 0, mapView });
  await h.send(conn, M.MSG_NEED_DISPLAY, { sid: session.id, sig, did, mapView });
  return conn;
}

function bytesOf(payload) {
  return Buffer.byteLength(JSON.stringify(payload));
}

async function lap(h, session, drivers, back = true) {
  const idx = (n) => session.listFilesInLowerCase.indexOf(n.toLowerCase());
  const tap = (conn, from, to, linkIdx) =>
    h.send(conn, M.MSG_TAP, {
      sid: session.id,
      sig: PLAYER,
      did: conn.label,
      cid: idx(from),
      selectedId: `${idx(to)}#${from}#${linkIdx}`,
      ctx: "",
    });
  const [a, b] = drivers;
  await tap(a, "START.svg", "P.svg", 0);
  await tap(b, "START.svg", "Q.svg", 1);
  for (let i = 0; i < 40 && a.lineId === b.lineId; i++) await h.advance(250);
  if (a.lineId === b.lineId) throw new Error("the split never resolved");
  await h.advance(1500);
  await tap(a, "P.svg", "J.svg", 0);
  await tap(b, "Q.svg", "J.svg", 0);
  for (let i = 0; i < 40 && a.lineId !== b.lineId; i++) await h.advance(250);
  if (a.lineId !== b.lineId) throw new Error("the routes never merged on J");
  await h.advance(1500);
  if (!back) return;
  await tap(a, "J.svg", "START.svg", 0);
  await h.advance(1500);
}

function timeIt(fn, repeat) {
  const started = process.hrtime.bigint();
  for (let i = 0; i < repeat; i++) fn();
  return Number(process.hrtime.bigint() - started) / 1e6 / repeat;
}

async function walkTrail(h, session, driver, steps) {
  const idx = (n) => session.listFilesInLowerCase.indexOf(n.toLowerCase());
  let from = "J.svg";
  let to = "W1.svg";
  let link = 1;
  for (let i = 0; i < steps; i++) {
    await h.send(driver, M.MSG_TAP, {
      sid: session.id,
      sig: PLAYER,
      did: driver.label,
      cid: idx(from),
      selectedId: `${idx(to)}#${from}#${link}`,
      ctx: "",
    });
    await h.advance(1200);
    [from, to, link] = [to, to === "W1.svg" ? "W2.svg" : "W1.svg", 0];
  }
}

async function measure(cycles, devices, trail) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nn-bench-"));
  let h;
  try {
    const dataDir = path.join(root, "data");
    writeLoopScore(dataDir);
    const session = await buildScore("Loop", { id: `__bench_${cycles}__`, dataDir });
    h = loadWww();
    h.addSession(session);
    const drivers = [await join(h, session, "drvA"), await join(h, session, "drvB")];
    for (let i = 0; i < devices; i++) await join(h, session, `p${i}`);
    const maps = [await join(h, session, "map1", ADMIN, true), await join(h, session, "map2", ADMIN, true)];
    const tab = await join(h, session, "adminTab", ADMIN);

    const countPushes = () =>
      maps[0].sent.filter((p) => p.m === M.MSG_SHOW_NUMBER_CONNECTION).length;
    let pushesInLaps = 0;
    for (let c = 0; c < cycles; c++) {
      const before = countPushes();
      await lap(h, session, drivers);
      pushesInLaps += countPushes() - before;
    }
    // One more lap that stops on J, then round the W loop.
    await lap(h, session, drivers, false);
    await walkTrail(h, session, drivers[0], trail);
    await settle();

    const push = () => h.www.pushConnectionSnapshot(session);
    const lastOf = (conn) =>
      conn.sent.filter((p) => p.m === M.MSG_SHOW_NUMBER_CONNECTION && !p.structuralDetails).pop();

    const coldMs = timeIt(() => {
      session.__structuralProjection = undefined;
      push();
    }, 5);
    const warmMs = timeIt(push, 50);

    const mapBytes = bytesOf(lastOf(maps[0]));
    const tabBytes = bytesOf(lastOf(tab));
    const trailBytes = bytesOf((lastOf(maps[0]).lines || []).map((l) => [l.trail, l.mainTrail]));

    await h.send(maps[0], M.MSG_NEED_DISPLAY, { sid: session.id, sig: ADMIN, did: "map1", mapView: true, structuralDetails: true });
    const details = maps[0].sent.filter((p) => p.structuralDetails).pop();

    return {
      cycles,
      devices,
      splitEvents: session.splitEvents.length,
      mergeEvents: session.mergeEvents.length,
      trailLength: Math.max(...session.lines.map((l) => l.history.length)),
      coldMs: coldMs.toFixed(2),
      warmMs: warmMs.toFixed(2),
      mapPushBytes: mapBytes,
      ofWhichTrails: trailBytes,
      adminTabPushBytes: tabBytes,
      detailBytes: details ? bytesOf(details) : 0,
      pushesPerLap: (pushesInLaps / cycles).toFixed(1),
    };
  } finally {
    if (h) h.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function main() {
  try {
    const { cycles, devices, trail } = parseArgs();
    const rows = [];
    for (const c of cycles) rows.push(await measure(c, devices, trail));
    console.table(rows);
  } finally {
    // Only the directory created above, whether or not a measurement failed.
    fs.rmSync(benchStateDir, { recursive: true, force: true });
    if (callerStateDir === undefined) delete process.env.SERVER_STATE_DIR;
    else process.env.SERVER_STATE_DIR = callerStateDir;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
