#!/usr/bin/env node
// Priority Matrix — all recommendations from all analyses
// Axes: Impact (0-10) vs Effort (hours). Top-right = do first.
// Usage: npx tsx server/scripts/priority-matrix.ts

interface Recommendation {
  id: string;
  name: string;
  impact: number;   // 0-10
  effort: number;   // hours
  risk: "low" | "medium" | "high";
  source: string;   // which analysis
  status: "done" | "partial" | "queued" | "strategic";
}

const items: Recommendation[] = [
  // ═══ DONE (shipped this session) ═══
  { id: "MC-1", name: "Fuzzy hunk matching", impact: 8, effort: 2, risk: "low", source: "Monte Carlo", status: "done" },
  { id: "MC-2", name: "Pre-commit semantic validation", impact: 7, effort: 3, risk: "low", source: "Monte Carlo", status: "done" },
  { id: "LCCA-1", name: "Prompt versioning registry", impact: 6, effort: 3, risk: "low", source: "LCCA", status: "done" },
  { id: "LCCA-2", name: "Eval drift CI guard", impact: 6, effort: 3, risk: "low", source: "LCCA", status: "done" },
  { id: "LCCA-3", name: "Discussion runner consolidation", impact: 5, effort: 8, risk: "medium", source: "LCCA", status: "done" },
  { id: "SC-1", name: "Stale cascade tracking (StaleReason)", impact: 7, effort: 2, risk: "low", source: "Statechart", status: "done" },
  { id: "SC-2", name: "Auditor all-resolved early return", impact: 5, effort: 1, risk: "low", source: "Statechart", status: "done" },
  { id: "FM-1", name: "dequeueByScore contract doc", impact: 3, effort: 0.5, risk: "low", source: "Formal methods", status: "done" },
  { id: "UML-1", name: "Route schema extraction (swarm.ts -264 loc)", impact: 5, effort: 2, risk: "low", source: "UML", status: "done" },
  { id: "UML-2", name: "RunnerFactory (Orchestrator -8 imports)", impact: 5, effort: 2, risk: "low", source: "UML", status: "done" },
  { id: "UML-3", name: "getPresetName abstract contract", impact: 4, effort: 1, risk: "low", source: "UML", status: "done" },
  { id: "UML-4", name: "LifecycleState consolidation", impact: 4, effort: 1, risk: "low", source: "UML", status: "done" },
  { id: "DF-1", name: "Break postRoundCritique cycle", impact: 3, effort: 0.5, risk: "low", source: "Dataflow", status: "done" },
  { id: "DF-2", name: "Extract RunConfig (SwarmRunner -875 loc)", impact: 5, effort: 1, risk: "low", source: "Dataflow", status: "done" },
  { id: "DF-3", name: "Orchestrator method extraction", impact: 3, effort: 1, risk: "low", source: "Dataflow", status: "done" },
  { id: "DF-4", name: "Split types.ts → domain files", impact: 4, effort: 2, risk: "low", source: "Dataflow", status: "done" },

  // ═══ PARTIALLY DONE ═══
  { id: "SC-3", name: "Region status dashboard (API done, UI deferred)", impact: 2, effort: 4, risk: "low", source: "Statechart", status: "partial" },
  { id: "STR-1", name: "Eval catalog 100% coverage (hunk scoring pending)", impact: 8, effort: 2, risk: "low", source: "Strategic", status: "partial" },
  { id: "STR-3", name: "Local-first API (UI toggle deferred)", impact: 9, effort: 3, risk: "low", source: "Strategic", status: "partial" },
  { id: "STR-4", name: "Tier-ratchet event (eval sweep pending)", impact: 7, effort: 4, risk: "medium", source: "Strategic", status: "partial" },

  // ═══ STRATEGIC (long-term) ═══
  { id: "NEW-A", name: "Publish eval catalog as benchmark scoreboard", impact: 10, effort: 8, risk: "low", source: "Strategic", status: "strategic" },
  { id: "NEW-B", name: "Validate tier ratchet on 5+ real repos", impact: 9, effort: 16, risk: "medium", source: "Strategic", status: "strategic" },
  { id: "NEW-C", name: "Build local-Ollama fast path (UI + benchmarks)", impact: 9, effort: 12, risk: "medium", source: "Strategic", status: "strategic" },
  { id: "STR-5", name: "Multi-user readiness (per-user filters, rate limits)", impact: 4, effort: 6, risk: "low", source: "Strategic", status: "strategic" },
  { id: "PERF-1", name: "Event-driven worker claims (replace polling)", impact: 6, effort: 24, risk: "high", source: "Performance", status: "strategic" },
  { id: "PERF-2", name: "Planner context summarization (long runs)", impact: 7, effort: 16, risk: "medium", source: "Performance", status: "strategic" },
];

