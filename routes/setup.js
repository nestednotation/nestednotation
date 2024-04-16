var express = require('express');
var router = express.Router();

/* GET home page. */
router.get('/', function(req, res, next) {
  if (req.url == '/'){
    res.render('setup', { title: 'Nested notation'});
  }else{
    var query = req.query;
    var msg = query.msg;
    if (msg != null){
        res.render('setup', { title: 'Nested notation'});
    }else{
        var username = query.un;
        var password = query.pw;
        if (username == null || username.length == 0 ||
            password == null || password.length == 0){
            res.status(301).redirect('setup/?msg=3');
        }else{
            var db = req.app.get('Database');
            if (username == db.adminUsername && password == db.adminPassword){
                res.cookie('root', 1);
                res.cookie('un', username);
                res.cookie('upw', password);
                res.status(301).redirect('admin/');
            }else{
                var candidate = db.admin.getByName(username);
                if (candidate == null || candidate.password != password || candidate.isActive != '1'){
                    res.status(301).redirect('setup/?msg=3');
                }else{
                    res.cookie('root', 2);
                    res.cookie('un', username);
                    res.cookie('upw', password);
                    res.status(301).redirect('sm/');
                }
            }
        }
    }
  }
});

module.exports = router;