#!/usr/bin/env node
// Run monitor for ollama_swarm blackboard runs.
// Watches event log + status API, detects irregularities, and optionally
// applies remedies (stuck agents, budget overruns, repeated failures).
//
// Usage: node scripts/run-monitor.mjs [--runId ID] [--api URL] [--remedy]

import { readFileSync, watchFile, unwatchFile } from "node:fs";
import { join } from "node:path";

const API = process.env.MONITOR_API || "http://localhost:8243";
const RUN_ID = process.argv.includes("--runId")
  ? process.argv[process.argv.indexOf("--runId") + 1]
  : null;
const REMEDY = process.argv.includes("--remedy");
const LOG_FILE = join(process.cwd(), "logs/current.jsonl");

// ── state ──────────────────────────────────────────────────────────
let lastStatus = null;
let consecutiveErrors = 0;
let agentStuckSince = {};
let lastTodoSnapshot = null;
let todosUnchangedSince = 0;
let totalTokensUsed = 0;
let totalPromptTokens = 0;
let totalResponseTokens = 0;
let errorPatterns = {};
let startTime = Date.now();

function log(level, msg) {
  const ts = new Date().toISOString().slice(11, 19);
  const prefix = { INFO: "ℹ", WARN: "⚠", ERROR: "✗", REMEDY: "🔧" }[level] || "·";
  console.log(`[${ts}] ${prefix} ${msg}`);
}

