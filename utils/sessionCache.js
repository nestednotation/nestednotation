const apicache = require("apicache");

const cache = apicache.options({
  headers: {
    "cache-control": "no-cache",
  },
}).middleware;

module.exports = { cache, apicache };
