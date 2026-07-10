/**
 * Historical token usage lives in per-run summary JSON files under each
 * project clone's logs/ (totalPromptTokens / totalResponseTokens, or
 * per-agent tokensIn/tokensOut). The topbar UsageWidget historically
 * only read the in-process tokenTracker JSONL in os.tmpdir() — which
 * was often empty when providers omitted usage counts.
 *
 * Recent cloud runs often finish with totalPromptTokens=0 and
 * tokensIn=null despite many turns — because usage was never captured.
 * For those we estimate from transcript size + calibrated per-attempt
 * floor so "last 1 day" reflects real work volume, not 150 tokens.
 */

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import type { UsageRecord } from "./ollamaProxy.js";

const MAX_WALK_DEPTH = 5;
const MAX_SUMMARY_FILES = 2_000;

/**
 * Empirically ~22k total tokens per successful attempt on tool-using
 * blackboard/cloud runs that DID record usage (workspace sample, 2026-07).
 * Used as a floor when summaries have turns but zero token fields.
 */
export const ESTIMATED_TOKENS_PER_ATTEMPT = 22_000;

export interface SummaryTokenRow {
  runId: string;
  endedAt: number;
  startedAt: number;
  promptTokens: number;
  responseTokens: number;
  preset?: string;
  model?: string;
  sourcePath: string;
  /** True when totals were estimated (summary lacked token fields). */
  estimated?: boolean;
}

function isSummaryFile(name: string): boolean {
  return name === "summary.json" || /^summary-.+\.json$/i.test(name);
}

function walkSummaryFiles(root: string, out: string[], depth: number): void {
  if (depth > MAX_WALK_DEPTH || out.length >= MAX_SUMMARY_FILES) return;
  let ents;
  try {
    ents = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    if (out.length >= MAX_SUMMARY_FILES) return;
    if (e.name === "node_modules" || e.name === ".git" || e.name === "dist") continue;
    const p = join(root, e.name);
    if (e.isDirectory()) {
      walkSummaryFiles(p, out, depth + 1);
    } else if (e.isFile() && isSummaryFile(e.name)) {
      out.push(p);
    }
  }
}

function sumRecordedTokens(s: Record<string, unknown>): { prompt: number; response: number } {
  let prompt = Number(s.totalPromptTokens) || 0;
  let response = Number(s.totalResponseTokens) || 0;
  if (prompt + response <= 0 && Array.isArray(s.agents)) {
    for (const a of s.agents as Array<Record<string, unknown>>) {
      const tin = a.tokensIn;
      const tout = a.tokensOut;
      if (typeof tin === "number" && tin > 0) prompt += tin;
      if (typeof tout === "number" && tout > 0) response += tout;
    }
  }
  return { prompt, response };
}

function countAttempts(s: Record<string, unknown>): number {
  if (!Array.isArray(s.agents)) return 0;
  let n = 0;
  for (const a of s.agents as Array<Record<string, unknown>>) {
    const att = Number(a.totalAttempts) || 0;
    const ok = Number(a.successfulAttempts) || 0;
    const turns = Number(a.turnsTaken) || 0;
    n += att > 0 ? att : ok > 0 ? ok : turns;
  }
  return n;
}

/** Estimate tokens when summary fields are zero but the run clearly worked. */
export function estimateTokensFromSummaryBody(s: Record<string, unknown>): {
  prompt: number;
  response: number;
} | null {
  const attempts = countAttempts(s);
  let textChars = 0;
  let thinkChars = 0;
  if (Array.isArray(s.transcript)) {
    for (const e of s.transcript as Array<Record<string, unknown>>) {
      if (e.role !== "agent") continue;
      textChars += String(e.text ?? "").length;
      thinkChars += String(e.thoughts ?? "").length;
    }
  }
  // Transcript only captures a fraction of cloud tool-loop prompt volume;
  // use it as a lower bound, then raise to attempts * calibrated floor.
  let response = Math.ceil(textChars / 4);
  let prompt = Math.ceil(thinkChars / 4) + Math.ceil(textChars / 2);
  if (attempts > 0) {
    const floor = attempts * ESTIMATED_TOKENS_PER_ATTEMPT;
    if (prompt + response < floor) {
      prompt = Math.floor(floor * 0.72);
      response = Math.floor(floor * 0.28);
    }
  }
  // Wall-clock backstop: long runs with few stats still spent heavily.
  const wall = Number(s.wallClockMs) || Math.max(0, Number(s.endedAt) - Number(s.startedAt));
  if (wall > 60_000) {
    // ~8 tok/s total (prompt+completion) as a soft lower bound for busy cloud runs
    const wallFloor = Math.floor((wall / 1000) * 8);
    if (prompt + response < wallFloor) {
      prompt = Math.floor(wallFloor * 0.72);
      response = Math.floor(wallFloor * 0.28);
    }
  }
  if (prompt + response <= 0) return null;
  return { prompt, response };
}

