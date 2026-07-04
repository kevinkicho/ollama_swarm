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

export async function scanForRunDigests(
  parentsToScan: Set<string>,
  opts: ScanOptions = {},
): Promise<{ runs: RunSummaryDigest[]; parentsScanned: string[] }> {
  const { activeClone = null, activeRunId = null } = opts;
  const collected: RunSummaryDigest[] = [];
  const parentsScanned: string[] = [];

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

// (moved from routes/swarm.ts)
async function readAllRunDigests(
  cloneDir: string,
  name: string,
): Promise<RunSummaryDigest[]> {
  const digests: RunSummaryDigest[] = [];
  const seen = new Set<string>();
  const dedupKey = (d: RunSummaryDigest) => d.runId ?? `t:${d.startedAt}`;

  let perRun: string[] = [];
  try {
    const all = await fs.readdir(cloneDir);
    perRun = all.filter((e) => /^summary-.+\.json$/.test(e));
  } catch (err) {
    console.warn('[swarm] readdir-cloneDir-digests-failed:', err instanceof Error ? err.message : String(err));
    return [];
  }
  for (const e of perRun) {
    let raw: string;
    try {
      raw = await fs.readFile(path.join(cloneDir, e), "utf8");
    } catch (err) {
      console.warn('[swarm] read-perRun-summary-failed:', err instanceof Error ? err.message : String(err));
      continue;
    }
    const d = parseSummaryToDigest(raw, cloneDir, name);
    if (!d) continue;
    const k = dedupKey(d);
    if (seen.has(k)) continue;
    seen.add(k);
    digests.push(d);
  }

  // fallback bare summary.json
  if (digests.length === 0) {
    try {
      const raw = await fs.readFile(path.join(cloneDir, "summary.json"), "utf8");
      const d = parseSummaryToDigest(raw, cloneDir, name);
      if (d) {
        const k = dedupKey(d);
        if (!seen.has(k)) {
          seen.add(k);
          digests.push(d);
        }
      }
    } catch {
      // no summary.json — fine
    }
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
