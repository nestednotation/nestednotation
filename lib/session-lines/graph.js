/**
 * Session Lines — relationship graph builder (pure).
 *
 * Consumes per-frame parsed attributes (from parse.js) and produces a
 * normalized, reciprocal-free model the runtime/validator consult. No
 * express/ws/fs imports.
 *
 * Frame-name references (hold-until / rejoin-at / sub-start return href) are
 * resolved case-insensitively, mirroring database.js `listFilesInLowerCase`.
 */

const { parseFrameAttrs } = require("./parse");

/**
 * @param {Array<{name: string, attrs?: object, svg?: string}>} frames
 *   Each frame supplies its parsed `attrs` (preferred) or raw `svg` to parse.
 * @returns {{
 *   hasSessionLines: boolean,
 *   frames: string[],
 *   frameNameByLower: Object<string,string>,
 *   byFrame: Object<string, object>,
 *   groups: Object<string, string[]>,
 *   splits: Object<string, {n: (number|null), hrefs: string[]}>,
 *   holdUntilTargets: Object<string, string[]>,
 *   rejoinTargets: Object<string, string[]>,
 *   subStart: Object<string, {score: string, returnHref: (string|null)}>,
 *   subEnd: Object<string, string>,
 * }}
 */
function buildGraph(frames) {
  const graph = {
    hasSessionLines: false,
    frames: [],
    frameNameByLower: {},
    byFrame: {},
    groups: {},
    splits: {},
    holdUntilTargets: {},
    rejoinTargets: {},
    subStart: {},
    subEnd: {},
  };

  if (!Array.isArray(frames)) {
    return graph;
  }

  for (const frame of frames) {
    if (!frame || typeof frame.name !== "string") {
      continue;
    }
    const name = frame.name;
    const attrs = frame.attrs || parseFrameAttrs(frame.svg || "");

    graph.frames.push(name);
    graph.frameNameByLower[name.toLowerCase()] = name;
    graph.byFrame[name] = { name, ...attrs };

    if (attrs.hasSessionAttr) {
      graph.hasSessionLines = true;
    }

    if (attrs.split != null) {
      graph.splits[name] = { n: attrs.split, hrefs: attrs.hrefs.slice() };
    }

    if (attrs.trackGroup) {
      if (!graph.groups[attrs.trackGroup]) {
        graph.groups[attrs.trackGroup] = [];
      }
      graph.groups[attrs.trackGroup].push(name);
    }

    if (attrs.holdUntil && attrs.holdUntil.length > 0) {
      graph.holdUntilTargets[name] = attrs.holdUntil.slice();
    }

    if (attrs.rejoinAt && attrs.rejoinAt.length > 0) {
      graph.rejoinTargets[name] = attrs.rejoinAt.slice();
    }

    if (attrs.subStart) {
      graph.subStart[name] = {
        score: attrs.subStart,
        returnHref: attrs.hrefs[0] ?? null,
      };
    }

    if (attrs.subEnd) {
      graph.subEnd[name] = attrs.subEnd;
    }
  }

  return graph;
}

/**
 * Case-insensitive resolution of a frame reference to its canonical name.
 * Returns null if unknown.
 */
function resolveFrameName(graph, ref) {
  if (!graph || typeof ref !== "string") {
    return null;
  }
  return graph.frameNameByLower[ref.toLowerCase()] ?? null;
}

module.exports = {
  buildGraph,
  resolveFrameName,
};
