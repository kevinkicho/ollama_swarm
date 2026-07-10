/**
 * Log + runs retention used by HTTP API, Brain MAINTENANCE actions, and CLI.
 * Mirrors scripts/prune-logs.mjs and scripts/prune-runs.mjs policy.
 *
 * Also prunes/purges **project** run logs under `<clonePath>/logs/` where
 * ollama_swarm writes summary-*.json and per-run dirs for target repos.
 */

import { readdirSync, statSync, rmSync, existsSync } from "node:fs";
import path from "node:path";

/** App cwd logs/runs, or project-logs under a clonePath. */
export type PruneTarget = "logs" | "runs" | "all" | "project-logs";

export type PruneMode = "prune" | "purge";

export interface PruneOptions {
  /** Repo / clone root (defaults to process.cwd()). */
  root?: string;
  apply?: boolean;
  keepDays?: number;
  /** logs: max per-run log dirs; runs: max kept beyond keep-days window */
  maxKeep?: number;
  keepNArchives?: number;
  target?: PruneTarget;
  /**
   * prune = retention policy (defaults).
   * purge = aggressive: keepDays=0, maxKeep=0 (delete all except protectNames).
   */
  mode?: PruneMode;
  /** Run-dir names (full or short UUID) that must never be deleted. */
  protectNames?: string[];
}

export interface PruneItem {
  kind: string;
  path: string;
  name: string;
  bytes: number;
  force?: boolean;
}

export interface PruneResult {
  apply: boolean;
  target: PruneTarget;
  mode: PruneMode;
  root: string;
  deletedCount: number;
  freedBytes: number;
  items: PruneItem[];
  summary: string;
  logsRunDirCount?: number;
  logsRunDirsRemaining?: number;
  summaryFileCount?: number;
  protectedSkipped?: number;
}

export interface ProjectLogsStatus {
  root: string;
  logsDir: string;
  logsRunDirCount: number;
  summaryFileCount: number;
  logsNeedsPrune: boolean;
  logsRunDirWarnThreshold: number;
  totalBytesApprox: number;
}

export interface MaintenanceStatus {
  root: string;
  logsDir: string;
  logsRunDirCount: number;
  logsRunDirWarnThreshold: number;
  logsNeedsPrune: boolean;
  runsRoots: Array<{ name: string; entryCount: number }>;
  runsEntryCount: number;
  /** Present when status was requested with a clonePath / project root. */
  project?: ProjectLogsStatus;
}

const DEFAULT_LOG_KEEP_DAYS = 14;
const DEFAULT_LOG_MAX_RUN_DIRS = 50;
const DEFAULT_LOG_KEEP_N_ARCHIVES = 20;
const DEFAULT_RUNS_KEEP_DAYS = 7;
const DEFAULT_RUNS_KEEP_N = 50;
const LOG_WARN_THRESHOLD = 50;
/** Project clones accumulate summary files faster; slightly lower warn threshold. */
const PROJECT_LOG_WARN_THRESHOLD = 30;

function bytesHuman(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

function dirSize(dir: string): number {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let names: string[];
    try {
      names = readdirSync(cur);
    } catch {
      continue;
    }
    for (const name of names) {
      const full = path.join(cur, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) stack.push(full);
      else total += st.size;
    }
  }
  return total;
}

function listFiles(
  dir: string,
  pattern: RegExp,
): Array<{ path: string; mtime: number; size: number; name: string }> {
  const out: Array<{ path: string; mtime: number; size: number; name: string }> = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!pattern.test(name)) continue;
    const full = path.join(dir, name);
    try {
      const st = statSync(full);
      if (st.isFile()) out.push({ path: full, mtime: st.mtimeMs, size: st.size, name });
    } catch {
      /* skip */
    }
  }
  return out;
}

