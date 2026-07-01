#!/usr/bin/env node
// #297: Eval harness — runs every (preset, task) pair from
// eval/catalog.json against a target repo, scores each run from
// summary.json, and produces a per-run-and-aggregate report.
//
// Phase 7 of #314: --seeds=N runs each (preset, task) pair N times.
// Each attempt is a fresh /api/swarm/start call. Multi-seed scoring
// reduces noise from non-deterministic LLM outputs — the aggregator
// (eval/aggregate.mjs) consumes results.json and computes per-cell
// median + IQR for the published eval/RESULTS.md scoreboard.
//
// Usage:
//   node eval/run-eval.mjs \
//     --repo=https://github.com/kevinkicho/multi-agent-orchestrator \
//     --catalog=eval/catalog.json \
//     [--out=runs/_eval/<timestamp>] \
//     [--server=http://127.0.0.1:8243] \
//     [--only=<task-id>[,<task-id>...]] \
//     [--presets=<preset>[,<preset>...]] \
//     [--seeds=N]                          # default 1; scoreboard sweep uses 3–5
//
// Outputs in <out>/:
//   results.json          — array of one row per (preset,task) attempt
//   REPORT.md             — preset×task matrix + aggregates + per-task
//                           commentary
//   per-run/<id>.json     — captured summary.json for each finished run
//   progress.log          — human-readable timeline

import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { judgeAnalysisRun, multiJudgeAnalysisRun } from "./qualityJudge.mjs";

