const apicache = require("apicache");

const cache = apicache.options({
  headers: {
    "cache-control": "no-cache",
  },
}).middleware;

const SESSION_CACHE_KEY = "session_html";

module.exports = { cache, apicache, SESSION_CACHE_KEY };
