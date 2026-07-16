/**
 * Cross-run deliberation memory for planner / council seeds.
 * Scans recent logs/<runId>/deliberation.jsonl under the project clone
 * and distills deny/approve patterns so the next run avoids repeated
 * weak claims and reuses validated approaches.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { DeliberationTransaction } from "./deliberationTypes.js";

export const DELIBERATION_SEED_MAX_RUNS = 8;
export const DELIBERATION_SEED_MAX_DENY = 8;
export const DELIBERATION_SEED_MAX_APPROVE = 5;

export interface DeliberationDenyPattern {
  sample: string;
  count: number;
  layer: string;
}

export interface DeliberationSeed {
  text: string;
  denyCount: number;
  approveCount: number;
  runsScanned: number;
  /** Ranked deny/challenge patterns (for hard filtering of re-proposed todos). */
  denyPatterns: DeliberationDenyPattern[];
  /** Ranked approve samples (for planner/arbitrator hints). */
  approvePatterns: Array<{ sample: string; count: number; layer: string }>;
}

function normalizeKey(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 120);
}

async function listRunLogDirs(logsRoot: string): Promise<string[]> {
  try {
    const ents = await fs.readdir(logsRoot, { withFileTypes: true });
    const dirs = ents.filter((e) => e.isDirectory()).map((e) => e.name);
    // Prefer longer ids (full runId) over short 8-char mirrors; sort by name
    // is weak — use mtime of deliberation.jsonl when present.
    const scored: Array<{ name: string; mtime: number }> = [];
    for (const name of dirs) {
      const f = path.join(logsRoot, name, "deliberation.jsonl");
      try {
        const st = await fs.stat(f);
        scored.push({ name, mtime: st.mtimeMs });
      } catch {
        /* no deliberation file */
      }
    }
    scored.sort((a, b) => b.mtime - a.mtime);
    return scored.map((s) => s.name);
  } catch {
    return [];
  }
}

async function readJsonl(file: string): Promise<DeliberationTransaction[]> {
  try {
    const raw = await fs.readFile(file, "utf8");
    const rows: DeliberationTransaction[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line) as DeliberationTransaction);
      } catch {
        /* skip */
      }
    }
    return rows;
  } catch {
    return [];
  }
}

/**
 * Load recent deliberation transactions from the project logs tree.
 * Pure aggregation after I/O; safe to call at seed time.
 */
export async function loadRecentDeliberationRows(
  clonePath: string,
  maxRuns: number = DELIBERATION_SEED_MAX_RUNS,
): Promise<{ rows: DeliberationTransaction[]; runsScanned: number }> {
  const logsRoot = path.join(clonePath, "logs");
  const runDirs = await listRunLogDirs(logsRoot);
  const seenShort = new Set<string>();
  const rows: DeliberationTransaction[] = [];
  let runsScanned = 0;

  for (const name of runDirs) {
    const short = name.slice(0, 8);
    if (seenShort.has(short)) continue; // skip duplicate short mirrors
    seenShort.add(short);
    if (runsScanned >= maxRuns) break;
    const file = path.join(logsRoot, name, "deliberation.jsonl");
    const batch = await readJsonl(file);
    if (batch.length === 0) continue;
    runsScanned++;
    rows.push(...batch);
  }

  return { rows, runsScanned };
}

