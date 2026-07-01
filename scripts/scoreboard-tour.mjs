#!/usr/bin/env node
// scripts/scoreboard-tour.mjs — 5-config × 1-fixture smoke test for the
// scoreboard publishing plan. Catches "preset not accepted" / "model not
// pulled" / "MoA flags not wired" / etc. BEFORE you kick the 150-attempt
// sweep that takes 6-10 hours.
//
// What it does:
//   - Loops over 4 configs (A, C, D, E — Claude config B opt-in)
//   - For each config, kicks `node eval/run-eval.mjs` against ONE fixture
//     (fix-off-by-one) with seeds=1
//   - Captures pass/fail per config from results.json
//   - Reports a summary table at the end
//   - Exits 0 when every config produced SOME result (pass or fail) — only
//     "harness exploded mid-attempt" counts as failure for tour purposes.
//     Per-config verify failures are EXPECTED for some configs and aren't
//     a tour-failure — they're real signal.
//
// Usage:
//   node scripts/scoreboard-tour.mjs                         # 4 free Ollama configs (~15 min)
//   node scripts/scoreboard-tour.mjs --with-claude           # +Claude config B (~$0.50, +1 min)
//   node scripts/scoreboard-tour.mjs --task=fixture-add-null-guard  # different fixture
//   node scripts/scoreboard-tour.mjs --out=runs/_tour-2026-05-02    # different out dir
//
// Pre-reqs:
//   - dev server up at :8243 (npm run dev)
//   - Ollama models pulled: glm-5.1:cloud, gemma4:31b-cloud, deepseek-v4-flash:cloud
//   - .env has ANTHROPIC_API_KEY (only when --with-claude)

import { spawn } from "node:child_process";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

// ----- arg parsing ---------------------------------------------------------
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ""), true];
  }),
);
const TASK = args.task ?? "fixture-fix-off-by-one";
const WITH_CLAUDE = args["with-claude"] === true || args.withClaude === true;
const PREFLIGHT_ONLY = args["preflight-only"] === true || args.preflightOnly === true;
const OUT_BASE =
  args.out ??
  path.join("runs", "_tour", new Date().toISOString().replace(/[:.]/g, "-"));

// ----- 5 config definitions -----------------------------------------------
const CONFIGS = [
  {
    id: "A",
    label: "Solo Ollama baseline",
    paid: false,
    flags: ["--presets=baseline", "--model=glm-5.1:cloud"],
  },
  {
    id: "B",
    label: "Solo Claude baseline",
    paid: true,
    flags: [
      "--presets=baseline",
      "--model=anthropic/claude-sonnet-4-6",
      "--maxCostUsd=1.00",
    ],
  },
  {
    id: "C",
    label: "Blackboard Ollama (default per-role models)",
    paid: false,
    flags: ["--presets=blackboard"],
  },
  {
    id: "D",
    label: "MoA homogeneous (glm-5.1 both layers)",
    paid: false,
    flags: ["--presets=moa", "--model=glm-5.1:cloud"],
  },
  {
    id: "E",
    label: "MoA heterogeneous (gemma4 + nemotron) — HEADLINE CLAIM",
    paid: false,
    flags: [
      "--presets=moa",
      "--moa-proposer-model=gemma4:31b-cloud",
      "--moa-aggregator-model=deepseek-v4-flash:cloud",
    ],
  },
];

// ----- helpers ------------------------------------------------------------
function run(cmd, cmdArgs, label) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(cmd, cmdArgs, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (err) => {
      resolve({ exitCode: -1, stdout, stderr: stderr + String(err.message), durationMs: Date.now() - t0 });
    });
    child.on("close", (code) => {
      void label;
      resolve({ exitCode: code ?? 0, stdout, stderr, durationMs: Date.now() - t0 });
    });
  });
}

async function checkPrereqs() {
  const errors = [];
  // Dev server up?
  try {
    const resp = await fetch("http://localhost:8243/api/providers");
    if (!resp.ok) errors.push(`dev server returned HTTP ${resp.status} on /api/providers`);
    else {
      const body = await resp.json();
      if (!body.ollama?.hasKey) errors.push("ollama not available (check Ollama is running on :11434)");
      if (WITH_CLAUDE && !body.anthropic?.hasKey) {
        errors.push("--with-claude set but ANTHROPIC_API_KEY not loaded by the server (set in .env, restart npm run dev)");
      }
    }
  } catch (err) {
    errors.push(`dev server unreachable at localhost:8243: ${err.message}`);
  }
  // Catalog has the task?
  try {
    const cat = JSON.parse(readFileSync("eval/catalog.json", "utf8"));
    const t = cat.tasks.find((task) => task.id === TASK);
    if (!t) errors.push(`task '${TASK}' not in eval/catalog.json`);
    else if (!t.fixture) errors.push(`task '${TASK}' has no fixture: field — tour requires fixture-mode tasks`);
  } catch (err) {
    errors.push(`failed to read eval/catalog.json: ${err.message}`);
  }
  return errors;
}

