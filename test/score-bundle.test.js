/**
 * Score builds publish all at once (review S6) and rediscover sounds (S7).
 *
 * Each case builds a real score from a temporary data directory into a
 * temporary state directory, then rebuilds it while a frame read is paused or
 * a read/write fails. The published score (frame lists, graph, sub-scores,
 * sounds, content hash and baked files) must stay the previous one until the
 * replacement is complete, and stay whole when the replacement fails.
 *
 * Publication itself (review F9): a build writes a new revision under its own
 * file names and switches the session's one revision reference only once all
 * of it is on disk, so the page and content routes never serve a mix.
 */

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { Writable } = require("node:stream");

const { buildScore } = require("../bin/build-score.js");

function frameSvg(links = [], attrs = "") {
  const aTags = links
    .map((h) => `<a xlink:href="${h}"><rect width="10" height="10"/></a>`)
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ${attrs}>${aTags}</svg>`;
}

// A score folder with Frames/ (and Sounds/ when given), in a fresh temporary
// data directory, plus a fresh temporary state directory for the output.
function makeWorkspace({ frames, sounds = null }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nn-bundle-"));
  const dataDir = path.join(root, "data");
  const stateDir = path.join(root, "state");
  const scoreDir = path.join(dataDir, "Score");
  fs.mkdirSync(path.join(scoreDir, "Frames"), { recursive: true });
  fs.mkdirSync(stateDir);
  for (const [name, svg] of Object.entries(frames)) {
    fs.writeFileSync(path.join(scoreDir, "Frames", name), svg);
  }
  if (sounds) {
    fs.mkdirSync(path.join(scoreDir, "Sounds"));
    for (const name of sounds) {
      fs.writeFileSync(path.join(scoreDir, "Sounds", name), "audio");
    }
  }
  return {
    root,
    dataDir,
    stateDir,
    scoreDir,
    framePath: (name) => path.join(scoreDir, "Frames", name),
    soundPath: (name) => path.join(scoreDir, "Sounds", name),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

async function build(ws, id) {
  return buildScore("Score", { id, dataDir: ws.dataDir, stateDir: ws.stateDir });
}

// The published view of a session: in-memory state plus the baked files of
// the revision it serves.
function published(session) {
  const read = (kind) => {
    const file = session.bundleFile(kind);
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  };
  return {
    listFiles: session.listFiles.slice(),
    frames: session.graph.frames.slice(),
    hasSessionLines: session.hasSessionLines,
    subScores: Object.keys(session.subFrames || {}),
    soundList: (session.soundList || []).slice(),
    contentHash: session.contentHash,
    html: read("html"),
    content: read("content.svg"),
    subs: read("subs.json"),
  };
}

function leftoverTemps(ws) {
  return fs.readdirSync(ws.stateDir).filter((f) => f.endsWith(".tmp"));
}

// Every baked file in the state directory (anything but session state).
function bakedFiles(ws) {
  return fs
    .readdirSync(ws.stateDir)
    .filter((f) => !/\.json$/.test(f) || f.endsWith(".subs.json"))
    .sort();
}

function routeHandler(routePath) {
  const router = require("../routes/session.js");
  const layer = router.stack.find((l) => l.route && l.route.path === routePath);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function requestFor(session, over = {}) {
  return {
    params: { sessionId: session.id },
    path: `/${session.id}/`,
    query: { p: "player" },
    app: { get: () => ({ sessionTable: { getById: () => session } }) },
    ...over,
  };
}

// What the page route (GET /session/:id/) answers, through its real handler.
async function servePage(session) {
  let body = null;
  await routeHandler("/*")(requestFor(session), {
    status() {
      return this;
    },
    type() {
      return this;
    },
    redirect() {},
    send(data) {
      body = data;
    },
  });
  return body;
}

// What the content route answers, streamed through its real handler.
function serveContent(session) {
  return new Promise((resolve) => {
    const chunks = [];
    const res = new Writable({
      write(chunk, enc, cb) {
        chunks.push(Buffer.from(chunk));
        cb();
      },
    });
    res.statusCode = 200;
    res.headersSent = false;
    res.header = () => {};
    res.status = (code) => {
      res.statusCode = code;
      return res;
    };
    res.type = () => res;
    res.send = (body) => resolve({ status: res.statusCode, body });
    res.on("finish", () =>
      resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }),
    );
    routeHandler("/:sessionId/svgcontent.html")(requestFor(session), res);
  });
}

// Replace fs.promises.<fn> for the duration of `work`, restoring it after.
async function withPatched(fn, replacement, work) {
  const original = fs.promises[fn];
  fs.promises[fn] = (...args) => replacement(original, ...args);
  try {
    return await work();
  } finally {
    fs.promises[fn] = original;
  }
}

// "Update session" through the real session-manager handler, recording the
// reload notices and connection resets it sends. `scores` is the folder list
// the manager checked moments before (a swap target can vanish after it).
async function updateSession(session, folder, scores = ["Score", folder]) {
  const handler = require("../routes/sm.js")
    .stack.find((l) => l.route && l.route.path === "/")
    .route.stack.find((s) => s.method === "get").handle;
  const sent = [];
  const resets = [];
  const db = {
    admin: { getByName: () => ({ id: "1", password: "pw" }) },
    sessionTable: { getById: () => session },
    getListScore: () => scores,
  };
  const helpers = {
    Database: db,
    sendToAllClients: (s, lineId, msg) => sent.push(msg.m),
    resetSessionConnections: (s) => resets.push(s.id),
  };
  const originalError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.map(String).join(" "));
  try {
    await handler(
      {
        url: "/?c=update-session",
        cookies: { root: "2", un: "admin", upw: "pw" },
        query: {
          i: session.id,
          n: "name",
          f: folder,
          hd: "0",
          vd: "10",
          c: "update-session",
          sp: "admin",
          pp: "player",
          defaultVolume: String(session.defaultVolume),
        },
        app: { get: (key) => helpers[key] },
      },
      {
        status() {
          return this;
        },
        redirect() {},
      },
    );
  } finally {
    console.error = originalError;
  }
  return { sent, resets, logged };
}

// The room a rebuild must not disturb: lines, positions and device bindings.
function room(session) {
  return {
    lines: session.lines,
    history: session.lines.map((l) => (l.history || []).slice()),
    currentIndex: session.lines.map((l) => l.currentIndex),
    deviceRegistry: JSON.stringify(session.deviceRegistry),
  };
}

// Put the room somewhere a reset would visibly undo.
function occupy(session) {
  session.lines[0].setCurrIdxTo(session.listFilesInLowerCase.indexOf("b.svg"));
  session.deviceRegistry = { d1: { lineId: session.lines[0].id } };
}

const BASE_FRAMES = {
  "START.svg": frameSvg(["B.svg"]),
  "B.svg": frameSvg([]),
};

const { MESSAGES } = require("../constants");

// START dives into the sub-score "Inner" and returns to B.
const DIVE_START = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><a session-sub-start="Inner" xlink:href="B.svg"><rect width="10" height="10"/></a></svg>`;

// BASE_FRAMES plus an "Inner" sub-score that START dives into.
function makeDiveWorkspace() {
  const ws = makeWorkspace({ frames: { ...BASE_FRAMES, "START.svg": DIVE_START } });
  const innerDir = path.join(ws.scoreDir, "Subscores", "Inner");
  const innerFrames = path.join(innerDir, "Frames");
  fs.mkdirSync(innerFrames, { recursive: true });
  fs.writeFileSync(path.join(innerFrames, "START.svg"), frameSvg(["Tail.svg"]));
  fs.writeFileSync(path.join(innerFrames, "Tail.svg"), frameSvg([], 'session-sub-end="Inner"'));
  return { ...ws, innerDir, innerFrames };
}

// The state snapshot on disk, as the next boot would read it.
function savedState(ws, session) {
  return JSON.parse(fs.readFileSync(path.join(ws.stateDir, `${session.id}.json`), "utf8"));
}

// Fail the state file's rename (the last step of writeFileAtomic) on the
// `nth` save from now, and only that one.
function failNthStateSave(nth) {
  let saves = 0;
  return async (original, from, to, ...rest) => {
    if (/[\\/][^\\/]+\.json$/.test(String(to)) && !String(to).endsWith(".subs.json")) {
      saves++;
      if (saves === nth) {
        throw Object.assign(new Error("EIO: injected"), { code: "EIO" });
      }
    }
    return original(from, to, ...rest);
  };
}

// Hold the state file's rename on the `nth` save from now until released
// (or rejected with EIO), so a test can act while that save is pending.
function gateNthStateSave(nth) {
  let saves = 0;
  let reached;
  const atGate = new Promise((resolve) => (reached = resolve));
  let settle;
  const gate = new Promise((resolve) => (settle = resolve));
  return {
    atGate,
    release: () => settle(false),
    reject: () => settle(true),
    patch: async (original, from, to, ...rest) => {
      if (/[\\/][^\\/]+\.json$/.test(String(to)) && !String(to).endsWith(".subs.json")) {
        saves++;
        if (saves === nth) {
          reached();
          if (await gate) {
            throw Object.assign(new Error("EIO: injected"), { code: "EIO" });
          }
        }
      }
      return original(from, to, ...rest);
    },
  };
}

// The real session router mounted in a real Express app, so every request
// passes through the apicache middleware in front of the handlers. `handled`
// counts requests that reached a handler (a cache hit never does).
async function startSessionServer(session) {
  const express = require("express");
  const http = require("node:http");
  const app = express();
  const counter = { handled: 0 };
  app.set("Database", {
    sessionTable: {
      getById: (id) => {
        counter.handled++;
        return id === session.id ? session : null;
      },
    },
  });
  app.use("/session", require("../routes/session.js"));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const get = (urlPath, headers = {}) =>
    new Promise((resolve, reject) => {
      http
        .get({ host: "127.0.0.1", port, path: urlPath, headers }, (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () =>
            resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }),
          );
        })
        .on("error", reject);
    });
  const urls = {
    page: `/session/${session.id}/?p=player`,
    content: `/session/${session.id}/svgcontent.html`,
    sub: `/session/${session.id}/sub/Inner`,
  };
  const fetchAll = async (headers) => ({
    page: (await get(urls.page, headers)).body,
    content: (await get(urls.content, headers)).body,
    sub: (await get(urls.sub, headers)).body,
  });
  return {
    counter,
    fetchAll,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// Fail the test instead of hanging when `promise` never settles.
function within(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// A score folder `name` whose START dives into "Inner" and returns to `ret`.
// `innerMid` adds a Mid frame to the sub-score, so two versions differ visibly.
function writeDiveScore(dataDir, name, { ret = "B.svg", innerMid = false } = {}) {
  const dir = path.join(dataDir, name);
  const frames = path.join(dir, "Frames");
  const inner = path.join(dir, "Subscores", "Inner", "Frames");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(frames, { recursive: true });
  fs.mkdirSync(inner, { recursive: true });
  fs.writeFileSync(path.join(frames, "START.svg"), DIVE_START.replace('xlink:href="B.svg"', `xlink:href="${ret}"`));
  fs.writeFileSync(path.join(frames, ret), frameSvg([]));
  fs.writeFileSync(path.join(inner, "START.svg"), frameSvg([innerMid ? "Mid.svg" : "Tail.svg"]));
  if (innerMid) fs.writeFileSync(path.join(inner, "Mid.svg"), frameSvg(["Tail.svg"]));
  fs.writeFileSync(path.join(inner, "Tail.svg"), frameSvg([], 'session-sub-end="Inner"'));
}

// Review F17: the reload notice must not beat the cache invalidation. With
// the post-publish state save held open, the requests a reloading device
// makes (page, content, sub-score) must already get the new score.
async function reloadRaceCase({ swap, saveFails }) {
  const { apicache, SESSION_CACHE_KEY } = require("../utils/sessionCache");
  const ws = makeWorkspace({ frames: BASE_FRAMES });
  let server = null;
  let gate = null;
  try {
    writeDiveScore(ws.dataDir, "Score");
    const session = await build(ws, swap ? "__bundle_cache_swap__" : "__bundle_cache_inplace__");
    occupy(session);
    apicache.clear(SESSION_CACHE_KEY);
    server = await startSessionServer(session);

    // Warm the cache, and prove the second round is served from it.
    const old = await server.fetchAll();
    assert.ok(old.page.includes('file="B.svg"'), old.page);
    const handled = server.counter.handled;
    assert.deepStrictEqual(await server.fetchAll(), old);
    assert.strictEqual(server.counter.handled, handled, "the cache was not warmed");

    // Same URLs, visibly different score: a new return frame and a longer sub.
    if (swap) {
      writeDiveScore(ws.dataDir, "Other", { ret: "X.svg", innerMid: true });
    } else {
      writeDiveScore(ws.dataDir, "Score", { ret: "C.svg", innerMid: true });
    }

    // Save 1 is the settings patch; save 2 follows the publish.
    gate = gateNthStateSave(2);
    const original = fs.promises.rename;
    fs.promises.rename = (...args) => gate.patch(original, ...args);
    let update;
    try {
      update = updateSession(session, swap ? "Other" : "Score", ["Score", "Other"]);
      await within(gate.atGate, 10000, "the post-publish state save");

      // The notice is out and the save still pending: what does a reload get?
      const now = await server.fetchAll({ "cache-control": "no-cache" });
      assert.notStrictEqual(now.page, old.page, "a reload got the cached old page");
      assert.ok(now.page.includes(swap ? 'file="X.svg"' : 'file="C.svg"'), now.page);
      assert.ok(!now.page.includes('file="B.svg"'), "the old frames are still served");
      assert.strictEqual(now.content, published(session).content);
      assert.notStrictEqual(now.content, old.content, "a reload got the cached old content");
      assert.deepStrictEqual(JSON.parse(now.sub).frameList, session.subFrames.Inner.frameList);
      assert.notDeepStrictEqual(JSON.parse(now.sub).frameList, JSON.parse(old.sub).frameList);
      assert.ok(session.subFrames.Inner.frameList.some((f) => /mid\.svg/i.test(f)));

      if (saveFails) gate.reject();
      else gate.release();
    } finally {
      gate.release();
      const result = await within(update, 10000, "the update to finish");
      fs.promises.rename = original;
      update = result;
    }

    assert.deepStrictEqual(update.sent, [MESSAGES.MSG_CHANGE_FOLDER], "expected exactly one reload notice");
    assert.deepStrictEqual(update.resets, [session.id]);
    if (swap) assert.strictEqual(session.folder, "Other");
    if (saveFails) {
      assert.ok(update.logged.some((line) => /saving its state failed/.test(line)), update.logged.join("\n"));
      assert.ok(!update.logged.some((line) => /previous score kept/.test(line)));
    } else {
      assert.deepStrictEqual(update.logged, []);
      assert.strictEqual(savedState(ws, session).contentHash, session.contentHash);
    }

    // After the save, the cache still answers with the new score.
    const after = await server.fetchAll();
    assert.ok(after.page.includes(swap ? 'file="X.svg"' : 'file="C.svg"'));
  } finally {
    if (gate) gate.release();
    if (server) await server.close();
    apicache.clear(SESSION_CACHE_KEY);
    ws.cleanup();
  }
}

module.exports = {
  "a reload after an in-place update gets the new score while the save is pending": () =>
    reloadRaceCase({ swap: false, saveFails: false }),
  "a reload after a folder swap gets the new score while the save is pending": () =>
    reloadRaceCase({ swap: true, saveFails: false }),
  "a reload after an in-place update gets the new score even when the save then fails": () =>
    reloadRaceCase({ swap: false, saveFails: true }),
  "a reload after a folder swap gets the new score even when the save then fails": () =>
    reloadRaceCase({ swap: true, saveFails: true }),

  "a parameter-only update does not reload the room, and its baked parameters are not served stale": async () => {
    const { apicache, SESSION_CACHE_KEY } = require("../utils/sessionCache");
    const ws = makeWorkspace({ frames: BASE_FRAMES });
    let server = null;
    try {
      writeDiveScore(ws.dataDir, "Score");
      const session = await build(ws, "__bundle_cache_params__");
      occupy(session);
      const roomBefore = room(session);
      apicache.clear(SESSION_CACHE_KEY);
      server = await startSessionServer(session);
      const old = await server.fetchAll();
      assert.ok(old.page.includes("window.fadeDuration = JSON.parse('1000')"), "fixture default changed");
      // The update form here sends no fade duration, so the page is re-baked.
      const update = await updateSession(session, "Score");
      assert.deepStrictEqual(update.sent, []);
      assert.deepStrictEqual(update.resets, []);
      assert.deepStrictEqual(room(session).currentIndex, roomBefore.currentIndex);
      const now = await server.fetchAll();
      assert.ok(now.page.includes("window.fadeDuration = JSON.parse('null')"), "the cached page kept the old parameters");
      assert.ok(now.page.includes('file="B.svg"'));
      assert.strictEqual(now.content, old.content);
      assert.strictEqual(now.sub, old.sub);
    } finally {
      if (server) await server.close();
      apicache.clear(SESSION_CACHE_KEY);
      ws.cleanup();
    }
  },

  "a rebuild paused mid-read still serves the previous score, then switches whole": async () => {
    const ws = makeWorkspace({ frames: BASE_FRAMES });
    try {
      const session = await build(ws, "__bundle_pause__");
      const before = published(session);

      fs.writeFileSync(ws.framePath("START.svg"), frameSvg(["B.svg", "C.svg"], 'session-split="2"'));
      fs.writeFileSync(ws.framePath("C.svg"), frameSvg([]));

      let release;
      const gate = new Promise((resolve) => (release = resolve));
      let reachedGate;
      const atGate = new Promise((resolve) => (reachedGate = resolve));

      const done = withPatched(
        "readFile",
        async (original, file, ...rest) => {
          if (String(file) === ws.framePath("C.svg").replace(/\\/g, "/") || String(file).endsWith("/Frames/C.svg")) {
            reachedGate();
            await gate;
          }
          return original(file, ...rest);
        },
        () => session.rebuildScore(),
      );

      await atGate;
      // Two frames already read, one pending: nothing of the new score is out.
      assert.deepStrictEqual(published(session), before);
      assert.deepStrictEqual(leftoverTemps(ws), []);

      release();
      assert.strictEqual(await done, true, "an edited score reports a change");

      const after = published(session);
      assert.deepStrictEqual(after.listFiles, ["B.svg", "C.svg", "START.svg"]);
      assert.deepStrictEqual(after.frames, after.listFiles);
      assert.strictEqual(after.hasSessionLines, true);
      assert.notStrictEqual(after.contentHash, before.contentHash);
      assert.ok(after.html.includes('file="C.svg"'), "the page carries the new frame");
      assert.ok(after.content.includes('file="C.svg"'));
      assert.deepStrictEqual(leftoverTemps(ws), []);
    } finally {
      ws.cleanup();
    }
  },

  "a frame read failure keeps the previous score complete and usable": async () => {
    const ws = makeWorkspace({ frames: BASE_FRAMES });
    try {
      const session = await build(ws, "__bundle_read_fail__");
      const before = published(session);
      fs.writeFileSync(ws.framePath("C.svg"), frameSvg([]));

      await assert.rejects(
        withPatched(
          "readFile",
          async (original, file, ...rest) => {
            if (String(file).endsWith("/Frames/C.svg")) {
              throw Object.assign(new Error("EIO: injected"), { code: "EIO" });
            }
            return original(file, ...rest);
          },
          () => session.rebuildScore(),
        ),
        /injected/,
      );

      assert.deepStrictEqual(published(session), before);
      assert.deepStrictEqual(leftoverTemps(ws), []);

      // The failure does not wedge the session: the next rebuild succeeds.
      assert.strictEqual(await session.rebuildScore(), true);
      assert.deepStrictEqual(session.listFiles, ["B.svg", "C.svg", "START.svg"]);
    } finally {
      ws.cleanup();
    }
  },

  "a failed write publishes none of the staged files": async () => {
    const ws = makeWorkspace({ frames: BASE_FRAMES });
    try {
      const session = await build(ws, "__bundle_write_fail__");
      const before = published(session);
      const filesBefore = bakedFiles(ws);
      fs.writeFileSync(ws.framePath("C.svg"), frameSvg([]));

      // content.svg stages first and succeeds; the page then fails to stage.
      await assert.rejects(
        withPatched(
          "writeFile",
          async (original, file, ...rest) => {
            if (/\.rev-[0-9a-z]+\.html$/.test(String(file))) {
              throw Object.assign(new Error("ENOSPC: injected"), { code: "ENOSPC" });
            }
            return original(file, ...rest);
          },
          () => session.rebuildScore(),
        ),
        /injected/,
      );

      assert.deepStrictEqual(published(session), before);
      assert.deepStrictEqual(leftoverTemps(ws), []);
      assert.deepStrictEqual(bakedFiles(ws), filesBefore, "the failed revision left files behind");
    } finally {
      ws.cleanup();
    }
  },

  "a failed folder swap keeps the old folder and room": async () => {
    const ws = makeWorkspace({ frames: BASE_FRAMES });
    try {
      const session = await build(ws, "__bundle_swap_fail__");
      const before = published(session);
      const lines = session.lines;
      fs.mkdirSync(path.join(ws.dataDir, "Other", "Frames"), { recursive: true });
      fs.writeFileSync(path.join(ws.dataDir, "Other", "Frames", "START.svg"), frameSvg([]));

      await assert.rejects(
        withPatched(
          "readFile",
          async (original, file, ...rest) => {
            if (String(file).includes("/Other/")) {
              throw new Error("injected");
            }
            return original(file, ...rest);
          },
          () => session.reloadScore("Other"),
        ),
        /injected/,
      );

      assert.strictEqual(session.folder, "Score");
      assert.strictEqual(session.lines, lines, "the room is not reset");
      assert.deepStrictEqual(published(session), before);

      await session.reloadScore("Other");
      assert.strictEqual(session.folder, "Other");
      assert.deepStrictEqual(session.listFiles, ["START.svg"]);
    } finally {
      ws.cleanup();
    }
  },

  "an in-place rebuild rediscovers main-score sounds": async () => {
    const ws = makeWorkspace({ frames: BASE_FRAMES, sounds: ["a.mp3"] });
    try {
      const session = await build(ws, "__bundle_sounds__");
      assert.strictEqual(session.hasSounds, true);
      assert.deepStrictEqual(session.soundList, ["a.mp3"]);

      // Frames untouched; only the sound inventory changes.
      fs.writeFileSync(ws.soundPath("b.mp3"), "audio");
      assert.strictEqual(await session.rebuildScore(), true, "an added sound is a change");
      assert.deepStrictEqual(session.soundList, ["a.mp3", "b.mp3"]);
      assert.ok(
        fs.readFileSync(session.bundleFile("html"), "utf8").includes("b.mp3"),
        "the page hands devices the new inventory",
      );

      fs.rmSync(ws.soundPath("a.mp3"));
      assert.strictEqual(await session.rebuildScore(), true, "a removed sound is a change");
      assert.deepStrictEqual(session.soundList, ["b.mp3"]);

      // Without a Sounds folder the score has no sounds at all.
      fs.rmSync(path.join(ws.scoreDir, "Sounds"), { recursive: true });
      assert.strictEqual(await session.rebuildScore(), true);
      assert.strictEqual(session.hasSounds, false);
      assert.deepStrictEqual(session.soundList, []);

      // Nothing changed on disk: the room is left alone.
      const lines = session.lines;
      assert.strictEqual(await session.rebuildScore(), false);
      assert.strictEqual(session.lines, lines);
    } finally {
      ws.cleanup();
    }
  },

  "the content route answers a missing file instead of crashing": async () => {
    const router = require("../routes/session.js");
    const layer = router.stack.find(
      (l) => l.route && l.route.path === "/:sessionId/svgcontent.html",
    );
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;

    const reply = await new Promise((resolve) => {
      const res = {
        headersSent: false,
        statusCode: 200,
        header() {},
        status(code) {
          this.statusCode = code;
          return this;
        },
        type() {
          return this;
        },
        send(body) {
          resolve({ status: this.statusCode, body });
        },
        // Minimal writable surface for stream.pipe on the success path.
        on() {},
        once() {},
        emit() {},
        write() {
          return true;
        },
        end() {
          resolve({ status: this.statusCode, body: "<piped>" });
        },
      };
      const session = {
        id: "__no_such_content__",
        folder: "Nope",
        bundleFile: (kind) => path.join(os.tmpdir(), `__no_such_content__.${kind}`),
      };
      const req = {
        params: { sessionId: session.id },
        app: { get: () => ({ sessionTable: { getById: () => session } }) },
      };
      handler(req, res);
    });

    assert.strictEqual(reply.status, 404);
  },
  // Review F9: publication itself. Between the first new file landing and the
  // switch, and when a later write fails, the routes keep serving one whole
  // revision.
  "page and content routes serve one revision while the next is written": async () => {
    const ws = makeWorkspace({ frames: BASE_FRAMES });
    try {
      const session = await build(ws, "__bundle_publish_gate__");
      const before = published(session);
      const pageBefore = await servePage(session);
      const contentBefore = await serveContent(session);
      assert.strictEqual(pageBefore, before.html);
      assert.strictEqual(contentBefore.body, before.content);

      fs.writeFileSync(ws.framePath("START.svg"), frameSvg(["B.svg", "C.svg"]));
      fs.writeFileSync(ws.framePath("C.svg"), frameSvg([]));

      // Hold the page write: the new content file is already on disk.
      let release;
      const gate = new Promise((resolve) => (release = resolve));
      let reachedGate;
      const atGate = new Promise((resolve) => (reachedGate = resolve));
      const done = withPatched(
        "writeFile",
        async (original, file, ...rest) => {
          if (/\.rev-[0-9a-z]+\.html$/.test(String(file))) {
            reachedGate();
            await gate;
          }
          return original(file, ...rest);
        },
        () => session.rebuildScore(),
      );

      await atGate;
      assert.strictEqual(
        bakedFiles(ws).filter((f) => f.endsWith(".content.svg")).length,
        2,
        "the new content file is not on disk yet",
      );
      assert.deepStrictEqual(published(session), before);
      assert.strictEqual(await servePage(session), pageBefore, "the page moved ahead of the score");
      const contentMid = await serveContent(session);
      assert.strictEqual(contentMid.status, 200);
      assert.strictEqual(contentMid.body, contentBefore.body, "the content moved ahead of the score");

      release();
      assert.strictEqual(await done, true);
      const after = published(session);
      assert.deepStrictEqual(after.listFiles, ["B.svg", "C.svg", "START.svg"]);
      assert.strictEqual(await servePage(session), after.html);
      assert.ok(after.html.includes('file="C.svg"'));
      assert.strictEqual((await serveContent(session)).body, after.content);
      assert.ok(after.content.includes('file="C.svg"'));
    } finally {
      ws.cleanup();
    }
  },

  "a failure at the last write keeps serving the previous revision and leaves nothing behind": async () => {
    // A score with Documentation writes about.svg last.
    const ws = makeWorkspace({ frames: BASE_FRAMES });
    try {
      const docs = path.join(ws.scoreDir, "Documentation");
      fs.mkdirSync(docs);
      fs.writeFileSync(path.join(docs, "About.svg"), frameSvg([]));
      const session = await build(ws, "__bundle_last_write__");
      const before = published(session);
      const filesBefore = bakedFiles(ws);
      assert.ok(filesBefore.some((f) => f.endsWith(".about.svg")));
      fs.writeFileSync(ws.framePath("C.svg"), frameSvg([]));

      const written = [];
      await assert.rejects(
        withPatched(
          "writeFile",
          async (original, file, ...rest) => {
            written.push(path.basename(String(file)));
            if (/\.rev-[0-9a-z]+\.about\.svg$/.test(String(file))) {
              throw Object.assign(new Error("ENOSPC: injected"), { code: "ENOSPC" });
            }
            return original(file, ...rest);
          },
          () => session.rebuildScore(),
        ),
        /injected/,
      );

      // content and page of the new revision were written before the failure.
      assert.strictEqual(written.length, 3, written.join(", "));
      assert.deepStrictEqual(published(session), before);
      assert.strictEqual(await servePage(session), before.html);
      assert.strictEqual((await serveContent(session)).body, before.content);
      assert.deepStrictEqual(bakedFiles(ws), filesBefore, "the failed revision left files behind");

      // The session is not wedged.
      assert.strictEqual(await session.rebuildScore(), true);
      assert.ok(published(session).html.includes('file="C.svg"'));
    } finally {
      ws.cleanup();
    }
  },

  "older revisions are removed after a switch, and a failed removal does not fail it": async () => {
    const ws = makeWorkspace({ frames: BASE_FRAMES });
    try {
      const session = await build(ws, "__bundle_sweep__");
      const revisionOf = (f) => /\.rev-([0-9a-z]+)\./.exec(f)[1];
      const revisions = () => [...new Set(bakedFiles(ws).map(revisionOf))].sort();
      const first = session.bundleRevision;
      // An unrevisioned file an older build left is swept too.
      fs.writeFileSync(path.join(ws.stateDir, `${session.id}.html`), "legacy");

      fs.writeFileSync(ws.framePath("C.svg"), frameSvg([]));
      assert.strictEqual(await session.rebuildScore(), true);
      const second = session.bundleRevision;
      // The replaced revision stays for a request that resolved it just before.
      assert.deepStrictEqual(revisions(), [first, second].sort());

      fs.writeFileSync(ws.framePath("D.svg"), frameSvg([]));
      let refused = 0;
      await withPatched(
        "rm",
        async (original, file, ...rest) => {
          if (String(file).includes(`.rev-${first}.`)) {
            refused++;
            throw Object.assign(new Error("EBUSY: injected"), { code: "EBUSY" });
          }
          return original(file, ...rest);
        },
        async () => {
          assert.strictEqual(await session.rebuildScore(), true, "a cleanup failure failed the publish");
        },
      );
      const third = session.bundleRevision;
      assert.ok(refused > 0);
      assert.ok(published(session).html.includes('file="D.svg"'), "the switch did not happen");
      assert.deepStrictEqual(revisions(), [first, second, third].sort());

      // The next publish sweeps what the refused removal left.
      fs.writeFileSync(ws.framePath("E.svg"), frameSvg([]));
      assert.strictEqual(await session.rebuildScore(), true);
      assert.deepStrictEqual(revisions(), [third, session.bundleRevision].sort());

      // Deleting the session removes every revision.
      await session.deleteStateFile();
      assert.deepStrictEqual(bakedFiles(ws), []);
    } finally {
      ws.cleanup();
    }
  },

  // Review F13: a rebuild that finds no score is a failed rebuild, not an
  // empty replacement. Through the real session-manager handler, the live
  // score, its served files, the room and the devices are all left alone.
  ...Object.fromEntries(
    [
      [
        "an emptied Frames folder",
        (ws) => {
          for (const name of fs.readdirSync(path.join(ws.scoreDir, "Frames"))) {
            fs.rmSync(ws.framePath(name));
          }
          return () => {
            for (const [name, svg] of Object.entries(BASE_FRAMES)) {
              fs.writeFileSync(ws.framePath(name), svg);
            }
          };
        },
      ],
      [
        "a missing score folder",
        (ws) => {
          const aside = `${ws.scoreDir}.aside`;
          fs.renameSync(ws.scoreDir, aside);
          return () => fs.renameSync(aside, ws.scoreDir);
        },
      ],
    ].map(([what, remove]) => [
      `an in-place update over ${what} keeps the live score, room and devices`,
      async () => {
        const ws = makeWorkspace({ frames: BASE_FRAMES });
        try {
          const session = await build(ws, "__bundle_unavailable__");
          occupy(session);
          const before = published(session);
          const roomBefore = room(session);
          const revision = session.bundleRevision;
          const pageBefore = await servePage(session);
          const contentBefore = await serveContent(session);

          const restore = remove(ws);
          await assert.rejects(session.rebuildScore(), { code: "SCORE_UNAVAILABLE" });

          const update = await updateSession(session, "Score");
          assert.deepStrictEqual(update.sent, [], "a reload notice went out");
          assert.deepStrictEqual(update.resets, [], "connections were reset");
          assert.ok(
            update.logged.some((line) => /previous score kept/.test(line)),
            "the failure was not reported",
          );

          assert.strictEqual(session.folder, "Score");
          assert.strictEqual(session.bundleRevision, revision);
          assert.strictEqual(session.scoreUnavailable, null);
          assert.deepStrictEqual(published(session), before);
          assert.deepStrictEqual(room(session), roomBefore, "the room was reset");
          assert.strictEqual(await servePage(session), pageBefore);
          assert.deepStrictEqual(await serveContent(session), contentBefore);

          // The score comes back unchanged: nothing to reload, room intact.
          restore();
          const back = await updateSession(session, "Score");
          assert.deepStrictEqual(back.sent, []);
          assert.deepStrictEqual(room(session), roomBefore);
        } finally {
          ws.cleanup();
        }
      },
    ]),
  ),

  "a swap to a folder that vanished after the listing keeps the old folder and room": async () => {
    const ws = makeWorkspace({ frames: BASE_FRAMES });
    try {
      const session = await build(ws, "__bundle_swap_gone__");
      occupy(session);
      const before = published(session);
      const roomBefore = room(session);
      const revision = session.bundleRevision;

      // The manager listed "Gone" as a score; it is not on disk any more.
      await assert.rejects(session.reloadScore("Gone"), { code: "SCORE_UNAVAILABLE" });
      const update = await updateSession(session, "Gone", ["Score", "Gone"]);
      assert.deepStrictEqual(update.sent, [], "a reload notice went out");
      assert.deepStrictEqual(update.resets, []);

      // An emptied target is refused the same way.
      fs.mkdirSync(path.join(ws.dataDir, "Empty", "Frames"), { recursive: true });
      await assert.rejects(session.reloadScore("Empty"), { code: "SCORE_UNAVAILABLE" });

      assert.strictEqual(session.folder, "Score");
      assert.strictEqual(session.bundleRevision, revision);
      assert.deepStrictEqual(published(session), before);
      assert.deepStrictEqual(room(session), roomBefore);
      assert.strictEqual(await servePage(session), before.html);
    } finally {
      ws.cleanup();
    }
  },

  "a session that finds no score before any publish serves no older page": async () => {
    const ws = makeWorkspace({ frames: BASE_FRAMES });
    try {
      const id = "__bundle_never_built__";
      // Baked files an older build left under the unrevisioned names.
      fs.writeFileSync(path.join(ws.stateDir, `${id}.html`), "stale page");
      fs.writeFileSync(path.join(ws.stateDir, `${id}.content.svg`), "stale content");

      const session = await buildScore("Gone", { id, dataDir: ws.dataDir, stateDir: ws.stateDir });
      assert.strictEqual(session.scoreUnavailable, "missing");
      assert.strictEqual(session.bundleRevision, null);
      assert.deepStrictEqual(session.listFiles, []);
      assert.strictEqual(await servePage(session), "Score unavailable");
      assert.deepStrictEqual(await serveContent(session), {
        status: 503,
        body: "Score unavailable",
      });

      // Still missing on the next update: nothing changed, nothing sent.
      assert.strictEqual(await session.rebuildScore(), false);

      // Once a score is published, it is served and the flag clears.
      await session.reloadScore("Score");
      assert.strictEqual(session.scoreUnavailable, null);
      assert.ok(session.bundleRevision);
      assert.ok((await servePage(session)).includes('file="START.svg"'));
      assert.strictEqual((await serveContent(session)).status, 200);
    } finally {
      ws.cleanup();
    }
  },

  // Review F15: a sub-score the frames still dive into is a dependency of the
  // replacement. Missing, emptied or unreadable, the update fails whole.
  ...Object.fromEntries(
    [
      [
        "is missing",
        (ws) => {
          const aside = `${ws.innerDir}.aside`;
          fs.renameSync(ws.innerDir, aside);
          return { restore: () => fs.renameSync(aside, ws.innerDir) };
        },
      ],
      [
        "has no frames",
        (ws) => {
          const saved = {};
          for (const name of fs.readdirSync(ws.innerFrames)) {
            saved[name] = fs.readFileSync(path.join(ws.innerFrames, name));
            fs.rmSync(path.join(ws.innerFrames, name));
          }
          return {
            restore: () => {
              for (const [name, data] of Object.entries(saved)) {
                fs.writeFileSync(path.join(ws.innerFrames, name), data);
              }
            },
          };
        },
      ],
      [
        "cannot be looked up",
        () => ({
          restore: () => {},
          stat: async (original, target, ...rest) => {
            if (String(target).replace(/\\/g, "/").includes("/Subscores/Inner")) {
              throw Object.assign(new Error("EACCES: injected"), { code: "EACCES" });
            }
            return original(target, ...rest);
          },
        }),
      ],
    ].map(([what, breakSub]) => [
      `an update whose referenced sub-score ${what} keeps the live score, room and devices`,
      async () => {
        const ws = makeDiveWorkspace();
        try {
          const session = await build(ws, "__bundle_sub_gone__");
          assert.deepStrictEqual(Object.keys(session.subFrames), ["Inner"]);
          occupy(session);
          const before = published(session);
          const roomBefore = room(session);
          const revision = session.bundleRevision;
          const subLinks = JSON.stringify(session.graph.subLinks);
          const pageBefore = await servePage(session);

          // An unrelated main-frame edit rides along: without the guard it
          // would publish and reset the room.
          fs.writeFileSync(ws.framePath("C.svg"), frameSvg([]));
          const broken = breakSub(ws);
          const attempt = () =>
            broken.stat ? withPatched("stat", broken.stat, () => updateSession(session, "Score")) : updateSession(session, "Score");
          const direct = () =>
            broken.stat ? withPatched("stat", broken.stat, () => session.rebuildScore()) : session.rebuildScore();

          await assert.rejects(direct(), broken.stat ? { code: "EACCES" } : { code: "SCORE_UNAVAILABLE", subs: [{ score: "Inner", reason: what === "is missing" ? "missing" : "empty" }] });

          const update = await attempt();
          assert.deepStrictEqual(update.sent, [], "a reload notice went out");
          assert.deepStrictEqual(update.resets, [], "connections were reset");
          assert.ok(
            update.logged.some((line) => /previous score kept/.test(line)),
            "the failure was not reported",
          );
          assert.strictEqual(session.bundleRevision, revision);
          assert.deepStrictEqual(published(session), before);
          assert.strictEqual(JSON.stringify(session.graph.subLinks), subLinks);
          assert.deepStrictEqual(room(session), roomBefore, "the room was reset");
          assert.strictEqual(await servePage(session), pageBefore);

          // Back on disk: the pending edit publishes, sub-score included.
          broken.restore();
          const back = await updateSession(session, "Score");
          assert.deepStrictEqual(back.sent, [MESSAGES.MSG_CHANGE_FOLDER]);
          assert.deepStrictEqual(published(session).subScores, ["Inner"]);
          assert.ok(published(session).listFiles.includes("C.svg"));
        } finally {
          ws.cleanup();
        }
      },
    ]),
  ),

  "dropping the dive reference retires its sub-score": async () => {
    const ws = makeDiveWorkspace();
    try {
      const session = await build(ws, "__bundle_sub_retired__");
      fs.writeFileSync(ws.framePath("START.svg"), frameSvg(["B.svg"]));
      fs.rmSync(ws.innerDir, { recursive: true });

      const update = await updateSession(session, "Score");
      assert.deepStrictEqual(update.sent, [MESSAGES.MSG_CHANGE_FOLDER]);
      assert.deepStrictEqual(published(session).subScores, []);
      assert.strictEqual(published(session).subs, null);
    } finally {
      ws.cleanup();
    }
  },

  "before any publish, a score goes live without a missing sub-score": async () => {
    const ws = makeDiveWorkspace();
    try {
      fs.rmSync(ws.innerDir, { recursive: true });
      const session = await build(ws, "__bundle_sub_initial__");
      assert.ok(session.bundleRevision);
      assert.deepStrictEqual(Object.keys(session.subFrames), []);
      assert.deepStrictEqual(session.listFiles, ["B.svg", "START.svg"]);
    } finally {
      ws.cleanup();
    }
  },

  // Review F16: publishing is the commit point. A state save that fails after
  // it cannot keep the previous score, so devices still hear about the new
  // one, the failure is reported as a save failure, and updating again
  // (nothing further edited) writes the snapshot.
  "a failed state save after an in-place publish still reloads the room and a retry saves it": async () => {
    const ws = makeWorkspace({ frames: BASE_FRAMES });
    try {
      const session = await build(ws, "__bundle_post_save__");
      occupy(session);
      const roomBefore = room(session);
      const revision = session.bundleRevision;
      fs.writeFileSync(ws.framePath("C.svg"), frameSvg([]));

      // Save 1 is the settings patch; save 2 follows the publish.
      const update = await withPatched("rename", failNthStateSave(2), () => updateSession(session, "Score"));
      assert.notStrictEqual(session.bundleRevision, revision, "the rebuild did not publish");
      assert.ok((await servePage(session)).includes('file="C.svg"'));
      assert.deepStrictEqual(update.resets, [session.id]);
      assert.deepStrictEqual(update.sent, [MESSAGES.MSG_CHANGE_FOLDER], "the room was not told to reload");
      assert.notDeepStrictEqual(room(session).currentIndex, roomBefore.currentIndex, "the room was not reset");
      assert.ok(update.logged.some((line) => /saving its state failed/.test(line)), update.logged.join("\n"));
      assert.ok(!update.logged.some((line) => /previous score kept/.test(line)), "claimed the old score was kept");
      assert.notStrictEqual(savedState(ws, session).contentHash, session.contentHash, "the failed save landed anyway");

      // Storage is back; update again with nothing edited.
      const retry = await updateSession(session, "Score");
      assert.deepStrictEqual(retry.logged, []);
      assert.deepStrictEqual(retry.sent, [], "an unchanged score reloaded the room again");
      const saved = savedState(ws, session);
      assert.strictEqual(saved.contentHash, session.contentHash);
      assert.strictEqual(saved.folder, "Score");
      assert.deepStrictEqual(
        saved.lines.map((l) => l.currentIndex),
        session.lines.map((l) => l.currentIndex),
      );
    } finally {
      ws.cleanup();
    }
  },

  "a failed state save after a folder swap still reloads the room and a retry saves it": async () => {
    const ws = makeWorkspace({ frames: BASE_FRAMES });
    try {
      const otherFrames = path.join(ws.dataDir, "Other", "Frames");
      fs.mkdirSync(otherFrames, { recursive: true });
      fs.writeFileSync(path.join(otherFrames, "START.svg"), frameSvg(["X.svg"]));
      fs.writeFileSync(path.join(otherFrames, "X.svg"), frameSvg([]));
      const session = await build(ws, "__bundle_swap_post_save__");
      occupy(session);

      const update = await withPatched("rename", failNthStateSave(2), () =>
        updateSession(session, "Other", ["Score", "Other"]),
      );
      assert.strictEqual(session.folder, "Other");
      assert.ok((await servePage(session)).includes('file="X.svg"'));
      assert.deepStrictEqual(update.resets, [session.id]);
      assert.deepStrictEqual(update.sent, [MESSAGES.MSG_CHANGE_FOLDER]);
      assert.ok(update.logged.some((line) => /saving its state failed/.test(line)), update.logged.join("\n"));
      assert.ok(!update.logged.some((line) => /previous score kept/.test(line)));
      assert.strictEqual(savedState(ws, session).folder, "Score", "the failed save landed anyway");

      const retry = await updateSession(session, "Other", ["Score", "Other"]);
      assert.deepStrictEqual(retry.logged, []);
      assert.deepStrictEqual(retry.sent, []);
      const saved = savedState(ws, session);
      assert.strictEqual(saved.folder, "Other");
      assert.strictEqual(saved.contentHash, session.contentHash);
    } finally {
      ws.cleanup();
    }
  },
};
