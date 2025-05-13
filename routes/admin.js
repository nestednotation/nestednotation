var express = require("express");
var router = express.Router();

const { FORM_MESSAGES } = require("../constants");

/* GET home page. */
router.get("/", function (req, res, next) {
  const db = req.app.get("Database");
  const permission = req.cookies["root"];
  const username = req.cookies["un"];
  const password = req.cookies["upw"];

  if (
    permission != "1" ||
    username != db.adminUsername ||
    password != db.adminPassword
  ) {
    res
      .status(301)
      .redirect(
        `/root/?msg=${encodeURIComponent(FORM_MESSAGES.INVALID_ADMIN_USER)}`
      );
  }

  if (req.url != "/") {
    const query = req.query;
    const index = query.i;
    const name = query.n;
    const password = query.p;
    const isActive = query.a;
    const command = query.c;
    if (
      index != null &&
      name != null &&
      password != null &&
      isActive != null &&
      command != null
    ) {
      if (command == "u") {
        const admin = db.admin.getById(index);
        admin.name = name;
        admin.password = password;
        admin.isActive = isActive;
        db.admin.dumpToFile("./account/admin.dat");
      } else if (command == "n") {
        db.admin.addWithIdAuto(name, password, isActive);
        db.admin.dumpToFile("./account/admin.dat");
      } else if (command == "s") {
        db.shouldAutoRedirect = isActive.trim() == "1" ? true : false;
        db.autoRedirectSession = name.trim();
        db.autoRedirectPassword = password.trim();
        db.dumpToFile("./account/db.dat");
      }
    }
    res.status(301).redirect("/admin");
    return;
  }

  res.render("admin", {
    title: "Nested notation",
    data: db.admin.data,
    car: db.shouldAutoRedirect ? "1" : "0",
    crs: db.autoRedirectSession,
    crp: db.autoRedirectPassword,
  });
});

module.exports = router;
