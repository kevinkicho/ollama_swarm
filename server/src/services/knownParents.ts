/**
 * Persisted parent-path LRU + disk scan for prior run locations.
 * Extracted from Orchestrator.ts (god-file modularization).
 */

import {
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { createLogger } from "./logger.js";

const rootLogger = createLogger();

// Persisted lastParentPath store. /tmp survives dev-server restarts
// but resets on reboot — fine for this use, since the user runs at
// least once after reboot and the path gets re-set automatically.
const LAST_PARENT_FILE = nodePath.join(tmpdir(), "ollama-swarm-last-parent.txt");

export function readPersistedLastParent(): string | undefined {
  try {
    const v = readFileSync(LAST_PARENT_FILE, "utf8").trim();
    return v.length > 0 ? v : undefined;
  } catch (err) {
    rootLogger.warn("read-persisted-last-parent-failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

export function writePersistedLastParent(p: string): void {
  try {
    writeFileSync(LAST_PARENT_FILE, p, "utf8");
  } catch (err) {
    rootLogger.warn("write-persisted-last-parent-failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// #238 + #240 (2026-04-28): persisted set of ALL parent paths the
// user has ever started a run from. Bounded to KNOWN_PARENTS_MAX
// entries (LRU on add) so the file doesn't grow unbounded.
const KNOWN_PARENTS_FILE = nodePath.join(tmpdir(), "ollama-swarm-known-parents.json");
export const KNOWN_PARENTS_MAX = 32;

export function readPersistedKnownParents(): string[] {
  try {
    const raw = readFileSync(KNOWN_PARENTS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed)
      ? parsed.filter((p): p is string => typeof p === "string")
      : [];
    return filterKnownParentPaths(list).slice(0, KNOWN_PARENTS_MAX);
  } catch (err) {
    rootLogger.warn("read-persisted-known-parents-failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

export function writePersistedKnownParents(paths: string[]): void {
  try {
    const cleaned = filterKnownParentPaths(paths).slice(0, KNOWN_PARENTS_MAX);
    writeFileSync(
      KNOWN_PARENTS_FILE,
      JSON.stringify(cleaned),
      "utf8",
    );
  } catch (err) {
    rootLogger.warn("write-persisted-known-parents-failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** #293: merge persisted (recent, ordered) + scanned (discovered)
 *  parent paths into a single LRU list. Persisted entries keep their
 *  order (most-recent first); scanned entries that aren't already in
 *  the list get appended. Capped at KNOWN_PARENTS_MAX.
 *  Junk recover-me / per-run log dirs are stripped. */
export function mergeKnownParents(persisted: string[], scanned: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of filterKnownParentPaths(persisted)) {
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  for (const p of filterKnownParentPaths(scanned)) {
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out.slice(0, KNOWN_PARENTS_MAX);
}

/**
 * True for paths that are app/crash artifacts, not user workspace parents.
 * Live loophole (2026-07-17): scanForRunParents + recover-me dirs filled the
 * KNOWN_PARENTS_MAX=32 LRU with server/logs/*runId* paths, crowding out real
 * project roots so cross-workspace history looked incomplete.
 */
export function isJunkKnownParentPath(p: string): boolean {
  const n = p.replace(/\\/g, "/").toLowerCase();
  if (!n) return true;
  if (n.includes("/server/logs/")) return true;
  if (/\/logs\/recover-me-/i.test(n)) return true;
  if (/\/logs\/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(n)) return true;
  // Short run-id dirs under any .../logs/<8hex>
  if (/\/logs\/[0-9a-f]{8}$/i.test(n)) return true;
  // OS temp trees (and the bare temp root) are never real workspace parents.
  if (n.includes("/temp/") || n.includes("/tmp/")) return true;
  if (n.endsWith("/temp") || n.endsWith("/tmp")) return true;
  if (n.includes("crash-sum-")) return true;
  return false;
}

/** Drop junk paths; keep order. */
export function filterKnownParentPaths(paths: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of paths) {
    if (typeof p !== "string" || !p.trim()) continue;
    if (isJunkKnownParentPath(p)) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

/**
 * Discover **project / workspace roots** that hold run summaries.
 * Returns clone roots and their parents — NOT per-run log dirs.
 *
 * Previously returned `.../logs/<runId>` which polluted knownParents with
 * recover-me and UUID folders (capped at 32 → real workspaces fell off).
 */
export function scanForRunParents(cwd: string): string[] {
  const found = new Set<string>();
  // App cwd + parent-of-cwd often host sibling project clones.
  const bases = [cwd, nodePath.dirname(cwd)];
  for (const base of bases) {
    // If this base itself has logs/ with summaries, remember the base.
    const logsDir = nodePath.join(base, "logs");
    let logEntries: string[];
    try {
      logEntries = readdirSync(logsDir);
    } catch {
      continue;
    }
    let baseHasSummary = false;
    for (const entry of logEntries) {
      if (entry === "summary.json" || (entry.startsWith("summary-") && entry.endsWith(".json"))) {
        baseHasSummary = true;
        break;
      }
      const runDir = nodePath.join(logsDir, entry);
      let stat;
      try {
        stat = statSync(runDir);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      try {
        for (const e of readdirSync(runDir)) {
          if (e === "summary.json" || (e.startsWith("summary-") && e.endsWith(".json"))) {
            baseHasSummary = true;
            // Project root (parent of logs/), not the run dir.
            found.add(base);
            // Also remember parent-of-project so sibling clones are discoverable.
            found.add(nodePath.dirname(base));
            break;
          }
        }
      } catch {
        continue;
      }
      if (baseHasSummary) break;
    }
    if (baseHasSummary) {
      found.add(base);
      found.add(nodePath.dirname(base));
    }

    // Sibling project dirs under base (e.g. workspace/*)
    let siblings: string[];
    try {
      siblings = readdirSync(base);
    } catch {
      continue;
    }
    for (const name of siblings) {
      const sibling = nodePath.join(base, name);
      let st;
      try {
        st = statSync(sibling);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      if (isJunkKnownParentPath(sibling)) continue;
      const sibLogs = nodePath.join(sibling, "logs");
      try {
        const ents = readdirSync(sibLogs);
        const has =
          ents.some(
            (e) =>
              e === "summary.json"
              || (e.startsWith("summary-") && e.endsWith(".json"))
              || e.length >= 8,
          );
        if (has) {
          found.add(sibling);
          found.add(base);
        }
      } catch {
        /* no logs */
      }
    }
  }
  return filterKnownParentPaths([...found]);
}
