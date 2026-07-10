/**
 * Validator tests (pure).
 *
 * Builds graphs from inline fixtures and asserts validateScore catches the
 * broken cases (split N != hrefs, dangling rejoin/hold-until, sub missing
 * START / sub-end) and passes valid ones.
 */

const assert = require("node:assert");

const { parseFrameAttrs } = require("../lib/session-lines/parse");
const { buildGraph } = require("../lib/session-lines/graph");
const { validateScore } = require("../lib/session-lines/validate");

function frameSvg(attrs = {}, hrefs = []) {
  const attrStr = Object.entries(attrs)
    .map(([k, v]) => `${k}="${v}"`)
    .join(" ");
  const aTags = hrefs.map((h) => `<a xlink:href="${h}"><rect/></a>`).join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ${attrStr}>${aTags}</svg>`;
}

function frame(name, attrs, hrefs) {
  return { name, svg: frameSvg(attrs, hrefs), attrs: parseFrameAttrs(frameSvg(attrs, hrefs)) };
}

function codes(list) {
  return list.map((e) => e.code).sort();
}

// A sub-loader for a well-formed sub-score "Tetra1".
function goodSubLoader(name) {
  if (name !== "Tetra1") return null;
  const subFrames = [
    frame("START.svg", {}, ["X.svg"]),
    frame("X.svg", { "session-sub-end": "Tetra1" }, []),
  ];
  return {
    frameNames: subFrames.map((f) => f.name),
    graph: buildGraph(subFrames),
  };
}

module.exports = {
  "valid score: no errors": () => {
    const frames = [
      frame("START.svg", { "session-split": "2" }, ["B.svg", "C.svg"]),
      frame("B.svg", { "session-track-group": "g" }, ["D.svg"]),
      frame("C.svg", { "session-track-group": "g" }, ["D.svg"]),
      frame("D.svg", { "session-hold-until": "B.svg,C.svg", "session-rejoin-at": "E.svg" }, ["E.svg"]),
      frame("E.svg", {}, []),
    ];
    const g = buildGraph(frames);
    const { errors, warnings } = validateScore(g, frames.map((f) => f.name), () => null);
    assert.deepStrictEqual(errors, [], `unexpected errors: ${JSON.stringify(errors)}`);
    assert.deepStrictEqual(warnings, [], `unexpected warnings: ${JSON.stringify(warnings)}`);
  },

  "split N != href count is an error": () => {
    const frames = [
      frame("START.svg", { "session-split": "3" }, ["B.svg", "C.svg"]),
      frame("B.svg", {}, []),
      frame("C.svg", {}, []),
    ];
    const g = buildGraph(frames);
    const { errors } = validateScore(g, frames.map((f) => f.name), () => null);
    assert.ok(codes(errors).includes("split-href-mismatch"), JSON.stringify(errors));
  },

  "split N < 2 is an error": () => {
    const frames = [frame("START.svg", { "session-split": "1" }, ["B.svg"]), frame("B.svg", {}, [])];
    const g = buildGraph(frames);
    const { errors } = validateScore(g, frames.map((f) => f.name), () => null);
    assert.ok(codes(errors).includes("split-n-too-small"), JSON.stringify(errors));
  },

  "dangling rejoin target is an error": () => {
    const frames = [
      frame("START.svg", { "session-rejoin-at": "Nowhere.svg" }, ["B.svg"]),
      frame("B.svg", {}, []),
    ];
    const g = buildGraph(frames);
    const { errors } = validateScore(g, frames.map((f) => f.name), () => null);
    assert.ok(codes(errors).includes("rejoin-unresolved"), JSON.stringify(errors));
  },

  "dangling hold-until target is an error": () => {
    const frames = [
      frame("START.svg", { "session-hold-until": "Ghost.svg" }, ["B.svg"]),
      frame("B.svg", {}, []),
    ];
    const g = buildGraph(frames);
    const { errors } = validateScore(g, frames.map((f) => f.name), () => null);
    assert.ok(codes(errors).includes("hold-until-unresolved"), JSON.stringify(errors));
  },

  "rejoin-at target that is not one of the frame's own links is an error": () => {
    // C announces a merge at D, but its only link goes to X — the merge frame
    // is not reachable in one step (owner rule 2026-07-08: rejoin-at = "this
    // line merges at the target on its NEXT step").
    const frames = [
      frame("START.svg", {}, ["C.svg"]),
      frame("C.svg", { "session-rejoin-at": "D.svg" }, ["X.svg"]),
      frame("X.svg", {}, ["D.svg"]),
      frame("D.svg", {}, []),
    ];
    const g = buildGraph(frames);
    const { errors } = validateScore(g, frames.map((f) => f.name), () => null);
    assert.ok(codes(errors).includes("rejoin-not-linked"), JSON.stringify(errors));
  },

  "rejoin-at on pre-merge frames linking their merge frame passes": () => {
    // The owner's canonical shape: C and F both announce + link the merge at D.
    const frames = [
      frame("START.svg", { "session-split": "2" }, ["B.svg", "E.svg"]),
      frame("B.svg", {}, ["C.svg"]),
      frame("E.svg", {}, ["F.svg"]),
      frame("C.svg", { "session-rejoin-at": "D.svg" }, ["D.svg"]),
      frame("F.svg", { "session-rejoin-at": "D.svg" }, ["D.svg"]),
      frame("D.svg", {}, []),
    ];
    const g = buildGraph(frames);
    const { errors } = validateScore(g, frames.map((f) => f.name), () => null);
    assert.deepStrictEqual(errors, [], JSON.stringify(errors));
  },

  "rejoin-at coexists with split on the same frame (no pairing rule)": () => {
    // Owner-clarified 2026-07-08: the attributes are independent — a frame may
    // split while also announcing a merge among its next steps (e.g. staged
    // merges, 3 lines → 2 → 1). No count relationship is enforced.
    const frames = [
      frame(
        "START.svg",
        { "session-split": "2", "session-rejoin-at": "D.svg" },
        ["B.svg", "D.svg"],
      ),
      frame("B.svg", {}, ["D.svg"]),
      frame("D.svg", {}, []),
    ];
    const g = buildGraph(frames);
    const { errors } = validateScore(g, frames.map((f) => f.name), () => null);
    assert.deepStrictEqual(errors, [], JSON.stringify(errors));
  },

  "sub-start referencing a missing sub-score is an error": () => {
    const frames = [
      frame("START.svg", { "session-sub-start": "DoesNotExist" }, ["B.svg"]),
      frame("B.svg", {}, []),
    ];
    const g = buildGraph(frames);
    const { errors } = validateScore(g, frames.map((f) => f.name), () => null);
    assert.ok(codes(errors).includes("sub-start-missing-score"), JSON.stringify(errors));
  },

  "sub-score missing START / sub-end are errors": () => {
    const frames = [
      frame("START.svg", { "session-sub-start": "BadSub" }, ["B.svg"]),
      frame("B.svg", {}, []),
    ];
    const g = buildGraph(frames);
    const badSubLoader = (name) => {
      if (name !== "BadSub") return null;
      // No START frame, and no sub-end attr anywhere.
      const subFrames = [frame("intro.svg", {}, [])];
      return { frameNames: subFrames.map((f) => f.name), graph: buildGraph(subFrames) };
    };
    const { errors } = validateScore(g, frames.map((f) => f.name), badSubLoader);
    const c = codes(errors);
    assert.ok(c.includes("sub-missing-start"), JSON.stringify(errors));
    assert.ok(c.includes("sub-missing-end"), JSON.stringify(errors));
  },

  "valid sub-session with good sub-loader passes": () => {
    const frames = [
      frame("START.svg", { "session-sub-start": "Tetra1" }, ["Landing.svg"]),
      frame("Landing.svg", {}, []),
    ];
    const g = buildGraph(frames);
    const { errors } = validateScore(g, frames.map((f) => f.name), goodSubLoader);
    assert.deepStrictEqual(errors, [], JSON.stringify(errors));
  },

  "sub-start with no return href is an error": () => {
    const frames = [frame("START.svg", { "session-sub-start": "Tetra1" }, [])];
    const g = buildGraph(frames);
    const { errors } = validateScore(g, frames.map((f) => f.name), goodSubLoader);
    assert.ok(codes(errors).includes("sub-start-no-return"), JSON.stringify(errors));
  },

  "sub frame with no path to a sub-end is an error (stranded line)": () => {
    const frames = [
      frame("START.svg", { "session-sub-start": "Trap" }, ["Landing.svg"]),
      frame("Landing.svg", {}, []),
    ];
    const g = buildGraph(frames);
    // START links to A (which exits) and D (a dead end: no hrefs, not a
    // sub-end). A line voting into D can never leave the sub.
    const trapSubLoader = (name) => {
      if (name !== "Trap") return null;
      const subFrames = [
        frame("START.svg", {}, ["A.svg", "D.svg"]),
        frame("A.svg", {}, ["End.svg"]),
        frame("D.svg", {}, []),
        frame("End.svg", { "session-sub-end": "Trap" }, []),
      ];
      return { frameNames: subFrames.map((f) => f.name), graph: buildGraph(subFrames) };
    };
    const { errors } = validateScore(g, frames.map((f) => f.name), trapSubLoader);
    const deadEnds = errors.filter((e) => e.code === "sub-dead-end");
    assert.strictEqual(deadEnds.length, 1, JSON.stringify(errors));
    assert.strictEqual(deadEnds[0].frame, "D.svg");
  },

  "sub cycle that can always exit passes the dead-end check": () => {
    const frames = [
      frame("START.svg", { "session-sub-start": "Loop" }, ["Landing.svg"]),
      frame("Landing.svg", {}, []),
    ];
    const g = buildGraph(frames);
    // A ↔ B cycle, but B links onward to the sub-end — no frame is stranded.
    const loopSubLoader = (name) => {
      if (name !== "Loop") return null;
      const subFrames = [
        frame("START.svg", {}, ["A.svg"]),
        frame("A.svg", {}, ["B.svg"]),
        frame("B.svg", {}, ["A.svg", "End.svg"]),
        frame("End.svg", { "session-sub-end": "Loop" }, []),
      ];
      return { frameNames: subFrames.map((f) => f.name), graph: buildGraph(subFrames) };
    };
    const { errors } = validateScore(g, frames.map((f) => f.name), loopSubLoader);
    assert.deepStrictEqual(errors, [], JSON.stringify(errors));
  },

  "hold-until sub-ref resolves through the sub-loader": () => {
    const frames = [
      frame("START.svg", { "session-hold-until": "Tetra1/X.svg" }, ["B.svg"]),
      frame("B.svg", {}, []),
    ];
    const g = buildGraph(frames);
    const { errors } = validateScore(g, frames.map((f) => f.name), goodSubLoader);
    assert.deepStrictEqual(
      errors.filter((e) => e.code.startsWith("hold-until")),
      [],
      JSON.stringify(errors),
    );
  },

  "singleton track-group is a warning, not an error": () => {
    const frames = [
      frame("START.svg", { "session-track-group": "lonely" }, ["B.svg"]),
      frame("B.svg", {}, []),
    ];
    const g = buildGraph(frames);
    const { errors, warnings } = validateScore(g, frames.map((f) => f.name), () => null);
    assert.deepStrictEqual(errors, [], JSON.stringify(errors));
    assert.ok(codes(warnings).includes("track-group-singleton"), JSON.stringify(warnings));
  },

  "unreachable barrier target is a warning": () => {
    const frames = [
      // Orphan.svg exists but nothing links to it and it is not a start frame.
      frame("START.svg", { "session-hold-until": "Orphan.svg" }, ["B.svg"]),
      frame("B.svg", {}, []),
      frame("Orphan.svg", {}, []),
    ];
    const g = buildGraph(frames);
    const { errors, warnings } = validateScore(g, frames.map((f) => f.name), () => null);
    assert.deepStrictEqual(errors, [], JSON.stringify(errors));
    assert.ok(codes(warnings).includes("barrier-target-unreachable"), JSON.stringify(warnings));
  },
};
