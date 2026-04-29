#!/usr/bin/env node
// #310 (2026-04-28): retention policy for runs/ artifacts.
//
// As ollama_swarm matures the runs/ tree grows quickly — every
// preset run drops a clone dir + N summary-<iso>.json snapshots +
// optional Playwright monitor artifacts. After a few months that's
// gigabytes of state most of which is never re-read.
//
// This script enforces a simple two-rule retention policy:
//   1. Always keep entries from the last KEEP_LAST_DAYS (default 7).
//   2. Beyond that window, keep at most KEEP_LAST_N most recent
//      entries (default 50). The rest get removed.
//
// Targets:
//   - clone directories under runs/, runs_overnight*/, runs_*/
//   - Playwright monitor artifacts under runs/_full-tour*/_monitors/
//   - eval output dirs under runs/_eval/
//
// Defaults err on the side of keeping data — bump --keep-n / --
// keep-days down for an aggressive prune. Always logs what it would
// delete; --dry-run by default. Pass --apply to actually delete.
//
// Usage:
//   node scripts/prune-runs.mjs                 # dry-run, defaults
//   node scripts/prune-runs.mjs --apply         # actually delete
//   node scripts/prune-runs.mjs --keep-days=3 --keep-n=20 --apply

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
const KEEP_LAST_DAYS = Number(args["keep-days"] ?? 7);
const KEEP_LAST_N = Number(args["keep-n"] ?? 50);
const APPLY = args.apply === true;

const cutoffMs = Date.now() - KEEP_LAST_DAYS * 24 * 60 * 60 * 1000;

function isRunRoot(name) {
  return name === "runs" || name.startsWith("runs_") || name.startsWith("runs-");
}

/** Walk a runs root + return an array of {path, mtime} for every
 *  immediate subdirectory. We don't recurse — clone dirs are 1
 *  level deep, eval/monitor dirs same depth. */
function listEntries(root) {
  const out = [];
  let names;
  try {
    names = readdirSync(root);
  } catch {
    return out;
  }
  for (const name of names) {
    const full = path.join(root, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    out.push({ path: full, mtime: st.mtimeMs, name });
  }
  return out;
}

function bytesHuman(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

function dirSize(dir) {
  let total = 0;
  let count = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    let names;
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
      else {
        total += st.size;
        count += 1;
      }
    }
  }
  return { bytes: total, files: count };
}

function applyPolicy(entries) {
  // Sort newest first
  entries.sort((a, b) => b.mtime - a.mtime);
  const keep = new Set();
  // Rule 1: always keep entries within the last KEEP_LAST_DAYS
  for (const e of entries) {
    if (e.mtime >= cutoffMs) keep.add(e.path);
  }
  // Rule 2: from the rest, keep the N most recent
  const remaining = entries.filter((e) => !keep.has(e.path));
  for (const e of remaining.slice(0, Math.max(0, KEEP_LAST_N - keep.size))) {
    keep.add(e.path);
  }
  return entries.filter((e) => !keep.has(e.path));
}

function main() {
  console.log(`prune-runs: scanning ${ROOT}`);
  console.log(
    `  keep-days=${KEEP_LAST_DAYS} keep-n=${KEEP_LAST_N} apply=${APPLY}`,
  );

  let topLevel;
  try {
    topLevel = readdirSync(ROOT);
  } catch (err) {
    console.error(`Cannot read ${ROOT}: ${err.message ?? err}`);
    process.exit(2);
  }

  const allRoots = [];
  for (const name of topLevel) {
    if (!isRunRoot(name)) continue;
    const root = path.join(ROOT, name);
    let st;
    try {
      st = statSync(root);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    allRoots.push(root);
  }

  if (allRoots.length === 0) {
    console.log("  no runs roots found");
    return;
  }

  let totalDeleted = 0;
  let totalBytes = 0;

  for (const root of allRoots) {
    const entries = listEntries(root);
    if (entries.length === 0) continue;
    console.log(`\n${root}: ${entries.length} entries`);
    const toDelete = applyPolicy(entries);
    if (toDelete.length === 0) {
      console.log("  nothing to prune (all within retention window)");
      continue;
    }
    for (const e of toDelete) {
      const { bytes, files } = dirSize(e.path);
      const ageDays = ((Date.now() - e.mtime) / (24 * 60 * 60 * 1000)).toFixed(1);
      console.log(
        `  ${APPLY ? "DELETING" : "would delete"}: ${e.name} (${bytesHuman(bytes)}, ${files} files, ${ageDays}d old)`,
      );
      totalDeleted += 1;
      totalBytes += bytes;
      if (APPLY) {
        try {
          rmSync(e.path, { recursive: true, force: true });
        } catch (err) {
          console.error(`    failed: ${err.message ?? err}`);
        }
      }
    }
  }

  console.log(`\nTotal: ${totalDeleted} entries (${bytesHuman(totalBytes)}) ${APPLY ? "deleted" : "would be deleted"}`);
  if (!APPLY) console.log("Re-run with --apply to actually delete.");
}

main();
