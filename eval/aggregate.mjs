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
import { pathToFileURL } from "node:url";

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

function main(...sweepDirs) {
  // 2026-05-01: accept multiple sweep dirs and merge their results.json
  // arrays into one. Lets the launcher pass every relevant dir
  // (sweep1-baseline + sweep1-blackboard + sweep1-blackboard-cont +
  // sweep2-analysis-v2) for one unified scoreboard. Pre-fix: only
  // argv[2] was read; everything else silently ignored.
  if (sweepDirs.length === 0) {
    console.error("Usage: node eval/aggregate.mjs <sweep-dir> [<sweep-dir> ...]");
    process.exit(2);
  }
  const sweepDir = sweepDirs.length === 1 ? sweepDirs[0] : sweepDirs.join(" + ");
  const allResults = [];
  for (const dir of sweepDirs) {
    const resultsPath = path.join(dir, "results.json");
    try {
      const arr = JSON.parse(readFileSync(resultsPath, "utf8"));
      if (Array.isArray(arr)) allResults.push(...arr);
    } catch (err) {
      console.error(`Skipping ${resultsPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (allResults.length === 0) {
    console.error("No valid results.json arrays across the passed dirs");
    process.exit(1);
  }
  const results = allResults;

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
// 2026-05-01: pathToFileURL guard to make CLI detection cross-platform
// (Windows backslashes broke the bare `file://${argv[1]}` template).
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sweepDirs = process.argv.slice(2);
  if (sweepDirs.length === 0) {
    console.error("Usage: node eval/aggregate.mjs <sweep-dir> [<sweep-dir> ...]");
    process.exit(2);
  }
  main(...sweepDirs);
}
