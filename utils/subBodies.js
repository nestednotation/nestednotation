const zlib = require("zlib");
const { promisify } = require("util");

const gzipAsync = promisify(zlib.gzip);

// In local mode a sub-score's response goes out gzipped to a browser that
// takes gzip (routes/session.js): with no Cloudflare in front, nothing else
// compresses it. Each sub's body, and its gzip, is made once and kept with the
// sub object. A publish replaces that object, so a new score never gets an
// old body, and the old one goes with it.
//
// A publish in local mode makes them right away (database.js), so the first
// dive into a sub, when the whole line fetches it at once, does not also wait
// for its compression. A request for a sub without one makes it then.
const bodies = new WeakMap();

const subBody = (sub) => {
  let body = bodies.get(sub);
  if (!body) {
    const json = Buffer.from(
      JSON.stringify({
        framesHtml: sub.framesHtml,
        frameList: sub.frameList,
        soundList: sub.soundList,
      }),
    );
    const gzip = gzipAsync(json, { level: zlib.constants.Z_BEST_COMPRESSION });
    // A failed compression is tried again on the next request.
    gzip.catch(() => {
      if (bodies.get(sub) === body) bodies.delete(sub);
    });
    body = { json, gzip };
    bodies.set(sub, body);
  }
  return body;
};

// The body already made for `sub`, if any; makes nothing.
const peekSubBody = (sub) => bodies.get(sub);

module.exports = { subBody, peekSubBody };