// Module-level state set inside main() — kept local so the file can
// be imported by the test without triggering the CLI run.
let REPO = "";
let CATALOG_PATH = "eval/catalog.json";
let SERVER = "http://127.0.0.1:8243";
let OUT_DIR = "";
let PARENT_PATH = "";
let ONLY_TASKS = null;
let ONLY_PRESETS = null;
let SEEDS = 1;
// Phase 7+ (#314): when set, ignore --repo and source the swarm's
// target from a local self-contained fixture directory under
// eval/fixtures/. Each iteration cp -r's the fixture into PARENT_PATH,
// git-inits it, and points the swarm at the file:// URL. Verification
// runs the fixture's verify.mjs; exit 0 = pass.
let FIXTURE_DIR = "";
// 2026-05-01: --model overrides what the server uses for every attempt
// in this sweep. Lets a paid scoreboard run (Sonnet 4.6 / GPT-5) target
// a specific model without touching .env or restarting dev. Empty =
// server default.
let MODEL_OVERRIDE = "";
// 2026-05-09 (LCCA): --local strips :cloud suffix from all model refs
// so the sweep benchmarks against local Ollama models. Useful for
// comparing local vs cloud latency + cost.
let USE_LOCAL_OLLAMA = false;
// 2026-05-01: --maxCostUsd applies the per-run dollar ceiling to every
// attempt in the sweep. Bounds runaway spend on paid providers. 0 =
// no cap. Capped server-side at $100; eval also clamps for sanity.
let MAX_COST_USD = 0;
// 2026-05-01 (scoreboard pre-flight): MoA per-layer model overrides.
// --moa-proposer-model + --moa-aggregator-model surface
// RunConfig.moaProposerModel / moaAggregatorModel (added in #98) so
// Config E (heterogeneous MoA — gemma4 proposers + nemotron aggregator)
// is one-command runnable. Only effective when preset === "moa".
let MOA_PROPOSER_MODEL = "";
let MOA_AGGREGATOR_MODEL = "";
// --moa-aggregator-count surfaces cfg.moaAggregatorCount (1..3, default
// 1). Lets multi-aggregator-vote experiments run from the CLI too.
let MOA_AGGREGATOR_COUNT = 0;
// 2026-05-02 (lever #2): LLM-as-judge for analysis-task quality scoring.
// --quality-judge-ollama-url defaults to http://127.0.0.1:11434 (the
// local Ollama daemon — same one the swarm hits). --quality-judge-model
// defaults to deepseek-v4-flash:cloud (strongest reasoning that ships
// free); override for cheaper-faster (gemma4) or higher-quality (paid).
let QUALITY_JUDGE_OLLAMA_URL = "http://127.0.0.1:11434";
let QUALITY_JUDGE_MODEL = "";
// 2026-05-02 (matrix row #7): comma-separated list of judge models for
// multi-judge inter-rater agreement. When set (2+ models), each judge
// scores the same deliverable + the eval reports agreement
// (high/medium/low) on the per-attempt row. Lets us know whether a
// "score 75" is robust across raters or judges wildly disagree.
let QUALITY_JUDGE_MODELS = []; // string[]
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
  if (preset === "blackboard") {
    // Blackboard: honor explicit task cap, else 20 min.
    payload.wallClockCapMs = task.wallClockCapMs ?? 1_200_000;
  } else {
    // Discussion presets: per-preset defaults for faster failure detection.
    const presetCaps = {
      "round-robin": 300_000,
      "council": 300_000,
      "role-diff": 300_000,
      "debate-judge": 300_000,
      "map-reduce": 300_000,
      "orchestrator-worker": 600_000,
      "orchestrator-worker-deep": 600_000,
      "stigmergy": 600_000,
      "moa": 300_000,
      "baseline": 300_000,
    };
    payload.wallClockCapMs = task.wallClockCapMs ?? presetCaps[preset] ?? 600_000;
  }
  if (preset === "debate-judge" && task.proposition) {
    payload.proposition = task.proposition;
  }
  // 2026-05-01: --model + --maxCostUsd override per sweep so paid runs
  // don't require touching .env / restarting dev. Applied uniformly to
  // every (task, preset, seed) attempt.
  if (MODEL_OVERRIDE) payload.model = MODEL_OVERRIDE;
  // 2026-05-09: --local strips :cloud from all model refs for local
  // Ollama benchmarks. Applied after MODEL_OVERRIDE so --model can
  // override the local model too.
  if (USE_LOCAL_OLLAMA) {
    const strip = (s) => s?.replace(/:cloud$/, "").replace(/-cloud$/, "") ?? s;
    if (payload.model) payload.model = strip(payload.model);
    if (payload.plannerModel) payload.plannerModel = strip(payload.plannerModel);
    if (payload.workerModel) payload.workerModel = strip(payload.workerModel);
    if (payload.auditorModel) payload.auditorModel = strip(payload.auditorModel);
  }
  if (MAX_COST_USD > 0) payload.maxCostUsd = MAX_COST_USD;
  // 2026-05-01 (scoreboard pre-flight): MoA per-layer model overrides.
  // Only meaningful when preset === "moa". Other presets ignore them.
  if (preset === "moa") {
    if (MOA_PROPOSER_MODEL) payload.moaProposerModel = MOA_PROPOSER_MODEL;
    if (MOA_AGGREGATOR_MODEL) payload.moaAggregatorModel = MOA_AGGREGATOR_MODEL;
    if (MOA_AGGREGATOR_COUNT > 0) payload.moaAggregatorCount = MOA_AGGREGATOR_COUNT;
  }
  return payload;
}

// Phase 7+ (#314): stage a local fixture as a git-init'd directory the
// swarm can clone via simple-git's file:// transport. Each attempt gets
// its own copy under PARENT_PATH so concurrent runs don't collide.
// Returns the file:// URL the swarm should clone from.
function stageFixture(fixtureDir, fixtureName, attemptId) {
  const stagePath = path.join(PARENT_PATH, `${fixtureName}__${attemptId}`);
  // Wipe any prior stage; cpSync expects a non-existent or empty dest
  if (existsSync(stagePath)) rmSync(stagePath, { recursive: true, force: true });
  cpSync(fixtureDir, stagePath, { recursive: true });
  // git-init the staged copy so simple-git.clone can pull from it
  const gitInit = spawnSync("git", ["init", "--quiet"], { cwd: stagePath });
  if (gitInit.status !== 0) {
    throw new Error(`git init failed in ${stagePath}: ${gitInit.stderr?.toString() ?? "no stderr"}`);
  }
  // Stage + commit so the clone has a HEAD to check out
  spawnSync("git", ["add", "-A"], { cwd: stagePath });
  spawnSync(
    "git",
    [
      "-c", "user.name=eval-fixture",
      "-c", "user.email=eval@local",
      "commit", "--quiet", "-m", "fixture seed",
    ],
    { cwd: stagePath },
  );
  return { fileUrl: `file://${stagePath}`, stagePath };
}

