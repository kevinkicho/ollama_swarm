#!/usr/bin/env node
import assert from "node:assert/strict";
import { formatUser } from "./src/format.js";

try {
  // Happy path still works
  assert.equal(
    formatUser({ name: "Kevin", email: "k@example.com" }),
    "Kevin <k@example.com>",
  );
  // Null guard: must NOT throw, must return the fallback
  assert.doesNotThrow(() => formatUser(null), "formatUser(null) must not throw");
  assert.equal(formatUser(null), "Anonymous <unknown>");
  assert.equal(formatUser(undefined), "Anonymous <unknown>");
  console.log("PASS: add-null-guard");
  process.exit(0);
} catch (err) {
  console.error("FAIL:", err instanceof Error ? err.message : String(err));
  process.exit(1);
}
