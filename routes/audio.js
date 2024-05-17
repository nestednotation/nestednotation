var express = require("express");
var router = express.Router();
var fs = require("fs");
var utils = require("../utils");

const scoreSlugMap = {};

const scoreFolderList = fs.readdirSync("./data");
for (let scoreFolder of scoreFolderList) {
  scoreSlugMap[utils.slugify(scoreFolder)] = `./data/${scoreFolder}/Sounds`;
}

router.get("/:score/:name", function (req, res, next) {
  const scoreSlug = req.params.score;
  const audioName = req.params.name;
  const audioFilePath = `${scoreSlugMap[scoreSlug]}/${audioName}`;

  res.status(200).download(audioFilePath, `${audioName}`);
});

module.exports = router;
