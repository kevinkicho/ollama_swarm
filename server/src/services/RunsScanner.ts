import fs from "node:fs/promises";
import path from "node:path";
import { normalizeWslPath } from "./pathNormalize.js";

// Minimal local copy of the digest shape (was previously local to the route).
// Kept in sync with the one used by the history dropdown / summary readers.
export interface RunSummaryDigest {
  name: string;
  clonePath: string;
  preset: string;
  model: string;
  startedAt: number;
  endedAt: number;
  wallClockMs: number;
  stopReason?: string;
  commits?: number;
  totalTodos?: number;
  hasContract: boolean;
  isActive: boolean;
  runId?: string;
  topology?: any;
}

// Extracted from routes/swarm.ts for better separation and testability.
// The parent-scanning + digest collection logic used by GET /api/swarm/runs.

export interface ScanOptions {
  includeActive?: boolean;
  activeClone?: string | null;
  activeRunId?: string | null;
}

/** In-memory cache TTL for GET /api/swarm/runs scans (ms). */
export const RUNS_LIST_CACHE_TTL_MS = 30_000;

let runsListCache: {
  key: string;
  at: number;
  runs: RunSummaryDigest[];
  parentsScanned: string[];
} | null = null;

/** Clears the in-memory runs list cache (tests). */
export function clearRunsListCache(): void {
  runsListCache = null;
}

export async function scanForRunDigests(
  parentsToScan: Set<string>,
  opts: ScanOptions = {},
): Promise<{ runs: RunSummaryDigest[]; parentsScanned: string[] }> {
  const key = `${[...parentsToScan].sort().join("\n")}|${opts.activeClone ?? ""}|${opts.activeRunId ?? ""}`;
  const now = Date.now();
  if (runsListCache && runsListCache.key === key && now - runsListCache.at < RUNS_LIST_CACHE_TTL_MS) {
    return { runs: runsListCache.runs, parentsScanned: runsListCache.parentsScanned };
  }

  const result = await scanForRunDigestsUncached(parentsToScan, opts);
  runsListCache = { key, at: now, runs: result.runs, parentsScanned: result.parentsScanned };
  return result;
}

/**
 * App-level mirrors: writeRunSummary also writes under cwd/logs/<runId>/ and
 * cwd/server/logs/<runId>/. These were never scanned by parent-based discovery,
 * so a run whose clone parent fell out of the knownParents LRU vanished from UI
 * even though the summary still existed (live: completed council df1eab0b).
 */
export async function scanAppRunRegistry(
  cwd: string = process.cwd(),
): Promise<RunSummaryDigest[]> {
  const out: RunSummaryDigest[] = [];
  const seen = new Set<string>();
  for (const rel of ["logs", path.join("server", "logs")]) {
    const root = path.join(cwd, rel);
    let entries: string[];
    try {
      entries = await fs.readdir(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      // Skip crash-recovery placeholders with no useful identity
      if (entry.startsWith("recover-me-")) continue;
      const runDir = path.join(root, entry);
      try {
        if (!(await fs.stat(runDir)).isDirectory()) continue;
      } catch {
        continue;
      }
      await readSummariesInDir(runDir, entry, seen, out);
    }
  }
  return out;
}

async function scanForRunDigestsUncached(
  parentsToScan: Set<string>,
  opts: ScanOptions = {},
): Promise<{ runs: RunSummaryDigest[]; parentsScanned: string[] }> {
  const { activeClone = null, activeRunId = null } = opts;
  const collected: RunSummaryDigest[] = [];
  const parentsScanned: string[] = [];

  // Always merge app registry (independent of parentPath / knownParents).
  try {
    const appRuns = await scanAppRunRegistry(process.cwd());
    for (const d of appRuns) {
      d.isActive =
        activeClone !== null
        && !!d.clonePath
        && path.resolve(d.clonePath) === path.resolve(activeClone)
        && d.runId !== undefined
        && d.runId === activeRunId;
      collected.push(d);
    }
    parentsScanned.push(path.join(process.cwd(), "logs"));
    parentsScanned.push(path.join(process.cwd(), "server", "logs"));
  } catch (err) {
    console.warn(
      "[swarm] scan-app-run-registry-failed:",
      err instanceof Error ? err.message : String(err),
    );
  }

  for (const parent of parentsToScan) {
    let entries: string[];
    try {
      entries = await fs.readdir(parent);
    } catch (err) {
      console.warn('[swarm] readdir-parent-failed:', err instanceof Error ? err.message : String(err));
      continue;
    }
    parentsScanned.push(parent);

    for (const name of entries) {
      const cloneDir = path.join(parent, name);
      let stat: import("node:fs").Stats;
      try {
        stat = await fs.stat(cloneDir);
      } catch (err) {
        console.warn('[swarm] stat-cloneDir-failed:', err instanceof Error ? err.message : String(err));
        continue;
      }
      if (!stat.isDirectory()) continue;

      // Heuristic to avoid probing every sibling folder when parent resolves to a broad workspace
      let looksPromising = false;
      try {
        const childEntries = await fs.readdir(cloneDir);
        looksPromising = childEntries.some(
          (e) => /^summary.*\.json$/.test(e) || e === "logs" || e === "run-state.json"
        );
      } catch {
        continue;
      }
      if (!looksPromising) continue;

      const digests = await readAllRunDigests(cloneDir, name);
      for (const d of digests) {
        d.isActive = activeClone !== null && cloneDir === activeClone && d.runId !== undefined && d.runId === activeRunId;
        (d as RunSummaryDigest & { parentPath?: string }).parentPath = parent;
        collected.push(d);
      }
    }

    // Also treat the parent itself for direct logs/<run>/ summaries
    const parentLooksPromising = entries.some(
      (e) => /^summary.*\.json$/.test(e) || e === "logs" || e === "run-state.json"
    );
    if (parentLooksPromising) {
      const directDigests = await readAllRunDigests(parent, path.basename(parent));
      for (const d of directDigests) {
        d.isActive = activeClone !== null && parent === activeClone && d.runId !== undefined && d.runId === activeRunId;
        (d as RunSummaryDigest & { parentPath?: string }).parentPath = parent;
        collected.push(d);
      }
    }
  }

  // dedupe
  const byKey = new Map<string, RunSummaryDigest>();
  for (const d of collected) {
    const k = d.runId || `t:${d.startedAt}`;
    if (!byKey.has(k)) byKey.set(k, d);
  }
  const runs = Array.from(byKey.values());
  runs.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));

  return { runs, parentsScanned };
}

