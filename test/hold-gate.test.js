/**
 * The landing hold has ONE gate, and it reads the FRAME.
 *
 * `landingHoldSeconds` made the graph the authority for how long a landing is
 * held. The gate deciding whether it is held at all stayed on
 * `session.holdDuration` — the room's default, which is 0 unless an operator
 * sets one — so a frame authored `holding="12"` was ignored outright on the
 * ordinary voted and grouped advance while every other landing in the §7.1
 * census played it. Same frame, different route, different behaviour, which is
 * the split `landingHoldSeconds` exists to close. It is not only a timing
 * difference: a landing with no hold is registered `done` on arrival, so a
 * `hold-until` there whose targets were already met releases in the same tick,
 * freeing the line the moment its device was told to show the frame.
 *
 * So `session.holdDuration` is the DEFAULT VALUE and nothing else: every gate
 * goes through `holdsAtLanding`. This pins that at the source, because bin/www
 * is a server entry point rather than a module and the rule cannot be asserted
 * by calling it — the same reason `orchestrator-surface.test.js` reads the file.
 */

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const RUNTIME = path.join(__dirname, "..", "bin", "www");

/** The runtime's lines with `//` comments and JSDoc stripped, 1-indexed. */
function codeLines() {
  const src = fs.readFileSync(RUNTIME, "utf8");
  let inBlock = false;
  return src.split(/\r?\n/).map((line, i) => {
    let text = line;
    if (inBlock) {
      const end = text.indexOf("*/");
      if (end < 0) return { n: i + 1, text: "" };
      text = text.slice(end + 2);
      inBlock = false;
    }
    const block = text.indexOf("/*");
    if (block >= 0) {
      inBlock = text.indexOf("*/", block) < 0;
      text = text.slice(0, block);
    }
    const slash = text.indexOf("//");
    if (slash >= 0) text = text.slice(0, slash);
    return { n: i + 1, text };
  });
}

module.exports = {
  "session.holdDuration is a default value, never a hold gate": () => {
    const uses = codeLines().filter((l) => l.text.includes("holdDuration"));
    assert.ok(uses.length > 0, "expected bin/www to read session.holdDuration");
    // The one legitimate read: the default `parseCustomDur` falls back to when
    // a frame authors no `holding` of its own.
    const stray = uses.filter(
      (l) => !/^\s*return parseCustomDur\(session\.holdDuration, authored\);$/.test(l.text),
    );
    assert.deepStrictEqual(
      stray.map((l) => `${l.n}: ${l.text.trim()}`),
      [],
      "a hold decision is reading session.holdDuration directly — it must ask " +
        "holdsAtLanding, of the frame the line has landed on",
    );
  },

  "every hold start is gated on the landing, and asked after the move": () => {
    const lines = codeLines();
    const starts = lines.filter((l) =>
      l.text.includes("startHoldingForSessionWithDelay("),
    );
    // Its own declaration, plus the call sites.
    assert.ok(starts.length >= 4, `expected the hold starts, got ${starts.length}`);
    const calls = starts.filter((l) => !l.text.includes("async function"));
    assert.ok(calls.length >= 3, `expected call sites, got ${calls.length}`);
    // Each call site sits under a gate derived from the landing: either the
    // `holds` the standby paths capture after `setCurrIdxTo`, or a direct
    // `holdsAtLanding` test.
    for (const call of calls) {
      const window = lines
        .slice(Math.max(0, call.n - 6), call.n)
        .map((l) => l.text)
        .join("\n");
      assert.ok(
        /\bholds\b|holdsAtLanding\(/.test(window),
        `bin/www:${call.n} starts a hold with no landing gate above it`,
      );
    }
  },

  "a sub-end never completes on arrival": () => {
    // The companion rule, and the one that made moving the gate dangerous.
    // `recordArrival` decides `arrived` vs `done` from whether the landing is
    // still holding — which for a sub-end used to be true by accident, because
    // the ordinary advance set `isHolding` on any non-zero session default
    // whatever the frame said. Reading the FRAME instead, a sub-end authored
    // `holding="false"` (the honest value for a marker no device displays)
    // started completing on arrival, releasing a `hold-until` waiting on it
    // while the line was still inside the sub. `test/sub-session.test.js` pins
    // the behaviour against the real fixture; this pins that bin/www still
    // states the rule rather than inheriting it from the hold flag.
    const src = fs.readFileSync(RUNTIME, "utf8");
    assert.match(
      src,
      /const passingThrough =\s*line\.isHolding \|\| isSubEndFrame\(session, line\);/,
      "recordArrival must treat a sub-end as passing through, not resting",
    );
    assert.match(
      src,
      /markReached\(session\.reachedTargets, ref, !passingThrough\)/,
      "…and complete the ref on that answer, not on isHolding alone",
    );
  },

  "the gate and the duration read the same frame": () => {
    const src = fs.readFileSync(RUNTIME, "utf8");
    assert.match(
      src,
      /function holdsAtLanding\(session, line\) \{\s*return landingHoldSeconds\(session, line\) > 0;\s*\}/,
      "holdsAtLanding must be landingHoldSeconds' own answer, not a second rule",
    );
  },
};
