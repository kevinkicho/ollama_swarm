#!/usr/bin/env node
/**
 * Preset tour — runs each preset until it naturally finishes or a timeout
 * expires, then captures status and moves to the next.
 *
 * Polls every 5s; if the run finishes (phase=stopped/completed) before
 * the timeout, moves on immediately — no wasted time.
 *
 * Usage: node scripts/preset-tour.mjs [max_wait_per_preset_seconds]
 *   Default: 600 (10 minutes max per preset)
 */

const BASE_URL = "http://localhost:8243/api/swarm";
const DEFAULT_MAX_WAIT = 600;
const POLL_INTERVAL = 5000;

const PRESETS = [
  { preset: "blackboard", agentCount: 3, label: "Blackboard" },
  { preset: "council", agentCount: 3, label: "Council" },
  { preset: "round-robin", agentCount: 3, label: "Round-Robin" },
  { preset: "orchestrator-worker", agentCount: 3, label: "OW" },
  { preset: "debate-judge", agentCount: 3, label: "Debate-Judge" },
  { preset: "mixture-of-agents", agentCount: 3, label: "MoA" },
  { preset: "map-reduce", agentCount: 4, label: "Map-Reduce" },
  { preset: "stigmergy", agentCount: 3, label: "Stigmergy" },
];

const REPO_URL = "https://github.com/kevinkicho/opencode_swarm";
const PARENT_PATH = "/mnt/c/Users/kevin/Workspace";
const MODEL = "glm-5.1:cloud";
const DIRECTIVE = "Add inline documentation to 3 key functions and fix any obvious lint warnings.";

function isTerminalPhase(phase) {
  return phase === "stopped" || phase === "completed" || phase === "idle";
}

