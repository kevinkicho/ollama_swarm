import { test } from "node:test";
import assert from "node:assert/strict";
import { computeRunTokenTotals } from "./blackboard/summary.js";

test("computeRunTokenTotals filters by runId when records are attributed", () => {
  const t0 = 1_000_000;
  const tracker = {
    recent: () => [
      { ts: t0 + 1000, promptTokens: 100, responseTokens: 10, runId: "run-a" },
      { ts: t0 + 2000, promptTokens: 500, responseTokens: 50, runId: "run-b" },
      { ts: t0 + 3000, promptTokens: 200, responseTokens: 20, runId: "run-a" },
    ],
  };
  const a = computeRunTokenTotals(t0, t0 + 10_000, tracker, "run-a");
  assert.equal(a.totalPromptTokens, 300);
  assert.equal(a.totalResponseTokens, 30);
  const b = computeRunTokenTotals(t0, t0 + 10_000, tracker, "run-b");
  assert.equal(b.totalPromptTokens, 500);
  assert.equal(b.totalResponseTokens, 50);
});

test("computeRunTokenTotals ignores out-of-window records", () => {
  const t0 = 1_000_000;
  const tracker = {
    recent: () => [
      { ts: t0 - 50_000, promptTokens: 9999, responseTokens: 9999, runId: "run-a" },
      { ts: t0 + 1000, promptTokens: 40, responseTokens: 5, runId: "run-a" },
    ],
  };
  const a = computeRunTokenTotals(t0, t0 + 10_000, tracker, "run-a");
  assert.equal(a.totalPromptTokens, 40);
  assert.equal(a.totalResponseTokens, 5);
});
