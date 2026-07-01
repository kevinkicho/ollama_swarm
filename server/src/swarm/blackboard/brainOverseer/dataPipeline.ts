// Cross-run data pipeline — processes event logs and per-run summaries
// to extract patterns for the brain.

import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

export interface RunSummary {
  runId?: string;
  preset?: string;
  model?: string;
  startedAt?: number;
  endedAt?: number;
  stopReason?: string;
  commits?: number;
  totalTodos?: number;
  skippedTodos?: number;
  filesChanged?: number;
  wallClockMs?: number;
}

export interface EventRecord {
  type: string;
  runId?: string;
  ts?: number;
  [key: string]: unknown;
}

/**
 * Read all run summaries from a logs directory.
 * Scans for summary-*.json files in logs/{runId}/ subdirectories.
 */
export async function readAllRunSummaries(logsDir: string): Promise<RunSummary[]> {
  const summaries: RunSummary[] = [];

  if (!existsSync(logsDir)) return summaries;

  try {
    const entries = await readdir(logsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const runDir = path.join(logsDir, entry.name);
      const summary = await readRunSummary(runDir);
      if (summary) summaries.push(summary);
    }
  } catch {
    // Ignore read errors
  }

  return summaries.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}

/**
 * Read a single run summary from a run directory.
 */
async function readRunSummary(runDir: string): Promise<RunSummary | null> {
  if (!existsSync(runDir)) return null;

  try {
    const files = await readdir(runDir);
    const summaryFile = files.find((f) => /^summary-.*\.json$/.test(f))
      ?? (files.includes("summary.json") ? "summary.json" : null);

    if (!summaryFile) return null;

    const content = await readFile(path.join(runDir, summaryFile), "utf8");
    return JSON.parse(content) as RunSummary;
  } catch {
    return null;
  }
}

/**
 * Read event records from current.jsonl.
 * Returns only records with valid structure.
 */
export async function readEventLog(logPath: string): Promise<EventRecord[]> {
  if (!existsSync(logPath)) return [];

  try {
    const content = await readFile(logPath, "utf8");
    return content
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        try {
          const record = JSON.parse(line);
          return record.event ?? record;
        } catch {
          return null;
        }
      })
      .filter((r): r is EventRecord => r !== null && typeof r === "object");
  } catch {
    return [];
  }
}

/**
 * Analyze run summaries to extract patterns for the brain.
 */
export function analyzeSummaries(summaries: RunSummary[]): {
  totalRuns: number;
  successRate: number;
  avgWallClockMs: number;
  commonStopReasons: Record<string, number>;
  recentTrend: "improving" | "declining" | "stable";
} {
  if (summaries.length === 0) {
    return { totalRuns: 0, successRate: 0, avgWallClockMs: 0, commonStopReasons: {}, recentTrend: "stable" };
  }

  const totalRuns = summaries.length;
  const completed = summaries.filter((s) => s.stopReason === "completed").length;
  const successRate = totalRuns > 0 ? completed / totalRuns : 0;

  const totalWallClock = summaries.reduce((sum, s) => sum + (s.wallClockMs ?? 0), 0);
  const avgWallClockMs = totalRuns > 0 ? totalWallClock / totalRuns : 0;

  const commonStopReasons: Record<string, number> = {};
  for (const s of summaries) {
    const reason = s.stopReason ?? "unknown";
    commonStopReasons[reason] = (commonStopReasons[reason] ?? 0) + 1;
  }

  // Simple trend: compare last 5 runs to previous 5 runs
  const recent = summaries.slice(0, 5);
  const previous = summaries.slice(5, 10);
  const recentSuccess = recent.filter((s) => s.stopReason === "completed").length / Math.max(recent.length, 1);
  const previousSuccess = previous.length > 0
    ? previous.filter((s) => s.stopReason === "completed").length / previous.length
    : recentSuccess;

  let recentTrend: "improving" | "declining" | "stable" = "stable";
  if (recentSuccess > previousSuccess + 0.1) recentTrend = "improving";
  else if (recentSuccess < previousSuccess - 0.1) recentTrend = "declining";

  return { totalRuns, successRate, avgWallClockMs, commonStopReasons, recentTrend };
}
