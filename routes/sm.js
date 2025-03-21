var express = require("express");
var router = express.Router();
const { MESSAGES } = require("../constants");

/* GET home page. */
router.get("/", function (req, res, next) {
  var db = req.app.get("Database");
  var permission = req.cookies["root"];
  var username = req.cookies["un"];
  var password = req.cookies["upw"];
  var checkExist = db.admin.getByName(username);
  if (
    permission != "2" ||
    checkExist == null ||
    checkExist.password.trim() != password.trim()
  ) {
    res.status(301).redirect("/root/?msg=3");
    return;
  }

  if (req.url != "/") {
    const query = req.query;
    const sessionId = query.i;
    const name = query.n;
    const folder = query.f;
    const holdDur = query.hd;
    const voteDur = query.vd;
    const command = query.c;
    const adminpassword = query.sp;
    const playerpassword = query.pp;
    const fadeDuration = Number(query.fadeDuration);
    const isHtml5 = Boolean(query.isHtml5);

    if (
      sessionId != null &&
      name != null &&
      name.length > 0 &&
      folder != null &&
      folder.length > 0 &&
      holdDur != null &&
      holdDur.length > 0 &&
      voteDur != null &&
      voteDur.length > 0 &&
      adminpassword != null &&
      adminpassword.length > 0 &&
      playerpassword != null &&
      playerpassword.length > 0 &&
      command != null
    ) {
      if (command === "update-session") {
        //hold duration
        const session = db.sessionTable.getById(sessionId);
        if (!session) {
          console.log(`Unable to find session with ID: ${sessionId}`);
          return;
        }

        const hold = parseInt(holdDur);
        const vote = parseInt(voteDur);
        session.patchState(
          {
            isHtml5,
            fadeDuration,
            holdDuration: hold >= 0 ? hold : session.holdDuration,
            votingDuration: vote >= 0 ? vote : session.votingDuration,
          },
          true
        );

        if (session.folder.trim() != folder) {
          const listScore = db.getListScore();
          if (listScore.indexOf(folder) >= 0) {
            session.reloadScore(folder);
            session.clearAllTimer();
            session.saveSessionStateToFile();

            const sendToAllClients = req.app.get("sendToAllClients");
            sendToAllClients(session, 0, MESSAGES.MSG_NEED_DISPLAY, 0, 0);
          }
        }
      } else if (command === "create-session") {
        const listScore = db.getListScore();
        if (listScore.indexOf(folder) >= 0) {
          const admin = db.admin.getByName(username);
          const session = db.sessionTable.add(
            Date.now().toString(),
            admin.id,
            folder,
            name,
            adminpassword,
            playerpassword,
            isHtml5,
            fadeDuration
          );

          const hold = parseInt(holdDur);
          const vote = parseInt(voteDur);
          session.patchState(
            {
              holdDuration: hold >= 0 ? hold : session.holdDuration,
              votingDuration: vote >= 0 ? vote : session.votingDuration,
            },
            true
          );
        }
      } else if (command === "stop-session") {
        const session = db.sessionTable.getById(sessionId);
        if (session != null) {
          db.sessionTable.forceSessionStop(session);

          const sendToAllClientsWithDelay = req.app.get(
            "sendToAllClientsWithDelay"
          );
          sendToAllClientsWithDelay(
            session,
            0,
            MESSAGES.MSG_NEED_DISPLAY,
            0,
            0
          );
        }
      }
    }

    res.status(301).redirect("/sm");
    return;
  }

  const listSession = db.sessionTable.data.filter(
    (o) => o.ownerId == checkExist.id
  );
  const listScore = db.getListScore();
  res.render("sm", {
    title: "Nested notation",
    session: listSession,
    score: listScore,
  });
});

module.exports = router;
