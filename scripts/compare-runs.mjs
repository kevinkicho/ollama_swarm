#!/usr/bin/env node
// Unit 33: cross-preset run comparison.
//
// Reads `summary.json` files from multiple run directories and prints a
// side-by-side table of the metrics worth comparing across runs /
// presets. Call with paths to either the `summary.json` file directly
// or the run directory containing it:
//
//   node scripts/compare-runs.mjs runs/phase11c-medium-v6 runs/phase11c-medium-v7
//   node scripts/compare-runs.mjs runs/*/summary.json
//
// Output is plain text — column-aligned, one row per metric, one column
// per run. Non-applicable cells (e.g., "commits" on a council preset)
// show as "—" rather than zero so the distinction between "this preset
// can't commit" and "this preset ran and committed zero" stays legible.

import { readFile } from "node:fs/promises";
import path from "node:path";

async function resolveSummaryPath(input) {
  // Accept either a file path or a directory path. If directory: append
  // summary.json. Throw a clear error if neither works.
  const looksLikeFile = input.endsWith(".json");
  const candidate = looksLikeFile ? input : path.join(input, "summary.json");
  try {
    const text = await readFile(candidate, "utf8");
    return { path: candidate, summary: JSON.parse(text) };
  } catch (err) {
    throw new Error(
      `could not read summary at '${candidate}': ${err.message}`,
    );
  }
}

function formatMs(ms) {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(2)}h`;
}

function formatNumberOrDash(n) {
  if (n == null) return "—";
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  return String(n);
}

function formatStatOrDash(n) {
  if (n == null) return "—";
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  return `${Math.round(n)}ms`;
}

// Aggregate helpers — derive things from the per-agent rows.
function sumAgentField(summary, field) {
  if (!Array.isArray(summary?.agents) || summary.agents.length === 0) return null;
  const vals = summary.agents
    .map((a) => a[field])
    .filter((v) => typeof v === "number" && Number.isFinite(v));
  if (vals.length === 0) return null;
  return vals.reduce((s, v) => s + v, 0);
}

function meanAgentField(summary, field) {
  if (!Array.isArray(summary?.agents) || summary.agents.length === 0) return null;
  const vals = summary.agents
    .map((a) => a[field])
    .filter((v) => typeof v === "number" && Number.isFinite(v));
  if (vals.length === 0) return null;
  return vals.reduce((s, v) => s + v, 0) / vals.length;
}

function countMetCriteria(summary) {
  if (!summary?.contract?.criteria) return null;
  return summary.contract.criteria.filter((c) => c.status === "met").length;
}

function countUnmetCriteria(summary) {
  if (!summary?.contract?.criteria) return null;
  return summary.contract.criteria.filter((c) => c.status === "unmet").length;
}

function totalCriteria(summary) {
  if (!summary?.contract?.criteria) return null;
  return summary.contract.criteria.length;
}

// ROW definitions: [label, formatter taking summary → string]. Order is
// the row order of the output table — tuned so identity rows come first,
// timing/cost rows next, then outcome, then preset-specific.
const ROWS = [
  ["preset", (s) => s.preset ?? "—"],
  ["agentCount", (s) => formatNumberOrDash(s.agentCount)],
  ["rounds", (s) => formatNumberOrDash(s.rounds)],
  ["model", (s) => s.model ?? "—"],
  ["—", () => ""],
  ["wallClock", (s) => formatMs(s.wallClockMs)],
  ["stopReason", (s) => s.stopReason ?? "—"],
  ["stopDetail", (s) => (s.stopDetail ? s.stopDetail.slice(0, 48) : "—")],
  ["—", () => ""],
  ["filesChanged", (s) => formatNumberOrDash(s.filesChanged)],
  // Blackboard-only rows. Dash for non-blackboard summaries.
  ["commits (bb)", (s) => formatNumberOrDash(s.commits)],
  ["todos total (bb)", (s) => formatNumberOrDash(s.totalTodos)],
  ["staleEvents (bb)", (s) => formatNumberOrDash(s.staleEvents)],
  ["criteria total", (s) => formatNumberOrDash(totalCriteria(s))],
  ["criteria met", (s) => formatNumberOrDash(countMetCriteria(s))],
  ["criteria unmet", (s) => formatNumberOrDash(countUnmetCriteria(s))],
  // Unit 34: ambition-ratchet tier stats. Absent for pre-Unit-34 runs
  // and runs that never installed a contract.
  ["max tier reached (bb)", (s) => formatNumberOrDash(s.maxTierReached)],
  ["tiers completed (bb)", (s) => formatNumberOrDash(s.tiersCompleted)],
  ["—", () => ""],
  ["total attempts", (s) => formatNumberOrDash(sumAgentField(s, "totalAttempts"))],
  ["total retries", (s) => formatNumberOrDash(sumAgentField(s, "totalRetries"))],
  ["successful attempts", (s) => formatNumberOrDash(sumAgentField(s, "successfulAttempts"))],
  ["mean latency (agent-avg)", (s) => formatStatOrDash(meanAgentField(s, "meanLatencyMs"))],
  ["p95 latency (agent-avg)", (s) => formatStatOrDash(meanAgentField(s, "p95LatencyMs"))],
];

function padEnd(s, n) {
  if (s.length >= n) return s;
  return s + " ".repeat(n - s.length);
}

function renderTable(columns, rows) {
  const widths = columns.map((c) => c.length);
  const cellGrid = rows.map((rowCells) =>
    rowCells.map((cell, ci) => {
      if (cell.length > widths[ci]) widths[ci] = cell.length;
      return cell;
    }),
  );
  const headerLine = columns.map((c, i) => padEnd(c, widths[i])).join("  │  ");
  const sepLine = columns
    .map((_, i) => "─".repeat(widths[i]))
    .join("──┼──");
  const bodyLines = cellGrid.map((r) =>
    r.map((cell, i) => padEnd(cell, widths[i])).join("  │  "),
  );
  return [headerLine, sepLine, ...bodyLines].join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("Usage: compare-runs.mjs <run-dir-or-summary.json> [<more>…]");
    console.error("");
    console.error("Examples:");
    console.error(
      "  node scripts/compare-runs.mjs runs/phase11c-medium-v6 runs/phase11c-medium-v7",
    );
    console.error("  node scripts/compare-runs.mjs runs/*/summary.json");
    process.exit(1);
  }

  const loaded = [];
  for (const a of args) {
    try {
      const { path: p, summary } = await resolveSummaryPath(a);
      loaded.push({ label: shortLabel(p), summary });
    } catch (err) {
      console.error(err.message);
      process.exitCode = 1;
    }
  }
  if (loaded.length === 0) {
    console.error("No valid summaries found. Nothing to compare.");
    process.exit(1);
  }

  const columns = ["metric", ...loaded.map((l) => l.label)];
  const rows = ROWS.map(([label, formatter]) => [
    label,
    ...loaded.map((l) => (label === "—" ? "" : formatter(l.summary))),
  ]);

  console.log(renderTable(columns, rows));
}

function shortLabel(p) {
  // runs/phase11c-medium-v7/summary.json → "phase11c-medium-v7"
  const parts = path.normalize(p).split(path.sep).filter(Boolean);
  // drop trailing "summary.json" if present
  const tail = parts[parts.length - 1] === "summary.json" ? parts.slice(0, -1) : parts;
  return tail[tail.length - 1] ?? p;
}

main().catch((err) => {
  console.error(err.stack ?? err.message ?? String(err));
  process.exit(1);
});