function listLogRunDirs(logDir: string): Array<{ path: string; mtime: number; name: string }> {
  const out: Array<{ path: string; mtime: number; name: string }> = [];
  let names: string[];
  try {
    names = readdirSync(logDir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (name === "current.jsonl" || name.startsWith("events-")) continue;
    const full = path.join(logDir, name);
    try {
      const st = statSync(full);
      if (st.isDirectory()) out.push({ path: full, mtime: st.mtimeMs, name });
    } catch {
      /* skip */
    }
  }
  return out;
}

function isProtectedName(name: string, protect: Set<string>): boolean {
  if (protect.size === 0) return false;
  if (protect.has(name)) return true;
  // Match short UUID prefixes (summary files use short run ids).
  for (const p of protect) {
    if (!p) continue;
    if (name === p || name.startsWith(p) || p.startsWith(name) || name.includes(p)) {
      return true;
    }
  }
  return false;
}

function selectRunDirsToCap(
  runDirs: Array<{ path: string; mtime: number; name: string }>,
  max: number,
  cutoffMs: number,
  protect: Set<string>,
): Array<{ run: { path: string; mtime: number; name: string }; force: boolean }> {
  const eligible = runDirs.filter((r) => !isProtectedName(r.name, protect));
  if (eligible.length <= max) return [];
  const sorted = [...eligible].sort((a, b) => a.mtime - b.mtime);
  const toDelete: Array<{ run: { path: string; mtime: number; name: string }; force: boolean }> =
    [];
  // remaining counts only eligible (unprotected) dirs
  let remaining = eligible.length;

  for (const run of sorted) {
    if (remaining <= max) break;
    if (run.mtime >= cutoffMs) continue;
    toDelete.push({ run, force: false });
    remaining -= 1;
  }

  if (remaining > max) {
    for (const run of sorted) {
      if (remaining <= max) break;
      if (toDelete.some((d) => d.run.path === run.path)) continue;
      toDelete.push({ run, force: true });
      remaining -= 1;
    }
  }

  return toDelete;
}

function isRunRoot(name: string): boolean {
  return name === "runs" || name.startsWith("runs_") || name.startsWith("runs-");
}

function listRunEntries(root: string): Array<{ path: string; mtime: number; name: string }> {
  const out: Array<{ path: string; mtime: number; name: string }> = [];
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return out;
  }
  for (const name of names) {
    const full = path.join(root, name);
    try {
      const st = statSync(full);
      if (st.isDirectory()) out.push({ path: full, mtime: st.mtimeMs, name });
    } catch {
      /* skip */
    }
  }
  return out;
}

function applyRunsPolicy(
  entries: Array<{ path: string; mtime: number; name: string }>,
  keepDays: number,
  keepN: number,
): Array<{ path: string; mtime: number; name: string }> {
  const cutoffMs = Date.now() - keepDays * 24 * 60 * 60 * 1000;
  entries = [...entries].sort((a, b) => b.mtime - a.mtime);
  const keep = new Set<string>();
  for (const e of entries) {
    if (e.mtime >= cutoffMs) keep.add(e.path);
  }
  const remaining = entries.filter((e) => !keep.has(e.path));
  for (const e of remaining.slice(0, Math.max(0, keepN - keep.size))) {
    keep.add(e.path);
  }
  return entries.filter((e) => !keep.has(e.path));
}

function tryRm(targetPath: string, recursive: boolean): boolean {
  try {
    rmSync(targetPath, { recursive, force: true });
    return true;
  } catch {
    return false;
  }
}

function resolveModeDefaults(opts: PruneOptions): {
  mode: PruneMode;
  keepDays: number;
  maxKeep: number;
  keepNArchives: number;
} {
  const mode: PruneMode = opts.mode === "purge" ? "purge" : "prune";
  if (mode === "purge") {
    return {
      mode,
      keepDays: opts.keepDays ?? 0,
      maxKeep: opts.maxKeep ?? 0,
      keepNArchives: opts.keepNArchives ?? 0,
    };
  }
  return {
    mode,
    keepDays: opts.keepDays ?? DEFAULT_LOG_KEEP_DAYS,
    maxKeep: opts.maxKeep ?? DEFAULT_LOG_MAX_RUN_DIRS,
    keepNArchives: opts.keepNArchives ?? DEFAULT_LOG_KEEP_N_ARCHIVES,
  };
}

export function getProjectLogsStatus(projectRoot: string): ProjectLogsStatus {
  const root = path.resolve(projectRoot);
  const logsDir = path.join(root, "logs");
  const runDirs = existsSync(logsDir) ? listLogRunDirs(logsDir) : [];
  const summaryFiles = existsSync(logsDir)
    ? listFiles(logsDir, /^summary-.+\.json$/)
    : [];
  let totalBytesApprox = 0;
  for (const d of runDirs.slice(0, 200)) {
    totalBytesApprox += dirSize(d.path);
  }
  for (const f of summaryFiles) totalBytesApprox += f.size;
  return {
    root,
    logsDir,
    logsRunDirCount: runDirs.length,
    summaryFileCount: summaryFiles.length,
    logsNeedsPrune:
      runDirs.length > PROJECT_LOG_WARN_THRESHOLD
      || summaryFiles.length > PROJECT_LOG_WARN_THRESHOLD,
    logsRunDirWarnThreshold: PROJECT_LOG_WARN_THRESHOLD,
    totalBytesApprox,
  };
}

