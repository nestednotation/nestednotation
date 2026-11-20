/**
 * M1 — every performer mutation is authenticated and validated before a line
 * is touched.
 *
 * Two rules, both exercised against the production predicates rather than a
 * copy of them: who may send a TAP (`canPerform` / `isBoundToSession`, routing)
 * and what a TAP may ask for (`validateTapTarget`, orchestrator). The tap
 * targets are resolved against the REAL fixture score, so "a destination this
 * frame offers" means what the built graph says it means.
 */

const assert = require("node:assert");

const {
  isBoundToSession,
  canPerform,
} = require("../lib/session-lines/routing");
const { validateTapTarget } = require("../lib/session-lines/orchestrator");
const { buildSessionLinesFixture } = require("./session-lines-fixture");

// The four kinds of connection a room holds, as MSG_PING tags them.
const player = (over = {}) => ({
  sessionId: "s1",
  lineId: "L0",
  deviceId: "dP",
  isStaff: true,
  ...over,
});
const rider = (over = {}) => player({ deviceId: "dR", isStaff: false, ...over });
const mapTab = (over = {}) =>
  player({ deviceId: "dM", isMapView: true, ...over });
// A socket that has opened but not completed the handshake: every field the
// PING branch assigns is still undefined.
const preHandshake = () => ({ lineId: undefined });

