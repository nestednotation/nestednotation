/**
 * Session Lines — markup parser (pure).
 *
 * Reads a single frame's SVG string and extracts the `session-*` coordination
 * attributes (root-level, except `session-sub-start` which lives on `<a>`
 * tags) plus the frame's `<a>` href targets.
 *
 * No express/ws/fs imports — unit-testable in isolation. Mirrors the href
 * extraction patterns used by database.js (HREF_REGX / LINK_REGEX).
 */

// Matches the opening <svg ...> tag (attribute values never contain '>').
// `[^>]` spans newlines, so multi-line root tags are handled.
const SVG_OPEN_TAG = /<svg\b[^>]*>/i;

// Matches a single `<a ...>` opening tag.
const A_OPEN_TAG = /<a\b[^>]*>/gi;

// Same intent as database.js HREF_REGX: capture the value of href="..." /
// xlink:href="..." (lookbehind on `href="`).
const HREF_REGX = /(?<=href=")(.*?)(?=")/;

// Generic `name="value"` attribute scanner for a single tag's attribute list.
const ATTR_REGEX = /([\w:-]+)\s*=\s*"([^"]*)"/g;

const SESSION_ATTRS = [
  "session-split",
  "session-track-group",
  "session-hold-until",
  "session-rejoin-at",
  "session-sub-start",
  "session-sub-end",
];

function splitList(value) {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Parse the attributes of the opening `<svg>` tag into a flat map.
 * Returns {} if no opening tag is found.
 */
function parseSvgRootAttrs(svgString) {
  if (typeof svgString !== "string") {
    return {};
  }
  const m = SVG_OPEN_TAG.exec(svgString);
  if (!m) {
    return {};
  }
  const tag = m[0];
  const attrs = {};
  let a;
  ATTR_REGEX.lastIndex = 0;
  while ((a = ATTR_REGEX.exec(tag)) !== null) {
    attrs[a[1]] = a[2];
  }
  return attrs;
}

/**
 * Parse every `<a>` opening tag into { href, subStart }. `href` is null when
 * the tag has none; `subStart` is the tag's `session-sub-start` value (a link
 * that dives into that sub-score, its href being the return landing) or null.
 */
function parseATags(svgString) {
  if (typeof svgString !== "string") {
    return [];
  }
  const tags = [];
  let tag;
  A_OPEN_TAG.lastIndex = 0;
  while ((tag = A_OPEN_TAG.exec(svgString)) !== null) {
    const attrs = {};
    let a;
    ATTR_REGEX.lastIndex = 0;
    while ((a = ATTR_REGEX.exec(tag[0])) !== null) {
      attrs[a[1]] = a[2];
    }
    tags.push({
      href: attrs["href"] ?? attrs["xlink:href"] ?? null,
      subStart: attrs["session-sub-start"]?.trim() || null,
    });
  }
  return tags;
}

/**
 * Extract the ordered list of href targets from every `<a>` in the frame.
 */
function parseHrefs(svgString) {
  return parseATags(svgString)
    .map((t) => t.href)
    .filter((h) => h != null && h !== "");
}

/**
 * Parse a single frame's SVG into a normalized session-lines descriptor.
 *
 * `session-sub-start` lives on an `<a>` tag (the link that dives into the sub;
 * its href is the return landing) — surfaced as `subLinks`. A root-level
 * `session-sub-start` is legacy markup, surfaced as `subStart` only so the
 * validator can reject it.
 *
 * @param {string} svgString - raw SVG content of one frame.
 * @returns {{
 *   split: (number|null),
 *   trackGroup: (string|null),
 *   holdUntil: string[],
 *   rejoinAt: string[],
 *   subStart: (string|null),
 *   subLinks: Array<{score: string, href: (string|null)}>,
 *   subEnd: (string|null),
 *   voting: (string|null),
 *   holding: (string|null),
 *   hrefs: string[],
 *   hasSessionAttr: boolean,
 * }}
 */
function parseFrameAttrs(svgString) {
  const root = parseSvgRootAttrs(svgString);
  const aTags = parseATags(svgString);
  const hrefs = aTags
    .map((t) => t.href)
    .filter((h) => h != null && h !== "");
  const subLinks = aTags
    .filter((t) => t.subStart)
    .map((t) => ({ score: t.subStart, href: t.href }));

  const splitRaw = root["session-split"];
  const splitNum =
    splitRaw != null && splitRaw !== "" ? parseInt(splitRaw, 10) : NaN;

  const trackGroup = root["session-track-group"]?.trim() || null;
  const holdUntil = splitList(root["session-hold-until"]);
  const rejoinAt = splitList(root["session-rejoin-at"]);
  const subStart = root["session-sub-start"]?.trim() || null;
  const subEnd = root["session-sub-end"]?.trim() || null;
  const voting = root.voting?.trim() || null;
  const holding = root.holding?.trim() || null;

  const hasSessionAttr =
    subLinks.length > 0 ||
    SESSION_ATTRS.some((k) => root[k] != null && String(root[k]).trim() !== "");

  return {
    split: Number.isNaN(splitNum) ? null : splitNum,
    trackGroup,
    holdUntil,
    rejoinAt,
    subStart,
    subLinks,
    subEnd,
    voting,
    holding,
    hrefs,
    hasSessionAttr,
  };
}

module.exports = {
  parseFrameAttrs,
  parseSvgRootAttrs,
  parseATags,
  parseHrefs,
  HREF_REGX,
  SESSION_ATTRS,
};
