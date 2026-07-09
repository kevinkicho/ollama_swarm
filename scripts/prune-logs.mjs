#!/usr/bin/env node
// Retention for repo-root logs/ directory.
//
// Targets:
//   - logs/current.jsonl + rotated events-*.jsonl (global event stream)
//   - logs/<runId>/debug*.jsonl and other per-run artifacts
//
// Policy (tunable via flags):
//   - Keep everything from the last KEEP_DAYS (default 14).
//   - For older rotated archives: keep at most KEEP_N_ARCHIVES (default 20).
//   - Cap per-run log directories at MAX_RUN_DIRS (default 50, matches
//     startupHealthCheck warning threshold). Oldest dirs beyond the cap are
//     removed once outside the KEEP_DAYS window; if still over cap, oldest
//     dirs are removed anyway (logged as [force]).
//
// Complements scripts/prune-runs.mjs (clone dirs under runs/).
//
// Usage:
//   npm run prune-logs                 # dry-run
//   npm run prune-logs:apply           # delete
//   node scripts/prune-logs.mjs --keep-days=7 --max-run-dirs=40 --apply

import { readdirSync, statSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  }),
);

const ROOT = path.resolve(args.root ?? process.cwd());
const LOG_DIR = path.join(ROOT, "logs");
const KEEP_DAYS = Number(args["keep-days"] ?? 14);
const KEEP_N_ARCHIVES = Number(args["keep-n"] ?? 20);
const MAX_RUN_DIRS = Number(args["max-run-dirs"] ?? 50);
const APPLY = args.apply === true;

const cutoffMs = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;

function bytesHuman(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function dirSize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    let names;
    try { names = readdirSync(cur); } catch { continue; }
    for (const name of names) {
      const full = path.join(cur, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) stack.push(full);
      else total += st.size;
    }
  }
  return total;
}

function listFiles(dir, pattern) {
  const out = [];
  let names;
  try { names = readdirSync(dir); } catch { return out; }
  for (const name of names) {
    if (!pattern.test(name)) continue;
    const full = path.join(dir, name);
    try {
      const st = statSync(full);
      if (st.isFile()) out.push({ path: full, mtime: st.mtimeMs, size: st.size, name });
    } catch {}
  }
  return out;
}

function listRunDirs() {
  const out = [];
  let names;
  try { names = readdirSync(LOG_DIR); } catch { return out; }
  for (const name of names) {
    if (name === "current.jsonl" || name.startsWith("events-")) continue;
    const full = path.join(LOG_DIR, name);
    try {
      const st = statSync(full);
      if (st.isDirectory()) out.push({ path: full, mtime: st.mtimeMs, name });
    } catch {}
  }
  return out;
}

function deleteRunDir(run, tag) {
  const sz = dirSize(run.path);
  const ageDays = ((Date.now() - run.mtime) / (24 * 60 * 60 * 1000)).toFixed(1);
  console.log(`  [${tag}] ${run.name}/ (${bytesHuman(sz)}, ${ageDays}d old)`);
  if (APPLY) {
    try {
      rmSync(run.path, { recursive: true, force: true });
      return { bytes: sz, count: 1 };
    } catch {}
  }
  return { bytes: sz, count: 1 };
}

/** Drop oldest run dirs until count <= max. Prefer dirs outside keep-days. */
function selectRunDirsToCap(runDirs, max) {
  if (runDirs.length <= max) return [];
  const sorted = [...runDirs].sort((a, b) => a.mtime - b.mtime); // oldest first
  const toDelete = [];
  let remaining = runDirs.length;

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

console.log(`Pruning logs under ${LOG_DIR}`);
console.log(
  `Policy: keep-days=${KEEP_DAYS}, keep-n-archives=${KEEP_N_ARCHIVES}, ` +
  `max-run-dirs=${MAX_RUN_DIRS}, apply=${APPLY}\n`,
);

let totalFreed = 0;
let deletedCount = 0;

// 1. Global rotated event logs (events-*.jsonl)
const eventArchives = listFiles(LOG_DIR, /^events-.*\.jsonl$/);
eventArchives.sort((a, b) => b.mtime - a.mtime);

for (let i = 0; i < eventArchives.length; i++) {
  const f = eventArchives[i];
  if (f.mtime < cutoffMs && i >= KEEP_N_ARCHIVES) {
    console.log(`  [archive] ${f.name} (${bytesHuman(f.size)}, ${new Date(f.mtime).toISOString().slice(0, 10)})`);
    if (APPLY) {
      try { rmSync(f.path); totalFreed += f.size; deletedCount++; } catch {}
    } else {
      totalFreed += f.size;
      deletedCount++;
    }
  }
}

// 2. Per-run debug files inside each run dir
let runDirs = listRunDirs();
for (const run of runDirs) {
  const debugFiles = listFiles(run.path, /^debug.*\.jsonl$/);
  debugFiles.sort((a, b) => b.mtime - a.mtime);

  const oldDebugs = debugFiles.filter((f) => f.mtime < cutoffMs);
  const toDeleteDebug = oldDebugs.slice(KEEP_N_ARCHIVES);

  for (const f of toDeleteDebug) {
    console.log(`  [debug] ${run.name}/${f.name} (${bytesHuman(f.size)})`);
    if (APPLY) {
      try { rmSync(f.path); totalFreed += f.size; deletedCount++; } catch {}
    } else {
      totalFreed += f.size;
      deletedCount++;
    }
  }
}

// 3. Cap per-run log directories (matches startup health check threshold)
runDirs = listRunDirs();
const capDeletes = selectRunDirsToCap(runDirs, MAX_RUN_DIRS);
for (const { run, force } of capDeletes) {
  const tag = force ? "run-dir-force" : "run-dir";
  const result = deleteRunDir(run, tag);
  totalFreed += result.bytes;
  deletedCount += result.count;
}

console.log(
  `\nDone. ${APPLY ? "Deleted" : "Would delete"} ${deletedCount} item(s), ` +
  `freed ~${bytesHuman(totalFreed)}. ` +
  `${runDirs.length - capDeletes.length} run dir(s) would remain.`,
);
if (!APPLY) {
  console.log("Run npm run prune-logs:apply (or pass --apply) to actually delete.");
}