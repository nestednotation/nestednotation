const express = require("express");
const router = express.Router();

const { FORM_MESSAGES } = require("../constants");

/* GET home page. */
router.get("/", function (req, res) {
  if (req.url == "/") {
    res.render("setup", { title: "Nested notation" });
  } else {
    const query = req.query;
    const msg = query.msg;
    if (msg != null) {
      res.render("setup", { title: "Nested notation" });
    } else {
      const username = query.un;
      const password = query.pw;
      if (
        username == null ||
        username.length == 0 ||
        password == null ||
        password.length == 0
      ) {
        res
          .status(301)
          .redirect(
            `setup/?msg=${encodeURIComponent(FORM_MESSAGES.INVALID_ADMIN_USER)}`
          );
      } else {
        const db = req.app.get("Database");
        if (username == db.adminUsername && password == db.adminPassword) {
          res.cookie("root", 1);
          res.cookie("un", username);
          res.cookie("upw", password);
          res.status(301).redirect("admin/");
        } else {
          const candidate = db.admin.getByName(username);
          if (
            candidate == null ||
            candidate.password != password ||
            candidate.isActive != "1"
          ) {
            res
              .status(301)
              .redirect(
                `setup/?msg=${encodeURIComponent(
                  FORM_MESSAGES.INVALID_ADMIN_USER
                )}`
              );
          } else {
            res.cookie("root", 2);
            res.cookie("un", username);
            res.cookie("upw", password);
            res.status(301).redirect("sm/");
          }
        }
      }
    }
  }
});

module.exports = router;
