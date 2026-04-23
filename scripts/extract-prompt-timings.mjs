#!/usr/bin/env node
// Unit 21: read `_prompt_timing` records from logs/current.jsonl and
// print per-preset / per-agent / per-attempt latency stats. Pairs with
// Unit 19, which writes the records.
//
// Usage:
//   node scripts/extract-prompt-timings.mjs
//   node scripts/extract-prompt-timings.mjs --log path/to/other.jsonl
//   node scripts/extract-prompt-timings.mjs --preset council
//
// Output is plain text tables for direct reading. No JSON / CSV
// emission yet — add when something downstream needs it.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

// ---- args ----
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ""), true];
  }),
);
const LOG_PATH = args.log ?? path.join(repoRoot, "logs", "current.jsonl");
const PRESET_FILTER = args.preset ?? null;

// ---- read records ----
if (!fs.existsSync(LOG_PATH)) {
  console.error(`log file not found: ${LOG_PATH}`);
  process.exit(1);
}
const records = [];
for (const line of fs.readFileSync(LOG_PATH, "utf8").split("\n")) {
  if (!line) continue;
  try {
    const d = JSON.parse(line);
    const e = d?.event;
    if (e?.type !== "_prompt_timing") continue;
    if (PRESET_FILTER && e.preset !== PRESET_FILTER) continue;
    records.push(e);
  } catch {
    // ignore malformed lines
  }
}

if (records.length === 0) {
  console.log(
    `No _prompt_timing records found in ${LOG_PATH}` +
      (PRESET_FILTER ? ` (preset=${PRESET_FILTER})` : "") +
      ". Run a swarm first; Unit 19 logs these on every session.prompt call.",
  );
  process.exit(0);
}

// ---- helpers ----
function pct(sortedAsc, p) {
  if (sortedAsc.length === 0) return null;
  const rank = Math.max(1, Math.ceil((p * sortedAsc.length) / 100));
  return sortedAsc[rank - 1];
}
function fmtMs(ms) {
  if (ms == null) return "—";
  if (ms < 10_000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
function group(records, keyFn) {
  const out = new Map();
  for (const r of records) {
    const k = keyFn(r);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(r);
  }
  return out;
}
function statsOf(records) {
  const succ = records.filter((r) => r.success);
  const lats = succ.map((r) => r.elapsedMs).sort((a, b) => a - b);
  const total = records.length;
  const mean = lats.length ? Math.round(lats.reduce((s, v) => s + v, 0) / lats.length) : null;
  return {
    total,
    success: succ.length,
    failurePct: total ? Math.round(100 * (total - succ.length) / total) : 0,
    p50: pct(lats, 50),
    p95: pct(lats, 95),
    mean,
    max: lats.length ? lats[lats.length - 1] : null,
  };
}
function printRow(label, s) {
  console.log(
    `${label.padEnd(34)} ` +
      `${String(s.total).padStart(5)}  ${String(s.success).padStart(5)}  ` +
      `${String(s.failurePct + "%").padStart(5)}  ` +
      `${fmtMs(s.p50).padStart(8)}  ${fmtMs(s.p95).padStart(8)}  ` +
      `${fmtMs(s.mean).padStart(8)}  ${fmtMs(s.max).padStart(8)}`,
  );
}

// ---- output ----
console.log(`source: ${LOG_PATH}`);
console.log(`records: ${records.length}` + (PRESET_FILTER ? ` (filtered to preset=${PRESET_FILTER})` : ""));
console.log("");
const HEADER =
  `${"".padEnd(34)} ${"calls".padStart(5)}  ${"ok".padStart(5)}  ${"fail%".padStart(5)}  ` +
  `${"p50".padStart(8)}  ${"p95".padStart(8)}  ${"mean".padStart(8)}  ${"max".padStart(8)}`;

console.log("=== Aggregate (all calls) ===");
console.log(HEADER);
printRow("ALL", statsOf(records));
console.log("");

console.log("=== By preset ===");
console.log(HEADER);
for (const [preset, rs] of [...group(records, (r) => r.preset ?? "?")].sort()) {
  printRow(preset, statsOf(rs));
}
console.log("");

console.log("=== By preset + agent (latency on successful calls only) ===");
console.log(HEADER);
const byKey = [...group(records, (r) => `${r.preset ?? "?"} / ${r.agentId ?? "?"}`)].sort();
for (const [key, rs] of byKey) {
  printRow(key, statsOf(rs));
}
console.log("");

console.log("=== By attempt number (cold = attempt 1; retries = 2+) ===");
console.log(HEADER);
for (const [att, rs] of [...group(records, (r) => `attempt ${r.attempt ?? "?"}`)].sort()) {
  printRow(att, statsOf(rs));
}
