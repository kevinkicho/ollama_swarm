import { test } from "node:test";
import assert from "node:assert/strict";
import { sum } from "./sum.js";

test("sum adds two numbers", () => {
  assert.equal(sum(1, 2), 3);
});

test("sum handles zero", () => {
  assert.equal(sum(0, 0), 0);
});

// THIS TEST IS BROKEN: the assertion is wrong (sum(2, 3) === 5, not 6).
// Fix the assertion to make `npm test` pass. Do NOT change src/sum.js —
// the production function is correct; only this assertion needs fixing.
test("sum of 2 and 3 is 5", () => {
  assert.equal(sum(2, 3), 6);
});