// ═══════════════════════════════════════════════════════════════════════════
// MATRIX
// ═══════════════════════════════════════════════════════════════════════════

console.log("=".repeat(68));
console.log("PRIORITY MATRIX — All Analyses Combined");
console.log("Axes: Impact (0-10) × Effort (hours). Top-left = do first.");
console.log("=".repeat(68));

console.log("\n── QUADRANT 1: High Impact, Low Effort (Do First) ──");
const q1 = items.filter((i) => i.impact >= 7 && i.effort <= 6 && i.status !== "done");
for (const i of q1) {
  console.log(`  [${i.status.toUpperCase()}] ${i.name} (${i.source})`);
  console.log(`    Impact: ${i.impact}/10 | Effort: ${i.effort}h | Risk: ${i.risk}`);
}

console.log("\n── QUADRANT 2: High Impact, High Effort (Plan Next) ──");
const q2 = items.filter((i) => i.impact >= 7 && i.effort > 6 && i.status !== "done");
for (const i of q2) {
  console.log(`  [${i.status.toUpperCase()}] ${i.name} (${i.source})`);
  console.log(`    Impact: ${i.impact}/10 | Effort: ${i.effort}h | Risk: ${i.risk}`);
}

console.log("\n── QUADRANT 3: Low Impact, Low Effort (Fill Gaps) ──");
const q3 = items.filter((i) => i.impact < 7 && i.effort <= 6 && i.status !== "done");
for (const i of q3) {
  console.log(`  [${i.status.toUpperCase()}] ${i.name} (${i.source})`);
  console.log(`    Impact: ${i.impact}/10 | Effort: ${i.effort}h | Risk: ${i.risk}`);
}

console.log("\n── QUADRANT 4: Low Impact, High Effort (Avoid) ──");
const q4 = items.filter((i) => i.impact < 7 && i.effort > 6 && i.status !== "done");
for (const i of q4) {
  console.log(`  [${i.status.toUpperCase()}] ${i.name} (${i.source})`);
  console.log(`    Impact: ${i.impact}/10 | Effort: ${i.effort}h | Risk: ${i.risk}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════════════════════════════════════

const done = items.filter((i) => i.status === "done").length;
const partial = items.filter((i) => i.status === "partial").length;
const strategic = items.filter((i) => i.status === "strategic").length;

console.log("\n── SUMMARY ──");
console.log(`  Done:       ${done} items`);
console.log(`  Partial:    ${partial} items`);
console.log(`  Strategic:  ${strategic} items`);
console.log(`  Total:      ${done + partial + strategic} items`);

const totalEffortDone = items.filter((i) => i.status === "done").reduce((s, i) => s + i.effort, 0);
const totalEffortRemaining = items.filter((i) => i.status !== "done").reduce((s, i) => s + i.effort, 0);
console.log(`  Effort shipped: ${totalEffortDone}h`);
console.log(`  Effort remaining: ${totalEffortRemaining}h`);

// ═══════════════════════════════════════════════════════════════════════════
// RANK BY ROI (impact / effort)
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n── RANKED BY ROI (Impact ÷ Effort) ──");
const roiRank = [...items]
  .filter((i) => i.status !== "done")
  .sort((a, b) => (b.impact / b.effort) - (a.impact / a.effort));

console.log("Rank | ROI  | Name                                          | Status");
console.log("-".repeat(72));
roiRank.forEach((i, n) => {
  const roi = (i.impact / i.effort).toFixed(1);
  console.log(
    ` ${String(n + 1).padStart(3)} | ${roi.padStart(4)} | ${i.name.padEnd(46)} | ${i.status}`,
  );
});

console.log("\n── TOP 3 NEXT ACTIONS ──");
const top3 = roiRank.slice(0, 3);
for (const i of top3) {
  console.log(`  ${i.id}: ${i.name} (${i.effort}h, ${i.status})`);
}
