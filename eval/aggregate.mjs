#!/usr/bin/env node
// Phase 7 of #314: aggregator for multi-seed eval results.
//
// Reads <sweep-dir>/results.json (the array of per-attempt rows that
// run-eval.mjs writes) and produces:
//   - eval/RESULTS.md     committed scoreboard (markdown table; medians + IQR per cell)
//   - eval/results.json   machine-readable sibling
//
// Usage:
//   node eval/aggregate.mjs runs/_eval/<timestamp>
//
// Cell value format: "median (p25-p75) · pass/N"
//   - median = 50th percentile of score.total across seeds
//   - p25-p75 = inter-quartile range so noise is visible at a glance
//   - pass/N = how many of the N seeds passed (score >= 60 AND ok)

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

// Per-cell aggregates: median, p25, p75, passCount, attemptCount.
function quantile(sortedAsc, q) {
  if (sortedAsc.length === 0) return 0;
  const idx = (sortedAsc.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}

export function aggregateCell(rows) {
  const scores = rows.map((r) => r?.score?.total ?? 0).slice().sort((a, b) => a - b);
  const median = Math.round(quantile(scores, 0.5));
  const p25 = Math.round(quantile(scores, 0.25));
  const p75 = Math.round(quantile(scores, 0.75));
  const passCount = rows.filter((r) => r.ok && (r?.score?.total ?? 0) >= 60).length;
  const attemptCount = rows.length;
  return { median, p25, p75, passCount, attemptCount };
}

function main(sweepDir) {
  const resultsPath = path.join(sweepDir, "results.json");
  let results;
  try {
    results = JSON.parse(readFileSync(resultsPath, "utf8"));
  } catch (err) {
    console.error(`Failed to read ${resultsPath}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  if (!Array.isArray(results) || results.length === 0) {
    console.error("results.json is empty or not an array");
    process.exit(1);
  }

  // Group by (taskId, preset). Each group becomes one cell.
  const groups = new Map();
  for (const r of results) {
    const key = `${r.taskId}::${r.preset}`;
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }

  const tasksSet = new Set();
  const presetsSet = new Set();
  for (const r of results) {
    tasksSet.add(r.taskId);
    presetsSet.add(r.preset);
  }
  const tasks = [...tasksSet].sort();
  const presets = [...presetsSet].sort();

  const aggregates = {};
  for (const task of tasks) {
    aggregates[task] = {};
    for (const preset of presets) {
      const rows = groups.get(`${task}::${preset}`);
      if (!rows || rows.length === 0) {
        aggregates[task][preset] = null;
        continue;
      }
      aggregates[task][preset] = aggregateCell(rows);
    }
  }

  // Build markdown table.
  const lines = [];
  lines.push("# Multi-provider scoreboard");
  lines.push("");
  lines.push(`**Generated:** ${new Date().toISOString().slice(0, 10)} from \`${sweepDir}\``);
  lines.push(`**Attempts:** ${results.length} runs across ${tasks.length} tasks × ${presets.length} presets`);
  lines.push("");
  lines.push("Cell format: `median (p25-p75) · passCount/attempts`. \"Pass\" = score ≥ 60 AND the run finished cleanly. Lower IQR = more consistent preset behavior.");
  lines.push("");
  lines.push(`| Task | ${presets.join(" | ")} |`);
  lines.push(`| --- | ${presets.map(() => "---:").join(" | ")} |`);
  for (const task of tasks) {
    const cells = presets.map((preset) => {
      const a = aggregates[task][preset];
      if (!a) return "—";
      return `${a.median} (${a.p25}–${a.p75}) · ${a.passCount}/${a.attemptCount}`;
    });
    lines.push(`| **${task}** | ${cells.join(" | ")} |`);
  }

  // Per-preset rollup at the bottom: median across all that preset's cells.
  lines.push("");
  lines.push("## Per-preset summary");
  lines.push("");
  lines.push(`| Preset | Median across tasks | Pass rate |`);
  lines.push(`| --- | ---: | ---: |`);
  for (const preset of presets) {
    const allRows = results.filter((r) => r.preset === preset);
    const allScores = allRows.map((r) => r?.score?.total ?? 0).slice().sort((a, b) => a - b);
    const median = Math.round(quantile(allScores, 0.5));
    const passCount = allRows.filter((r) => r.ok && (r?.score?.total ?? 0) >= 60).length;
    const passRate = allRows.length === 0 ? 0 : Math.round((passCount / allRows.length) * 100);
    lines.push(`| ${preset} | ${median} | ${passRate}% (${passCount}/${allRows.length}) |`);
  }

  lines.push("");
  lines.push("## How to reproduce");
  lines.push("");
  lines.push("```bash");
  lines.push("# 1. Set ANTHROPIC_API_KEY (or OPENAI_API_KEY) in .env");
  lines.push("# 2. Start the dev server: npm run dev");
  lines.push("# 3. Run the sweep (5 seeds × every preset × every task in catalog):");
  lines.push("node eval/run-eval.mjs --repo=https://github.com/<your/target> --seeds=5");
  lines.push("# 4. Aggregate the results:");
  lines.push("node eval/aggregate.mjs runs/_eval/<timestamp>");
  lines.push("```");
  lines.push("");
  lines.push("Numbers above are not absolute. They are a comparative ranking of presets on the same fixture set with the same model. Move the model + the fixture set and the table changes — pick presets for *your* task class, not by copying these.");

  const md = lines.join("\n");
  writeFileSync(path.join("eval", "RESULTS.md"), md);
  writeFileSync(
    path.join("eval", "results.json"),
    JSON.stringify({ generated: new Date().toISOString(), sweepDir, aggregates, raw: results }, null, 2),
  );

  console.log(`Wrote eval/RESULTS.md (${md.length} bytes) and eval/results.json (${results.length} runs).`);
}

// Only run main() when invoked as a CLI; importing for tests skips it.
if (import.meta.url === `file://${process.argv[1]}`) {
  const sweepDir = process.argv[2];
  if (!sweepDir) {
    console.error("Usage: node eval/aggregate.mjs <sweep-dir>");
    process.exit(2);
  }
  main(sweepDir);
}
