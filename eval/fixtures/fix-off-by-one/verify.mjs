#!/usr/bin/env node
// Verify command for the fix-off-by-one fixture. Imports the SUT,
// runs three asserts, exits 0 on success / 1 on any failure with
// the failing case printed. Self-contained — no test framework so
// this verifies cleanly on a vendored-deps-free fixture.

import assert from "node:assert/strict";
import { countDown } from "./src/countdown.js";

try {
  assert.deepEqual(countDown(3), [3, 2, 1], "countDown(3) must include 1");
  assert.deepEqual(countDown(1), [1], "countDown(1) must return [1] (not [])");
  assert.deepEqual(countDown(0), [], "countDown(0) must return []");
  console.log("PASS: fix-off-by-one");
  process.exit(0);
} catch (err) {
  console.error("FAIL:", err instanceof Error ? err.message : String(err));
  process.exit(1);
}