export function getMaintenanceStatus(
  root = process.cwd(),
  projectRoot?: string,
): MaintenanceStatus {
  const logsDir = path.join(root, "logs");
  const runDirs = existsSync(logsDir) ? listLogRunDirs(logsDir) : [];
  const runsRoots: Array<{ name: string; entryCount: number }> = [];
  let runsEntryCount = 0;
  try {
    for (const name of readdirSync(root)) {
      if (!isRunRoot(name)) continue;
      const entries = listRunEntries(path.join(root, name));
      runsRoots.push({ name, entryCount: entries.length });
      runsEntryCount += entries.length;
    }
  } catch {
    /* ignore */
  }
  const status: MaintenanceStatus = {
    root,
    logsDir,
    logsRunDirCount: runDirs.length,
    logsRunDirWarnThreshold: LOG_WARN_THRESHOLD,
    logsNeedsPrune: runDirs.length > LOG_WARN_THRESHOLD,
    runsRoots,
    runsEntryCount,
  };
  if (projectRoot) {
    status.project = getProjectLogsStatus(projectRoot);
  }
  return status;
}

export function pruneLogs(opts: PruneOptions = {}): PruneResult {
  const root = path.resolve(opts.root ?? process.cwd());
  const logDir = path.join(root, "logs");
  const apply = opts.apply === true;
  const { mode, keepDays, maxKeep: maxRunDirs, keepNArchives } = resolveModeDefaults(opts);
  const protect = new Set((opts.protectNames ?? []).map(String).filter(Boolean));
  const cutoffMs = Date.now() - keepDays * 24 * 60 * 60 * 1000;
  const resultTarget: PruneTarget = opts.target === "project-logs" ? "project-logs" : "logs";

  const items: PruneItem[] = [];
  let freedBytes = 0;
  let deletedCount = 0;
  let protectedSkipped = 0;

  if (!existsSync(logDir)) {
    return {
      apply,
      target: resultTarget,
      mode,
      root,
      deletedCount: 0,
      freedBytes: 0,
      items: [],
      summary: `No logs/ directory under ${root}`,
      logsRunDirCount: 0,
      logsRunDirsRemaining: 0,
      summaryFileCount: 0,
      protectedSkipped: 0,
    };
  }

  // 1. Global rotated event archives (app) + per-run summary-*.json (project)
  const eventArchives = listFiles(logDir, /^events-.*\.jsonl$/).sort((a, b) => b.mtime - a.mtime);
  for (let i = 0; i < eventArchives.length; i++) {
    const f = eventArchives[i]!;
    if (f.mtime < cutoffMs && i >= keepNArchives) {
      items.push({ kind: "archive", path: f.path, name: f.name, bytes: f.size });
      if (!apply || tryRm(f.path, false)) {
        freedBytes += f.size;
        deletedCount += 1;
      }
    }
  }

  // Top-level summary-<run>.json (never touch summary.json "latest" pointer)
  const summaryFiles = listFiles(logDir, /^summary-.+\.json$/).sort((a, b) => b.mtime - a.mtime);
  const summaryFileCountBefore = summaryFiles.length;
  for (let i = 0; i < summaryFiles.length; i++) {
    const f = summaryFiles[i]!;
    if (isProtectedName(f.name, protect)) {
      protectedSkipped += 1;
      continue;
    }
    // purge: delete all unprotected; prune: only old files beyond keepNArchives newest
    const shouldDelete =
      mode === "purge" || (f.mtime < cutoffMs && i >= keepNArchives);
    if (!shouldDelete) continue;
    items.push({ kind: "summary-file", path: f.path, name: f.name, bytes: f.size });
    if (!apply || tryRm(f.path, false)) {
      freedBytes += f.size;
      deletedCount += 1;
    }
  }

  // 2. Old debug*.jsonl inside run dirs (skip protected)
  let runDirs = listLogRunDirs(logDir);
  for (const run of runDirs) {
    if (isProtectedName(run.name, protect)) continue;
    const debugFiles = listFiles(run.path, /^debug.*\.jsonl$/).sort((a, b) => b.mtime - a.mtime);
    const oldDebugs = debugFiles.filter((f) => f.mtime < cutoffMs);
    for (const f of oldDebugs.slice(keepNArchives)) {
      items.push({
        kind: "debug",
        path: f.path,
        name: `${run.name}/${f.name}`,
        bytes: f.size,
      });
      if (!apply || tryRm(f.path, false)) {
        freedBytes += f.size;
        deletedCount += 1;
      }
    }
  }

  // 3. Cap / purge per-run log directories
  runDirs = listLogRunDirs(logDir);
  const beforeCap = runDirs.length;
  for (const r of runDirs) {
    if (isProtectedName(r.name, protect)) protectedSkipped += 1;
  }
  const capDeletes = selectRunDirsToCap(runDirs, maxRunDirs, cutoffMs, protect);
  for (const { run, force } of capDeletes) {
    const sz = dirSize(run.path);
    items.push({
      kind: force ? "run-dir-force" : "run-dir",
      path: run.path,
      name: run.name,
      bytes: sz,
      force,
    });
    if (!apply || tryRm(run.path, true)) {
      freedBytes += sz;
      deletedCount += 1;
    }
  }

  const remaining = apply
    ? listLogRunDirs(logDir).length
    : beforeCap - capDeletes.length;

  const verb = apply ? "Deleted" : "Would delete";
  const scope = resultTarget === "project-logs" ? "project" : "app";
  const summary =
    `${verb} ${deletedCount} ${scope} log item(s), freed ~${bytesHuman(freedBytes)}. ` +
    `${remaining} run dir(s) remain` +
    (protectedSkipped ? ` (${protectedSkipped} protected skipped)` : "") +
    (apply ? "." : " (dry-run; pass apply:true to delete).");

  return {
    apply,
    target: resultTarget,
    mode,
    root,
    deletedCount,
    freedBytes,
    items: items.slice(0, 80),
    summary,
    logsRunDirCount: beforeCap,
    logsRunDirsRemaining: remaining,
    summaryFileCount: summaryFileCountBefore,
    protectedSkipped,
  };
}

