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
    return Array.isArray(parsed)
      ? parsed.filter((p): p is string => typeof p === "string")
      : [];
  } catch (err) {
    rootLogger.warn("read-persisted-known-parents-failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

export function writePersistedKnownParents(paths: string[]): void {
  try {
    writeFileSync(
      KNOWN_PARENTS_FILE,
      JSON.stringify(paths.slice(0, KNOWN_PARENTS_MAX)),
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
 *  the list get appended. Capped at KNOWN_PARENTS_MAX. */
export function mergeKnownParents(persisted: string[], scanned: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of persisted) {
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  for (const p of scanned) {
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out.slice(0, KNOWN_PARENTS_MAX);
}

export function scanForRunParents(cwd: string): string[] {
  const found = new Set<string>();
  // Scan for logs/ directories containing {runId}/ subdirectories
  // with summary*.json files. Runs are stored in <project>/logs/{runId}/.
  const bases = [cwd, nodePath.dirname(cwd)];
  for (const base of bases) {
    const logsDir = nodePath.join(base, "logs");
    let logEntries: string[];
    try {
      logEntries = readdirSync(logsDir);
    } catch {
      continue; // no logs/ dir — fine
    }
    for (const entry of logEntries) {
      const runDir = nodePath.join(logsDir, entry);
      let stat;
      try {
        stat = statSync(runDir);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      let hasSummary = false;
      try {
        for (const e of readdirSync(runDir)) {
          if (e === "summary.json" || (e.startsWith("summary-") && e.endsWith(".json"))) {
            hasSummary = true;
            break;
          }
        }
      } catch {
        continue;
      }
      if (hasSummary) found.add(runDir);
    }
  }
  return [...found];
}
