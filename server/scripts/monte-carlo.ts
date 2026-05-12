#!/usr/bin/env node
// Monte Carlo simulation of the blackboard worker parse cascade.
// Models each todo through: parse → repair → brain → sibling → stale.
// Uses conservative empirical priors from production observations.
//
// Usage: npx tsx server/scripts/monte-carlo.ts

// ── Empirical priors (from docs/model-behaviors.md, project_run_patterns.md) ──

interface ModelProfile {
  name: string;
  /** Probability raw parse succeeds on first attempt */
  pParseOk: number;
  /** Probability repair prompt succeeds (given parse failed) */
  pRepairOk: number;
  /** Probability brain fallback succeeds (given repair failed) */
  pBrainOk: number;
  /** Probability sibling model succeeds (given all above failed) */
  pSiblingOk: number;
  /** Probability applyAndCommit succeeds (given valid hunks) */
  pHunkOk: number;
  /** Mean turn time (seconds) */
  meanTurnS: number;
  /** P95 turn time (seconds) */
  p95TurnS: number;
}

// Conservative estimates — erring on the pessimistic side.
// Derived from: glm-5.1 ~70s mean, heavy reasoning, known XML drift.
// gemma4 ~12s mean, fast, fewer failures. nemotron bimodal latency.
const models: Record<string, ModelProfile> = {
  "glm-5.1:cloud": {
    name: "glm-5.1:cloud",
    pParseOk: 0.75,      // ~25% XML drift / format failure
    pRepairOk: 0.60,     // repair helps but not always
    pBrainOk: 0.80,      // gemma4 brain parser is good at extraction
    pSiblingOk: 0.55,    // nemotron as sibling, moderate success
    pHunkOk: 0.85,       // hunks usually apply (few-search failures ~15%)
    meanTurnS: 70,
    p95TurnS: 300,
  },
  "gemma4:31b-cloud": {
    name: "gemma4:31b-cloud",
    pParseOk: 0.82,      // faster model, fewer format issues
    pRepairOk: 0.65,
    pBrainOk: 0.80,      // same brain model
    pSiblingOk: 0.45,    // falls back to nemotron, lower success for coding tasks
    pHunkOk: 0.80,       // slightly worse hunks (few-shot mistakes documented)
    meanTurnS: 12,
    p95TurnS: 47,
  },
  "nemotron-3-super:cloud": {
    name: "nemotron-3-super:cloud",
    pParseOk: 0.78,
    pRepairOk: 0.58,
    pBrainOk: 0.80,
    pSiblingOk: 0.50,    // falls back to glm-5.1
    pHunkOk: 0.83,
    meanTurnS: 58,
    p95TurnS: 457,
  },
};

// Sibling model mapping (from BlackboardRunnerConstants.ts)
const siblings: Record<string, string> = {
  "glm-5.1:cloud": "nemotron-3-super:cloud",
  "nemotron-3-super:cloud": "glm-5.1:cloud",
  "gemma4:31b-cloud": "nemotron-3-super:cloud",
};

interface SimResult {
  tier: string;
  success: boolean;
  attempts: number;
  wallTimeS: number;
  cascadePath: string[];  // e.g., ["parse"] or ["parse","repair","brain","sibling","sibling-ok"]
}

