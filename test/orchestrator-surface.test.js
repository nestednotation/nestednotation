/**
 * The orchestrator's public surface, checked against its only caller.
 *
 * `bin/www` reaches the orchestrator through ONE object — the instance
 * `createOrchestrator` returns — while the module also has a `module.exports`
 * listing the same pure helpers for the unit tests. The two lists are written
 * out by hand, in different places, and nothing connected them: adding a
 * helper to `module.exports` and forgetting the instance produced a module
 * that loads, unit tests that pass, and a `TypeError: orch.X is not a
 * function` thrown at the moment an operator clicks something mid-piece
 * (`cascadeSteps` — the cascade race guard was dead on arrival and every
 * structural undo it guarded refused in silence).
 *
 * So the check is made from the call site: every `orch.<name>` that appears in
 * `bin/www` has to exist on a real instance. Cheap, and it fails at the moment
 * the mistake is made rather than in front of a room.
 */

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const {
  createOrchestrator,
  ...moduleExports
} = require("../lib/session-lines/orchestrator");

/** Every `orch.<name>` bin/www calls, in source order. */
function namesUsedByRuntime() {
  const src = fs.readFileSync(path.join(__dirname, "..", "bin", "www"), "utf8");
  const used = new Set();
  for (const match of src.matchAll(/\borch\.([A-Za-z_$][\w$]*)/g)) {
    used.add(match[1]);
  }
  return [...used].sort();
}

module.exports = {
  "every orch.* bin/www calls exists on the instance": () => {
    // The orchestrator only closes over these for line creation / ids; nothing
    // in the surface check calls through to them.
    const orch = createOrchestrator({}, {});
    const used = namesUsedByRuntime();
    assert.ok(used.length > 20, `expected a real call list, got ${used.length}`);
    const missing = used.filter((name) => typeof orch[name] !== "function");
    assert.deepStrictEqual(
      missing,
      [],
      `bin/www calls orch.${missing.join(", orch.")} — missing from createOrchestrator's return`,
    );
  },

  "the pure module exports are all on the instance too": () => {
    const orch = createOrchestrator({}, {});
    const missing = Object.keys(moduleExports).filter(
      (name) =>
        typeof moduleExports[name] === "function" &&
        typeof orch[name] !== "function",
    );
    // Not a hard rule for every helper — some are genuinely test-only — but a
    // new one that the runtime will want is far likelier to be forgotten here
    // than to be deliberately withheld, so the list is pinned.
    assert.deepStrictEqual(
      missing,
      [],
      `exported but not on the instance: ${missing.join(", ")}`,
    );
  },
};
