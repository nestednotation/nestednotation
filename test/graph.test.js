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
function frameSvg(attrs = {}, hrefs = []) {
  const attrStr = Object.entries(attrs)
    .map(([k, v]) => `${k}="${v}"`)
    .join(" ");
  const aTags = hrefs
    .map((h) => `<a xlink:href="${h}"><rect x="0" y="0"/></a>`)
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
  frame("S.svg", { "session-sub-start": "Tetra1" }, ["L.svg"]),
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
    assert.strictEqual(attrs.subEnd, null);
    assert.strictEqual(attrs.hasSessionAttr, false);
    assert.deepStrictEqual(attrs.hrefs, ["X.svg"]);
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

  "a-z: sub-start maps score + return href": () => {
    const g = buildGraph(azFrames);
    assert.deepStrictEqual(g.subStart["S.svg"], {
      score: "Tetra1",
      returnHref: "L.svg",
    });
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