function simTodo(model: string, enableSibling = true): SimResult {
  const profile = models[model];
  if (!profile) throw new Error(`Unknown model: ${model}`);

  const path: string[] = [];
  let currentModel = model;
  let wallTime = 0;
  let attempts = 0;

  function turnTime(): number {
    // Sample from a lognormal-ish distribution bounded by mean and p95
    const base = profile.meanTurnS;
    const stretch = profile.p95TurnS / profile.meanTurnS;
    // Use a simple triangular-like random sample
    const r = Math.random();
    if (r < 0.5) return base * (0.5 + r);              // fast half: 0.5-1.0x mean
    if (r < 0.85) return base * (1 + 2 * Math.random()); // normal: 1-3x mean
    return base * (2 + 3 * Math.random());               // tail: 2-5x mean
  }

  // ---- Tier 1: Raw parse ----
  wallTime += turnTime();
  attempts++;
  if (Math.random() < profile.pParseOk) {
    path.push("parse");
    // Check hunk application
    if (Math.random() < profile.pHunkOk) {
      return { tier: "committed", success: true, attempts, wallTimeS: Math.round(wallTime), cascadePath: path };
    }
    // Hunk repair retry
    wallTime += turnTime();
    if (Math.random() < profile.pHunkOk) {
      path.push("hunk-repair-ok");
      return { tier: "committed", success: true, attempts, wallTimeS: Math.round(wallTime), cascadePath: path };
    }
    return { tier: "hunk-fail", success: false, attempts, wallTimeS: Math.round(wallTime), cascadePath: [...path, "hunk-fail"] };
  }
  path.push("parse-fail");

  // ---- Tier 2: Repair prompt ----
  wallTime += turnTime();
  attempts++;
  if (Math.random() < profile.pRepairOk) {
    path.push("repair");
    if (Math.random() < profile.pHunkOk) {
      return { tier: "committed", success: true, attempts, wallTimeS: Math.round(wallTime), cascadePath: path };
    }
    return { tier: "hunk-fail", success: false, attempts, wallTimeS: Math.round(wallTime), cascadePath: [...path, "hunk-fail"] };
  }
  path.push("repair-fail");

  // ---- Tier 3: Brain fallback ----
  wallTime += turnTime() * 0.3;  // brain model is faster (gemma4)
  if (Math.random() < profile.pBrainOk) {
    path.push("brain");
    if (Math.random() < profile.pHunkOk) {
      return { tier: "committed", success: true, attempts, wallTimeS: Math.round(wallTime), cascadePath: path };
    }
    return { tier: "hunk-fail", success: false, attempts, wallTimeS: Math.round(wallTime), cascadePath: [...path, "hunk-fail"] };
  }
  path.push("brain-fail");

  // ---- Tier 4: Sibling retry ----
  if (enableSibling) {
    const sibling = siblings[currentModel];
    if (sibling && sibling !== currentModel) {
      const sibProfile = models[sibling];
      if (sibProfile) {
        wallTime += turnTime();  // model swap + fresh prompt
        attempts++;
        if (Math.random() < sibProfile.pParseOk) {
          path.push("sibling-ok");
          if (Math.random() < sibProfile.pHunkOk) {
            return { tier: "committed", success: true, attempts, wallTimeS: Math.round(wallTime), cascadePath: path };
          }
          return { tier: "hunk-fail", success: false, attempts, wallTimeS: Math.round(wallTime), cascadePath: [...path, "hunk-fail"] };
        }
        path.push("sibling-fail");
      }
    }
  }

  return { tier: "stale", success: false, attempts, wallTimeS: Math.round(wallTime), cascadePath: path };
}

// ── Run simulation ──

const ITERATIONS = 100_000;
const TODO_COUNT = 10; // todos per run

interface AggregateStats {
  model: string;
  successRate: number;
  meanTimeS: number;
  p95TimeS: number;
  tierBreakdown: Record<string, number>;  // tier → count of successes
  cascadeBreakdown: Record<string, number>;  // path → count
  siblingSavings: number;  // % of runs saved by sibling retry
}

function runSim(model: string, enableSibling: boolean): AggregateStats {
  const results: SimResult[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    for (let t = 0; t < TODO_COUNT; t++) {
      results.push(simTodo(model, enableSibling));
    }
  }

  const successes = results.filter((r) => r.success);
  const times = results.map((r) => r.wallTimeS).sort((a, b) => a - b);
  const tierBreakdown: Record<string, number> = {};
  const cascadeBreakdown: Record<string, number> = {};

  for (const r of results) {
    const key = r.cascadePath.join("→") || "unknown";
    cascadeBreakdown[key] = (cascadeBreakdown[key] ?? 0) + 1;
    if (r.success) {
      tierBreakdown[r.tier] = (tierBreakdown[r.tier] ?? 0) + 1;
    }
  }

  return {
    model,
    successRate: successes.length / results.length,
    meanTimeS: Math.round(times.reduce((a, b) => a + b, 0) / times.length),
    p95TimeS: times[Math.floor(times.length * 0.95)],
    tierBreakdown,
    cascadeBreakdown,
    siblingSavings: 0, // computed below
  };
}

// ── Main ──

console.log("=".repeat(70));
console.log("Monte Carlo — Blackboard worker parse cascade");
console.log(`${ITERATIONS.toLocaleString()} iterations × ${TODO_COUNT} todos = ${(ITERATIONS * TODO_COUNT).toLocaleString()} simulated todos`);
console.log("=".repeat(70));