// Run the fixture's verify.mjs and return { ok: bool, output: string }.
// Path is the fixture's STAGED directory (the cp -r destination), so
// swarm-applied changes are what we're verifying.
function runFixtureVerify(stagePath) {
  const r = spawnSync(process.execPath, ["verify.mjs"], {
    cwd: stagePath,
    timeout: 30_000,
  });
  return {
    ok: r.status === 0,
    output: ((r.stdout?.toString() ?? "") + (r.stderr?.toString() ?? "")).slice(-1000),
  };
}

async function fireStart(payload) {
  // Mirror the full-tour fix: fire POST + poll status (route awaits
  // entire warmup which can exceed any reasonable curl timeout). Treat
  // as "started" when EITHER the runId has changed OR the phase has
  // moved off whatever terminal state the prior run left behind.
  // 2026-05-01 fix: previous version accepted phase=completed/stopped
  // as "started" — it falsely passed when the prior run was already
  // terminal and the POST silently failed (returned old runId again).
  const preStatus = await fetchStatus();
  const priorRunId = preStatus.runId ?? "";
  const priorPhase = preStatus.phase ?? "";
  const TRANSIENT_PHASES = ["spawning", "running", "discussing", "executing", "planning"];

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
    const runIdChanged = s.runId && s.runId !== priorRunId;
    const enteredTransient = TRANSIENT_PHASES.includes(s.phase ?? "");
    if (runIdChanged || enteredTransient) {
      ctrl.abort();
      return { ok: true, runId: s.runId ?? "" };
    }
    // If phase remains in the same terminal state with same runId after
    // 30s, the POST hasn't taken effect — fall through to await the
    // actual response below.
    void priorPhase;
  }
  // Not transitioned in 60s — fall through to the POST result
  const r = await post;
  if (r && r._err) return { ok: false, reason: String(r._err) };
  if (!r?.ok) return { ok: false, reason: `HTTP ${r?.status ?? "unknown"}` };
  const body = await r.json().catch(() => ({}));
  if (body.ok === false) return { ok: false, reason: body.error ?? "unknown" };
  const s = await fetchStatus();
  if (s.runId === priorRunId) {
    return { ok: false, reason: `runId unchanged after POST (still ${priorRunId})` };
  }
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
//  - hunk-quality (10 pts): cascade efficiency from stale/commit ratios
//  - conformance (0 pts): reserved (#295 not aggregated yet)
export function scoreRun(summary, task) {
  if (!summary || typeof summary !== "object") {
    return { total: 0, components: { completion: 0, throughput: 0, efficiency: 0, hunkQuality: 0, conformance: 0 }, notes: "no summary" };
  }

  // Completion (40)
  const stopReason = summary.stopReason ?? "unknown";
  let completion = 0;
  if (stopReason === "completed") completion = 40;
  else if (stopReason === "user" || stopReason === "wall_clock") completion = 20;
  else if (stopReason === "failed") completion = 0;
  else completion = 10;

  // Throughput (30): for code tasks, weight commits heavily; for
  // analysis tasks weight transcript activity OR judge-quality if a
  // qualityScore was supplied (lever #2, 2026-05-02 — see qualityJudge.mjs).
  let throughput = 0;
  const commits = summary.filesChanged ?? 0;
  const transcriptCount = (summary.transcript?.length ?? summary.agents?.reduce?.((a, b) => a + (b.turns ?? 0), 0)) ?? 0;
  if (task.expectFilesChanged) {
    // scale: 1 file = 6, 5+ files = full 30
    throughput = Math.min(30, commits * 6);
  } else if (typeof task.qualityScore === "number") {
    // 2026-05-02 (lever #2): when a quality judge ran, replace the
    // transcript-volume proxy with the judge's 0-100 score scaled to
    // 0-30. This is the actual differentiator between discussion
    // presets — pre-fix, every analysis run got ~30 free pts for
    // emitting any transcript at all.
    throughput = Math.round((task.qualityScore / 100) * 30);
  } else {
    // analysis without judge (back-compat): scale on transcript
    // volume up to 30. Will be deprecated once every analysis task
    // has a qualityRubric.
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

  // Conformance (0): reserved slot — #295 emits live samples but
  // doesn't aggregate into summary.json yet. Default to 0 (neutral)
  // so it doesn't inflate scores. Restore to 10 when aggregation lands.
  const conformance = 0;

  // Hunk quality (10): derived from cascade efficiency. Higher =
  // fewer stale todos, more first-try commits. Directly measures
  // the system's primary throughput bottleneck (Monte Carlo, 2026-05-09).
  let hunkQuality = 5; // neutral default
  const board = summary.board ?? {};
  const counts = board.counts ?? {};
  const totalTodos = (counts.committed ?? 0) + (counts.stale ?? 0) + (counts.skipped ?? 0);
  if (totalTodos > 0) {
    const cascadeEfficiency = (counts.committed ?? 0) / totalTodos;
    if (cascadeEfficiency >= 0.95) hunkQuality = 10;
    else if (cascadeEfficiency >= 0.85) hunkQuality = 8;
    else if (cascadeEfficiency >= 0.70) hunkQuality = 5;
    else hunkQuality = 2;
  }

  const total = completion + throughput + efficiency + conformance + hunkQuality;
  return {
    total,
    components: { completion, throughput, efficiency, hunkQuality, conformance },
    notes: `${stopReason} · commits=${commits} · ${Math.round(wallS)}s · ${Math.round(tokPerMin)} tok/min · cascade=${((counts?.committed ?? 0) / Math.max(totalTodos, 1) * 100).toFixed(0)}%`,
  };
}

async function readSummary(clonePath) {
  // summary.json lives at the clone root. Best-effort — return null
  // if missing or unparseable.
  // 2026-05-07: Poll/retry to avoid race condition where summarize.json
  // is read before finalize has actually written the file.
  for (let i = 0; i < 5; i++) {
    try {
      if (!existsSync(path.join(clonePath, "summary.json"))) {
        await sleep(2000);
        continue;
      }
      const raw = readFileSync(path.join(clonePath, "summary.json"), "utf8");
      return JSON.parse(raw);
    } catch {
      await sleep(2000);
    }
  }
  return null;
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
  REPO = args.repo ?? "";
  const SWE_BENCH_DATASET = args["swe-bench-dataset"] ?? args.sweBenchDataset ?? "";
  const SWE_BENCH_TASK = args["swe-bench-task"] ?? args.sweBenchTask ?? "";
  const SWE_BENCH_LIMIT_RAW = args["swe-bench-limit"] ?? args.sweBenchLimit;
  const SWE_BENCH_LIMIT = SWE_BENCH_LIMIT_RAW !== undefined ? Number(SWE_BENCH_LIMIT_RAW) : null;
  const SWE_BENCH_DRY_RUN = args["swe-bench-dry-run"] === true || args.sweBenchDryRun === true;
  // --repo OR --fixture-dir OR --swe-bench-dataset is required; each
  // supplies its own per-attempt staging.
  if (!REPO && !args["fixture-dir"] && !args.fixtureDir && !SWE_BENCH_DATASET) {
    console.error("--repo=<github-url> OR --fixture-dir=<dir> OR --swe-bench-dataset=<path> is required");
    process.exit(2);
  }

  // SWE-Bench mode: load dataset, adapt to catalog entries, optionally
  // dry-run (print what would run + exit). Full execution requires
  // Docker isolation per the official SWE-Bench harness — until that
  // wiring lands (see eval/swe-bench/README.md), --swe-bench-dry-run
  // is the supported mode.
  if (SWE_BENCH_DATASET) {
    const { adaptSweBenchJsonl } = await import("./swe-bench/adapter.mjs");
    let datasetText;
    try {
      datasetText = readFileSync(SWE_BENCH_DATASET, "utf8");
    } catch (err) {
      console.error(`failed to read --swe-bench-dataset=${SWE_BENCH_DATASET}: ${err.message}`);
      process.exit(2);
    }
    const limit = Number.isFinite(SWE_BENCH_LIMIT) && SWE_BENCH_LIMIT > 0 ? SWE_BENCH_LIMIT : undefined;
    const { entries, errors } = adaptSweBenchJsonl(datasetText, limit !== undefined ? { limit } : {});
    let filtered = entries;
    if (SWE_BENCH_TASK) {
      filtered = entries.filter((e) => e.sweBenchInstanceId === SWE_BENCH_TASK);
      if (filtered.length === 0) {
        console.error(`--swe-bench-task=${SWE_BENCH_TASK} not found in dataset (${entries.length} tasks loaded)`);
        process.exit(2);
      }
    }
    const compatible = filtered.filter((e) => !e.skipReason);
    const skipped = filtered.filter((e) => e.skipReason);
    console.log(`SWE-Bench dataset: ${entries.length} tasks loaded, ${errors.length} parse errors`);
    if (SWE_BENCH_TASK) console.log(`  filtered to --swe-bench-task=${SWE_BENCH_TASK}: ${filtered.length} match(es)`);
    console.log(`  ${compatible.length} compatible, ${skipped.length} skipped (env-incompatible)`);
    console.log();
    if (SWE_BENCH_DRY_RUN) {
      console.log("DRY RUN — would execute:");
      for (const e of compatible.slice(0, 20)) {
        console.log(`  ${e.id}  (${e.title})`);
      }
      if (compatible.length > 20) console.log(`  ... and ${compatible.length - 20} more`);
      console.log();
      if (skipped.length > 0) {
        console.log("SKIPPED (env-incompatible):");
        for (const e of skipped.slice(0, 5)) {
          console.log(`  ${e.id}: ${e.skipReason?.slice(0, 80)}`);
        }
        if (skipped.length > 5) console.log(`  ... and ${skipped.length - 5} more`);
      }
      process.exit(0);
    }
    console.error(
      "SWE-Bench full execution mode requires Docker-based test isolation, which isn't wired yet.\n" +
        "Use --swe-bench-dry-run to preview which tasks would run, OR see eval/swe-bench/README.md for the Docker integration plan.",
    );
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
  FIXTURE_DIR = args["fixture-dir"] ?? args.fixtureDir ?? "";
  // Phase 7 of #314: multi-seed support. Default 1 (single attempt).
  // Scoreboard sweeps use 3–5 to reduce LLM-output noise. Capped at
  // 20 client-side so a typo can't authorize a 200-run accidental.
  const seedsRaw = Number(args.seeds ?? 1);
  SEEDS = Number.isFinite(seedsRaw) && seedsRaw >= 1 && seedsRaw <= 20 ? Math.floor(seedsRaw) : 1;
  MODEL_OVERRIDE = args.model ?? "";
  USE_LOCAL_OLLAMA = args.local === "true" || args.local === "1";
  const maxCostRaw = Number(args.maxCostUsd ?? args["max-cost-usd"] ?? 0);
  MAX_COST_USD = Number.isFinite(maxCostRaw) && maxCostRaw > 0 && maxCostRaw <= 100
    ? maxCostRaw
    : 0;
  MOA_PROPOSER_MODEL = args["moa-proposer-model"] ?? args.moaProposerModel ?? "";
  MOA_AGGREGATOR_MODEL = args["moa-aggregator-model"] ?? args.moaAggregatorModel ?? "";
  const aggCountRaw = Number(args["moa-aggregator-count"] ?? args.moaAggregatorCount ?? 0);
  MOA_AGGREGATOR_COUNT = Number.isFinite(aggCountRaw) && aggCountRaw >= 1 && aggCountRaw <= 3
    ? Math.floor(aggCountRaw)
    : 0;
  // 2026-05-02 (lever #2): quality-judge config.
  QUALITY_JUDGE_OLLAMA_URL =
    args["quality-judge-ollama-url"] ?? args.qualityJudgeOllamaUrl ?? QUALITY_JUDGE_OLLAMA_URL;
  QUALITY_JUDGE_MODEL =
    args["quality-judge-model"] ?? args.qualityJudgeModel ?? "";
  // 2026-05-02 (matrix row #7): multi-judge inter-rater config.
  const judgesArg = args["quality-judge-models"] ?? args.qualityJudgeModels ?? "";
  QUALITY_JUDGE_MODELS = typeof judgesArg === "string" && judgesArg.length > 0
    ? judgesArg.split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  if (MODEL_OVERRIDE) console.log(`[eval] model override: ${MODEL_OVERRIDE}`);
  if (MAX_COST_USD > 0) console.log(`[eval] per-attempt cost cap: $${MAX_COST_USD}`);
  if (MOA_PROPOSER_MODEL) console.log(`[eval] MoA proposer model: ${MOA_PROPOSER_MODEL}`);
  if (MOA_AGGREGATOR_MODEL) console.log(`[eval] MoA aggregator model: ${MOA_AGGREGATOR_MODEL}`);
  if (MOA_AGGREGATOR_COUNT > 0) console.log(`[eval] MoA aggregator count: ${MOA_AGGREGATOR_COUNT}`);

  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(path.join(OUT_DIR, "per-run"), { recursive: true });
  mkdirSync(PARENT_PATH, { recursive: true });

  const catalog = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
  const tasks = catalog.tasks.filter(
    (t) => !ONLY_TASKS || ONLY_TASKS.includes(t.id),
  );
  logFile = path.join(OUT_DIR, "progress.log");

  log(`==== eval harness — ${tasks.length} tasks against ${REPO} (seeds=${SEEDS}) ====`);
  log(`Catalog: ${CATALOG_PATH}`);
  log(`Output:  ${OUT_DIR}`);

  const results = [];
  for (const task of tasks) {
    const presets = (task.presets ?? []).filter(
      (p) => !ONLY_PRESETS || ONLY_PRESETS.includes(p),
    );
    log(`---- task ${task.id} (${presets.length} presets × ${SEEDS} seeds) ----`);
    for (const preset of presets) {
      for (let seed = 1; seed <= SEEDS; seed++) {
        log(`  preset=${preset} seed=${seed}/${SEEDS}`);
        const startTs = Date.now();
        const payload = buildPayload(task, preset);
        // Phase 7+ (#314): fixture-mode override. When the task has a
        // `fixture: "<name>"` field AND --fixture-dir is set, stage
        // the fixture as a local file:// repo per attempt. The swarm
        // sees a freshly-init'd clone with one seed commit; verify
        // runs after the swarm finishes.
        let stage = null;
        if (task.fixture && FIXTURE_DIR) {
          const fixtureSrc = path.join(FIXTURE_DIR, task.fixture);
          if (!existsSync(fixtureSrc)) {
            log(`    fixture missing: ${fixtureSrc}`);
            results.push({
              taskId: task.id, preset, seed, ok: false, reason: `fixture missing: ${fixtureSrc}`,
              score: { total: 0, components: {}, notes: "fixture_missing" },
              wallS: 0, ts: startTs,
            });
            continue;
          }
          try {
            stage = stageFixture(fixtureSrc, task.fixture, `${preset}-${seed}-${startTs}`);
            payload.repoUrl = stage.fileUrl;
            log(`    staged fixture → ${stage.stagePath}`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log(`    stage FAILED: ${msg}`);
            results.push({
              taskId: task.id, preset, seed, ok: false, reason: `stage failed: ${msg}`,
              score: { total: 0, components: {}, notes: "stage_failed" },
              wallS: 0, ts: startTs,
            });
            continue;
          }
        }
        const fired = await fireStart(payload);
        if (!fired.ok) {
          log(`    start FAILED: ${fired.reason}`);
          results.push({
            taskId: task.id, preset, seed, ok: false, reason: fired.reason,
            score: { total: 0, components: {}, notes: "start_failed" },
            wallS: 0, ts: startTs,
          });
          await sleep(5000);
          continue;
        }
        const safetyMs = (task.wallClockCapMs ?? 600_000) + 120_000;
        const final = await waitUntilIdle(safetyMs);
        const wallS = Math.round((Date.now() - startTs) / 1000);
        // derive clonePath: in fixture mode, swarm clones from the
        // file:// URL into PARENT_PATH/<basename-of-fileurl>; basename
        // is the staged dir's leaf, which is `<fixture>__<attemptId>`
        // since git doesn't strip the path at clone time the same way
        // it strips remote URLs. Easiest: use the stage path directly.
        let derivedClone;
        if (stage) {
          // Swarm.deriveCloneDir(file://, parent) → parent/<basename>;
          // basename of file://<stagePath> is the trailing dir name.
          derivedClone = path.join(PARENT_PATH, path.basename(stage.stagePath));
        } else {
          const repoName =
            REPO.replace(/\.git$/, "")
              .split("/")
              .filter(Boolean)
              .pop() ?? "repo";
          derivedClone = path.join(PARENT_PATH, repoName);
        }
        const summary = await readSummary(derivedClone);
        // 2026-05-02 (lever #2 + matrix row #7): for non-fixture
        // analysis tasks with a qualityRubric, run the LLM judge
        // before scoring so scoreRun can use the judge's 0-100 score
        // instead of the lazy transcript-volume proxy. When
        // --quality-judge-models is set (2+ models), use multi-judge
        // inter-rater for agreement scoring; otherwise single-judge.
        // Failure is silent — null judgeResult falls back to the
        // legacy throughput formula.
        let judgeResult = null;
        let multiJudgeResult = null;
        if (!stage && task.qualityRubric && summary) {
          try {
            if (QUALITY_JUDGE_MODELS.length >= 2) {
              multiJudgeResult = await multiJudgeAnalysisRun({
                task,
                summary,
                ollamaBaseUrl: QUALITY_JUDGE_OLLAMA_URL,
                models: QUALITY_JUDGE_MODELS,
              });
              if (multiJudgeResult) {
                judgeResult = { score: multiJudgeResult.meanScore, rationale: `multi-judge mean (${multiJudgeResult.judgeCount} judges)` };
                log(
                  `    multi-judge: mean=${multiJudgeResult.meanScore} spread=${multiJudgeResult.spread} agreement=${multiJudgeResult.agreement} (${multiJudgeResult.perJudge.map((j) => `${j.model}:${j.score}`).join(", ")})`,
                );
              } else {
                log(`    multi-judge: all judges failed`);
              }
            } else {
              judgeResult = await judgeAnalysisRun({
                task,
                summary,
                ollamaBaseUrl: QUALITY_JUDGE_OLLAMA_URL,
                ...(QUALITY_JUDGE_MODEL ? { model: QUALITY_JUDGE_MODEL } : {}),
              });
              if (judgeResult) {
                log(`    judge: score=${judgeResult.score} (${judgeResult.rationale})`);
              } else {
                log(`    judge: skipped (no parseable response)`);
              }
            }
          } catch (err) {
            log(`    judge: failed — ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        // Pass judge score into scoreRun via task.qualityScore (mutated
        // for THIS attempt only; intentionally not on the catalog).
        const taskWithJudge = judgeResult
          ? { ...task, qualityScore: judgeResult.score }
          : task;
        const score = scoreRun(summary, taskWithJudge);
        // Phase 7+ (#314): if this was a fixture run, exec verify.mjs
        // and add a +50 bonus on pass (or zero out completion on fail).
        // Verify runs in the SWARM's clone path (where edits landed),
        // not the original fixture src — so the test sees real changes.
        let verify = null;
        if (stage) {
          verify = runFixtureVerify(derivedClone);
          if (verify.ok) {
            score.total += 50;
            score.notes = `${score.notes} · verify=PASS`;
          } else {
            score.total = Math.max(0, score.total - 30);
            score.notes = `${score.notes} · verify=FAIL`;
          }
        }
        log(`    done — phase=${final.phase} score=${score.total} (${score.notes})`);
        if (summary) {
          try {
            writeFileSync(
              path.join(OUT_DIR, "per-run", `${task.id}__${preset}__seed${seed}__${startTs}.json`),
              JSON.stringify(summary, null, 2),
            );
          } catch {
            // ignore
          }
        }
        results.push({
          taskId: task.id, preset, seed, ok: final.phase !== "timeout",
          phase: final.phase, runId: fired.runId, wallS, ts: startTs, score,
          ...(verify ? { verify: { ok: verify.ok, output: verify.output } } : {}),
          ...(judgeResult ? { judge: judgeResult } : {}),
          ...(multiJudgeResult ? { multiJudge: multiJudgeResult } : {}),
          ...(stage ? { stagePath: stage.stagePath } : {}),
        });
        // Persist results after every attempt so a partial run still has data
        writeFileSync(path.join(OUT_DIR, "results.json"), JSON.stringify(results, null, 2));
        await sleep(8000);
      }
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
// 2026-05-01: cross-platform guard — `file://${process.argv[1]}` doesn't
// match `import.meta.url` on Windows (backslashes + triple-slash). Use
// pathToFileURL so the comparison is reliable on every platform.
import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
