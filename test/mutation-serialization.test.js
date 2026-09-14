/** Structural rewinds and live performer mutations share one session lane. */

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { BMSession } = require("../database.js");

const RUNTIME = path.join(__dirname, "..", "bin", "www");
const SESSION_MANAGER = path.join(__dirname, "..", "routes", "sm.js");

module.exports = {
  "a performer move and disconnect wait for an in-flight rewind": async () => {
    const session = new BMSession();
    const order = [];
    let releaseRewind;
    const rewindGate = new Promise((resolve) => {
      releaseRewind = resolve;
    });

    const rewind = session.runExclusively(async () => {
      order.push("rewind:start");
      await rewindGate;
      order.push("rewind:end");
    });
    const tap = session.runExclusively(async () => {
      order.push("tap");
    });
    const disconnect = session.runExclusively(async () => {
      order.push("disconnect");
    });

    await Promise.resolve();
    assert.deepStrictEqual(order, ["rewind:start"]);
    releaseRewind();
    await Promise.all([rewind, tap, disconnect]);
    assert.deepStrictEqual(order, [
      "rewind:start",
      "rewind:end",
      "tap",
      "disconnect",
    ]);
  },

  "a failed mutation does not poison the session lane": async () => {
    const session = new BMSession();
    await assert.rejects(
      session.runExclusively(async () => {
        throw new Error("expected");
      }),
      /expected/,
    );

    let ran = false;
    await session.runExclusively(async () => {
      ran = true;
    });
    assert.strictEqual(ran, true);
  },

  "runtime and score rebuild entry points use the session lane": () => {
    const runtime = fs.readFileSync(RUNTIME, "utf8");
    const manager = fs.readFileSync(SESSION_MANAGER, "utf8");

    assert.match(
      runtime,
      /return session\.runExclusively\(\(\) =>\s*messageHandleExclusively/,
      "all WebSocket messages, including MSG_TAP, must enter the session lane",
    );
    assert.match(
      runtime,
      /connection\.on\("close"[\s\S]*?\.runExclusively\(async \(\) =>/,
      "connection attrition must enter the session lane",
    );
    assert.match(
      manager,
      /await session\.runExclusively\(async \(\) =>[\s\S]*?session\.rebuildScore\(\)/,
      "score rebuilds must share the live mutation lane",
    );

    const timerSites = [
      ...runtime.matchAll(/(?:setTimeout|setInterval)\(/g),
    ];
    assert.ok(timerSites.length >= 6, "expected the runtime timer callbacks");
    for (const site of timerSites) {
      const callback = runtime.slice(site.index, site.index + 220);
      assert.match(
        callback,
        /\.runExclusively\(/,
        `timer at bin/www:${runtime.slice(0, site.index).split("\n").length} bypasses the session lane`,
      );
    }
  },
};
