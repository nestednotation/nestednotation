/** Responsive map controls and uniquely correlated rewind receipts. */

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const CLIENT = fs.readFileSync(
  path.join(ROOT, "public", "javascripts", "session-map.js"),
  "utf8",
);
const CSS = fs.readFileSync(
  path.join(ROOT, "public", "stylesheets", "style.css"),
  "utf8",
);
const RUNTIME = fs.readFileSync(path.join(ROOT, "bin", "www"), "utf8");
const VIEW = fs.readFileSync(
  path.join(ROOT, "views", "session-map.jade"),
  "utf8",
);

function between(source, start, end) {
  const from = source.indexOf(start);
  assert.notStrictEqual(from, -1, `missing ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.notStrictEqual(to, -1, `missing ${end}`);
  return source.slice(from, to);
}

function ruleContaining(source, selector) {
  const at = source.indexOf(selector);
  assert.notStrictEqual(at, -1, `missing CSS selector ${selector}`);
  const open = source.indexOf("{", at);
  const close = source.indexOf("}", open);
  assert.notStrictEqual(open, -1, `missing body for ${selector}`);
  assert.notStrictEqual(close, -1, `unterminated body for ${selector}`);
  return source.slice(open + 1, close);
}

module.exports = {
  "rewind log is hydrated from persisted session state": () => {
    assert.match(CLIENT, /function syncRewindLog\(entries\)/);
    assert.match(CLIENT, /Array\.isArray\(data\.rewindLog\)/);
    assert.match(CLIENT, /syncRewindLog\(data\.rewindLog\)/);
    assert.match(CLIENT, /data\.rewindEntry/);

    assert.match(RUNTIME, /session\.recordRewind\(/);
    assert.match(RUNTIME, /await session\.saveSessionStateToFile\(\)/);
    assert.match(RUNTIME, /rewindLog: session\.rewindLog \|\| \[\]/);
    assert.match(RUNTIME, /rewindEntry,/);

    assert.match(VIEW, /the rewinds this session has made/);
  },

  "rewind requests and answers carry one exact operation id": () => {
    const sends = [...CLIENT.matchAll(/sendToServer\(MSG_SELECT_HISTORY,/g)];
    assert.strictEqual(sends.length, 7, "expected every map rewind entry point");
    for (const send of sends) {
      const nearby = CLIENT.slice(
        Math.max(0, send.index - 400),
        send.index + 450,
      );
      assert.match(
        nearby,
        /operationId/,
        `rewind send at offset ${send.index} has no operation id`,
      );
    }

    const done = between(
      CLIENT,
      "if (msg === window.MSG_REWIND_DONE)",
      "if (msg === MSG_SHOW_NUMBER_CONNECTION)",
    );
    assert.match(done, /pendingRewind\.operationId === data\.operationId/);
    assert.doesNotMatch(done, /pendingRewind\.(?:kind|frame)/);

    const refused = between(
      CLIENT,
      "if (msg === window.MSG_REWIND_REFUSED)",
      "if (msg === window.MSG_REWIND_DONE)",
    );
    assert.match(refused, /pendingRewind\.operationId === data\.operationId/);

    const refusalReporter = between(
      RUNTIME,
      "function reportRewindRefusal(",
      "function reportRewindDone(",
    );
    const doneReporter = between(
      RUNTIME,
      "function reportRewindDone(",
      "function dormantLineKeys(",
    );
    assert.match(refusalReporter, /operationId: operationId \|\| null/);
    assert.match(doneReporter, /operationId: operationId \|\| null/);
    assert.match(
      RUNTIME,
      /const operationId = rewindOperationIdOf\(messageData\)/,
    );
  },

  "map controls and menus remain reachable in narrow viewports": () => {
    assert.match(ruleContaining(CSS, "#session-map-header"), /flex-wrap:\s*wrap/);
    assert.match(ruleContaining(CSS, "#session-map-heading"), /flex:\s*1 1/);
    assert.match(ruleContaining(CSS, "#session-map-title,"), /min-width:\s*0/);
    assert.match(
      ruleContaining(CSS, "#session-map-title,"),
      /text-overflow:\s*ellipsis/,
    );
    assert.match(
      VIEW,
      /div\(id="session-map-heading"\)[\s\S]*span\(id="session-map-title"\)[\s\S]*span\(id="session-map-status"\)/,
    );

    const menu = ruleContaining(CSS, "#session-map-menu {");
    assert.match(menu, /min-width:\s*min\(160px, calc\(100vw - 8px\)\)/);
    assert.match(menu, /max-width:\s*calc\(100vw - 8px\)/);
    assert.match(menu, /max-height:\s*calc\(100vh - 8px\)/);
    assert.match(menu, /overflow:\s*auto/);

    const controls = ruleContaining(CSS, "#session-map-relayout,");
    assert.match(controls, /min-width:\s*44px/);
    assert.match(controls, /min-height:\s*44px/);
    assert.match(
      ruleContaining(CSS, "#session-map-menu button {"),
      /min-height:\s*44px/,
    );

    assert.match(CLIENT, /const maxLeft = Math\.max\(4,/);
    assert.match(CLIENT, /const maxTop = Math\.max\(4,/);
    assert.match(CLIENT, /Math\.max\(4, Math\.min\(clientX, maxLeft\)\)/);
    assert.match(CLIENT, /Math\.max\(4, Math\.min\(clientY, maxTop\)\)/);
  },
};
