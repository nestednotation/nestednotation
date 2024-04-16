var express = require('express');
var router = express.Router();

/* GET home page. */
router.get('/', function(req, res, next) {
  if (req.url == '/'){
    var db = req.app.get('Database');
    if (db.shouldAutoRedirect){
      var url = '/session?s=' + db.autoRedirectSession + '&p=' + db.autoRedirectPassword;
      res.status(301).redirect(url);
    }else{
      res.render('index', { title: 'Nested notation'});
    }
  }else{
    res.render('index', { title: 'Nested notation'});
  }
});

module.exports = router;
