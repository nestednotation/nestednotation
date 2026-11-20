/**
 * Responsive map controls (CSS/markup rules).
 *
 * Rewind receipts used to be checked here too, by searching the source for
 * `operationId` near each send. That coverage now executes: the map's own
 * requests and receipt handling in map-client.test.js, and the server's
 * receipt, log entry and save in rewind-receipts.test.js.
 */

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
const VIEW = fs.readFileSync(
  path.join(ROOT, "views", "session-map.jade"),
  "utf8",
);

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