function readResultsJson(outDir) {
  const p = path.join(outDir, "results.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

// ----- main ---------------------------------------------------------------
async function main() {
  console.log(`scoreboard-tour: ${TASK} × ${WITH_CLAUDE ? CONFIGS.length : CONFIGS.length - 1} configs`);
  console.log(`output base: ${OUT_BASE}`);
  console.log();

  // Pre-flight
  console.log("Pre-flight checks...");
  const errors = await checkPrereqs();
  if (errors.length > 0) {
    console.error("PRE-FLIGHT FAILED:");
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(2);
  }
  console.log("  OK");
  console.log();

  if (PREFLIGHT_ONLY) {
    console.log("--preflight-only set; skipping the actual config runs.");
    console.log("Catalog tasks moa-enabled:");
    try {
      const cat = JSON.parse(readFileSync("eval/catalog.json", "utf8"));
      for (const t of cat.tasks.filter((t) => t.fixture)) {
        const moaIn = (t.presets ?? []).includes("moa");
        console.log(`  ${moaIn ? "✓" : "✗"} ${t.id} · presets=${(t.presets ?? []).join(",")}`);
      }
    } catch {
      console.log("  (catalog read failed)");
    }
    return;
  }

  mkdirSync(OUT_BASE, { recursive: true });
  const summary = [];

  for (const cfg of CONFIGS) {
    if (cfg.paid && !WITH_CLAUDE) {
      console.log(`SKIP ${cfg.id} ${cfg.label} (--with-claude not set)`);
      summary.push({ id: cfg.id, label: cfg.label, skipped: true });
      continue;
    }
    const cfgOutDir = path.join(OUT_BASE, `cfg-${cfg.id.toLowerCase()}`);
    const cmdArgs = [
      "eval/run-eval.mjs",
      "--fixture-dir=eval/fixtures",
      `--only=${TASK}`,
      "--seeds=1",
      `--out=${cfgOutDir}`,
      ...cfg.flags,
    ];
    console.log(`---- ${cfg.id} ${cfg.label} ----`);
    console.log(`     ${cmdArgs.join(" ")}`);
    const result = await run("node", cmdArgs, cfg.id);
    const wallS = Math.round(result.durationMs / 1000);
    const results = readResultsJson(cfgOutDir);
    const attempt = Array.isArray(results) ? results[0] : null;
    const verify = attempt?.verify?.ok;
    const score = attempt?.score?.total;
    const phase = attempt?.phase;
    const harness = result.exitCode === 0 ? "ok" : `FAILED (exit ${result.exitCode})`;
    console.log(`     result: harness=${harness} phase=${phase ?? "?"} score=${score ?? "?"} verify=${verify === true ? "PASS" : verify === false ? "FAIL" : "?"} wall=${wallS}s`);
    summary.push({
      id: cfg.id,
      label: cfg.label,
      harness,
      phase,
      score,
      verify,
      wallS,
      outDir: cfgOutDir,
    });
    console.log();
  }

  // Summary table
  console.log("====================================================================");
  console.log("Tour summary");
  console.log("====================================================================");
  console.log(
    `${"id".padEnd(4)} ${"harness".padEnd(8)} ${"phase".padEnd(11)} ${"verify".padEnd(7)} ${"score".padEnd(6)} wall  label`,
  );
  for (const r of summary) {
    if (r.skipped) {
      console.log(`${r.id.padEnd(4)} ${"SKIP".padEnd(8)} ${"-".padEnd(11)} ${"-".padEnd(7)} ${"-".padEnd(6)} ${"-".padEnd(5)} ${r.label}`);
      continue;
    }
    const verifyStr = r.verify === true ? "PASS" : r.verify === false ? "FAIL" : "-";
    console.log(
      `${r.id.padEnd(4)} ${r.harness.padEnd(8)} ${(r.phase ?? "?").padEnd(11)} ${verifyStr.padEnd(7)} ${String(r.score ?? "?").padEnd(6)} ${(r.wallS + "s").padEnd(5)} ${r.label}`,
    );
  }
  console.log();

  const harnessFailed = summary.filter((r) => !r.skipped && r.harness !== "ok");
  if (harnessFailed.length > 0) {
    console.error(
      `HARNESS FAILURES: ${harnessFailed.length} config(s) didn't produce a result. Tour fails.`,
    );
    for (const r of harnessFailed) console.error(`  - ${r.id} ${r.label}: ${r.harness}`);
    process.exit(1);
  }

  console.log("Tour OK — all configs produced results. Per-config pass/fail is real signal,");
  console.log("not a harness problem. Ready to kick the full sweep.");
  console.log();
  console.log(`Results in: ${OUT_BASE}`);
}

main().catch((err) => {
  console.error("tour failed:", err);
  process.exit(1);
});