// ── API helpers ─────────────────────────────────────────────────────
async function fetchStatus() {
  try {
    const res = await fetch(`${API}/api/swarm/status`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    consecutiveErrors++;
    if (consecutiveErrors <= 3) {
      log("WARN", `Status fetch failed (${consecutiveErrors}): ${e.message}`);
    }
    return null;
  }
}

async function fetchTranscript() {
  try {
    const res = await fetch(`${API}/api/swarm/status`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data.transcript || [];
  } catch {
    return [];
  }
}

// ── anomaly detectors ───────────────────────────────────────────────
function detectStuckAgents(status) {
  if (!status?.agents) return;
  const now = Date.now();
  for (const agent of status.agents) {
    if (agent.status === "thinking" && agent.thinkingSince) {
      const elapsed = now - agent.thinkingSince;
      if (elapsed > 5 * 60 * 1000) {
        if (!agentStuckSince[agent.id]) {
          agentStuckSince[agent.id] = agent.thinkingSince;
          log("WARN", `${agent.id} thinking for ${Math.round(elapsed / 1000)}s (>${5}min threshold)`);
        }
      }
      if (elapsed > 15 * 60 * 1000) {
        log("ERROR", `${agent.id} stuck thinking for ${Math.round(elapsed / 60000)}min — likely hung`);
      }
    } else {
      delete agentStuckSince[agent.id];
    }
    if (agent.status === "failed") {
      log("ERROR", `${agent.id} is in failed state — may need manual intervention`);
    }
  }
}

function detectDeadBoard(status) {
  if (!status?.board) return;
  const counts = status.board.counts || {};
  const total = counts.total || 0;
  if (total === 0 && status.phase === "executing") {
    const elapsed = Date.now() - startTime;
    if (elapsed > 2 * 60 * 1000) {
      log("WARN", `Board is empty after ${Math.round(elapsed / 60000)}min in executing phase`);
    }
  }
  if (counts.committed === total && total > 0 && status.phase !== "completed") {
    log("INFO", `All ${total} todos committed but phase is still ${status.phase} — waiting for next cycle`);
  }
  if (counts.skipped > 0 && total > 0 && counts.skipped === total) {
    log("WARN", `All ${total} todos skipped — planner may need re-seeding`);
  }
  const skippedRatio = counts.skipped / (total || 1);
  if (skippedRatio > 0.7 && total >= 5) {
    log("WARN", `${counts.skipped}/${total} todos skipped (${Math.round(skippedRatio * 100)}%) — planner quality issue`);
  }
}

function detectTodoStagnation(status) {
  if (!status?.board?.todos) return;
  const snapshot = JSON.stringify(status.board.todos.map(t => `${t.id}:${t.status}`));
  if (snapshot === lastTodoSnapshot) {
    todosUnchangedSince++;
    if (todosUnchangedSince >= 10) {
      const min = Math.round(todosUnchangedSince * 5 / 60);
      log("WARN", `Todo board unchanged for ${min} checks — possible stall`);
    }
  } else {
    lastTodoSnapshot = snapshot;
    todosUnchangedSince = 0;
  }
}

function detectPhaseAnomaly(status) {
  if (!status) return;
  if (status.phase === "failed") {
    log("ERROR", `Run is in FAILED phase`);
  }
  if (status.phase === "idle" && status.round > 0) {
    log("WARN", `Run returned to IDLE after round ${status.round} — may have crashed`);
  }
}

function tallyErrorsFromLog() {
  try {
    const lines = readFileSync(LOG_FILE, "utf8").split("\n").filter(Boolean);
    const recentLines = lines.slice(-500);
    let newErrors = 0;
    let transportErrors = 0;
    let hunkFailures = 0;
    let skippedTodos = 0;
    for (const line of recentLines) {
      try {
        const ev = JSON.parse(line);
        const type = ev.event?.type || "";
        const text = ev.event?.entry?.text || ev.event?.message || "";
        if (type === "error" || text.includes("error:") || text.includes("Error:")) {
          newErrors++;
          errorPatterns[text.slice(0, 80)] = (errorPatterns[text.slice(0, 80)] || 0) + 1;
        }
        if (text.includes("UND_ERR_") || text.includes("ECONNREFUSED") || text.includes("transport error")) {
          transportErrors++;
        }
        if (text.includes("hunk apply failed") || text.includes("anchor not found")) {
          hunkFailures++;
        }
        if (text.includes("skipped") && text.includes("todo")) {
          skippedTodos++;
        }
        // Tally tokens
        const timing = ev.event;
        if (timing?.promptTokens && timing?.responseTokens) {
          totalPromptTokens += timing.promptTokens;
          totalResponseTokens += timing.responseTokens;
        }
      } catch {}
    }
    if (transportErrors > 5) {
      log("WARN", `${transportErrors} transport errors in recent log — possible provider instability`);
    }
    if (hunkFailures > 3) {
      log("WARN", `${hunkFailures} hunk apply failures — anchors may be stale`);
    }
  } catch (e) {
    // Log file may not exist yet
  }
}

function printStatus(status) {
  if (!status) return;
  consecutiveErrors = 0;
  const phase = status.phase || "?";
  const round = status.round ?? "?";
  const agents = status.agents || [];
  const board = status.board?.counts || {};
  const elapsed = Math.round((Date.now() - startTime) / 60000);

  const agentSummary = agents.map(a => {
    const tag = a.status === "thinking" ? "⏳" : a.status === "ready" ? "✓" : a.status === "failed" ? "✗" : "?";
    return `${a.id}:${tag}`;
  }).join(" ");

  const todoStr = board.total
    ? `${board.committed || 0}✓/${board.open || 0}○/${board.claimed || 0}◈/${board.skipped || 0}⊘/${board.total}≡`
    : "(no todos yet)";

  log("INFO", `[${phase} r${round}] ${agentSummary} board:${todoStr} ${elapsed}min elapsed`);
}

function printSummary() {
  log("INFO", `── Session summary ──`);
  log("INFO", `Prompt tokens: ${totalPromptTokens.toLocaleString()}`);
  log("INFO", `Response tokens: ${totalResponseTokens.toLocaleString()}`);
  const topErrors = Object.entries(errorPatterns)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  if (topErrors.length > 0) {
    log("INFO", `Top error patterns:`);
    for (const [pattern, count] of topErrors) {
      log("INFO", `  ${count}× ${pattern}`);
    }
  }
}

// ── main loop ───────────────────────────────────────────────────────
log("INFO", `Monitor started (API=${API}, runId=${RUN_ID || "auto"}, remedy=${REMEDY})`);

const INTERVAL = 5000;
let tickCount = 0;

const interval = setInterval(async () => {
  tickCount++;
  const status = await fetchStatus();

  printStatus(status);
  detectStuckAgents(status);
  detectDeadBoard(status);
  detectTodoStagnation(status);
  detectPhaseAnomaly(status);

  if (tickCount % 6 === 0) {
    tallyErrorsFromLog();
  }

  // Summary every 5 minutes
  if (tickCount % 60 === 0) {
    printSummary();
  }

  // If run completed or failed, stop monitoring
  if (status?.phase === "completed" || status?.phase === "failed" || status?.phase === "stopped") {
    log("INFO", `Run ended: phase=${status.phase}`);
    printSummary();
    clearInterval(interval);
    process.exit(status.phase === "completed" ? 0 : 1);
  }
}, INTERVAL);

// Graceful shutdown
process.on("SIGINT", () => {
  log("INFO", "Monitor stopped (SIGINT)");
  printSummary();
  clearInterval(interval);
  process.exit(0);
});