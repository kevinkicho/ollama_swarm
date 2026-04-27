#!/usr/bin/env node
// Periodic full /api/swarm/status snapshots → time-series JSON files.
// Pairs with monitor-blackboard-issues.mjs (which captures evidence
// for known issues). This one captures EVERYTHING — full status JSON
// at a regular cadence so post-run analysis can see the run evolve.
//
// Usage:
//   node scripts/capture-status-snapshots.mjs --runId=<uuid> --runDir=runs/_monitor/<uuid>
//
// Args:
//   --port           server port (default 8243)
//   --runId          required — run identity for the snapshot dir
//   --runDir         where to write snapshots (default runs/_monitor/<runId>)
//   --intervalSec    polling cadence (default 30)
//   --maxWaitMin     exit after N min if run never terminates (default 30)

import { writeFile, mkdir, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ""), true];
  }),
);
const PORT = Number(args.port ?? 8243);
const RUN_ID = args.runId;
const RUN_DIR = args.runDir ?? `runs/_monitor/${RUN_ID ?? "unspecified"}`;
const INTERVAL_MS = Number(args.intervalSec ?? 30) * 1000;
const MAX_WAIT_MS = Number(args.maxWaitMin ?? 30) * 60 * 1000;

if (!RUN_ID) {
  console.error("--runId=<uuid> is required");
  process.exit(2);
}

const STATUS_URL = `http://127.0.0.1:${PORT}/api/swarm/status`;
const TOKENS_URL = `http://127.0.0.1:${PORT}/api/tokens/window?windowMs=86400000`;
const RUN_DIR_ABS = path.resolve(RUN_DIR);
const SNAPSHOT_DIR = path.join(RUN_DIR_ABS, "snapshots");
const INDEX_PATH = path.join(SNAPSHOT_DIR, "index.jsonl");
const TERMINAL = new Set(["completed", "stopped", "failed"]);

if (!existsSync(SNAPSHOT_DIR)) await mkdir(SNAPSHOT_DIR, { recursive: true });

const startedAt = Date.now();
let pollNum = 0;
console.log(`snapshotter: every ${INTERVAL_MS / 1000}s → ${SNAPSHOT_DIR}`);

while (true) {
  pollNum++;
  const t0 = Date.now();
  let status = null;
  let tokens = null;
  try {
    const r = await fetch(STATUS_URL);
    if (r.ok) status = await r.json();
  } catch (e) {
    status = { _fetch_error: String(e) };
  }
  try {
    const r = await fetch(TOKENS_URL);
    if (r.ok) tokens = await r.json();
  } catch {
    /* tokens optional */
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const snapPath = path.join(SNAPSHOT_DIR, `snapshot-${String(pollNum).padStart(4, "0")}-${ts}.json`);
  await writeFile(
    snapPath,
    JSON.stringify(
      {
        capturedAt: t0,
        pollNum,
        elapsedSinceStartMs: t0 - startedAt,
        runId: RUN_ID,
        status,
        tokens,
      },
      null,
      2,
    ),
  );
  await appendFile(
    INDEX_PATH,
    JSON.stringify({
      pollNum,
      capturedAt: t0,
      elapsedSec: Math.round((t0 - startedAt) / 1000),
      phase: status?.phase ?? "?",
      transcriptLen: status?.transcript?.length ?? 0,
      boardCounts: status?.board?.counts ?? null,
      file: path.basename(snapPath),
    }) + "\n",
  );
  console.log(
    `[${Math.round((t0 - startedAt) / 1000)}s] poll #${pollNum} phase=${status?.phase ?? "?"} entries=${status?.transcript?.length ?? 0} board=${JSON.stringify(status?.board?.counts ?? {})}`,
  );

  if (status && TERMINAL.has(status.phase)) {
    console.log(`terminal phase '${status.phase}' — final snapshot saved, exiting`);
    break;
  }
  if (Date.now() - startedAt > MAX_WAIT_MS) {
    console.log(`max wait reached, exiting`);
    break;
  }
  await sleep(INTERVAL_MS);
}
