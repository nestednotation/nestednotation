const express = require("express");
const router = express.Router();
const { FORM_MESSAGES, MESSAGES } = require("../constants");
const { wsPath } = require("../database");
const fs = require("fs");

const { cache, SESSION_CACHE_KEY } = require("../utils/sessionCache");

let prefixDir = ".";
const testPrefixFile = prefixDir + "/account/admin.dat";
if (!fs.existsSync(testPrefixFile)) {
  prefixDir = "..";
}
const SERVER_STATE_DIR = `${prefixDir}/server_state`;

router.get(
  "/:sessionId/svgcontent.html",
  cache("30 minutes"),
  async function (req, res) {
    req.apicacheGroup = SESSION_CACHE_KEY;

    const sessionId = req.params.sessionId;
    const db = req.app.get("Database");
    const session = db.sessionTable.getById(sessionId);

    if (!session) {
      res.status(404).send("Session not found");
      return;
    }

    res.header("data-session-folder", session.folder);

    const stream = fs.createReadStream(
      `${SERVER_STATE_DIR}/${sessionId}.content.svg`,
    );
    stream.pipe(res);
  },
);

// Session Lines: on-demand sub-score frames. Read-only; mirrors the apicache of
// the main content route. Returns the rewritten frames + frame/sound lists the
// client injects when a line dives into a sub-session.
router.get(
  "/:sessionId/sub/:subName",
  cache("30 minutes"),
  function (req, res) {
    req.apicacheGroup = SESSION_CACHE_KEY;

    const { sessionId, subName } = req.params;
    const db = req.app.get("Database");
    const session = db.sessionTable.getById(sessionId);

    if (!session || !session.subFrames || !session.subFrames[subName]) {
      res.status(404).json({ error: "Sub-score not found" });
      return;
    }

    const sub = session.subFrames[subName];
    res.json({
      framesHtml: sub.framesHtml,
      frameList: sub.frameList,
      soundList: sub.soundList,
    });
  },
);

// Session Lines: the full score structure (main graph + every sub-score graph)
// for the admin live map. Read-only, pure data. Vanilla scores get a graph too
// (the map shows them as a single-line session; main.hasSessionLines tells the
// client which mode it is). Deliberately UNCACHED: session.graph is re-derived
// asynchronously after boot, and apicache would also cache a 404 emitted
// during that window — wedging the map for the whole cache TTL.
router.get("/:sessionId/graph", function (req, res) {
  const db = req.app.get("Database");
  const session = db.sessionTable.getById(req.params.sessionId);

  if (!session || !session.graph) {
    res.status(404).json({ error: "No graph (score still building?)" });
    return;
  }

  const subs = {};
  for (const [score, sub] of Object.entries(session.subFrames || {})) {
    subs[score] = sub.graph;
  }
  res.json({ main: session.graph, subs });
});

// Session Lines: standalone live score-map page (admin tool). Rendered on the
// fly (not baked/cached like the session page). Works for vanilla scores too —
// the map presents them as a single-line session.
router.get("/:sessionId/map", function (req, res) {
  const db = req.app.get("Database");
  const session = db.sessionTable.getById(req.params.sessionId);

  if (!session) {
    res.status(404).send("Session not found");
    return;
  }

  // One JSON blob instead of per-constant locals: jade renders the view from
  // disk per request, so a view newer than the running process would turn a
  // missing local into `window.X = ;` — a SyntaxError killing the whole
  // inline script. A blob just leaves new constants undefined.
  res.render("session-map", {
    sessionId: session.id,
    scoreTitle: session.folder,
    wsPath,
    constantsJson: JSON.stringify({
      MSG_PING: MESSAGES.MSG_PING,
      MSG_SHOW: MESSAGES.MSG_SHOW,
      MSG_NEED_DISPLAY: MESSAGES.MSG_NEED_DISPLAY,
      MSG_SHOW_NUMBER_CONNECTION: MESSAGES.MSG_SHOW_NUMBER_CONNECTION,
      MSG_SELECT_HISTORY: MESSAGES.MSG_SELECT_HISTORY,
      // Vanilla-mode voting/holding overlay (session-lines mode gets these
      // states in the `lines` payload instead).
      MSG_BEGIN_VOTING: MESSAGES.MSG_BEGIN_VOTING,
      MSG_BEGIN_HOLDING: MESSAGES.MSG_BEGIN_HOLDING,
      // Barrier valve strip: the admin-flagged waiting list comes in on
      // MSG_BARRIER_WAITING, and release / force-advance go back out on
      // MSG_BARRIER_RELEASED.
      MSG_BARRIER_WAITING: MESSAGES.MSG_BARRIER_WAITING,
      MSG_BARRIER_RELEASED: MESSAGES.MSG_BARRIER_RELEASED,
    }),
  });
});

router.get("/", function (req, res) {
  const sessionName = req.query.s;
  if (sessionName == null || sessionName.length == 0) {
    res
      .status(301)
      .redirect(
        `/?msg=${encodeURIComponent(FORM_MESSAGES.INVALID_SESSION_DATA)}`,
      );
    return;
  }

  const password = req.query.p;
  const db = req.app.get("Database");
  const session = db.sessionTable.getBySessionName(sessionName);
  if (
    !session ||
    (session.adminPassword !== password &&
      session.playerPassword !== password &&
      password.length != 0)
  ) {
    res
      .status(301)
      .redirect(
        `/?msg=${encodeURIComponent(FORM_MESSAGES.INVALID_SESSION_DATA)}`,
      );
    return;
  }

  const type =
    session.adminPassword === password
      ? 1
      : session.playerPassword === password
        ? 2
        : 0;

  res
    .status(301)
    .redirect(
      `/session/${session.id}/?p=${encodeURIComponent(
        password,
      )}&t=${encodeURIComponent(type)}`,
    );
});

router.get("/*", cache("30 minutes"), async function (req, res) {
  // API Cache will be clear in routes/sm.js
  req.apicacheGroup = SESSION_CACHE_KEY;

  const path = req.path.match("/(.*?)/*$");
  const sessionId = path[1];
  const password = req.query.p;
  if (sessionId == null || password == null) {
    res
      .status(301)
      .redirect(
        `/?msg=${encodeURIComponent(FORM_MESSAGES.INVALID_SESSION_DATA)}`,
      );
    return;
  }

  const db = req.app.get("Database");
  const session = db.sessionTable.getById(sessionId);
  if (session == null) {
    res
      .status(301)
      .redirect(
        `/?msg=${encodeURIComponent(FORM_MESSAGES.INVALID_SESSION_DATA)}`,
      );
    return;
  }

  if (session == null) {
    res
      .status(301)
      .redirect(
        `/?msg=${encodeURIComponent(FORM_MESSAGES.INVALID_SESSION_DATA)}`,
      );
    return;
  }

  const data = fs.readFileSync(`${SERVER_STATE_DIR}/${sessionId}.html`, {
    encoding: "utf-8",
  });
  res.send(data);
});

module.exports = router;