export function pruneRuns(opts: PruneOptions = {}): PruneResult {
  const root = path.resolve(opts.root ?? process.cwd());
  const apply = opts.apply === true;
  const mode: PruneMode = opts.mode === "purge" ? "purge" : "prune";
  const keepDays =
    mode === "purge" ? (opts.keepDays ?? 0) : (opts.keepDays ?? DEFAULT_RUNS_KEEP_DAYS);
  const keepN =
    mode === "purge" ? (opts.maxKeep ?? 0) : (opts.maxKeep ?? DEFAULT_RUNS_KEEP_N);

  const items: PruneItem[] = [];
  let freedBytes = 0;
  let deletedCount = 0;

  let topLevel: string[];
  try {
    topLevel = readdirSync(root);
  } catch {
    return {
      apply,
      target: "runs",
      mode,
      root,
      deletedCount: 0,
      freedBytes: 0,
      items: [],
      summary: `Cannot read root ${root}`,
    };
  }

  for (const name of topLevel) {
    if (!isRunRoot(name)) continue;
    const runRoot = path.join(root, name);
    let st;
    try {
      st = statSync(runRoot);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;

    const entries = listRunEntries(runRoot);
    const toDelete = applyRunsPolicy(entries, keepDays, keepN);
    for (const e of toDelete) {
      const sz = dirSize(e.path);
      items.push({
        kind: "runs-entry",
        path: e.path,
        name: `${name}/${e.name}`,
        bytes: sz,
      });
      if (!apply || tryRm(e.path, true)) {
        freedBytes += sz;
        deletedCount += 1;
      }
    }
  }

  const verb = apply ? "Deleted" : "Would delete";
  const summary =
    `${verb} ${deletedCount} runs/ entry(ies), freed ~${bytesHuman(freedBytes)}` +
    (apply ? "." : " (dry-run; pass apply:true to delete).");

  return {
    apply,
    target: "runs",
    mode,
    root,
    deletedCount,
    freedBytes,
    items: items.slice(0, 80),
    summary,
  };
}

export function runMaintenancePrune(opts: PruneOptions = {}): PruneResult {
  const target: PruneTarget = opts.target ?? "logs";
  if (target === "project-logs") {
    return pruneLogs({ ...opts, target: "project-logs" });
  }
  if (target === "logs") return pruneLogs(opts);
  if (target === "runs") return pruneRuns(opts);

  const logs = pruneLogs(opts);
  const runs = pruneRuns(opts);
  const items = [...logs.items, ...runs.items].slice(0, 80);
  const deletedCount = logs.deletedCount + runs.deletedCount;
  const freedBytes = logs.freedBytes + runs.freedBytes;
  const verb = opts.apply ? "Deleted" : "Would delete";
  const mode: PruneMode = opts.mode === "purge" ? "purge" : "prune";
  return {
    apply: opts.apply === true,
    target: "all",
    mode,
    root: path.resolve(opts.root ?? process.cwd()),
    deletedCount,
    freedBytes,
    items,
    summary:
      `${verb} ${deletedCount} item(s) total (app logs + runs), freed ~${bytesHuman(freedBytes)}. ` +
      `Logs: ${logs.summary} Runs: ${runs.summary}`,
    logsRunDirCount: logs.logsRunDirCount,
    logsRunDirsRemaining: logs.logsRunDirsRemaining,
  };
}