async function fetchStatus() {
  try {
    const res = await fetch(`${BASE_URL}/status`);
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

async function startPreset(cfg) {
  const res = await fetch(`${BASE_URL}/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      repoUrl: REPO_URL,
      parentPath: PARENT_PATH,
      preset: cfg.preset,
      model: MODEL,
      agentCount: cfg.agentCount,
      rounds: 2,
      directive: DIRECTIVE,
    }),
  });
  return res.json();
}

async function stopRun() {
  try {
    const res = await fetch(`${BASE_URL}/stop`, { method: "POST" });
    return res.json();
  } catch {
    return null;
  }
}

async function waitForRunEnd(maxMs) {
  const start = Date.now();
  let lastPhase = "";
  let lastLog = 0;
  while (Date.now() - start < maxMs) {
    const status = await fetchStatus();
    if (!status) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL));
      continue;
    }
    const phase = status.phase ?? status.v2State?.phase ?? "unknown";
    if (phase !== lastPhase) {
      const elapsed = Math.round((Date.now() - start) / 1000);
      console.log(`    [${elapsed}s] phase: ${phase}`);
      lastPhase = phase;
    }
    // Progress log every 30s
    const now = Date.now();
    if (now - lastLog > 30000) {
      const elapsed = Math.round((now - start) / 1000);
      const agents = status.agents ?? [];
      const agentStatus = agents.map((a) => `${a.id}=${a.status}`).join(" ");
      const board = status.board?.counts;
      const boardInfo = board ? `board: open=${board.open} claimed=${board.claimed} committed=${board.committed}` : "";
      console.log(`    [${elapsed}s] ${agentStatus} ${boardInfo}`);
      lastLog = now;
    }
    if (isTerminalPhase(phase)) {
      return { status, timedOut: false };
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }
  // Timeout — drain and stop
  console.log("  ⏰ Timeout, draining...");
  await stopRun();
  const drainStart = Date.now();
  while (Date.now() - drainStart < 180000) {
    const status = await fetchStatus();
    if (!status) { await new Promise((r) => setTimeout(r, 3000)); continue; }
    const phase = status.phase ?? status.v2State?.phase ?? "unknown";
    if (isTerminalPhase(phase)) return { status, timedOut: true };
    await new Promise((r) => setTimeout(r, 3000));
  }
  // Hard stop
  await stopRun();
  await new Promise((r) => setTimeout(r, 5000));
  return { status: await fetchStatus(), timedOut: true };
}

function summarize(status, label, elapsed) {
  const agents = status.agents ?? [];
  const transcript = status.transcript ?? [];
  const failovers = transcript.filter((t) => t.text?.includes?.("failover:"));
  const modelShifts = transcript.filter((t) => t.text?.includes?.("model_shift"));
  const board = status.board ?? {};
  const counts = board.counts ?? {};
  const summary = status.summary;
  const healthScore = summary?.healthScore?.score ?? "?";
  const healthBucket = summary?.healthScore?.bucket ?? "?";
  const rca = summary?.rca?.primaryCause ?? summary?.rca?.markdown?.split("\n")?.[0] ?? "?";

  // Check for bugs
  const bugs = [];
  const staleAgents = agents.filter((a) => a.status !== "stopped" && a.status !== "completed" && status.phase === "stopped");
  if (staleAgents.length > 0) bugs.push(`stale-agent-status: ${staleAgents.map((a) => `${a.id}=${a.status}`).join(", ")}`);
  const missingModel = agents.filter((a) => !a.model && a.status !== "stopped");
  if (missingModel.length > 0) bugs.push(`missing-model-field: ${missingModel.map((a) => a.id).join(", ")}`);

  return {
    label,
    phase: status.phase,
    elapsed: `${Math.round(elapsed / 1000)}s`,
    agentCount: agents.length,
    agents: agents.map((a) => `${a.id}=${a.status}(${a.model ?? "??"})`).join(", "),
    transcriptEntries: transcript.length,
    failovers: failovers.length,
    failoverDetails: failovers.map((f) => f.text.slice(0, 120)),
    modelShifts: modelShifts.length,
    board: { ...counts },
    healthScore,
    healthBucket,
    rca,
    runId: status.runId,
    bugs,
    runConfig: status.runConfig
      ? { preset: status.runConfig.preset, planner: status.runConfig.plannerModel, worker: status.runConfig.workerModel }
      : null,
  };
}

async function main() {
  const maxMs = (parseInt(process.argv[2], 10) || DEFAULT_MAX_WAIT) * 1000;
  console.log(`\n=== Preset Tour (max ${maxMs / 1000}s per preset, early-exit on completion) ===\n`);

  const results = [];

  for (const cfg of PRESETS) {
    console.log(`\n--- ${cfg.label} (${cfg.preset}) ---`);
    // Ensure idle
    let status = await fetchStatus();
    if (status && !isTerminalPhase(status.phase)) {
      console.log("  Run still active, draining first...");
      await stopRun();
      await waitForRunEnd(180000);
    }
    await new Promise((r) => setTimeout(r, 3000));

    const runStart = Date.now();
    const startRes = await startPreset(cfg);
    if (startRes.error) {
      console.log(`  ERROR starting: ${JSON.stringify(startRes.error)}`);
      results.push({ label: cfg.label, error: JSON.stringify(startRes.error) });
      continue;
    }
    console.log(`  Started runId=${startRes.ok ? startRes.status?.runId ?? "?" : "?"}`);

    const { status: endStatus, timedOut } = await waitForRunEnd(maxMs);
    const elapsed = Date.now() - runStart;
    const info = summarize(endStatus ?? {}, cfg.label, elapsed);
    info.timedOut = timedOut;
    results.push(info);

    console.log(`  Done in ${info.elapsed} (timedOut=${timedOut})`);
    console.log(`  health=${info.healthScore}(${info.healthBucket}) rca=${info.rca}`);
    console.log(`  agents: ${info.agents}`);
    console.log(`  failovers: ${info.failovers} model_shifts: ${info.modelShifts}`);
    if (info.bugs.length) console.log(`  BUGS: ${info.bugs.join("; ")}`);

    // Cooldown
    await new Promise((r) => setTimeout(r, 5000));
  }

  console.log("\n\n========== TOUR RESULTS ==========\n");
  const header = "Preset".padEnd(16) + "Health".padEnd(10) + "Time".padEnd(8) + "Failovers".padEnd(12) + "Board".padEnd(24) + "Bugs";
  console.log(header);
  console.log("-".repeat(header.length));
  for (const r of results) {
    if (r.error) {
      console.log(`${r.label.padEnd(16)} ERROR: ${r.error}`);
      continue;
    }
    const board = r.board;
    const boardStr = `o=${board.open ?? "?"} c=${board.claimed ?? "?"} ✓=${board.committed ?? "?"} s=${board.skipped ?? "?"}`;
    const bugStr = r.bugs.length ? r.bugs.join("; ") : "none";
    const toStr = r.timedOut ? "⏰" : "✓";
    console.log(
      `${r.label.padEnd(16)} ${String(r.healthScore).padEnd(10)} ${r.elapsed.padEnd(8)} ${String(r.failovers).padEnd(12)} ${boardStr.padEnd(24)} ${bugStr}`,
    );
    if (r.failoverDetails?.length) {
      for (const f of r.failoverDetails) console.log(`    failover: ${f}`);
    }
  }
  console.log();
}

main().catch(console.error);