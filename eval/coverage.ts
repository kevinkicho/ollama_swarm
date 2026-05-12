#!/usr/bin/env node
// Eval coverage: cross-references eval catalog against presets, models,
// and prompt assertions. Identifies gaps where coverage is zero.
// Usage: npx tsx eval/coverage.ts

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const catalog = JSON.parse(
  readFileSync(path.join(root, "eval", "catalog.json"), "utf8"),
);

const tasks = catalog.tasks as Array<{
  id: string;
  title: string;
  presets: string[];
  wallClockCapMs?: number;
  rounds?: number;
}>;

const ALL_PRESETS = [
  "round-robin", "blackboard", "role-diff", "council",
  "orchestrator-worker", "orchestrator-worker-deep",
  "debate-judge", "map-reduce", "stigmergy", "moa", "baseline",
];

// ── Preset coverage ──
console.log("=".repeat(55));
console.log("Eval Coverage Analysis");
console.log("=".repeat(55));

const presetCoverage = new Map<string, number>();
for (const p of ALL_PRESETS) presetCoverage.set(p, 0);
for (const t of tasks) {
  for (const p of (t.presets ?? [])) {
    presetCoverage.set(p, (presetCoverage.get(p) ?? 0) + 1);
  }
}

console.log("\nPreset coverage (tasks per preset):");
const covered = [...presetCoverage.entries()].filter(([, n]) => n > 0);
const uncovered = [...presetCoverage.entries()].filter(([, n]) => n === 0);
for (const [p, n] of covered.sort(([, a], [, b]) => b - a)) {
  console.log(`  ${p.padEnd(25)} ${n} task(s)`);
}
if (uncovered.length > 0) {
  console.log("\n  UNCOVERED:");
  for (const [p] of uncovered) {
    console.log(`  ${p.padEnd(25)} 0 tasks — GAP`);
  }
}

// ── Model coverage ──
console.log("\nModel coverage:");
const modelsCovered = new Set<string>();
const allModels = ["glm-5.1:cloud", "gemma4:31b-cloud", "nemotron-3-super:cloud", "deepseek-v4-pro:cloud"];
for (const m of allModels) {
  // The eval catalog doesn't directly specify models per task —
  // models are selected by the sweep script defaults.
  // Report warning if no model override exists in any task.
  const tasksWithModel = tasks.filter((t: any) => t.model === m);
  const status = tasksWithModel.length > 0 ? `${tasksWithModel.length} tasks explicitly` : "uses sweep default";
  console.log(`  ${m.padEnd(25)} ${status}`);
}

// ── Round count distribution ──
console.log("\nRound count distribution:");
const roundDist = new Map<number, number>();
for (const t of tasks) {
  const r = t.rounds ?? 0;
  roundDist.set(r, (roundDist.get(r) ?? 0) + 1);
}
for (const [r, n] of [...roundDist.entries()].sort(([a], [b]) => a - b)) {
  const label = r === 0 ? "autonomous" : String(r);
  console.log(`  ${String(label).padEnd(10)} ${n} task(s)`);
}

// ── Wall-clock cap distribution ──
console.log("\nWall-clock cap distribution:");
const capDist = new Map<string, number>();
for (const t of tasks) {
  const capMin = Math.round((t.wallClockCapMs ?? 600_000) / 60_000);
  const label = `${capMin} min`;
  capDist.set(label, (capDist.get(label) ?? 0) + 1);
}
for (const [cap, n] of [...capDist.entries()].sort(([a], [b]) => parseInt(a) - parseInt(b))) {
  console.log(`  ${cap.padEnd(10)} ${n} task(s)`);
}

// ── Summary ──
console.log(`\n${tasks.length} tasks across ${covered.length}/${ALL_PRESETS.length} presets (${((covered.length / ALL_PRESETS.length) * 100).toFixed(0)}% coverage)`);
if (uncovered.length > 0) {
  console.log(`GAP: ${uncovered.length} preset(s) with zero tasks: ${uncovered.map(([p]) => p).join(", ")}`);
}
console.log("\nRecommendation: add 1-2 tasks per uncovered preset to reach 100% coverage.");
