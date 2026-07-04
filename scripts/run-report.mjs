#!/usr/bin/env node
/**
 * Run Report — human + machine readable summary for a run.
 * Usage:
 *   node scripts/run-report.mjs 59648aa6-7f12-4023-bcfc-945fc16e3599
 *   node scripts/run-report.mjs <runId> --json
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";

const runId = process.argv[2];
const asJson = process.argv.includes("--json") || process.argv.includes("-j");

if (!runId) {
  console.error("Usage: node scripts/run-report.mjs <run-id> [--json]");
  process.exit(1);
}

const projectLogs = path.join(process.cwd(), "logs", runId);
const summaryPath = path.join(projectLogs, "summary.json");
const delivDir = path.join(projectLogs, "deliverable");

let summary = null;
if (existsSync(summaryPath)) {
  try {
    summary = JSON.parse(readFileSync(summaryPath, "utf8"));
  } catch (e) {
    console.error("Failed to parse summary:", e.message);
  }
} else {
  console.error(`No summary.json found at ${summaryPath}`);
  // fallback: search clone? but for now error
  process.exit(2);
}

if (asJson) {
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

// Human readable
console.log(`\n=== Run Report: ${runId} ===\n`);
console.log(`Preset: ${summary.preset} | Model: ${summary.model}`);
console.log(`Started: ${new Date(summary.startedAt).toISOString()} | Ended: ${new Date(summary.endedAt).toISOString()}`);
console.log(`Duration: ${(summary.wallClockMs / 1000 / 60).toFixed(1)}m | Stop: ${summary.stopReason}`);
console.log(`Commits: ${summary.commits} | Files: ${summary.filesChanged} | Todos: ${summary.totalTodos} (skipped ${summary.skippedTodos}, stale ${summary.staleEvents})`);
console.log(`Tokens: prompt ${summary.totalPromptTokens} / resp ${summary.totalResponseTokens}`);
console.log(`Health: ${summary.healthScore?.score} (${summary.healthScore?.bucket})`);
if (summary.rca) {
  console.log(`RCA: ${summary.rca.primaryCause}`);
  if (summary.rca.recommendation) console.log(`  → ${summary.rca.recommendation}`);
}

console.log("\n--- Agents ---");
(summary.agents || []).forEach(a => {
  console.log(`  agent-${a.agentIndex} (${a.role || 'n/a'}): turns=${a.turnsTaken} tokensIn=${a.tokensIn} commits=${a.commits} rejected=${a.rejectedAttempts} meanLatency=${a.meanLatencyMs}ms`);
});

if (summary.contract) {
  console.log("\n--- Contract ---");
  console.log(summary.contract.missionStatement);
  (summary.contract.criteria || []).slice(0, 5).forEach(c => {
    console.log(`  [${c.status}] ${c.description}`);
  });
}

console.log("\n--- Deliverable / Next Actions ---");
if (existsSync(delivDir)) {
  const files = readdirSync(delivDir);
  console.log(`  Deliverable files: ${files.join(", ")}`);
} else {
  console.log("  No project-level deliverable dir");
}

console.log(`\nFull summary: ${summaryPath}`);
if (summary.startCommand) {
  console.log("\nReplay start:");
  console.log(summary.startCommand);
}