function tokensFromSummary(raw: unknown, sourcePath: string): SummaryTokenRow | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  const runId = typeof s.runId === "string" && s.runId.length > 0
    ? s.runId
    : basename(sourcePath).replace(/^summary-/, "").replace(/\.json$/i, "").slice(0, 36);
  const startedAt = typeof s.startedAt === "number" ? s.startedAt : 0;
  const endedAt = typeof s.endedAt === "number" ? s.endedAt : startedAt;
  if (!endedAt && !startedAt) return null;

  const recorded = sumRecordedTokens(s);
  let prompt = recorded.prompt;
  let response = recorded.response;
  let estimated = false;

  if (prompt + response <= 0) {
    const est = estimateTokensFromSummaryBody(s);
    if (!est) return null;
    prompt = est.prompt;
    response = est.response;
    estimated = true;
  }

  return {
    runId,
    startedAt: startedAt || endedAt,
    endedAt: endedAt || startedAt,
    promptTokens: prompt,
    responseTokens: response,
    preset: typeof s.preset === "string" ? s.preset : undefined,
    model: typeof s.model === "string" ? s.model : undefined,
    sourcePath,
    estimated,
  };
}

/** Collect token rows from summary JSON under the given project roots. */
export function collectSummaryTokenRows(parentPaths: readonly string[]): SummaryTokenRow[] {
  const files: string[] = [];
  const seenRoots = new Set<string>();
  for (const root of parentPaths) {
    if (!root || seenRoots.has(root)) continue;
    seenRoots.add(root);
    if (!existsSync(root)) continue;
    const candidates = [root, join(root, "logs")];
    for (const c of candidates) {
      if (existsSync(c)) walkSummaryFiles(c, files, 0);
    }
  }

  const byRun = new Map<string, SummaryTokenRow>();
  for (const f of files) {
    try {
      const st = statSync(f);
      if (!st.isFile() || st.size < 20 || st.size > 50 * 1024 * 1024) continue;
      const raw = JSON.parse(readFileSync(f, "utf8"));
      const row = tokensFromSummary(raw, f);
      if (!row) continue;
      const prev = byRun.get(row.runId);
      // Prefer real (non-estimated) totals, else larger total.
      if (!prev) {
        byRun.set(row.runId, row);
      } else if (prev.estimated && !row.estimated) {
        byRun.set(row.runId, row);
      } else if (prev.estimated === row.estimated
        && prev.promptTokens + prev.responseTokens < row.promptTokens + row.responseTokens) {
        byRun.set(row.runId, row);
      }
    } catch {
      /* skip unreadable */
    }
  }
  return [...byRun.values()];
}

/** Convert summary rows into tokenTracker UsageRecord shape (one per run). */
export function summaryRowsToUsageRecords(rows: readonly SummaryTokenRow[]): UsageRecord[] {
  return rows.map((row) => ({
    ts: row.endedAt || row.startedAt || Date.now(),
    promptTokens: row.promptTokens,
    responseTokens: row.responseTokens,
    durationMs: Math.max(0, (row.endedAt || 0) - (row.startedAt || 0)),
    model: row.model,
    preset: row.preset,
    path: row.estimated
      ? `summary-est:${row.runId.slice(0, 8)}`
      : `summary-backfill:${row.runId.slice(0, 8)}`,
    runId: row.runId,
  }));
}
