#!/usr/bin/env node
// Overnight sweep: tests every swarm preset against opencode_swarm
// to validate they all produce meaningful work-output post R1-R17.
//
// Three modes (run sequentially when --mode=all):
//   A  single ambitious-framing directive across 10 presets
//   B  two-pass: same directive, then "build on prior pass" pass 2
//   C  per-preset tuned directives that play to each preset's strengths
//
// Per-preset cap defaults to 20 min wall-clock. With --mode=all the
// total ceiling is 10*(20 + 2*20 + 20) = 800 min ≈ 13.3 hr. Sequential.
//
// Output: structured progress log + per-run summary captures + an
// aggregate JSON. The progress log emits ONE line per event boundary
// so an external Monitor can tail it without reading transcripts.

import { mkdirSync, writeFileSync, appendFileSync, existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";

const SERVER = process.env.SWEEP_SERVER ?? "http://127.0.0.1:8243";
const PARENT_BASE = process.env.SWEEP_PARENT ?? "C:\\Users\\kevin\\Workspace";
const REPO = process.env.SWEEP_REPO ?? "https://github.com/kevinkicho/opencode_swarm";
const POLL_MS = Number(process.env.SWEEP_POLL_MS ?? 30_000);
const WALLCLOCK_CAP_MS = Number(process.env.SWEEP_WALL_MS ?? 20 * 60_000);
const MODE = process.env.SWEEP_MODE ?? process.argv[2] ?? "all"; // A|B|C|all

const ALL_SWARM_PRESETS = [
  "blackboard",
  "round-robin",
  "role-diff",
  "council",
  "orchestrator-worker",
  "orchestrator-worker-deep",
  "debate-judge",
  "map-reduce",
  "stigmergy",
  "moa",
];

// SWEEP_ONLY_PRESETS=blackboard,council  → run just those two.
// Useful for resuming after a known-bug fix without re-running every
// preset that already succeeded.
const onlyEnv = (process.env.SWEEP_ONLY_PRESETS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const SWARM_PRESETS = onlyEnv.length > 0
  ? ALL_SWARM_PRESETS.filter((p) => onlyEnv.includes(p))
  : ALL_SWARM_PRESETS;

// 2026-05-04: per-preset Ollama Cloud model assignments. All `:cloud`
// suffix — local machine can't host models, everything routes via the
// local Ollama desktop app to ollama.com on the user's subscription.
//
// Updated post-Bug#1 (2026-05-04 01:30): glm-5.1:cloud demoted from
// PLANNER to a fallback. The blackboard A run (commit 6f950a48) showed
// glm-5.1 emitting prose ("I need to ...") and XML pseudo-tool-calls
// (`<list path...>`) when asked for the second JSON envelope (todo
// batch). Same #231 finding from memory. Nemotron handles repeated
// structured JSON cleanly.
//
//   PLANNER  nemotron-3-super:cloud  — JSON-stable structured output
//   WORKER   gemma4:31b-cloud        — fast + code-edit-friendly
//   SYNTH    nemotron-3-super:cloud  — cross-criterion synthesis
//   FALLBACK glm-5.1:cloud           — used in failover chain only
const PLANNER = "nemotron-3-super:cloud";
const WORKER = "gemma4:31b-cloud";
const SYNTH = "nemotron-3-super:cloud";
const PER_PRESET_MODELS = {
  // Blackboard splits per-role (route accepts plannerModel/
  // workerModel/auditorModel — all three are honored at the runner).
  blackboard: { plannerModel: PLANNER, workerModel: WORKER, auditorModel: SYNTH },
  // Discussion presets — pick the model whose strength matches the
  // preset's dominant workload.
  "round-robin": { model: SYNTH }, // disposition rotation → synthesis-heavy
  "role-diff": { model: SYNTH }, // multi-perspective deliverable
  council: { model: PLANNER }, // positional argumentation
  "orchestrator-worker": { model: PLANNER }, // decomposition + delegation
  "orchestrator-worker-deep": { model: PLANNER }, // tiered decomposition
  "debate-judge": { model: PLANNER }, // PRO/CON argumentation
  "map-reduce": { model: WORKER }, // per-section read-walks (volume)
  stigmergy: { model: WORKER }, // annotation walking (volume)
  moa: { model: SYNTH, moaProposerModel: SYNTH, moaAggregatorModel: SYNTH },
};

const DIRECTIVE_AMBITIOUS = [
  "Audit this codebase's README.md against its current implementation.",
  "For each feature claimed, verify it exists and works as described, OR identify gaps with file:line evidence.",
  "Use the bash tool to actually run the repo's existing tests as supporting evidence:",
  "`npm test`, `npx playwright test --reporter=line`, `npx vitest run`, `npm run typecheck`, etc.",
  "Capture screenshots via Playwright when verifying a UI claim (the repo has playwright.config.ts; use `npx playwright screenshot` if needed).",
  "Cite test output, file:line refs, and screenshot paths as your evidence — not vibes.",
  "Then for at least 3 gaps with clear fixes, propose a concrete remediation.",
  "If your preset can write files: COMMIT the fixes (one commit per fix, small + atomic).",
  "If your preset cannot write files: produce the patches inline in your synthesis, formatted as unified diffs.",
  "Land your final audit + fixes report as README-audit.md when your preset supports file writes.",
].join(" ");

const DIRECTIVE_PASS2_IMPROVE = [
  "A prior swarm produced an audit + initial fixes on this clone (check `git log --oneline` for prior commits, plus any *-audit.md or deliverable.md files).",
  "Read what was done, then EXTEND it: find at least 3 more concrete gaps the prior pass missed, fix them, and update the audit document with your additions.",
  "Run the repo's tests via bash (`npm test`, `npx playwright test`, `npx vitest run`) as evidence, and capture screenshots via Playwright for any UI-relevant claim.",
  "Be more ambitious than the prior pass — escalate scope, not retread the same ground.",
].join(" ");

// Tuned-directive shared tail: every preset gets the same "use bash
// to verify with the repo's tests + screenshots" footer so Mode C
// also benefits from the verification asks.
const VERIFY_TAIL = " Use bash to run the repo's tests (`npm test`, `npx playwright test --reporter=line`, `npx vitest run`) and capture screenshots via Playwright when relevant. Cite test output + file:line refs as evidence.";

const TUNED_DIRECTIVES = {
  blackboard:
    "Audit README + land 5+ commits fixing the gaps you find. Track each fix as its own todo + commit. Use the ambition ratchet — after the initial fixes, climb to a Tier 2 contract that goes deeper." + VERIFY_TAIL,
  "round-robin":
    "Critic challenges each README claim. Synthesizer drafts a corrected README. Gap-finder lists missing features. Builder produces a deliverable.md with the corrected README + a fix list." + VERIFY_TAIL,
  "role-diff":
    "Researcher maps repo structure. Designer drafts a corrected README architecture. Implementer writes the patches. Tester proposes verification. Reviewer critiques. Documenter produces deliverable.md." + VERIFY_TAIL,
  council:
    "Each agent commits to a position on what the README SHOULD claim, given the actual code. Reconcile to a final unified position with a Minority report listing dissenting facts." + VERIFY_TAIL,
  "orchestrator-worker":
    "Decompose the audit into per-section subtasks (Architecture, Setup, Features, Limitations). Delegate to workers. Synthesize their reports into a corrected README outline." + VERIFY_TAIL,
  "orchestrator-worker-deep":
    "3-tier audit: orchestrator partitions README into top-level claims; mid-leads each take a domain (architecture/build/api); workers verify specific claims. Synthesize bottom-up." + VERIFY_TAIL,
  "debate-judge":
    "PRO argues 'README is accurate enough to ship.' CON argues 'README has material gaps that mislead users.' Judge produces a verdict, evidence list, and concrete remediation plan." + VERIFY_TAIL,
  "map-reduce":
    "Each mapper takes one README section + reads the code it references. Reducer aggregates findings into a unified gap list with severity ranking." + VERIFY_TAIL,
  stigmergy:
    "Walk the repo with the README as the map. Leave pheromone annotations on every file with a claim ↔ code mismatch. Plateau triggers a synthesis report of the strongest trails." + VERIFY_TAIL,
  moa:
    "5 proposers each draft an improved README from scratch (peer-hidden). Aggregator synthesizes the strongest version, citing where each proposer's draft contributed." + VERIFY_TAIL,
};

const TS = new Date().toISOString().replace(/[:.]/g, "-");
const OUT_DIR = path.join("runs", "_sweep", `all-presets-${TS}`);
mkdirSync(OUT_DIR, { recursive: true });
const LOG_PATH = path.join(OUT_DIR, "progress.log");
const RESULTS_PATH = path.join(OUT_DIR, "results.json");

const results = [];

function logLine(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  appendFileSync(LOG_PATH, stamped + "\n");
  console.log(stamped);
}

async function fetchJson(url, init) {
  const r = await fetch(url, init);
  const ct = r.headers.get("content-type") ?? "";
  const body = ct.includes("application/json") ? await r.json() : await r.text();
  return { ok: r.ok, status: r.status, body };
}

function cleanParentPathPreClone(parentPath) {
  // Workaround for a bug where RunStatePersister writes
  // <localPath>/run-state.json BEFORE RepoService clones, which then
  // makes RepoService refuse the clone ("not empty + not a git repo").
  // For mode-B pass-2 we WANT the path to persist (pass 1's commits
  // are what pass 2 reads); the caller skips this for those calls.
  const repoBase = REPO.split("/").pop().replace(/\.git$/, "");
  const cloneDir = path.join(parentPath, repoBase);
  // Use Windows-side rmdir since the dir lives on /mnt/c (WSL rm
  // sometimes fails with EPERM on dirs Windows still has open).
  try {
    const winPath = cloneDir.replace(/\//g, "\\");
    execSync(`cmd.exe /c "if exist \"${winPath}\" rmdir /s /q \"${winPath}\""`, {
      stdio: "ignore",
    });
  } catch { /* best-effort */ }
}

async function startRun({ preset, parentPath, directive, agentCount, rounds, freshClone = true }) {
  if (freshClone) cleanParentPathPreClone(parentPath);
  const modelOverrides = PER_PRESET_MODELS[preset] ?? {};
  const payload = {
    repoUrl: REPO,
    parentPath,
    preset,
    agentCount,
    rounds,
    userDirective: directive,
    wallClockCapMs: WALLCLOCK_CAP_MS,
    ...modelOverrides,
  };
  const res = await fetchJson(`${SERVER}/api/swarm/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`/start http=${res.status} body=${JSON.stringify(res.body).slice(0, 300)}`);
  }
  return res.body?.status?.runId ?? null;
}

async function pollUntilTerminal(runId) {
  const TERMINAL = new Set(["completed", "failed", "stopped"]);
  const start = Date.now();
  let lastPhase = "";
  while (true) {
    let snapshot;
    try {
      const r = await fetchJson(`${SERVER}/api/swarm/status`);
      snapshot = r.ok ? r.body : null;
    } catch {
      snapshot = null;
    }
    const phase = snapshot?.phase ?? "(unknown)";
    if (phase !== lastPhase) {
      logLine(`  phase=${phase} runId=${runId} elapsedS=${((Date.now() - start) / 1000).toFixed(0)}`);
      lastPhase = phase;
    }
    if (TERMINAL.has(phase)) return { snapshot, durationMs: Date.now() - start };
    if (Date.now() - start > WALLCLOCK_CAP_MS + 5 * 60_000) {
      logLine(`  WATCHDOG: poll timeout for runId=${runId} — abandoning`);
      try {
        await fetchJson(`${SERVER}/api/swarm/stop`, { method: "POST" });
      } catch { /* */ }
      return { snapshot, durationMs: Date.now() - start, abandoned: true };
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

function loadSummary(parentPath) {
  // The summary lives at <parentPath>/<repo-basename>/summary.json (or
  // summary-<iso>.json for dated snapshots). Try the canonical name
  // first, then fall back to the most recent *.summary.json sibling.
  const repoBase = REPO.split("/").pop().replace(/\.git$/, "");
  const repoDir = path.join(parentPath, repoBase);
  const canonical = path.join(repoDir, "summary.json");
  try {
    return JSON.parse(readFileSync(canonical, "utf8"));
  } catch {
    // Fall back to summary-<iso>.json (dated snapshot).
    try {
      const files = require("node:fs").readdirSync(repoDir).filter((f) => f.endsWith(".summary.json"));
      if (files.length > 0) {
        files.sort(); // iso-dates sort lexicographically = chronologically
        return JSON.parse(readFileSync(path.join(repoDir, files[files.length - 1]), "utf8"));
      }
    } catch { /* dir may not exist */ }
    return null;
  }
}
}

// Race condition: pollUntilTerminal() returns when the API reports
// the run is terminal, but the server may still be finalizing
// summary.json (writing commits, health score, etc.). The file exists
// but fields are zero/incomplete. Retry for up to 10s with 500ms
// backoff until we see non-zero data or the retry budget is spent.
async function loadSummaryWithRetry(parentPath, maxWaitMs = 10_000) {
  const started = Date.now();
  let summary = null;
  while (Date.now() - started < maxWaitMs) {
    summary = loadSummary(parentPath);
    if (summary && (summary.commits > 0 || summary.tier > 0 || summary.healthScore != null)) {
      return summary;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  // Fall through: return whatever we have after retries exhausted.
  return summary ?? loadSummary(parentPath);
}

async function runOnePreset({ mode, preset, pass = 1, parentPath, directive }) {
  const tag = `mode=${mode} preset=${preset}${pass > 1 ? ` pass=${pass}` : ""}`;
  logLine(`[preset-start] ${tag} cloneAt=${parentPath}`);
  // Per-preset agentCount + rounds heuristics. Map-reduce + OW-Deep
  // need ≥4 agents (route-layer enforced). Debate-judge fixed at 3.
  const agentCount = preset === "debate-judge" ? 3 : preset.startsWith("orchestrator") || preset === "map-reduce" ? 4 : 4;
  const rounds = preset === "blackboard" ? 8 : 3;
  let runId;
  try {
    // Mode B's pass 2 needs to SEE pass 1's commits/files; pass 1
    // (and every other call) wants a fresh clone.
    const freshClone = !(mode === "B" && pass === 2);
    runId = await startRun({ preset, parentPath, directive, agentCount, rounds, freshClone });
  } catch (err) {
    logLine(`[preset-error] ${tag} startFailed=${err.message}`);
    results.push({ mode, preset, pass, ok: false, error: err.message });
    return;
  }
  const { snapshot, durationMs, abandoned } = await pollUntilTerminal(runId);
  const summary = await loadSummaryWithRetry(parentPath);
  const finalPhase = snapshot?.phase ?? "(unknown)";
  const commits = summary?.commits ?? 0;
  const tier = summary?.maxTierReached ?? 0;
  const healthScore = summary?.healthScore?.score ?? null;
  const rcaPrimary = summary?.rca?.primaryCause ?? null;
  const stopReason = summary?.stopReason ?? null;
  results.push({
    mode, preset, pass, runId, finalPhase, durationMs, abandoned,
    commits, tier, healthScore, rcaPrimary, stopReason,
    parentPath,
  });
  logLine(
    `[preset-end] ${tag} phase=${finalPhase} commits=${commits} tier=${tier} healthScore=${healthScore ?? "n/a"} stopReason=${stopReason ?? "n/a"} durationS=${(durationMs / 1000).toFixed(0)}${abandoned ? " ABANDONED" : ""}`,
  );
  writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
}

async function modeA() {
  logLine(`[mode-start] mode=A directive="single-ambitious"`);
  for (const preset of SWARM_PRESETS) {
    const parentPath = path.join(PARENT_BASE, `sweep-${TS}`, `A-${preset}`);
    await runOnePreset({ mode: "A", preset, parentPath, directive: DIRECTIVE_AMBITIOUS });
  }
  logLine(`[mode-end] mode=A`);
}

async function modeB() {
  logLine(`[mode-start] mode=B directive="two-pass-extend"`);
  for (const preset of SWARM_PRESETS) {
    const parentPath = path.join(PARENT_BASE, `sweep-${TS}`, `B-${preset}`);
    await runOnePreset({ mode: "B", preset, pass: 1, parentPath, directive: DIRECTIVE_AMBITIOUS });
    await runOnePreset({ mode: "B", preset, pass: 2, parentPath, directive: DIRECTIVE_PASS2_IMPROVE });
  }
  logLine(`[mode-end] mode=B`);
}

async function modeC() {
  logLine(`[mode-start] mode=C directive="per-preset-tuned"`);
  for (const preset of SWARM_PRESETS) {
    const parentPath = path.join(PARENT_BASE, `sweep-${TS}`, `C-${preset}`);
    await runOnePreset({ mode: "C", preset, parentPath, directive: TUNED_DIRECTIVES[preset] });
  }
  logLine(`[mode-end] mode=C`);
}

async function main() {
  logLine(`[sweep-start] mode=${MODE} repo=${REPO} parent=${PARENT_BASE} cap=${WALLCLOCK_CAP_MS}ms server=${SERVER}`);
  // Health-check once.
  try {
    const r = await fetchJson(`${SERVER}/api/health`);
    if (!r.ok) throw new Error(`/api/health ${r.status}`);
  } catch (err) {
    logLine(`[sweep-error] server-not-healthy: ${err.message}`);
    process.exit(2);
  }
  const t0 = Date.now();
  if (MODE === "A") await modeA();
  else if (MODE === "B") await modeB();
  else if (MODE === "C") await modeC();
  else if (MODE === "all") { await modeA(); await modeB(); await modeC(); }
  else {
    logLine(`[sweep-error] unknown mode=${MODE} (expected A|B|C|all)`);
    process.exit(2);
  }
  const totalS = ((Date.now() - t0) / 1000).toFixed(0);
  const ok = results.filter((r) => r.finalPhase === "completed" && !r.abandoned).length;
  logLine(`[sweep-end] mode=${MODE} totalRuns=${results.length} completed=${ok} durationS=${totalS}`);
  writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
  // Aggregate report
  const report = buildReport();
  writeFileSync(path.join(OUT_DIR, "REPORT.md"), report);
  logLine(`[sweep-done] report=${path.join(OUT_DIR, "REPORT.md")}`);
}

function buildReport() {
  const lines = [`# All-presets sweep — ${TS}`, "", `Repo: ${REPO}`, `Parent base: ${PARENT_BASE}`, `Mode: ${MODE}`, `Total runs: ${results.length}`, ""];
  const byMode = {};
  for (const r of results) {
    (byMode[r.mode] ??= []).push(r);
  }
  for (const mode of Object.keys(byMode).sort()) {
    lines.push(`## Mode ${mode}`, "", "| Preset | Pass | Phase | Commits | Tier | Health | StopReason | Duration |", "|---|---|---|---|---|---|---|---|");
    for (const r of byMode[mode]) {
      lines.push(`| ${r.preset} | ${r.pass ?? 1} | ${r.finalPhase ?? "?"} | ${r.commits ?? 0} | ${r.tier ?? 0} | ${r.healthScore ?? "n/a"} | ${r.stopReason ?? "n/a"} | ${r.durationMs ? Math.round(r.durationMs / 1000) + "s" : "n/a"} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

main().catch((err) => {
  logLine(`[sweep-fatal] ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
