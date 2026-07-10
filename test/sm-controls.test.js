/**
 * Chunk M — SM controls across lines (pure decision logic).
 *
 * Covers the FigJam "history modal behavior" rule via the pure
 * `historyAvailability` predicate: with 2+ populated lines history/jump is
 * available only while the room is synchronized (every device-bearing line on
 * a track-grouped frame), and "impossible" the moment a device-bearing line
 * sits on a non-grouped frame or dives into a sub-session. A SINGLE populated
 * line is an undiverged room (S6, decided 2026-07-07): available anywhere on
 * the main flow, disabled only inside a sub. Empty lines (0 devices) never
 * block. The final case runs the rule over the real "Session Lines Demo" graph
 * so it lines up with the actual markup (START split → Left/Right track-group
 * "converge" → Barrier → Tetra sub).
 */

const assert = require("node:assert");
const {
  historyAvailability,
  groupOfFrame,
} = require("../lib/session-lines/orchestrator");
const { buildScore } = require("../bin/build-score.js");

const always = () => 1; // every line has a device
const groupConst = (g) => () => g;

module.exports = {
  "historyAvailability: no populated lines → available (nothing to desync)": () => {
    const lines = [{ id: "L0" }, { id: "L1" }];
    assert.strictEqual(
      historyAvailability(lines, () => null, () => 0),
      true,
    );
  },

  "historyAvailability: all device-bearing lines grouped → available": () => {
    const lines = [{ id: "L1" }, { id: "L2" }];
    assert.strictEqual(
      historyAvailability(lines, groupConst("converge"), always),
      true,
    );
  },

  "historyAvailability: a device-bearing line on a non-grouped frame → impossible": () => {
    const lines = [
      { id: "L1", g: "converge" },
      { id: "L2", g: null }, // diverged onto a non-grouped frame
    ];
    assert.strictEqual(
      historyAvailability(lines, (l) => l.g, always),
      false,
    );
  },

  "historyAvailability: a single populated line is undiverged → available anywhere (S6)": () => {
    const lines = [{ id: "L0", g: null }]; // e.g. pre-split on START
    assert.strictEqual(
      historyAvailability(lines, (l) => l.g, always),
      true,
    );
  },

  "historyAvailability: a single populated line inside a sub → impossible": () => {
    const lines = [{ id: "L0", g: null, inSub: true }];
    assert.strictEqual(
      historyAvailability(lines, (l) => l.g, always, (l) => l.inSub === true),
      false,
    );
  },

  "historyAvailability: empty lines are ignored (don't block populated ones)": () => {
    const lines = [
      { id: "L1", g: "converge", devices: 2 },
      { id: "L2", g: null, devices: 0 }, // empty child (e.g. in a sub) → ignored
    ];
    assert.strictEqual(
      historyAvailability(lines, (l) => l.g, (l) => l.devices),
      true,
    );
  },

  "Session Lines Demo: availability follows the real frame markup": async () => {
    const session = await buildScore("Session Lines Demo", {
      id: "__sm_hist_test__",
    });
    const graph = session.graph;
    const groupForFrame = (frame) => groupOfFrame(graph, frame);

    // A line whose current frame resolves to its track group (null in a sub).
    const lineAt = (frame, { devices = 1, inSub = false } = {}) => ({
      devices,
      inSub,
      group: inSub ? null : groupForFrame(frame),
    });
    const avail = (lines) =>
      historyAvailability(
        lines,
        (l) => l.group,
        (l) => l.devices,
        (l) => l.inSub,
      );

    // Only Left/Right belong to the "converge" track group; the rest do not.
    assert.strictEqual(groupForFrame("Left.svg"), "converge");
    assert.strictEqual(groupForFrame("Right.svg"), "converge");
    assert.strictEqual(groupForFrame("START.svg"), null);
    assert.strictEqual(groupForFrame("Barrier.svg"), null);
    assert.strictEqual(groupForFrame("DONE.svg"), null);

    // At START (split frame, non-grouped) — a single undiverged line, so the
    // room's whole story is one plain history → available (S6).
    assert.strictEqual(avail([lineAt("START.svg")]), true);

    // Both children on the converge group → available.
    assert.strictEqual(avail([lineAt("Left.svg"), lineAt("Right.svg")]), true);

    // Right dived into the Tetra sub (non-grouped) → impossible.
    assert.strictEqual(
      avail([lineAt("Left.svg"), lineAt("Right.svg", { inSub: true })]),
      false,
    );

    // Everyone chose Left; the empty Right child (0 devices, in sub) is ignored,
    // so the single populated line on the converge group keeps history available.
    assert.strictEqual(
      avail([
        lineAt("Left.svg", { devices: 3 }),
        lineAt("Right.svg", { devices: 0, inSub: true }),
      ]),
      true,
    );

    // Two populated lines, one parked at the Barrier (non-grouped) → impossible
    // (the decided reading-(i) checkpoint fallback is future modal work).
    assert.strictEqual(
      avail([lineAt("Barrier.svg"), lineAt("Left.svg")]),
      false,
    );

    // …but a LONE populated line parked at the Barrier is still one branch →
    // available (S6): the operator can rewind it out of the wait.
    assert.strictEqual(avail([lineAt("Barrier.svg")]), true);
  },
};
