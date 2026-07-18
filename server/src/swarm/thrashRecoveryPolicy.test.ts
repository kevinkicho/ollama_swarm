/**
 * Source-level thrash recovery policy locks for council worker stack.
 * Complements shared/thrashInvariants.test.ts (pure classify metrics).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RETRY = readFileSync(join(__dirname, "councilWorkerRetryChain.ts"), "utf8");
const ATTEMPT = readFileSync(join(__dirname, "councilWorkerAttempt.ts"), "utf8");
const LIT = readFileSync(join(__dirname, "councilWorkerLiterature.ts"), "utf8");

test("thrash policy — apply_miss skips same-model re-emit (stage 2)", () => {
  assert.match(RETRY, /primaryBucket === "apply_miss"/);
  assert.match(RETRY, /skipping same-model re-emit/);
  // Stage 2 for apply_miss must NOT call tryWorkerPrompt with repairFrom
  // in that branch — only set repairResult to retry with lastResponse.
  const applyBranch = RETRY.slice(
    RETRY.indexOf('primaryBucket === "apply_miss"'),
    RETRY.indexOf("} else {", RETRY.indexOf('primaryBucket === "apply_miss"')),
  );
  assert.doesNotMatch(applyBranch, /tryWorkerPrompt\s*\(/);
  assert.match(applyBranch, /outcome: "retry"/);
});

test("thrash policy — non-apply_miss still uses repairFrom envelope repair", () => {
  assert.match(RETRY, /trying JSON\/envelope repair prompt/);
  assert.match(RETRY, /repairFrom:/);
  assert.match(RETRY, /buildWorkerRepairPrompt|repairFrom/);
});

test("thrash policy — literature never re-enters on repairFrom", () => {
  assert.match(ATTEMPT, /skip:\s*!!opts\.repairFrom/);
  assert.match(ATTEMPT, /no literature/);
  assert.match(LIT, /opts\?\.skip/);
});

test("thrash policy — grounded repair notes recovered vs terminal", () => {
  assert.match(ATTEMPT, /noteMissRecoveredDet/);
  assert.match(ATTEMPT, /noteMissRecoveredLlm/);
  assert.match(ATTEMPT, /noteMissTerminal/);
  assert.match(ATTEMPT, /deterministicCandidate/);
});

test("thrash policy — garbage skip does not settle as permanent skip", () => {
  assert.match(ATTEMPT, /classifyWorkerSkip/);
  assert.match(ATTEMPT, /garbage skip/);
  assert.match(ATTEMPT, /worker returned no hunks \(garbage skip placeholder\)/);
});

test("thrash policy — stage 3 is one failover model only (not same-model loop)", () => {
  assert.match(RETRY, /withSiblingRetry/);
  assert.match(RETRY, /councilWorkerFallbackModel/);
  // Failover path calls tryWorkerPrompt once after model swap — not a retry loop.
  assert.match(
    RETRY,
    /withSiblingRetry\s*\(\s*\{[\s\S]*?\},\s*async\s*\(\)\s*=>\s*\{\s*siblingResult\s*=\s*await\s*tryWorkerPrompt/,
  );
  // No while-loop re-emit around stage 3.
  const stage3Idx = RETRY.indexOf("Stage 3: Failover");
  assert.ok(stage3Idx > 0);
  assert.doesNotMatch(RETRY.slice(stage3Idx), /while\s*\(/);
});
