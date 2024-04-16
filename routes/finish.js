var express = require('express');
var router = express.Router();
var fs = require('fs');


router.get('/', function(req, res, next) {
    res.render('finish', {
        title: 'Nested Notation'
    });
});

module.exports = router;