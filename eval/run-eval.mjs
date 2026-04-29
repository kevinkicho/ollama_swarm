#!/usr/bin/env node
// #297: Eval harness — runs every (preset, task) pair from
// eval/catalog.json against a target repo, scores each run from
// summary.json, and produces a per-run-and-aggregate report.
//
// Usage:
//   node eval/run-eval.mjs \
//     --repo=https://github.com/kevinkicho/multi-agent-orchestrator \
//     --catalog=eval/catalog.json \
//     [--out=runs/_eval/<timestamp>] \
//     [--server=http://127.0.0.1:8243] \
//     [--only=<task-id>[,<task-id>...]] \
//     [--presets=<preset>[,<preset>...]]
//
// Outputs in <out>/:
//   results.json          — array of one row per (preset,task) attempt
//   REPORT.md             — preset×task matrix + aggregates + per-task
//                           commentary
//   per-run/<id>.json     — captured summary.json for each finished run
//   progress.log          — human-readable timeline

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";

// Module-level state set inside main() — kept local so the file can
// be imported by the test without triggering the CLI run.
let REPO = "";
let CATALOG_PATH = "eval/catalog.json";
let SERVER = "http://127.0.0.1:8243";
let OUT_DIR = "";
let PARENT_PATH = "";
let ONLY_TASKS = null;
let ONLY_PRESETS = null;
let logFile = "";

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  try {
    writeFileSync(logFile, line, { flag: "a" });
  } catch {
    // ignore
  }
}

function buildPayload(task, preset) {
  const payload = {
    repoUrl: REPO,
    parentPath: PARENT_PATH,
    preset,
    agentCount: task.agentCount,
    rounds: task.rounds,
    userDirective: task.directive,
    force: true,
  };
  if (typeof task.wallClockCapMs === "number" && preset === "blackboard") {
    payload.wallClockCapMs = task.wallClockCapMs;
  }
  if (preset === "debate-judge" && task.proposition) {
    payload.proposition = task.proposition;
  }
  return payload;
}

