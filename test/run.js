#!/usr/bin/env node

/**
 * Dependency-free test runner.
 *
 * Discovers every `test/*.test.js`, runs the tests it exports, and exits
 * non-zero if any fail. A test file may export:
 *   - a single async/sync function: `module.exports = async () => { ... }`
 *   - an object of named tests:     `module.exports = { "name": fn, ... }`
 *
 * Tests use `node:assert`. No external framework (jest/mocha/etc.).
 */

const fs = require("fs");
const path = require("path");

async function main() {
  const testDir = __dirname;
  const files = fs
    .readdirSync(testDir)
    .filter((f) => f.endsWith(".test.js"))
    .sort();

  let passed = 0;
  let failed = 0;
  const failures = [];

  for (const file of files) {
    const mod = require(path.join(testDir, file));
    const cases =
      typeof mod === "function"
        ? [[file.replace(/\.test\.js$/, ""), mod]]
        : Object.entries(mod).filter(([, fn]) => typeof fn === "function");

    for (const [name, fn] of cases) {
      const label = `${file} :: ${name}`;
      try {
        await fn();
        passed++;
        console.log(`  ok   ${label}`);
      } catch (err) {
        failed++;
        failures.push({ label, err });
        console.error(`  FAIL ${label}`);
      }
    }
  }

  if (failures.length > 0) {
    console.error("\n--- Failures ---");
    for (const { label, err } of failures) {
      console.error(`\n${label}`);
      console.error(err && err.stack ? err.stack : err);
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
