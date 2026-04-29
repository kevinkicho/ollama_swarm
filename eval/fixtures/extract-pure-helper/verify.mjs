#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { computePrice } from "./src/calc.js";

try {
  // Behavior preserved
  assert.equal(computePrice([{ price: 10, qty: 2 }]), 26.4); // 20 * 1.07 + 5
  assert.equal(computePrice([]), 5); // 0 + 0 + 5 shipping
  assert.equal(
    computePrice([{ price: 100, qty: 1 }, { price: 50, qty: 2 }]),
    219, // 200 * 1.07 + 5
  );

  // Refactor must have happened: source must declare a function called applyTax
  const src = readFileSync(new URL("./src/calc.js", import.meta.url), "utf8");
  if (!/(function|const|let)\s+applyTax/.test(src)) {
    console.error("FAIL: src/calc.js must declare a helper named `applyTax`.");
    process.exit(1);
  }

  console.log("PASS: extract-pure-helper");
  process.exit(0);
} catch (err) {
  console.error("FAIL:", err instanceof Error ? err.message : String(err));
  process.exit(1);
}
