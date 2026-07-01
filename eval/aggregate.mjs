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
  lines.push("## Methodology");
  lines.push("");
  lines.push("Each cell is N independent attempts of one (task, preset) pair, each with a different seed. The score is computed by `eval/score.mjs` against the task's verify gate; \"pass\" means score ≥ 60 AND the run completed cleanly (no crash, no cap-trip, no quota wall).");
  lines.push("");
  lines.push("- **median + IQR** rather than mean — single bad seed shouldn't dominate the cell, and IQR width signals consistency.");
  lines.push("- **passCount/attempts** is the headline number for go/no-go decisions; the median score is for ranking.");
  lines.push("- **Fixture set** lives in `eval/fixtures/`; each fixture is a self-contained git repo the swarm clones + modifies + we verify via the fixture's own `verify.mjs`. Synthetic by design — they isolate one capability per task.");
  lines.push("- **Per-role models** (when shown for blackboard / MoA hetero): planner = reasoning tier, worker = coding tier, auditor = strongest reasoning. See `server/src/swarm/dynamicModelRoute.ts` for the routing logic.");
  lines.push("");
  lines.push("## Honest limitations");
  lines.push("");
  lines.push("These numbers are useful for **comparative ranking on this fixture set** — not for absolute claims about the underlying models or for cross-paper benchmarking.");
  lines.push("");
  lines.push("1. **Synthetic fixtures.** All tasks are author-written code-modify / refactor / analysis exercises. Real-world tasks (SWE-Bench style) have different distributions; numbers don't transfer 1:1.");
  lines.push("2. **JS/TS only.** Every fixture targets a Node-runnable verify gate. Cross-language coverage (Python, Go, Rust) needs separate fixture work + per-language verify harnesses.");
  lines.push("3. **Sample size.** Default sweeps run 3 seeds × ~10 tasks ≈ 30 attempts per preset. Variance is wide at this scale; per-task outliers shouldn't be over-claimed.");
  lines.push("4. **Local-Node verify.** Verify gates run in this machine's Node — no Docker isolation, no cross-environment compatibility check. SWE-Bench-style \"tests pass against the real upstream environment\" is a harder bar (`eval/swe-bench/` for that path).");
  lines.push("5. **`:cloud` models** route through Ollama-Cloud's hosted infra. \"Open weights\" by model identity, not by self-hosted GPU. A truly self-hosted comparison would change the cost calculus.");
  lines.push("6. **Cost ratio** comparing free (Ollama / local) and paid (Anthropic / OpenAI) presets uses dollars; for tokens-per-dollar fairness see `summary.totalPromptTokens + totalResponseTokens` per attempt + the `server/src/services/CostTracker.ts` rate table.");
  lines.push("7. **Single-machine, single-pass.** No multi-machine scaling, no hyperparameter sweep, no A/B vs older versions of the codebase. This is a snapshot.");
  lines.push("");
  lines.push("## How to reproduce");
  lines.push("");
  lines.push("```bash");
  lines.push("# 1. Set ANTHROPIC_API_KEY (or OPENAI_API_KEY) in .env if comparing paid models");
  lines.push("# 2. Pull the Ollama models referenced in the matrix:");
  lines.push("#    ollama pull glm-5.1:cloud gemma4:31b-cloud deepseek-v4-flash:cloud");
  lines.push("# 3. Start the dev server: npm run dev");
  lines.push("# 4. Run the sweep (3 seeds × every preset × every task in catalog):");
  lines.push("node eval/run-eval.mjs --fixture-dir=eval/fixtures --seeds=3");
  lines.push("# 5. Aggregate the results:");
  lines.push("node eval/aggregate.mjs runs/_eval/<timestamp>");
  lines.push("```");
  lines.push("");
  lines.push("To run JUST the MoA heterogeneous config (small fast proposers + big synthesis aggregator):");
  lines.push("");
  lines.push("```bash");
  lines.push("node eval/run-eval.mjs --fixture-dir=eval/fixtures --presets=moa --seeds=3 \\");
  lines.push("  --moa-proposer-model=gemma4:31b-cloud \\");
  lines.push("  --moa-aggregator-model=deepseek-v4-flash:cloud \\");
  lines.push("  --out=runs/_eval/scoreboard-E-moa-hetero");
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