/** Pure distill: most common deny / approve validation reasons. */
export function distillDeliberationSeed(
  rows: readonly DeliberationTransaction[],
  runsScanned: number,
): DeliberationSeed {
  if (rows.length === 0) {
    return {
      text: "",
      denyCount: 0,
      approveCount: 0,
      runsScanned,
      denyPatterns: [],
      approvePatterns: [],
    };
  }

  const denyFreq = new Map<string, { count: number; sample: string; layer: string }>();
  const approveFreq = new Map<string, { count: number; sample: string; layer: string }>();

  for (const r of rows) {
    const why = (r.validationReason || r.claim || r.subject || "").trim();
    if (!why) continue;
    const key = normalizeKey(why);
    if (r.verdict === "deny" || r.verdict === "challenge") {
      const prev = denyFreq.get(key);
      if (prev) prev.count++;
      else denyFreq.set(key, { count: 1, sample: why.slice(0, 160), layer: r.layer });
    } else if (r.verdict === "approve" || r.verdict === "validate") {
      const prev = approveFreq.get(key);
      if (prev) prev.count++;
      else approveFreq.set(key, { count: 1, sample: why.slice(0, 160), layer: r.layer });
    }
  }

  const topDeny = [...denyFreq.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, DELIBERATION_SEED_MAX_DENY);
  const topApprove = [...approveFreq.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, DELIBERATION_SEED_MAX_APPROVE);

  if (topDeny.length === 0 && topApprove.length === 0) {
    return {
      text: "",
      denyCount: 0,
      approveCount: 0,
      runsScanned,
      denyPatterns: [],
      approvePatterns: [],
    };
  }

  const lines: string[] = [
    "=== Prior deliberation (approve/deny lessons from recent runs) ===",
    "HARD: do NOT re-post todos that match DENY/challenge patterns below unless you have NEW file-level evidence.",
    "Prefer APPROVED patterns. Re-proposing denied work without new evidence wastes cycles.",
    `Source: ${runsScanned} recent run log(s) under logs/*/deliberation.jsonl.`,
    "",
  ];

  if (topDeny.length > 0) {
    lines.push("Repeated DENY / challenge patterns (blocked without new evidence):");
    for (const d of topDeny) {
      lines.push(`  ✗ [${d.layer}] (${d.count}×) ${d.sample}`);
    }
    lines.push("");
  }
  if (topApprove.length > 0) {
    lines.push("Repeated APPROVE / validate patterns (prefer similar grounded work):");
    for (const a of topApprove) {
      lines.push(`  ✓ [${a.layer}] (${a.count}×) ${a.sample}`);
    }
    lines.push("");
  }
  lines.push("=== end prior deliberation ===");

  return {
    text: lines.join("\n"),
    denyCount: topDeny.reduce((n, d) => n + d.count, 0),
    approveCount: topApprove.reduce((n, a) => n + a.count, 0),
    runsScanned,
    denyPatterns: topDeny.map((d) => ({ sample: d.sample, count: d.count, layer: d.layer })),
    approvePatterns: topApprove.map((a) => ({ sample: a.sample, count: a.count, layer: a.layer })),
  };
}

/**
 * True when a todo description strongly matches a repeated deny pattern
 * (count >= minCount). Used to drop re-proposed dead-end work.
 */
export function todoMatchesDenyPattern(
  description: string,
  patterns: readonly DeliberationDenyPattern[],
  minCount = 2,
): boolean {
  const d = description.toLowerCase();
  if (!d.trim()) return false;
  for (const p of patterns) {
    if (p.count < minCount) continue;
    const sample = p.sample.toLowerCase();
    // Substantial substring overlap
    if (sample.length >= 24) {
      const head = sample.slice(0, Math.min(48, sample.length));
      if (d.includes(head) || sample.includes(d.slice(0, 40))) return true;
    }
    const tokens = sample.split(/\W+/).filter((t) => t.length >= 5);
    if (tokens.length < 2) continue;
    const hits = tokens.filter((t) => d.includes(t));
    const need = Math.min(3, Math.ceil(tokens.length * 0.5));
    if (hits.length >= need) return true;
  }
  return false;
}

/** Drop todos that rehash repeated deny patterns. */
export function filterTodosAgainstDeliberationDenies<
  T extends { description: string },
>(
  todos: readonly T[],
  patterns: readonly DeliberationDenyPattern[],
  minCount = 2,
): { kept: T[]; dropped: T[] } {
  const kept: T[] = [];
  const dropped: T[] = [];
  for (const t of todos) {
    if (todoMatchesDenyPattern(t.description, patterns, minCount)) dropped.push(t);
    else kept.push(t);
  }
  return { kept, dropped };
}

/** Compact lines for stall arbitrator / control prompts. */
export function formatDeliberationForControlPrompt(seed: DeliberationSeed, max = 6): string {
  if (!seed.denyPatterns.length && !seed.approvePatterns.length) return "";
  const lines = ["priorDeliberation:"];
  for (const d of seed.denyPatterns.slice(0, max)) {
    lines.push(`  DENY×${d.count}: ${d.sample.slice(0, 120)}`);
  }
  for (const a of seed.approvePatterns.slice(0, Math.max(2, max - 4))) {
    lines.push(`  APPROVE×${a.count}: ${a.sample.slice(0, 120)}`);
  }
  return lines.join("\n");
}

export async function buildDeliberationSeed(clonePath: string): Promise<DeliberationSeed> {
  const { rows, runsScanned } = await loadRecentDeliberationRows(clonePath);
  return distillDeliberationSeed(rows, runsScanned);
}
