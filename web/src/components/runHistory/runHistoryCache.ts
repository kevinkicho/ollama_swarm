/** localStorage cache for run history list + summaries. */
import type { RunSummary, RunSummaryDigest } from "../../types";

const CACHE_RUNS_LIST_KEY = "ollama-swarm:runs-list";
const CACHE_RUN_SUMMARY_PREFIX = "ollama-swarm:run-summary:";
const CACHE_RUNS_LIST_MAX = 100;
const CACHE_SUMMARY_MAX_BYTES = 1_000_000; // 1MB per summary
export const RUN_SUMMARY_PAGE_SIZE = 10;

function tryReadCache<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch (err) {
    console.error("[RunHistory] tryReadCache-failed:", err);
    return null;
  }
}
function tryWriteCache(key: string, value: unknown): void {
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length > CACHE_SUMMARY_MAX_BYTES) return;
    localStorage.setItem(key, serialized);
  } catch (err) {
    console.error("[RunHistory] tryWriteCache-failed:", err);
  }
}
export function cacheRunsList(runs: RunSummaryDigest[]): void {
  tryWriteCache(CACHE_RUNS_LIST_KEY, runs.slice(0, CACHE_RUNS_LIST_MAX));
}
export function cachedRunsList(): RunSummaryDigest[] | null {
  return tryReadCache<RunSummaryDigest[]>(CACHE_RUNS_LIST_KEY);
}
export function cacheRunSummary(clonePath: string, runId: string | undefined, summary: RunSummary): void {
  const id = runId ?? clonePath;
  tryWriteCache(`${CACHE_RUN_SUMMARY_PREFIX}${id}`, summary);
}
export function cachedRunSummary(clonePath: string, runId: string | undefined): RunSummary | null {
  const id = runId ?? clonePath;
  return tryReadCache<RunSummary>(`${CACHE_RUN_SUMMARY_PREFIX}${id}`);
}
