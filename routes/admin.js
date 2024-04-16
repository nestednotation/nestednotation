var express = require('express');
var router = express.Router();

/* GET home page. */
router.get('/', function(req, res, next) {
    var db = req.app.get('Database');
    var permission = req.cookies['root'];
    var username = req.cookies['un'];
    var password = req.cookies['upw'];
    if (permission != '1' || username != db.adminUsername || password != db.adminPassword){
        res.status(301).redirect('/root/?msg=3');
    }

    if (req.url != '/'){
        var query = req.query;
        var index = query.i;
        var name = query.n;
        var password = query.p;
        var isActive = query.a;
        var command = query.c;
        if (index != null &&
            name != null &&
            password != null &&
            isActive != null &&
            command != null){
                if (command == 'u'){
                    var admin = db.admin.getById(index);
                    admin.name = name;
                    admin.password = password;
                    admin.isActive = isActive;
                    db.admin.dumpToFile('./account/admin.dat');
                }else if (command == 'n'){
                    db.admin.addWithIdAuto(name, password, isActive);
                    db.admin.dumpToFile('./account/admin.dat');
                }else if (command == 's'){
                    db.shouldAutoRedirect = isActive.trim() == '1'? true:false;
                    db.autoRedirectSession = name.trim();
                    db.autoRedirectPassword = password.trim();
                    db.dumpToFile('./account/db.dat')
                }
        }
        res.status(301).redirect('/admin');
        return;
    }
    var data = db.admin.data;
    var ar = db.autoRedirect;
    res.render('admin', { 
        title: 'Nested notation', 
        data: data, 
        car: db.shouldAutoRedirect? '1':'0',
        crs: db.autoRedirectSession,
        crp: db.autoRedirectPassword
    });
});

module.exports = router;
