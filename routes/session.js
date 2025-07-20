const express = require("express");
const router = express.Router();
const { FORM_MESSAGES } = require("../constants");
const fs = require("fs");

let prefixDir = ".";
const testPrefixFile = prefixDir + "/account/admin.dat";
if (!fs.existsSync(testPrefixFile)) {
  prefixDir = "..";
}
const SERVER_STATE_DIR = `${prefixDir}/server_state`;

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
    const stream = fs.createReadStream(
      `${SERVER_STATE_DIR}/${sessionId}.content.svg`
    );
    stream.pipe(res);
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

  const stream = fs.createReadStream(`${SERVER_STATE_DIR}/${sessionId}.html`);
  stream.pipe(res);
});

module.exports = router;
