/**
 * Graph builder + parser tests (pure, no server boot).
 *
 * Feeds two synthetic scores built strictly from the markup reference table in
 * docs/session-lines.md:
 *   - "a-z": one frame exercising each session-* attribute.
 *   - "hybrid": split -> 3 lines -> track-group -> barrier(hold-until)+rejoin.
 */

const assert = require("node:assert");

const { parseFrameAttrs } = require("../lib/session-lines/parse");
const { buildGraph, resolveFrameName } = require("../lib/session-lines/graph");

// Minimal SVG wrapper: session-* attrs on the <svg> root, hrefs as <a> tags.
// An href entry may be a string, or { href, sub } to mark the <a> with
// session-sub-start="sub" (link-level dive; href = return landing).
function frameSvg(attrs = {}, hrefs = []) {
  const attrStr = Object.entries(attrs)
    .map(([k, v]) => `${k}="${v}"`)
    .join(" ");
  const aTags = hrefs
    .map((h) => {
      if (typeof h === "string") {
        return `<a xlink:href="${h}"><rect x="0" y="0"/></a>`;
      }
      const sub = h.sub ? ` session-sub-start="${h.sub}"` : "";
      const href = h.href ? ` xlink:href="${h.href}"` : "";
      return `<a${sub}${href}><rect x="0" y="0"/></a>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE svg>
<svg width="100%" height="100%" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ${attrStr}>
${aTags}
</svg>`;
}

function frame(name, attrs, hrefs) {
  return { name, svg: frameSvg(attrs, hrefs) };
}

// ---------------------------------------------------------------------------
// Fixture: the "a-z" example — one of each markup attribute.
// ---------------------------------------------------------------------------
const azFrames = [
  frame("A.svg", { "session-split": "2" }, ["B.svg", "C.svg"]),
  frame("B.svg", { "session-track-group": "alpha" }, ["D.svg"]),
  frame("C.svg", { "session-track-group": "alpha" }, ["D.svg"]),
  frame("D.svg", { "session-hold-until": "B.svg, C.svg" }, ["E.svg"]),
  frame("E.svg", { "session-rejoin-at": "A.svg" }, ["A.svg"]),
  frame("S.svg", {}, [{ href: "L.svg", sub: "Tetra1" }]),
  frame("Tetra1/Z.svg", { "session-sub-end": "Tetra1" }, []),
  frame("Z.svg", {}, ["A.svg"]), // plain frame, no session markup
];

// ---------------------------------------------------------------------------
// Fixture: the "hybrid" example — split into 3, grouped, barrier + rejoin.
// ---------------------------------------------------------------------------
const hybridFrames = [
  frame("M0.svg", { "session-split": "3" }, ["M1.svg", "M2.svg", "M3.svg"]),
  frame("M1.svg", { "session-track-group": "g" }, ["B1.svg"]),
  frame("M2.svg", { "session-track-group": "g" }, ["B1.svg"]),
  frame("M3.svg", { "session-track-group": "g" }, ["B1.svg"]),
  frame(
    "B1.svg",
    { "session-hold-until": "M1.svg,M2.svg,M3.svg", "session-rejoin-at": "R.svg" },
    ["R.svg"],
  ),
  frame("R.svg", {}, []),
];

module.exports = {
  "parseFrameAttrs extracts split + hrefs": () => {
    const attrs = parseFrameAttrs(frameSvg({ "session-split": "2" }, ["B.svg", "C.svg"]));
    assert.strictEqual(attrs.split, 2);
    assert.deepStrictEqual(attrs.hrefs, ["B.svg", "C.svg"]);
    assert.strictEqual(attrs.hasSessionAttr, true);
  },

  "parseFrameAttrs handles a vanilla frame (no session markup)": () => {
    const attrs = parseFrameAttrs(frameSvg({}, ["X.svg"]));
    assert.strictEqual(attrs.split, null);
    assert.strictEqual(attrs.trackGroup, null);
    assert.deepStrictEqual(attrs.holdUntil, []);
    assert.deepStrictEqual(attrs.rejoinAt, []);
    assert.strictEqual(attrs.subStart, null);
    assert.deepStrictEqual(attrs.subLinks, []);
    assert.strictEqual(attrs.subEnd, null);
    assert.strictEqual(attrs.voting, null);
    assert.strictEqual(attrs.holding, null);
    assert.strictEqual(attrs.hasSessionAttr, false);
    assert.deepStrictEqual(attrs.hrefs, ["X.svg"]);
  },

  "parseFrameAttrs extracts and trims voting/holding overrides": () => {
    const attrs = parseFrameAttrs(
      frameSvg({ voting: " 250% ", holding: " 4 " }, ["X.svg"]),
    );
    assert.strictEqual(attrs.voting, "250%");
    assert.strictEqual(attrs.holding, "4");
    assert.strictEqual(
      attrs.hasSessionAttr,
      false,
      "timing overrides alone do not enable session-lines mode",
    );
  },

  "parseFrameAttrs: session-sub-start on an <a> yields a subLink + session flag": () => {
    const attrs = parseFrameAttrs(
      frameSvg({}, ["Plain.svg", { href: "L.svg", sub: "Tetra1" }]),
    );
    assert.deepStrictEqual(attrs.subLinks, [{ score: "Tetra1", href: "L.svg" }]);
    assert.strictEqual(attrs.subStart, null);
    assert.strictEqual(attrs.hasSessionAttr, true);
    assert.deepStrictEqual(attrs.hrefs, ["Plain.svg", "L.svg"]);
  },

  "parseFrameAttrs trims comma lists": () => {
    const attrs = parseFrameAttrs(frameSvg({ "session-hold-until": " B.svg , C.svg ,, " }));
    assert.deepStrictEqual(attrs.holdUntil, ["B.svg", "C.svg"]);
  },

  "a-z: hasSessionLines is true": () => {
    const g = buildGraph(azFrames);
    assert.strictEqual(g.hasSessionLines, true);
  },

  "a-z: split N matches and exposes its hrefs": () => {
    const g = buildGraph(azFrames);
    assert.strictEqual(g.splits["A.svg"].n, 2);
    assert.deepStrictEqual(g.splits["A.svg"].hrefs, ["B.svg", "C.svg"]);
  },

  "a-z: track-group membership set": () => {
    const g = buildGraph(azFrames);
    assert.deepStrictEqual(g.groups["alpha"], ["B.svg", "C.svg"]);
  },

  "a-z: hold-until targets parsed": () => {
    const g = buildGraph(azFrames);
    assert.deepStrictEqual(g.holdUntilTargets["D.svg"], ["B.svg", "C.svg"]);
  },

  "a-z: rejoin target parsed": () => {
    const g = buildGraph(azFrames);
    assert.deepStrictEqual(g.rejoinTargets["E.svg"], ["A.svg"]);
  },

  "a-z: sub-start link maps score + return href": () => {
    const g = buildGraph(azFrames);
    assert.deepStrictEqual(g.subLinks["S.svg"], [
      { score: "Tetra1", returnHref: "L.svg" },
    ]);
  },

  "a-z: sub-end maps to its score": () => {
    const g = buildGraph(azFrames);
    assert.strictEqual(g.subEnd["Tetra1/Z.svg"], "Tetra1");
  },

  "a-z: plain frame is recorded but flagged no session attrs": () => {
    const g = buildGraph(azFrames);
    assert.strictEqual(g.byFrame["Z.svg"].hasSessionAttr, false);
  },

  "a-z: frame names resolve case-insensitively": () => {
    const g = buildGraph(azFrames);
    assert.strictEqual(resolveFrameName(g, "a.svg"), "A.svg");
    assert.strictEqual(resolveFrameName(g, "TETRA1/z.SVG"), "Tetra1/Z.svg");
    assert.strictEqual(resolveFrameName(g, "nope.svg"), null);
  },

  "hybrid: split into 3 with 3 hrefs": () => {
    const g = buildGraph(hybridFrames);
    assert.strictEqual(g.splits["M0.svg"].n, 3);
    assert.strictEqual(g.splits["M0.svg"].hrefs.length, 3);
  },

  "hybrid: 3 grouped frames in one group": () => {
    const g = buildGraph(hybridFrames);
    assert.deepStrictEqual(g.groups["g"], ["M1.svg", "M2.svg", "M3.svg"]);
  },

  "hybrid: barrier frame carries hold-until + rejoin": () => {
    const g = buildGraph(hybridFrames);
    assert.deepStrictEqual(g.holdUntilTargets["B1.svg"], [
      "M1.svg",
      "M2.svg",
      "M3.svg",
    ]);
    assert.deepStrictEqual(g.rejoinTargets["B1.svg"], ["R.svg"]);
  },

  "vanilla score yields hasSessionLines false": () => {
    const g = buildGraph([frame("1.svg", {}, ["2.svg"]), frame("2.svg", {}, [])]);
    assert.strictEqual(g.hasSessionLines, false);
    assert.deepStrictEqual(g.splits, {});
    assert.deepStrictEqual(g.groups, {});
  },

  "buildGraph accepts pre-parsed attrs": () => {
    const attrs = parseFrameAttrs(frameSvg({ "session-split": "2" }, ["x", "y"]));
    const g = buildGraph([{ name: "A.svg", attrs }]);
    assert.strictEqual(g.splits["A.svg"].n, 2);
  },
};
