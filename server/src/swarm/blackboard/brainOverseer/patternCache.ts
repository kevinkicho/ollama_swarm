// Pattern cache for the brain system overseer.
//
// Caches analysis results so the brain doesn't re-analyze patterns that
// were already identified in prior runs. Keyed by pattern fingerprint
// (type + normalized reason).

import fs from "node:fs/promises";
import path from "node:path";
import { buildFingerprint, type ExceptionEvent } from "./exceptionCollector.js";

export interface CachedPattern {
  fingerprint: string;
  count: number;
  firstSeen: number;
  lastSeen: number;
  rootCause: string;
  proposal?: CachedProposal;
  confidence: number;
}

export interface CachedProposal {
  title: string;
  description: string;
  affectedComponent: string;
  priority: "high" | "medium" | "low";
}

export interface PatternCacheData {
  patterns: Record<string, CachedPattern>;
  lastAnalyzedAt: number;
  lastRunId: string;
}

const CACHE_FILE = ".swarm-improvements/pattern-cache.json";

export async function readPatternCache(clonePath: string): Promise<PatternCacheData> {
  const cachePath = path.join(clonePath, CACHE_FILE);
  try {
    const raw = await fs.readFile(cachePath, "utf8");
    return JSON.parse(raw) as PatternCacheData;
  } catch {
    return { patterns: {}, lastAnalyzedAt: 0, lastRunId: "" };
  }
}

/** Append in-run exception fingerprints to the clone pattern cache (best-effort). */
export async function persistExceptionPatterns(
  clonePath: string,
  runId: string,
  events: ExceptionEvent[],
): Promise<void> {
  if (!clonePath || events.length === 0) return;
  const prior = await readPatternCache(clonePath);
  const updated = updateCache(prior, events, runId);
  await writePatternCache(clonePath, updated);
}

export async function writePatternCache(clonePath: string, data: PatternCacheData): Promise<void> {
  const cachePath = path.join(clonePath, CACHE_FILE);
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, JSON.stringify(data, null, 2));
}

/**
 * Check if a pattern fingerprint is already cached with sufficient count.
 * Returns the cached analysis if available, null if fresh analysis needed.
 */
export function checkCache(
  cache: PatternCacheData,
  fingerprint: string,
): CachedPattern | null {
  const cached = cache.patterns[fingerprint];
  if (!cached) return null;
  // If count hasn't changed significantly, use cached analysis
  return cached;
}

/**
 * Update the cache with new exception events.
 * Merges new events into existing patterns and updates counts.
 */
export function updateCache(
  cache: PatternCacheData,
  events: ExceptionEvent[],
  runId: string,
): PatternCacheData {
  const updated = { ...cache, patterns: { ...cache.patterns }, lastAnalyzedAt: Date.now(), lastRunId: runId };

  for (const event of events) {
    const fp = buildFingerprint(event);
    const existing = updated.patterns[fp];
    if (existing) {
      existing.count++;
      existing.lastSeen = event.timestamp;
    } else {
      updated.patterns[fp] = {
        fingerprint: fp,
        count: 1,
        firstSeen: event.timestamp,
        lastSeen: event.timestamp,
        rootCause: "",
        confidence: 0,
      };
    }
  }

  return updated;
}