for (const modelKey of Object.keys(models)) {
  console.log(`\n--- ${modelKey} ---`);

  // With sibling retry
  const withSib = runSim(modelKey, true);
  // Without sibling retry (baseline)
  const withoutSib = runSim(modelKey, false);

  const improvement = withSib.successRate - withoutSib.successRate;
  const relativeImprovement = (improvement / withoutSib.successRate) * 100;

  console.log(`  Success rate:       ${(withSib.successRate * 100).toFixed(1)}% (without sibling: ${(withoutSib.successRate * 100).toFixed(1)}%)`);
  console.log(`  Sibling improvement: +${(improvement * 100).toFixed(1)}pp (${relativeImprovement.toFixed(0)}% relative)`);
  console.log(`  Mean turn wall-time: ${withSib.meanTimeS}s (p95: ${withSib.p95TimeS}s)`);

  // Top cascade paths
  console.log("  Cascade path distribution:");
  const sorted = Object.entries(withSib.cascadeBreakdown)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 6);
  for (const [path, count] of sorted) {
    const pct = ((count / (ITERATIONS * TODO_COUNT)) * 100).toFixed(1);
    console.log(`    ${pct}%  ${path}`);
  }

  // Tier where success happened
  console.log("  Success tier breakdown:");
  const totalSuccess = withSib.successRate * ITERATIONS * TODO_COUNT;
  for (const [tier, count] of Object.entries(withSib.tierBreakdown).sort()) {
    const pct = ((count / totalSuccess) * 100).toFixed(1);
    console.log(`    ${pct}%  ${tier}`);
  }
}

// ── Cross-model comparison ──
console.log("\n" + "=".repeat(70));
console.log("Cross-model comparison");
console.log("=".repeat(70));

const allModels = Object.keys(models);
console.log("\nEnd-to-end todo success probability (including hunk apply):");
for (const m of allModels) {
  const s = runSim(m, true);
  console.log(`  ${m.padEnd(25)} ${(s.successRate * 100).toFixed(1)}%  (${s.meanTimeS}s mean, ${s.p95TimeS}s p95)`);
}

console.log("\nSibling-retry impact:");
for (const m of allModels) {
  const withSib = runSim(m, true);
  const withoutSib = runSim(m, false);
  const saved = (withSib.successRate - withoutSib.successRate) * 100;
  console.log(`  ${m.padEnd(25)} +${saved.toFixed(1)}pp  (${((saved / withoutSib.successRate) * 100).toFixed(0)}% relative improvement)`);
}

// ── Sensitivity: what if brain model improves? ──
console.log("\n" + "=".repeat(70));
console.log("Sensitivity: brain fallback improvement");
console.log("=".repeat(70));

for (const brainP of [0.7, 0.8, 0.9, 0.95]) {
  const origP = models["glm-5.1:cloud"].pBrainOk;
  models["glm-5.1:cloud"].pBrainOk = brainP;
  const s = runSim("glm-5.1:cloud", true);
  models["glm-5.1:cloud"].pBrainOk = origP;
  console.log(`  glm-5.1 brain P=${brainP}: success ${(s.successRate * 100).toFixed(1)}% (mean ${s.meanTimeS}s)`);
}

// ── Queue dynamics under parallel workers ──
console.log("\n" + "=".repeat(70));
console.log("Queue dynamics: 4 workers, 50 todos per run");
console.log("=".repeat(70));

const workers = 4;
const todos = 50;
const runs = 10_000;
let totalStale = 0;
let totalCommitted = 0;
let totalTime = 0;

for (let r = 0; r < runs; r++) {
  let queueOpen = todos;
  let queueClaimed = 0;
  let runTime = 0;

  // Simple discrete-event sim: each "tick" ~= one worker turn
  while (queueOpen > 0 || queueClaimed > 0) {
    // Workers claim open todos
    const claiming = Math.min(workers - queueClaimed, queueOpen);
    queueOpen -= claiming;
    queueClaimed += claiming;

    // Each claimed worker processes (with gemma4 params)
    const processed = queueClaimed;
    for (let w = 0; w < processed; w++) {
      const result = simTodo("gemma4:31b-cloud", true);
      runTime += result.wallTimeS / workers; // parallelized
      queueClaimed--;
      if (result.success) totalCommitted++;
      else totalStale++;
    }
  }
  totalTime += runTime;
}

console.log(`  Per-run: ${(totalCommitted / runs).toFixed(0)} committed, ${(totalStale / runs).toFixed(0)} stale`);
console.log(`  Commit rate: ${((totalCommitted / (totalCommitted + totalStale)) * 100).toFixed(1)}%`);
console.log(`  Mean wall-time: ${Math.round(totalTime / runs / 60)} min`);