module.exports = {
  "a pre-handshake socket is bound to no room": () => {
    assert.strictEqual(isBoundToSession(preHandshake(), "s1"), false);
    assert.strictEqual(canPerform(preHandshake(), "s1", true), false);
  },

  "a socket cannot act on a room it never joined": () => {
    const elsewhere = player({ sessionId: "s2" });
    assert.strictEqual(isBoundToSession(elsewhere, "s1"), false);
    assert.strictEqual(canPerform(elsewhere, "s1", true), false);
  },

  "a rider may not tap, however it addresses the room": () => {
    assert.strictEqual(isBoundToSession(rider(), "s1"), true);
    assert.strictEqual(canPerform(rider(), "s1", true), false);
  },

  "a map tab authenticates as staff and still may not tap": () => {
    const tab = mapTab();
    assert.strictEqual(tab.isStaff, true);
    assert.strictEqual(canPerform(tab, "s1", true), false);
  },

  "a performer whose message carries bad credentials may not tap": () => {
    // The handshake flag alone is not the answer: the password on THIS message
    // is checked too, so a socket cannot change what it claims to be between
    // messages.
    assert.strictEqual(canPerform(player(), "s1", false), false);
    assert.strictEqual(canPerform(player(), "s1", true), true);
  },

  // ── What a tap may ask for ──────────────────────────────────────────────
  "tap validation accepts a destination the frame links to": async () => {
    const session = await buildSessionLinesFixture({ id: "__tap_ok__" });
    const idx = (n) => session.listFilesInLowerCase.indexOf(n.toLowerCase());
    const leftIdx = idx("Left.svg");

    assert.strictEqual(
      validateTapTarget({
        selectedId: `${leftIdx}#START.svg#0`,
        frameName: "START.svg",
        frameList: session.listFiles,
        frameLinks: session.graph.frameLinks,
        currentIndex: idx("START.svg"),
      }),
      leftIdx,
    );
  },

  "tap validation refuses a destination the frame does not link to": async () => {
    const session = await buildSessionLinesFixture({ id: "__tap_unlinked__" });
    const idx = (n) => session.listFilesInLowerCase.indexOf(n.toLowerCase());
    // DONE.svg is a real frame of this score and is NOT a child of START.
    const doneIdx = idx("DONE.svg");
    assert.ok(doneIdx >= 0);
    assert.ok(!session.graph.frameLinks["START.svg"].includes(doneIdx));

    assert.strictEqual(
      validateTapTarget({
        selectedId: `${doneIdx}#START.svg#0`,
        frameName: "START.svg",
        frameList: session.listFiles,
        frameLinks: session.graph.frameLinks,
        currentIndex: idx("START.svg"),
      }),
      null,
    );
  },

  "tap validation refuses an out-of-range or non-numeric destination": async () => {
    const session = await buildSessionLinesFixture({ id: "__tap_range__" });
    const idx = (n) => session.listFilesInLowerCase.indexOf(n.toLowerCase());
    const ask = (selectedId) =>
      validateTapTarget({
        selectedId,
        frameName: "START.svg",
        frameList: session.listFiles,
        frameLinks: session.graph.frameLinks,
        currentIndex: idx("START.svg"),
      });

    assert.strictEqual(ask("999#START.svg#0"), null);
    assert.strictEqual(ask("-1#START.svg#0"), null);
    assert.strictEqual(ask("1.5#START.svg#0"), null);
    assert.strictEqual(ask("oops#START.svg#0"), null);
    assert.strictEqual(ask(""), null);
    assert.strictEqual(ask(null), null);
  },

  "tap validation refuses a tap authored on another frame": async () => {
    const session = await buildSessionLinesFixture({ id: "__tap_source__" });
    const idx = (n) => session.listFilesInLowerCase.indexOf(n.toLowerCase());
    const leftIdx = idx("Left.svg");

    // The destination is legitimate; the SOURCE is not — this vote id was
    // built on a frame the line is not standing on.
    assert.strictEqual(
      validateTapTarget({
        selectedId: `${leftIdx}#Barrier.svg#0`,
        frameName: "START.svg",
        frameList: session.listFiles,
        frameLinks: session.graph.frameLinks,
        currentIndex: idx("START.svg"),
      }),
      null,
    );
    // …and the same id, sent from where it was authored, is fine.
    assert.strictEqual(
      validateTapTarget({
        selectedId: `${leftIdx}#start.svg#0`, // case-insensitive, as elsewhere
        frameName: "START.svg",
        frameList: session.listFiles,
        frameLinks: session.graph.frameLinks,
        currentIndex: idx("START.svg"),
      }),
      leftIdx,
    );
  },

  // The one a real client produces: the page's STAY button carries no frame and
  // no numeric target, and `Number("stay")` is NaN.
  "STAY resolves to the line's own frame, never NaN": async () => {
    const session = await buildSessionLinesFixture({ id: "__tap_stay__" });
    const idx = (n) => session.listFilesInLowerCase.indexOf(n.toLowerCase());
    const here = idx("START.svg");

    assert.strictEqual(
      validateTapTarget({
        selectedId: "stay",
        frameName: "START.svg",
        frameList: session.listFiles,
        frameLinks: session.graph.frameLinks,
        currentIndex: here,
      }),
      here,
    );
  },

  // A vanilla score builds no `frameLinks`, so the graph cannot speak for the
  // frame and the bounds check is the whole answer — today's behavior.
  "a score with no link graph still bounds the destination": () => {
    const frameList = ["A.svg", "B.svg", "C.svg"];
    const ask = (selectedId) =>
      validateTapTarget({
        selectedId,
        frameName: "A.svg",
        frameList,
        frameLinks: undefined,
        currentIndex: 0,
      });
    assert.strictEqual(ask("2#A.svg#0"), 2);
    assert.strictEqual(ask("3#A.svg#0"), null);
    assert.strictEqual(ask("stay#"), 0);
  },

  // A dead end is an ANSWER, not an absence of one.
  "a frame with no outgoing links offers no destination": () => {
    assert.strictEqual(
      validateTapTarget({
        selectedId: "1#End.svg#0",
        frameName: "End.svg",
        frameList: ["Start.svg", "End.svg"],
        frameLinks: { "End.svg": [] },
        currentIndex: 1,
      }),
      null,
    );
  },

  // Mid-dive the line indexes the SUB's frame list, and the vote id names a sub
  // frame — resolved against the sub's own graph, never the main flow's.
  "a tap inside a sub resolves against that sub's frames": async () => {
    const session = await buildSessionLinesFixture({ id: "__tap_sub__" });
    const sub = session.subFrames["Tetra"];
    assert.ok(sub, "fixture must build the Tetra sub-score");
    const startIdx = sub.frameList.findIndex(
      (f) => f.toLowerCase() === "start.svg",
    );
    const links = sub.graph.frameLinks[sub.frameList[startIdx]] || [];
    assert.ok(links.length > 0, "the sub START must link somewhere");

    assert.strictEqual(
      validateTapTarget({
        selectedId: `${links[0]}#${sub.frameList[startIdx]}#0`,
        frameName: sub.frameList[startIdx],
        frameList: sub.frameList,
        frameLinks: sub.graph.frameLinks,
        currentIndex: startIdx,
      }),
      links[0],
    );
    // A main-flow index that happens to be in range for the sub list is still
    // refused: it is not a destination this sub frame offers.
    const notALink = sub.frameList
      .map((_, i) => i)
      .find((i) => !links.includes(i) && i !== startIdx);
    if (notALink != null) {
      assert.strictEqual(
        validateTapTarget({
          selectedId: `${notALink}#${sub.frameList[startIdx]}#0`,
          frameName: sub.frameList[startIdx],
          frameList: sub.frameList,
          frameLinks: sub.graph.frameLinks,
          currentIndex: startIdx,
        }),
        null,
      );
    }
  },
};