function dedupKey(d: RunSummaryDigest): string {
  return d.runId ?? `t:${d.startedAt}`;
}

/** Read summary-*.json + summary.json from a single directory. */
async function readSummariesInDir(
  readDir: string,
  name: string,
  seen: Set<string>,
  out: RunSummaryDigest[],
): Promise<void> {
  let perRun: string[] = [];
  try {
    const all = await fs.readdir(readDir);
    perRun = all.filter((e) => /^summary-.+\.json$/.test(e));
  } catch (err) {
    console.warn('[swarm] readdir-cloneDir-digests-failed:', err instanceof Error ? err.message : String(err));
    return;
  }
  for (const e of perRun) {
    let raw: string;
    try {
      raw = await fs.readFile(path.join(readDir, e), "utf8");
    } catch (err) {
      console.warn('[swarm] read-perRun-summary-failed:', err instanceof Error ? err.message : String(err));
      continue;
    }
    const d = parseSummaryToDigest(raw, readDir, name);
    if (!d) continue;
    const k = dedupKey(d);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(d);
  }

  try {
    const raw = await fs.readFile(path.join(readDir, "summary.json"), "utf8");
    const d = parseSummaryToDigest(raw, readDir, name);
    if (d) {
      const k = dedupKey(d);
      if (!seen.has(k)) {
        seen.add(k);
        out.push(d);
      }
    }
  } catch {
    // no summary.json — fine
  }
}

// (moved from routes/swarm.ts)
async function readAllRunDigests(
  cloneDir: string,
  name: string,
): Promise<RunSummaryDigest[]> {
  const digests: RunSummaryDigest[] = [];
  const seen = new Set<string>();

  await readSummariesInDir(cloneDir, name, seen, digests);

  // Blackboard writes per-run artifacts under logs/<runId>/ — scan those
  // when summaries are not at the clone root (common for direct-workspace runs).
  const logsDir = path.join(cloneDir, "logs");
  try {
    const logEntries = await fs.readdir(logsDir);
    for (const entry of logEntries) {
      const subPath = path.join(logsDir, entry);
      try {
        if (!(await fs.stat(subPath)).isDirectory()) continue;
      } catch {
        continue;
      }
      await readSummariesInDir(subPath, entry, seen, digests);
    }
  } catch {
    // no logs/ — fine
  }

  return digests;
}

// (moved helper)
function parseSummaryToDigest(
  raw: string,
  readDir: string,
  name: string,
): RunSummaryDigest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn('[swarm] parse-summary-digest-failed:', err instanceof Error ? err.message : String(err));
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.preset !== "string" || typeof obj.startedAt !== "number") return null;
  const contract = obj.contract as Record<string, unknown> | undefined;
  const topology =
    obj.topology &&
    typeof obj.topology === "object" &&
    Array.isArray((obj.topology as { agents?: unknown }).agents)
      ? (obj.topology as RunSummaryDigest["topology"])
      : undefined;
  // Use the authoritative localPath (project clone root) recorded in the summary
  // rather than the directory we happened to read the file from (could be a
  // logs/<runId> subdir). This ensures match.clonePath passed to /run-summary
  // and guard checks is the real clone dir (so per-run /runs/:id views hydrate).
  const effectiveClone = (obj as any).localPath || (obj as any).clonePath || readDir;
  return {
    name,
    clonePath: effectiveClone,
    preset: obj.preset,
    model: (obj as any).model || "",
    startedAt: obj.startedAt,
    endedAt: (obj as any).endedAt || 0,
    wallClockMs: (obj as any).wallClockMs || 0,
    stopReason: (obj as any).stopReason,
    commits: (obj as any).commits,
    totalTodos: (obj as any).totalTodos,
    hasContract: !!contract,
    isActive: false,
    runId: (obj as any).runId,
    topology,
  };
}
