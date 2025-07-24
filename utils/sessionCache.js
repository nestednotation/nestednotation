const fs = require("fs");

let prefixDir = ".";
const testPrefixFile = prefixDir + "/account/admin.dat";
if (!fs.existsSync(testPrefixFile)) {
  prefixDir = "..";
}
const SERVER_STATE_DIR = `${prefixDir}/server_state`;

const EXPIRED_TIME = 1000 * 120;

class SessionCache {
  cache = new Map();

  constructor() {
    // Clean up expired cache entries every minute
    setInterval(() => {
      for (const [sessionId, { expiresAt }] of this.cache.entries()) {
        if (expiresAt < Date.now()) {
          this.cache.delete(sessionId);
          console.log("cache removed", sessionId);
        }
      }
      console.log("SessionCache size:", this.cache.size);
    }, EXPIRED_TIME);
  }

  async get(sessionId) {
    if (this.cache.has(sessionId)) {
      console.log("cache reset", sessionId);
      const cachedData = this.cache.get(sessionId);
      cachedData.expiresAt = Date.now() + EXPIRED_TIME;
      this.cache.set(sessionId, cachedData);
      return cachedData.data;
    }

    const filePath = `${SERVER_STATE_DIR}/${sessionId}.html`;
    const data = await fs.promises.readFile(filePath, "utf8");
    this.cache.set(sessionId, { data, expiresAt: Date.now() + EXPIRED_TIME });
    console.log("cache stored", sessionId);
    return data;
  }
}

module.exports = SessionCache;