async function fireStart(payload) {
  // Mirror the full-tour fix: fire POST + poll status (route awaits
  // entire warmup which can exceed any reasonable curl timeout). If
  // status transitions out of idle within 60s, treat as "started ok"
  // regardless of whether POST has returned.
  const ctrl = new AbortController();
  const post = fetch(`${SERVER}/api/swarm/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: ctrl.signal,
  }).catch((err) => ({ _err: err }));

  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const s = await fetchStatus();
    if (
      s.phase &&
      ["spawning", "running", "discussing", "executing", "completed", "stopped", "failed"].includes(s.phase)
    ) {
      // Best-effort cancel the in-flight POST since we no longer need it
      ctrl.abort();
      return { ok: true, runId: s.runId ?? "" };
    }
  }
  // Not transitioned in 60s — fall through to the POST result
  const r = await post;
  if (r && r._err) return { ok: false, reason: String(r._err) };
  if (!r?.ok) return { ok: false, reason: `HTTP ${r?.status ?? "unknown"}` };
  const body = await r.json().catch(() => ({}));
  if (body.ok === false) return { ok: false, reason: body.error ?? "unknown" };
  const s = await fetchStatus();
  return { ok: true, runId: s.runId ?? "" };
}

async function fetchStatus() {
  try {
    const r = await fetch(`${SERVER}/api/swarm/status`);
    if (!r.ok) return { phase: "unknown" };
    return await r.json();
  } catch {
    return { phase: "unknown" };
  }
}

async function waitUntilIdle(safetyMs) {
  const deadline = Date.now() + safetyMs;
  while (true) {
    const s = await fetchStatus();
    if (["idle", "completed", "stopped", "failed"].includes(s.phase ?? "")) {
      return { phase: s.phase, runId: s.runId };
    }
    if (Date.now() > deadline) {
      log(`  WARNING safety timeout ${Math.round(safetyMs / 1000)}s — POST /stop`);
      try {
        await fetch(`${SERVER}/api/swarm/stop`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });
      } catch {
        // ignore
      }
      await sleep(10_000);
      return { phase: "timeout" };
    }
    await sleep(15_000);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Score a single run from its summary.json. Higher score = better.
// Components:
//  - completion (40 pts): completed cleanly = 40, stopped/timeout = 20, failed = 0
//  - throughput (30 pts): commits + transcript activity normalized
//  - efficiency (20 pts): tokens per minute (lower = better)
//  - conformance (10 pts): from #295 conformance samples if present in summary
export function scoreRun(summary, task) {
  if (!summary || typeof summary !== "object") {
    return { total: 0, components: { completion: 0, throughput: 0, efficiency: 0, conformance: 0 }, notes: "no summary" };
  }

  // Completion (40)
  const stopReason = summary.stopReason ?? "unknown";
  let completion = 0;
  if (stopReason === "completed") completion = 40;
  else if (stopReason === "user" || stopReason === "wall_clock") completion = 20;
  else if (stopReason === "failed") completion = 0;
  else completion = 10;

  // Throughput (30): for code tasks, weight commits heavily; for
  // analysis tasks weight transcript activity
  let throughput = 0;
  const commits = summary.filesChanged ?? 0;
  const transcriptCount = (summary.transcript?.length ?? summary.agents?.reduce?.((a, b) => a + (b.turns ?? 0), 0)) ?? 0;
  if (task.expectFilesChanged) {
    // scale: 1 file = 6, 5+ files = full 30
    throughput = Math.min(30, commits * 6);
  } else {
    // analysis: scale on transcript volume up to 30
    throughput = Math.min(30, Math.round(transcriptCount * 2));
  }

  // Efficiency (20): tokens per minute. Lower is better; bias toward
  // <50k tok/min as full score.
  const wallS = (summary.wallClockMs ?? 1) / 1000;
  const totalToks = (summary.totalPromptTokens ?? 0) + (summary.totalResponseTokens ?? 0);
  const tokPerMin = totalToks / Math.max(wallS / 60, 0.01);
  let efficiency = 0;
  if (tokPerMin < 50_000) efficiency = 20;
  else if (tokPerMin < 200_000) efficiency = Math.round(20 - ((tokPerMin - 50_000) / 150_000) * 15);
  else efficiency = 5;

  // Conformance (10): server doesn't yet bake conformance averages
  // into summary.json (#295 emits live samples but doesn't aggregate).
  // Reserve the slot; default to 5 (neutral) until aggregation lands.
  const conformance = 5;

  const total = completion + throughput + efficiency + conformance;
  return {
    total,
    components: { completion, throughput, efficiency, conformance },
    notes: `${stopReason} · commits=${commits} · ${Math.round(wallS)}s · ${Math.round(tokPerMin)} tok/min`,
  };
}

async function readSummary(clonePath) {
  // summary.json lives at the clone root. Best-effort — return null
  // if missing or unparseable.
  try {
    const raw = readFileSync(path.join(clonePath, "summary.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function main() {
  // Parse argv now (deferred from module load so tests can import
  // scoreRun without the CLI argv-validation crashing the runner).
  const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
      const m = a.match(/^--([^=]+)=(.*)$/);
      return m ? [m[1], m[2]] : [a.replace(/^--/, ""), true];
    }),
  );
  REPO = args.repo;
  if (!REPO) {
    console.error("--repo=<github-url> is required");
    process.exit(2);
  }
  CATALOG_PATH = args.catalog ?? CATALOG_PATH;
  SERVER = args.server ?? SERVER;
  OUT_DIR =
    args.out ??
    path.join("runs", "_eval", new Date().toISOString().replace(/[:.]/g, "-"));
  PARENT_PATH = args.parent ?? path.resolve("runs", "_eval-clones");
  ONLY_TASKS = args.only ? String(args.only).split(",") : null;
  ONLY_PRESETS = args.presets ? String(args.presets).split(",") : null;

  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(path.join(OUT_DIR, "per-run"), { recursive: true });
  mkdirSync(PARENT_PATH, { recursive: true });

  const catalog = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
  const tasks = catalog.tasks.filter(
    (t) => !ONLY_TASKS || ONLY_TASKS.includes(t.id),
  );
  logFile = path.join(OUT_DIR, "progress.log");

  log(`==== eval harness — ${tasks.length} tasks against ${REPO} ====`);
  log(`Catalog: ${CATALOG_PATH}`);
  log(`Output:  ${OUT_DIR}`);

  const results = [];
  for (const task of tasks) {
    const presets = (task.presets ?? []).filter(
      (p) => !ONLY_PRESETS || ONLY_PRESETS.includes(p),
    );
    log(`---- task ${task.id} (${presets.length} presets) ----`);
    for (const preset of presets) {
      log(`  preset=${preset}`);
      const startTs = Date.now();
      const payload = buildPayload(task, preset);
      const fired = await fireStart(payload);
      if (!fired.ok) {
        log(`    start FAILED: ${fired.reason}`);
        results.push({
          taskId: task.id, preset, ok: false, reason: fired.reason,
          score: { total: 0, components: {}, notes: "start_failed" },
          wallS: 0, ts: startTs,
        });
        await sleep(5000);
        continue;
      }
      const safetyMs = (task.wallClockCapMs ?? 600_000) + 120_000;
      const final = await waitUntilIdle(safetyMs);
      const wallS = Math.round((Date.now() - startTs) / 1000);
      const status = await fetchStatus();
      const clonePath = status.repoUrl
        ? null /* not directly available; derive */
        : null;
      // derive clonePath from runs/_eval-clones/<repo-name>
      const repoName =
        REPO.replace(/\.git$/, "")
          .split("/")
          .filter(Boolean)
          .pop() ?? "repo";
      const derivedClone = path.join(PARENT_PATH, repoName);
      const summary = await readSummary(derivedClone);
      const score = scoreRun(summary, task);
      log(`    done — phase=${final.phase} score=${score.total} (${score.notes})`);
      // Snapshot summary for the report
      if (summary) {
        try {
          writeFileSync(
            path.join(OUT_DIR, "per-run", `${task.id}__${preset}__${startTs}.json`),
            JSON.stringify(summary, null, 2),
          );
        } catch {
          // ignore
        }
      }
      results.push({
        taskId: task.id, preset, ok: final.phase !== "timeout",
        phase: final.phase, runId: fired.runId, wallS, ts: startTs, score,
      });
      // Persist results after every preset so a partial run still has data
      writeFileSync(path.join(OUT_DIR, "results.json"), JSON.stringify(results, null, 2));
      await sleep(8000);
    }
  }

  // Build the report
  const report = buildReport(tasks, results);
  writeFileSync(path.join(OUT_DIR, "REPORT.md"), report);
  log(`==== eval COMPLETE — ${results.length} runs · report at ${OUT_DIR}/REPORT.md ====`);
}

function buildReport(tasksDef, results) {
  const lines = [];
  lines.push(`# Eval report — ${new Date().toISOString()}`);
  lines.push(``);
  lines.push(`Repo: ${REPO}`);
  lines.push(`Tasks: ${tasksDef.length} · Runs: ${results.length}`);
  lines.push(``);
  lines.push(`## Score matrix`);
  lines.push(``);
  // Collect all presets that appeared
  const presetSet = new Set();
  results.forEach((r) => presetSet.add(r.preset));
  const presets = [...presetSet].sort();
  // Header row
  lines.push(`| Task | ${presets.join(" | ")} |`);
  lines.push(`| --- | ${presets.map(() => "---").join(" | ")} |`);
  for (const task of tasksDef) {
    const cells = presets.map((p) => {
      const r = results.find((x) => x.taskId === task.id && x.preset === p);
      if (!r) return "—";
      const s = r.score?.total ?? 0;
      const tag = r.ok ? "" : " ⚠";
      return `${s}${tag}`;
    });
    lines.push(`| **${task.id}** | ${cells.join(" | ")} |`);
  }
  lines.push(``);
  lines.push(`## Per-run details`);
  lines.push(``);
  for (const r of results) {
    lines.push(`### ${r.taskId} × ${r.preset}`);
    lines.push(`- Phase: ${r.phase ?? "?"} · Wall: ${r.wallS}s · runId: \`${r.runId ?? ""}\``);
    if (r.score) {
      lines.push(
        `- Score: **${r.score.total}** = completion ${r.score.components.completion} + throughput ${r.score.components.throughput} + efficiency ${r.score.components.efficiency} + conformance ${r.score.components.conformance}`,
      );
      lines.push(`- ${r.score.notes}`);
    }
    if (r.reason) lines.push(`- Reason: ${r.reason}`);
    lines.push(``);
  }
  lines.push(`## Aggregates per preset`);
  lines.push(``);
  lines.push(`| Preset | Mean score | Runs | Pass rate |`);
  lines.push(`| --- | ---: | ---: | ---: |`);
  for (const p of presets) {
    const rows = results.filter((r) => r.preset === p);
    const mean =
      rows.reduce((a, b) => a + (b.score?.total ?? 0), 0) / Math.max(rows.length, 1);
    const passRate =
      rows.filter((r) => r.ok && (r.score?.total ?? 0) >= 60).length /
      Math.max(rows.length, 1);
    lines.push(`| ${p} | ${Math.round(mean)} | ${rows.length} | ${Math.round(passRate * 100)}% |`);
  }
  return lines.join("\n");
}

// Only run main() when invoked as a CLI; importing for tests skips it.
if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
