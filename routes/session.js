var express = require("express");
var router = express.Router();
const utils = require("../utils");

router.get("/", function (req, res, next) {
  var query = req.query;
  var sessionName = query.s;
  var password = query.p;
  if (sessionName == null || sessionName.length == 0) {
    res.status(301).redirect("/?msg=1");
  } else {
    var db = req.app.get("Database");
    var session = db.session.getBySessionName(sessionName);
    if (session == null) {
      res.status(301).redirect("/?msg=1");
    } else {
      if (
        session.adminPassword == password ||
        session.playerPassword == password ||
        password.length == 0
      ) {
        var type =
          session.adminPassword == password
            ? 1
            : session.playerPassword == password
            ? 2
            : 0;
        res
          .status(301)
          .redirect(
            "/session/" + session.id + "/?p=" + password + "&t=" + type
          );
      } else {
        res.status(301).redirect("/?msg=1");
      }
    }
  }
});

router.get("/*", function (req, res, next) {
  if (req.path.endsWith("svgcontent.html")) {
    var path = req.path.match("/(.*?)/.*$");
    var sessionId = path[1];
    var db = req.app.get("Database");
    var session = db.session.getById(sessionId);
    res.send(session.svgContent);
  } else {
    var path = req.path.match("/(.*?)/*$");
    var sessionId = path[1];
    var password = req.query.p;
    if (sessionId == null || password == null) {
      res.status(301).redirect("/?msg=1");
    } else {
      var db = req.app.get("Database");
      var session = db.session.getById(sessionId);
      if (session == null) {
        res.status(301).redirect("/?msg=1");
      } else {
        var noSleepDuration = 60;
        res.render("session", {
          title: "Session",
          staffCode: password,
          sessionId: sessionId,
          hostAddress: db.hostAddress,
          webSocketPort: db.wsPort,
          noSleepDuration: noSleepDuration,

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

          svg: session.svgContent,
          scoreSlug: utils.slugify(session.folder),
          soundList: session.soundList && JSON.stringify(session.soundList),
          wsPath: db.wsPath,
        });
      }
    }
  }
});

module.exports = router;
