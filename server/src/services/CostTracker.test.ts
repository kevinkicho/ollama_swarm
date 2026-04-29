import { test } from "node:test";
import assert from "node:assert/strict";
import {
  costForUsage,
  sumCost,
  costCapExceeded,
  getPricesForTest,
} from "./CostTracker.js";
import {
  ANTHROPIC_MODELS,
  OPENAI_MODELS,
  stripProviderPrefix,
} from "../../../shared/src/providers.js";

test("costForUsage — ollama models cost $0", () => {
  assert.equal(
    costForUsage({ model: "glm-5.1:cloud", promptTokens: 1_000_000, responseTokens: 1_000_000 }),
    0,
  );
});

test("costForUsage — anthropic claude-opus-4-7 = $15 input + $75 output per Mtok", () => {
  const cost = costForUsage({
    model: "anthropic/claude-opus-4-7",
    promptTokens: 1_000_000,
    responseTokens: 1_000_000,
  });
  assert.equal(cost, 90); // 15 + 75
});

test("costForUsage — openai gpt-5 = $5 input + $20 output per Mtok", () => {
  const cost = costForUsage({
    model: "openai/gpt-5",
    promptTokens: 1_000_000,
    responseTokens: 1_000_000,
  });
  assert.equal(cost, 25); // 5 + 20
});

test("costForUsage — undefined model returns $0 (no provider known)", () => {
  assert.equal(costForUsage({ promptTokens: 1000, responseTokens: 1000 }), 0);
});

test("costForUsage — unknown anthropic model uses fallback pricing", () => {
  const cost = costForUsage({
    model: "anthropic/claude-future-model-99",
    promptTokens: 1_000_000,
    responseTokens: 1_000_000,
  });
  // fallback: $5 input + $25 output = $30 per Mtok+Mtok
  assert.equal(cost, 30);
});

test("costForUsage — partial Mtok scales linearly", () => {
  // 100k prompt + 50k response on Sonnet (3 / 15)
  const cost = costForUsage({
    model: "anthropic/claude-sonnet-4-6",
    promptTokens: 100_000,
    responseTokens: 50_000,
  });
  // (100k / 1M) * 3 + (50k / 1M) * 15 = 0.3 + 0.75 = 1.05
  assert.ok(Math.abs(cost - 1.05) < 1e-9, `expected ~1.05, got ${cost}`);
});

test("sumCost — sums across heterogeneous records", () => {
  const records = [
    { model: "anthropic/claude-sonnet-4-6", promptTokens: 100_000, responseTokens: 50_000 },
    { model: "glm-5.1:cloud", promptTokens: 999_999_999, responseTokens: 999_999_999 },
    { model: "openai/gpt-5-nano", promptTokens: 1_000_000, responseTokens: 1_000_000 },
  ];
  // sonnet 1.05 + ollama 0 + nano (0.2 + 0.8 = 1.0) = 2.05
  assert.ok(Math.abs(sumCost(records) - 2.05) < 1e-9);
});

test("costCapExceeded — undefined or zero cap is always false", () => {
  const records = [
    { model: "anthropic/claude-opus-4-7", promptTokens: 999_999_999, responseTokens: 999_999_999 },
  ];
  assert.equal(costCapExceeded(records, undefined), false);
  assert.equal(costCapExceeded(records, 0), false);
});

test("costCapExceeded — fires at-or-above threshold", () => {
  // Sonnet: 100k prompt + 50k response = $1.05
  const records = [
    { model: "anthropic/claude-sonnet-4-6", promptTokens: 100_000, responseTokens: 50_000 },
  ];
  assert.equal(costCapExceeded(records, 1.0), true, "$1.05 ≥ $1 → exceeded");
  assert.equal(costCapExceeded(records, 1.05), true, "exactly equal → exceeded (>= semantics)");
  assert.equal(costCapExceeded(records, 1.06), false, "$1.05 < $1.06 → not exceeded");
});

test("PRICES table — every advertised anthropic / openai model has a price", () => {
  const prices = getPricesForTest();
  for (const m of ANTHROPIC_MODELS) {
    const id = stripProviderPrefix(m);
    assert.ok(prices.anthropic[id], `anthropic price missing for ${id}`);
  }
  for (const m of OPENAI_MODELS) {
    const id = stripProviderPrefix(m);
    assert.ok(prices.openai[id], `openai price missing for ${id}`);
  }
});
