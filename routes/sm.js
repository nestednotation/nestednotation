var express = require("express");
var router = express.Router();

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
  }

  if (req.url != "/") {
    var query = req.query;
    var index = query.i;
    var name = query.n;
    var folder = query.f;
    var holdDur = query.hd;
    var voteDur = query.vd;
    var command = query.c;
    var adminpassword = query.sp;
    var playerpassword = query.pp;
    let fadeDuration = Number(query.fadeDuration);
    let isHtml5 = Boolean(query.isHtml5);

    if (
      index != null &&
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
      if (command == "u") {
        //hold duration
        var session = db.session.getById(index);
        if (session != null) {
          session.isHtml5 = isHtml5;
          session.fadeDuration = fadeDuration;

          var hold = parseInt(holdDur);
          if (hold >= 0) {
            session.holdDuration = hold;
          }
          var vote = parseInt(voteDur);
          if (vote >= 0) {
            session.votingDuration = vote;
          }
          if (session.folder.trim() != folder) {
            var listScore = db.getListScore();
            if (listScore.indexOf(folder) >= 0) {
              session.loadScoreAtFolder(folder);
              var fr = req.app.get("ForceRefresh");
              fr(session);
            }
          }
        }
      } else if (command == "n") {
        var listScore = db.getListScore();
        if (listScore.indexOf(folder) >= 0) {
          var admin = db.admin.getByName(username);
          var ownerId = admin.id;
          var displayName = "mcknight";

          var session = db.session.add(
            ownerId,
            folder,
            name,
            adminpassword,
            playerpassword,
            isHtml5,
            fadeDuration
          );
          var hold = parseInt(holdDur);
          if (hold >= 0) {
            session.holdDuration = hold;
          }
          var vote = parseInt(voteDur);
          if (vote >= 0) {
            session.votingDuration = vote;
          }
        }
      } else if (command == "s") {
        var session = db.session.getById(index);
        if (session != null) {
          var fs = req.app.get("ForceStop");
          fs(session);
        }
      }
    }
    res.status(301).redirect("/sm");
    return;
  }

  var listSession = db.session.data.filter((o) => o.ownerId == checkExist.id);
  var listScore = db.getListScore();
  res.render("sm", {
    title: "Nested notation",
    session: listSession,
    score: listScore,
  });
});

module.exports = router;
