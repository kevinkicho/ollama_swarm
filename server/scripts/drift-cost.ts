#!/usr/bin/env node
// Drift-cost model: estimates the dollar cost of ignoring each drifted prompt.
// Reads the prompt registry and drift-check results, then computes
// stale_todos × seconds_per_turn × engineer_rate = annual waste per prompt.
// Usage: npx tsx server/scripts/drift-cost.ts

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// ── Configuration ──
const ENG_HOURLY_RATE = 150;       // USD
const MEAN_TURN_SECONDS = 26;       // gemma4 mean (conservative)
const RUNS_PER_YEAR = 365;          // 1 run/day
const TODOS_PER_RUN = 40;
const STALE_RATE_INCREMENT = 0.02;  // fractional increase in stale rate per drifted assertion

// ── Load registry ──
async function loadRegistry(): Promise<any[]> {
  const mod = await import("../src/swarm/blackboard/prompts/registry.js");
  return mod.promptRegistry;
}

// ── Simulate drift-check results ──
async function runDriftCheck(): Promise<Map<string, { prompt: string; failedAssertions: string[] }>> {
  const results = new Map();
  const registry = await loadRegistry();

  for (const entry of registry) {
    const promptPath = path.join(here, "..", "src", "swarm", "blackboard", entry.sourceFile);
    let promptText = "";
    try {
      promptText = readFileSync(promptPath, "utf8");
    } catch { continue; }

    const failed: string[] = [];
    for (const assertion of entry.expectedBehavior) {
      // Check only prompt-text-verifiable assertions
      if (assertion.includes("MUST NOT contain")) {
        const match = assertion.match(/MUST NOT contain '([^']+)'/);
        if (match && promptText.includes(match[1])) {
          failed.push(assertion);
        }
      }
      if (assertion.includes("MUST mention") || assertion.includes("MUST contain") || assertion.includes("MUST require")) {
        const match = assertion.match(/(?:MUST (?:contain|mention|require)).*?(\w+)/i);
        if (match && !promptText.toLowerCase().includes(match[1].toLowerCase())) {
          failed.push(assertion);
        }
      }
      if (assertion.includes("MUST prohibit")) {
        const match = assertion.match(/MUST prohibit.*?['']?([A-Z]+)/i);
        if (match && !promptText.toLowerCase().includes(match[1].toLowerCase())) {
          failed.push(assertion);
        }
      }
    }
    results.set(entry.name, { prompt: entry.name, failedAssertions: failed });
  }
  return results;
}

// ── Compute cost ──
async function main() {
  const driftResults = await runDriftCheck();
  const registry = await loadRegistry();

  console.log("=".repeat(65));
  console.log("Model Drift Economic Model");
  console.log("=".repeat(65));
  console.log(`  Engineer rate: $${ENG_HOURLY_RATE}/hr`);
  console.log(`  Mean turn:     ${MEAN_TURN_SECONDS}s`);
  console.log(`  Runs/year:     ${RUNS_PER_YEAR}`);
  console.log(`  Todos/run:     ${TODOS_PER_RUN}`);
  console.log("");

  const hourlyRatePerSec = ENG_HOURLY_RATE / 3600;
  let totalAnnualCost = 0;

  console.log("Prompt               | Failed | Annual Waste | Verdict");
  console.log("-".repeat(65));

  for (const entry of registry) {
    const result = driftResults.get(entry.name);
    if (!result) continue;
    const n = result.failedAssertions.length;

    // Annual waste: staleRateIncrement × n × TODOS_PER_RUN × MEAN_TURN × hourlyRate
    // Only meaningful for format-breaking assertions (MUST contain, MUST mention, MUST require)
    const formatFails = result.failedAssertions.filter(
      (a) => a.includes("MUST contain") || a.includes("MUST mention") || a.includes("MUST require") || a.includes("MUST prohibit"),
    ).length;

    const annualWaste = formatFails * STALE_RATE_INCREMENT * TODOS_PER_RUN * MEAN_TURN_SECONDS * hourlyRatePerSec * RUNS_PER_YEAR;
    totalAnnualCost += annualWaste;

    let verdict: string;
    if (n === 0) verdict = "OK";
    else if (annualWaste < 1) verdict = "IGNORE";
    else if (annualWaste < 100) verdict = "MONITOR";
    else verdict = "MIGRATE";

    const wasteStr = annualWaste < 0.01 ? "$<0.01" : `$${annualWaste.toFixed(2)}`;
    console.log(
      `${entry.name.padEnd(21)} | ${String(n).padStart(5)}  | ${wasteStr.padStart(8)}/yr  | ${verdict}`,
    );
  }

  console.log("-".repeat(65));
  console.log(`Total annual model drift waste: $${totalAnnualCost.toFixed(2)}/year`);
  console.log(`(At $${ENG_HOURLY_RATE}/hr, this equals ${(totalAnnualCost / ENG_HOURLY_RATE).toFixed(1)} hours/year)`);
  if (totalAnnualCost < 1) {
    console.log("\nAll prompts are healthy. No migration needed.");
  }
}

main().catch((err) => {
  console.error("Drift-cost analysis failed:", err.message);
  process.exit(1);
});
