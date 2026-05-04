#!/usr/bin/env node
// Pre-publishing smoke test for the scoreboard sweep.
//
// Runs all 5 scoreboard configs against ONE fixture, single-seed, so
// wiring breakage surfaces in ~10 minutes instead of mid-sweep at hour
// 4. Catches:
//   - "moa preset isn't accepted by route" / cfg-shape regressions
//   - Ollama models not pulled (glm-5.1 / gemma4 / nemotron)
//   - ANTHROPIC_API_KEY missing for Config B
//   - per-layer MoA model flags not threading correctly
//
// Cost: ~$1 for the Anthropic config (skip with --skip-paid). Other
// configs are Ollama-only ($0). Wall-clock: ~10–20 min total.
//
// Usage:
//   node eval/tour-smoke.mjs                          # all 5 configs
//   node eval/tour-smoke.mjs --skip-paid              # skip Config B
//   node eval/tour-smoke.mjs --fixture=add-null-guard # custom fixture
//   node eval/tour-smoke.mjs --server=http://...      # custom server
//
// On success: prints "✓ tour-smoke passed (5/5 configs)" — the
// scoreboard sweep is safe to kick. On failure: prints which config
// failed + the error so you can fix before the multi-hour sweep.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

function parseArgs(argv) {
  const args = { skipPaid: false, fixture: "fix-off-by-one", server: "http://127.0.0.1:8243" };
  for (const a of argv.slice(2)) {
    if (a === "--skip-paid") args.skipPaid = true;
    else if (a.startsWith("--fixture=")) args.fixture = a.slice("--fixture=".length);
    else if (a.startsWith("--server=")) args.server = a.slice("--server=".length);
  }
  return args;
}

// Each config maps directly onto the published-plan's matrix row.
function buildConfigs(fixtureId, skipPaid) {
  const fixtureTaskId = `fixture-${fixtureId}`;
  const out = [
    {
      label: "A. Solo Ollama baseline",
      preset: "baseline",
      taskId: fixtureTaskId,
      extra: ["--model=glm-5.1:cloud"],
    },
    {
      label: "C. Blackboard Ollama",
      preset: "blackboard",
      taskId: fixtureTaskId,
      extra: [],
    },
    {
      label: "D. MoA homogeneous",
      preset: "moa",
      taskId: fixtureTaskId,
      extra: ["--model=glm-5.1:cloud"],
    },
    {
      label: "E. MoA heterogeneous (headline)",
      preset: "moa",
      taskId: fixtureTaskId,
      extra: [
        "--moa-proposer-model=gemma4:31b-cloud",
        "--moa-aggregator-model=nemotron-3-super:cloud",
      ],
    },
  ];
  if (!skipPaid) {
    out.splice(1, 0, {
      label: "B. Solo Claude baseline",
      preset: "baseline",
      taskId: fixtureTaskId,
      extra: ["--model=anthropic/claude-sonnet-4-6", "--maxCostUsd=1.00"],
    });
  }
  return out;
}

function runOne(config, fixtureDir, server) {
  const out = mkdtempSync(join(tmpdir(), `tour-smoke-${config.preset}-`));
  const args = [
    "eval/run-eval.mjs",
    `--fixture-dir=${fixtureDir}`,
    `--only=${config.taskId}`,
    `--presets=${config.preset}`,
    "--seeds=1",
    `--out=${out}`,
    `--server=${server}`,
    ...config.extra,
  ];
  const start = Date.now();
  const r = spawnSync(process.execPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30 * 60_000, // 30 min per config
  });
  const elapsedSec = Math.round((Date.now() - start) / 1000);
  const stdout = r.stdout?.toString() ?? "";
  const stderr = r.stderr?.toString() ?? "";
  // Cleanup the temp out dir; the smoke test doesn't need to keep results
  try {
    rmSync(out, { recursive: true, force: true });
  } catch {
    // best-effort
  }
  return {
    ok: r.status === 0,
    elapsedSec,
    code: r.status,
    stdout: stdout.slice(-2000),
    stderr: stderr.slice(-2000),
  };
}

function main() {
  const args = parseArgs(process.argv);
  const fixtureDir = "eval/fixtures";
  if (!existsSync(fixtureDir)) {
    console.error(`Fixture dir not found: ${fixtureDir}`);
    process.exit(2);
  }
  const fixturePath = join(fixtureDir, args.fixture);
  if (!existsSync(fixturePath)) {
    console.error(`Fixture not found: ${fixturePath}`);
    console.error("Available fixtures:");
    for (const name of readdirSync(fixtureDir)) {
      if (statSync(join(fixtureDir, name)).isDirectory()) {
        console.error(`  ${name}`);
      }
    }
    process.exit(2);
  }
  const configs = buildConfigs(args.fixture, args.skipPaid);
  console.log(`[tour-smoke] fixture=${args.fixture} configs=${configs.length} server=${args.server}`);
  if (args.skipPaid) console.log("[tour-smoke] --skip-paid: Config B (Anthropic Claude) skipped");

  const results = [];
  let passed = 0;
  for (const cfg of configs) {
    process.stdout.write(`[tour-smoke] ${cfg.label} (${cfg.preset}) … `);
    const r = runOne(cfg, fixtureDir, args.server);
    results.push({ cfg, r });
    if (r.ok) {
      passed += 1;
      console.log(`✓ ${r.elapsedSec}s`);
    } else {
      console.log(`✗ exit=${r.code} (${r.elapsedSec}s)`);
    }
  }

  console.log("");
  console.log(`[tour-smoke] ${passed}/${configs.length} configs passed`);

  if (passed === configs.length) {
    console.log("✓ tour-smoke passed — scoreboard sweep is safe to kick");
    return 0;
  }

  // Print failure diagnostics for any failed config
  console.log("");
  console.log("=== Failure diagnostics ===");
  for (const { cfg, r } of results) {
    if (r.ok) continue;
    console.log("");
    console.log(`✗ ${cfg.label} (${cfg.preset}): exit=${r.code}`);
    if (r.stderr) {
      console.log("--- stderr (last 2000 chars) ---");
      console.log(r.stderr);
    }
    if (r.stdout) {
      console.log("--- stdout (last 2000 chars) ---");
      console.log(r.stdout);
    }
  }
  return 1;
}

// Cross-platform CLI invocation guard (Windows backslashes break the
// bare `file://${argv[1]}` template). Same pattern aggregate.mjs uses.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
