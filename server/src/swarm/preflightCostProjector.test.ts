// R4 (2026-05-04): tests for the pre-flight cost projector.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  projectRunCost,
  exceedsBudget,
} from "./preflightCostProjector.js";

test("projectRunCost — 0 turns → all zeros", () => {
  const got = projectRunCost({
    model: "anthropic/claude-opus-4-7",
    totalTurns: 0,
  });
  assert.equal(got.projectedPromptTokens, 0);
  assert.equal(got.projectedResponseTokens, 0);
  assert.equal(got.projectedCostUsd, 0);
});

test("projectRunCost — local Ollama model → $0 cost", () => {
  const got = projectRunCost({
    model: "llama3:8b",
    totalTurns: 30,
  });
  assert.equal(got.projectedCostUsd, 0);
  assert.ok(got.projectedPromptTokens > 0, "still reports tokens");
});

test("projectRunCost — single turn → just base context", () => {
  const got = projectRunCost({
    model: "anthropic/claude-opus-4-7",
    totalTurns: 1,
    baseContextTokens: 4000,
    growthPerTurnTokens: 800,
    responseTokensPerTurn: 600,
  });
  // 1 × 4000 + 800 × (1 × 0)/2 = 4000
  assert.equal(got.projectedPromptTokens, 4000);
  assert.equal(got.projectedResponseTokens, 600);
});

test("projectRunCost — quadratic growth across turns", () => {
  // 3 turns: base=1000, growth=500, response=200
  // prompt = 3 × 1000 + 500 × (3 × 2)/2 = 3000 + 1500 = 4500
  // response = 3 × 200 = 600
  const got = projectRunCost({
    model: "llama3:8b",
    totalTurns: 3,
    baseContextTokens: 1000,
    growthPerTurnTokens: 500,
    responseTokensPerTurn: 200,
  });
  assert.equal(got.projectedPromptTokens, 4500);
  assert.equal(got.projectedResponseTokens, 600);
});

test("projectRunCost — Anthropic Opus pricing reflected in projection", () => {
  // Opus = $15/M prompt + $75/M response
  // 100k prompt + 100k response → $1.50 + $7.50 = $9
  const got = projectRunCost({
    model: "anthropic/claude-opus-4-7",
    totalTurns: 1,
    baseContextTokens: 100_000,
    growthPerTurnTokens: 0,
    responseTokensPerTurn: 100_000,
  });
  assert.equal(got.projectedCostUsd, 9);
});

test("projectRunCost — breakdown string mentions model + tokens + dollars", () => {
  const got = projectRunCost({
    model: "anthropic/claude-haiku-4-5-20251001",
    totalTurns: 10,
  });
  assert.match(got.breakdown, /10 turns/);
  assert.match(got.breakdown, /claude-haiku/);
  assert.match(got.breakdown, /\$\d+\.\d{2}/);
});

test("projectRunCost — totalTurns derived from rounds × agents (sanity check on math)", () => {
  // Caller pattern: rounds=4, agents=3 → totalTurns=12
  const got = projectRunCost({
    model: "anthropic/claude-sonnet-4-6",
    totalTurns: 12,
  });
  // 12 × 4000 + 800 × (12 × 11)/2 = 48000 + 52800 = 100800
  assert.equal(got.projectedPromptTokens, 100_800);
});

test("exceedsBudget — projected < cap → false", () => {
  assert.equal(
    exceedsBudget({ projectedCostUsd: 5, costCapUsd: 10 }),
    false,
  );
});

test("exceedsBudget — projected > cap → true", () => {
  assert.equal(
    exceedsBudget({ projectedCostUsd: 15, costCapUsd: 10 }),
    true,
  );
});

test("exceedsBudget — cap of 0 means no cap → never exceeds", () => {
  assert.equal(
    exceedsBudget({ projectedCostUsd: 1000, costCapUsd: 0 }),
    false,
  );
});

test("exceedsBudget — cap = projected → not exceeded (equal allowed)", () => {
  assert.equal(
    exceedsBudget({ projectedCostUsd: 10, costCapUsd: 10 }),
    false,
  );
});
