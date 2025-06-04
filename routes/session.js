const express = require("express");
const router = express.Router();

const utils = require("../utils");
const { FORM_MESSAGES } = require("../constants");

router.get("/", function (req, res) {
  const sessionName = req.query.s;
  if (sessionName == null || sessionName.length == 0) {
    res
      .status(301)
      .redirect(
        `/?msg=${encodeURIComponent(FORM_MESSAGES.INVALID_SESSION_DATA)}`
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
        `/?msg=${encodeURIComponent(FORM_MESSAGES.INVALID_SESSION_DATA)}`
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
        password
      )}&t=${encodeURIComponent(type)}`
    );
});

router.get("/*", function (req, res) {
  if (req.path.endsWith("svgcontent.html")) {
    const path = req.path.match("/(.*?)/.*$");
    const sessionId = path[1];
    const db = req.app.get("Database");
    const session = db.sessionTable.getById(sessionId);
    res.send(session.svgContent);
    return;
  }

  const path = req.path.match("/(.*?)/*$");
  const sessionId = path[1];
  const password = req.query.p;
  if (sessionId == null || password == null) {
    res
      .status(301)
      .redirect(
        `/?msg=${encodeURIComponent(FORM_MESSAGES.INVALID_SESSION_DATA)}`
      );
    return;
  }

  const db = req.app.get("Database");
  const session = db.sessionTable.getById(sessionId);
  if (session == null) {
    res
      .status(301)
      .redirect(
        `/?msg=${encodeURIComponent(FORM_MESSAGES.INVALID_SESSION_DATA)}`
      );
    return;
  }

  res.render("session", {
    title: `Session: ${session.folder}`,
    staffCode: password,
    sessionId: sessionId,
    hostAddress: db.hostAddress,
    webSocketPort: db.wsPort,
    noSleepDuration: 60,
    scoreTitle: session.folder,

    msgPing: db.MSG_PING,
    msgTap: db.MSG_TAP,
    msgShow: db.MSG_SHOW,
    msgNeedDisplay: db.MSG_NEED_DISPLAY,
    msgUpdateVoting: db.MSG_UPDATE_VOTING,
    msgBeginVoting: db.MSG_BEGIN_VOTING,
    msgBeginStandby: db.MSG_BEGIN_STANDBY,
    msgCheckHold: db.MSG_CHECK_HOLD,
    msgBeginHolding: db.MSG_BEGIN_HOLDING,
    msgFinish: db.MSG_FINISH,
    msgPause: db.MSG_PAUSE,
    msgSelectHistory: db.MSG_SELECT_HISTORY,
    msgShowNumberConnection: db.MSG_SHOW_NUMBER_CONNECTION,

    fadeDuration: JSON.stringify(session.fadeDuration),
    isHtml5: JSON.stringify(session.isHtml5),
    sessionSvg: session.svgContent,
    scoreSlug: utils.slugify(session.folder),
    soundFileList: session.soundList && JSON.stringify(session.soundList),
    wsPath: db.wsPath,
    aboutNestedNotationSvg: db.aboutSvg,
    aboutScoreSvg: session.aboutSvg,
    scoreHasAbout: session.aboutSvg !== null,
    votingSize: session.votingSize,
    qrSharePath: `/session/${session.id}/?p=${encodeURIComponent(
      session.playerPassword
    )}&t=2`,
    listFiles: JSON.stringify(session.listFiles),
  });
});

module.exports = router;
