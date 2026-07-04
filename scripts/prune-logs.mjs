#!/usr/bin/env node
// Simple retention for logs/ directory.
//
// Targets the two main sources of large files:
//   - logs/current.jsonl + rotated events-*.jsonl (global event stream)
//   - logs/<runId>/debug*.jsonl (per-run verbose debug)
//
// Policy (tunable via flags):
//   - Keep everything from the last KEEP_DAYS (default 14).
//   - For older files: keep at most KEEP_N_ARCHIVES of the rotated event/debug files.
//   - Also trims very old per-run debug directories if their run is ancient.
//
// This complements scripts/prune-runs.mjs (which handles clone dirs).
//
// Usage:
//   node scripts/prune-logs.mjs                 # dry-run
//   node scripts/prune-logs.mjs --apply
//   node scripts/prune-logs.mjs --keep-days=7 --keep-n=10 --apply

import { readdirSync, statSync, rmSync, renameSync } from "node:fs";
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
const APPLY = args.apply === true;

const cutoffMs = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;

function bytesHuman(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
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

console.log(`Pruning logs under ${LOG_DIR}`);
console.log(`Policy: keep last ${KEEP_DAYS} days + at most ${KEEP_N_ARCHIVES} old archives per type. Apply=${APPLY}\n`);

let totalFreed = 0;
let deletedCount = 0;

// 1. Handle global rotated event logs (events-*.jsonl)
const eventArchives = listFiles(LOG_DIR, /^events-.*\.jsonl$/);
eventArchives.sort((a, b) => b.mtime - a.mtime);

const toDeleteEvents = [];
for (let i = 0; i < eventArchives.length; i++) {
  const f = eventArchives[i];
  if (f.mtime < cutoffMs && i >= KEEP_N_ARCHIVES) {
    toDeleteEvents.push(f);
  }
}

for (const f of toDeleteEvents) {
  const sz = f.size;
  console.log(`  [archive] ${f.name} (${bytesHuman(sz)}, ${new Date(f.mtime).toISOString().slice(0,10)})`);
  if (APPLY) {
    try { rmSync(f.path); totalFreed += sz; deletedCount++; } catch {}
  }
}

// 2. Per-run debug files + dirs
const runDirs = listRunDirs();
for (const run of runDirs) {
  const debugFiles = listFiles(run.path, /^debug.*\.jsonl$/);
  debugFiles.sort((a, b) => b.mtime - a.mtime);

  const oldDebugs = debugFiles.filter(f => f.mtime < cutoffMs);
  // Keep only the newest KEEP_N_ARCHIVES old debug files inside this run dir
  const toDeleteDebug = oldDebugs.slice(KEEP_N_ARCHIVES);

  for (const f of toDeleteDebug) {
    console.log(`  [debug] ${run.name}/${f.name} (${bytesHuman(f.size)})`);
    if (APPLY) {
      try { rmSync(f.path); totalFreed += f.size; deletedCount++; } catch {}
    }
  }

  // If the whole run dir is ancient and contains only old debug stuff, consider removing the dir
  // (conservative: only if all its files are old and beyond keep window)
  if (run.mtime < cutoffMs && debugFiles.length > 0) {
    const remaining = listFiles(run.path, /./); // anything left?
    if (remaining.length === 0 || (remaining.every(r => r.mtime < cutoffMs) && debugFiles.length <= KEEP_N_ARCHIVES)) {
      console.log(`  [run-dir] ${run.name}/ (ancient debug dir)`);
      if (APPLY) {
        try {
          const sz = remaining.reduce((s, r) => s + r.size, 0);
          rmSync(run.path, { recursive: true, force: true });
          totalFreed += sz;
          deletedCount++;
        } catch {}
      }
    }
  }
}

// 3. Optionally compress old archives (future improvement hook)
console.log(`\nDone. ${APPLY ? "Deleted" : "Would delete"} ${deletedCount} files, freed ~${bytesHuman(totalFreed)}.`);
if (!APPLY) {
  console.log("Pass --apply to actually delete.");
}
