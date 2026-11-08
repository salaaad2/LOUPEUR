"use strict";

// Minimal test runner: no dependencies, no build step. `node test/run.js`.
//
// Each test file exports an array of { name, fn }. A test fails by throwing.
// The runner prints one line per test and exits non-zero if anything failed.

const fs = require("fs");
const path = require("path");

const files = fs
  .readdirSync(__dirname)
  .filter((f) => f.endsWith(".test.js"))
  .sort();

async function main() {
  let passed = 0;
  const failures = [];

  for (const file of files) {
    const tests = require(path.join(__dirname, file));
    console.log("\n" + file);
    for (const test of tests) {
      try {
        await test.fn();
        passed++;
        console.log("  ok   " + test.name);
      } catch (err) {
        failures.push({ file, name: test.name, err });
        console.log("  FAIL " + test.name);
      }
    }
  }

  console.log("");
  if (failures.length) {
    for (const f of failures) {
      console.log("--- " + f.file + " :: " + f.name);
      console.log(String((f.err && f.err.stack) || f.err).replace(/^/gm, "    "));
      console.log("");
    }
    console.log(`${passed} passed, ${failures.length} failed`);
    process.exitCode = 1;
  } else {
    console.log(`${passed} passed`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
