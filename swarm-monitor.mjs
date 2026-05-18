#!/usr/bin/env node
// swarm-monitor.mjs — Continuous swarm runner + smart monitor
//
// Starts swarm runs against a local repo and monitors via WebSocket.
// Dynamically responds to events with structured logging for post-mortem.

import { WebSocket } from "ws";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const SERVER = process.env.SWARM_SERVER || "http://localhost:8243";
const WS_URL = SERVER.replace(/^http/, "ws");
const API = SERVER;

const REPO_URL = process.env.SWARM_REPO_URL || "https://github.com/kevinkicho/opencode_swarm";
const PARENT_PATH = process.env.SWARM_PARENT_PATH || "/mnt/c/Users/kevin/Workspace";
const PRESETS = (process.env.SWARM_PRESETS || "blackboard").split(",");
const AGENT_COUNT = parseInt(process.env.SWARM_AGENTS || "4", 10);
const ROUNDS = parseInt(process.env.SWARM_ROUNDS || "1", 10);
const MODEL = process.env.SWARM_MODEL || "glm-5.1:cloud";
const PLANNER_MODEL = process.env.SWARM_PLANNER_MODEL || "";
const WORKER_MODEL = process.env.SWARM_WORKER_MODEL || "";
const AUDITOR_MODEL = process.env.SWARM_AUDITOR_MODEL || "";
const DEDICATED_AUDITOR = process.env.SWARM_DEDICATED_AUDITOR !== "0" && process.env.SWARM_DEDICATED_AUDITOR !== "";
const WRITE_MODE = process.env.SWARM_WRITE_MODE || "none";
const RUBRIC_GRADING = process.env.SWARM_RUBRIC !== "0";
const IDLE_TIMEOUT_SEC = parseInt(process.env.SWARM_IDLE_TIMEOUT || "180", 10);
const MAX_RUNTIME_MIN = parseInt(process.env.SWARM_MAX_RUNTIME_MIN || "30", 10);
const PAUSE_SEC = parseInt(process.env.SWARM_PAUSE_SEC || "10", 10);
const SINGLE_RUN = process.env.SWARM_SINGLE === "1" || process.env.SWARM_SINGLE === "true";
const LOG_DIR = process.env.SWARM_LOG_DIR || join(PARENT_PATH, REPO_URL.split("/").pop().replace(".git", ""), ".swarm-monitor-logs");
const DIRECTIVES = [
  "Review the codebase and identify the top 3 areas that would benefit most from refactoring, then propose specific improvements for each",
  "Analyze the architecture trade-offs in the multi-agent orchestration layer and suggest concrete changes",
  "Find potential performance bottlenecks in the event pipeline and recommend optimizations",
  "Identify gaps in error handling and resilience across the swarm runners, and propose fixes",
  "Evaluate the test coverage strategy and suggest where additional tests would add the most value",
];

let runNumber = 0;
let shuttingDown = false;

// ── Structured logging ──────────────────────────────────────────────
const LOG_LEVELS = { INFO: 0, PROGRESS: 1, OK: 2, WARN: 3, ERR: 4, OUTCOME: 5, RUN: 6, ALERT: 7 };
const LOG_COLORS = { INFO: "\x1b[36m", PROGRESS: "\x1b[35m", OK: "\x1b[32m", WARN: "\x1b[33m", ERR: "\x1b[31m", OUTCOME: "\x1b[36;1m", RUN: "\x1b[33;1m", ALERT: "\x1b[41;37m" };
let runLogBuffer = [];

function log(tag, msg, data = null) {
  const ts = new Date().toISOString();
  const shortTs = ts.slice(11, 19);
  const c = LOG_COLORS[tag] || "\x1b[37m";
  const line = `\x1b[90m[${shortTs}]\x1b[0m ${c}${tag}\x1b[0m ${msg}`;
  console.log(line);
  const entry = { ts, tag, msg, ...(data ? { data } : {}) };
  runLogBuffer.push(entry);
  // Alert-level events get extra emphasis
  if (tag === "ALERT") {
    console.log(`\x1b[41;37m !!! ${msg} !!! \x1b[0m`);
  }
}

function flushRunLog(runId, preset) {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
  const safeId = (runId || "unknown").slice(0, 8);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const path = join(LOG_DIR, `run-${safeId}-${preset}-${stamp}.jsonl`);
  for (const entry of runLogBuffer) {
    writeFileSync(path, JSON.stringify({ ...entry, runId, preset }) + "\n", { flag: "a" });
  }
  runLogBuffer = [];
  return path;
}

function fmtMs(ms) {
  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  const s = sec % 60;
  return min > 0 ? `${min}m ${s}s` : `${s}s`;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function pickPresetAndDirective() {
  const preset = PRESETS[runNumber % PRESETS.length];
  const directive = DIRECTIVES[runNumber % DIRECTIVES.length];
  return { preset, directive };
}

// ── API helpers ──────────────────────────────────────────────────────

async function startRun(preset, directive) {
  const body = {
    repoUrl: REPO_URL,
    parentPath: PARENT_PATH,
    preset,
    agentCount: AGENT_COUNT,
    rounds: ROUNDS,
    model: MODEL,
    userDirective: directive,
    force: true,
  };
  if (WRITE_MODE !== "none") body.writeMode = WRITE_MODE;
  if (RUBRIC_GRADING) body.rubricGrading = true;
  if (PLANNER_MODEL) body.plannerModel = PLANNER_MODEL;
  if (WORKER_MODEL) body.workerModel = WORKER_MODEL;
  if (AUDITOR_MODEL) body.auditorModel = AUDITOR_MODEL;
  if (DEDICATED_AUDITOR) body.dedicatedAuditor = true;

  const res = await fetch(`${API}/api/swarm/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Start ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

async function getStatus() {
  try {
    const res = await fetch(`${API}/api/swarm/status`);
    return await res.json();
  } catch { return null; }
}

async function stopRun(runId) {
  const url = runId ? `${API}/api/swarm/runs/${encodeURIComponent(runId)}/stop` : `${API}/api/swarm/stop`;
  try { await fetch(url, { method: "POST" }); } catch {}
}

// ── Event classification ─────────────────────────────────────────────

function classifyTranscriptEntry(text, role) {
  if (role !== "system") return null;
  const lower = text.toLowerCase();
  if (lower.includes("crash") || lower.includes("aborted") || lower.includes("unhandled")) return "CRASH";
  if (lower.includes("error") || lower.includes("failed") || lower.includes("failure")) return "ERROR";
  if (lower.includes("warning") || lower.includes("warn")) return "WARNING";
  if (lower.includes("outcome scoring") || lower.includes("run outcome")) return "OUTCOME";
  if (lower.includes("contract") || lower.includes("tier")) return "CONTRACT";
  if (lower.includes("commit") || lower.includes("hunk applied") || lower.includes("files changed")) return "COMMIT";
  if (lower.includes("reflection") || lower.includes("memory") || lower.includes("lesson")) return "REFLECTION";
  if (lower.includes("stopped") || lower.includes("no-progress") || lower.includes("early-stop")) return "STOP";
  if (lower.includes("deliverable")) return "DELIVERABLE";
  if (lower.includes("run finished") || lower.includes("run started") || lower.includes("agent ready")) return "LIFECYCLE";
  if (lower.includes("model") || lower.includes("failover") || lower.includes("retry")) return "MODEL";
  return null;
}

// ── Monitor ─────────────────────────────────────────────────────────

function monitorRun(runIdFromStart) {
  return new Promise((resolve) => {
    let phase = "idle";
    let round = 0;
    let lastActivityTs = Date.now();
    let transcriptEntries = 0;
    let errors = [];
    let alerts = [];
    let outcomeScore = null;
    let outcomeVerdict = null;
    let outcomeDimensions = [];
    let agentTurns = new Map();
    let agentStreaming = new Set();
    let startTime = Date.now();
    let completed = false;
    let runId = runIdFromStart;
    let lastRoundLogTime = 0;
    let watchdogRef = null;
    let contractTiers = new Set();
    let commitCount = 0;
    let filesChanged = 0;
    let stopDetail = null;
    let modelFailovers = [];
    let parsedErrors = 0;
    let parsedRepairs = 0;
    let agentStatuses = new Map();
    let deliverablePath = null;

    const url = runId ? `${WS_URL}/ws?runId=${runId}` : `${WS_URL}/ws`;
    log("INFO", `WS: ${url}`);
    const ws = new WebSocket(url);

    function cleanup() {
      if (watchdogRef) clearInterval(watchdogRef);
      try { ws.close(); } catch {}
    }

    ws.on("open", () => { log("OK", "WS connected"); });

    ws.on("message", (raw) => {
      let ev;
      try { ev = JSON.parse(raw.toString()); } catch { return; }
      lastActivityTs = Date.now();

      switch (ev.type) {
        case "run_started":
          runId = ev.runId || runId;
          phase = "running";
          startTime = Date.now();
          log("OK", `Run started: ${runId} | ${ev.preset} | ${ev.agentCount} agents | planner=${ev.plannerModel} worker=${ev.workerModel}`, {
            runId, preset: ev.preset, agentCount: ev.agentCount, plannerModel: ev.plannerModel, workerModel: ev.workerModel
          });
          break;

        case "swarm_state":
          phase = ev.phase;
          round = ev.round ?? round;
          if (ev.phase === "completed") {
            completed = true;
            log("OK", `Completed in ${fmtMs(Date.now() - startTime)}`);
            printSummaryAndFinish();
          } else if (ev.phase === "failed" || ev.phase === "stopped") {
            completed = true;
            log("ERR", `Run ${ev.phase} in ${fmtMs(Date.now() - startTime)}`);
            printSummaryAndFinish();
          } else if (Date.now() - lastRoundLogTime > 8000) {
            const streaming = [...agentStreaming].join(",");
            log("PROGRESS", `${ev.phase} | round ${round} | streaming: ${streaming || "none"}`);
            lastRoundLogTime = Date.now();
          }
          break;

        case "outcome_scored":
          outcomeScore = ev.score;
          outcomeVerdict = ev.verdict;
          outcomeDimensions = ev.dimensions || [];
          const dimSummary = outcomeDimensions.map(d => `${d.label}=${d.score}`).join(" ");
          log("OUTCOME", `${(ev.score * 10).toFixed(1)}/10 (${ev.verdict}) [${dimSummary}]`);
          break;

        case "error":
          errors.push(ev.message);
          log("ERR", ev.message);
          if (ev.message.toLowerCase().includes("crash") || ev.message.toLowerCase().includes("unhandled")) {
            alerts.push({ ts: new Date().toISOString(), type: "CRASH", message: ev.message });
            log("ALERT", `CRASH: ${ev.message}`);
          }
          break;

        case "run_summary":
          log("OK", `Summary: ${(ev.summary?.agentCount || "?")} agents, ${ev.summary?.totalRounds || "?"} rounds, ${ev.summary?.totalTurns || "?"} turns, ${ev.summary?.stopReason || "?"}`, ev.summary);
          break;

        case "clone_state":
          log("OK", ev.alreadyPresent ? `Resumed clone (${ev.priorCommits} commits, ${ev.priorChangedFiles || 0} changed, ${ev.priorUntrackedFiles || 0} untracked)` : `Cloned to ${ev.clonePath}`);
          break;

        case "agent_state":
          agentStatuses.set(ev.agent?.id, ev.agent?.status);
          break;

        case "agent_streaming":
          agentStreaming.add(ev.agentId);
          { const t = (agentTurns.get(ev.agentId) || 0) + 1;
            agentTurns.set(ev.agentId, t); }
          break;

        case "agent_streaming_end":
          agentStreaming.delete(ev.agentId);
          break;

        case "transcript_append":
          transcriptEntries++;
          { const text = (ev.entry?.text || "");
            const role = ev.entry?.role || "";
            const classification = classifyTranscriptEntry(text, role);
            const short = text.slice(0, 120).replace(/\n/g, " ");
            if (classification === "CRASH") {
              alerts.push({ ts: new Date().toISOString(), type: "CRASH", message: short });
              log("ALERT", `CRASH: ${short}`);
            } else if (classification === "ERROR") {
              log("ERR", short);
            } else if (classification === "WARNING") {
              log("WARN", short);
            } else if (classification === "OUTCOME") {
              // Already handled via outcome_scored event
            } else if (classification === "STOP") {
              stopDetail = short;
              log("WARN", `STOP: ${short}`);
            } else if (classification === "COMMIT") {
              commitCount++;
              log("OK", `COMMIT: ${short}`);
            } else if (classification === "CONTRACT") {
              if (text.match(/tier\s*(\d+)/i)) {
                const m = text.match(/tier\s*(\d+)/i);
                if (m) contractTiers.add(parseInt(m[1]));
              }
              log("PROGRESS", short);
            } else if (classification === "MODEL") {
              if (text.includes("failover")) {
                modelFailovers.push(short);
                log("WARN", `FAILOVER: ${short}`);
              } else if (text.includes("parse") && text.includes("repair")) {
                parsedRepairs++;
                log("WARN", `PARSE-REPAIR: ${short}`);
              } else if (text.includes("parse") && text.includes("invalid")) {
                parsedErrors++;
                log("ERR", `PARSE-ERROR: ${short}`);
              } else {
                log("PROGRESS", short);
              }
            } else if (classification === "REFLECTION") {
              log("OK", short);
            } else if (classification === "DELIVERABLE") {
              deliverablePath = text.match(/→\s*(\S+\.md)/)?.[1] || short;
              log("OK", `DELIVERABLE: ${short}`);
            }
          }
          break;

        case "model_shift":
          modelFailovers.push(`${ev.agentId}: ${ev.fromModel} → ${ev.toModel} (${ev.reason})${ev.rawError ? ` — ${ev.rawError}` : ""}`);
          log("WARN", `MODEL-SHIFT: ${ev.agentId}: ${ev.fromModel} → ${ev.toModel} (${ev.reason})${ev.rawError ? ` — ${ev.rawError}` : ""}`);
          break;

        case "conformance_sample":
          log("PROGRESS", `Conformance: ${ev.score?.toFixed(2)}/1.0 (smoothed: ${ev.smoothedScore?.toFixed(2)})${ev.reason ? ` — ${ev.reason}` : ""}`);
          break;

        case "drift_sample":
          log("PROGRESS", `Drift: similarity=${ev.similarity?.toFixed(3)} (smoothed: ${ev.smoothedSimilarity?.toFixed(3)})${ev.excerptChars ? ` ${ev.excerptChars}ch` : ""}`);
          break;

        case "directive_amended":
          log("INFO", `Directive amended: ${ev.text?.slice(0, 80)}`);
          break;

        case "pheromone_updated":
          // Silent — too frequent to log individually
          break;

        case "queue_state":
          // Silent — polled frequently
          break;

        case "finding_posted":
          log("INFO", `Finding: ${ev.finding?.title || ev.finding?.id || "unknown"}`);
          break;
      }
    });

    ws.on("close", () => {
      if (!completed) {
        log("WARN", "WS closed mid-run; reconnecting...");
        setTimeout(() => {
          if (!completed && !shuttingDown) {
            monitorRun(runId).then(resolve);
          }
        }, 3000);
      }
    });

    ws.on("error", (err) => { log("ERR", `WS: ${err.message}`); });

    // Idle + hard timeout watchdog
    watchdogRef = setInterval(() => {
      if (completed || shuttingDown) { cleanup(); return; }
      const idle = (Date.now() - lastActivityTs) / 1000;
      const runtime = (Date.now() - startTime) / 1000 / 60;

      if (runtime > MAX_RUNTIME_MIN) {
        log("ALERT", `Hard timeout (${MAX_RUNTIME_MIN}m). Force-stopping.`);
        stopRun(runId).then(() => {
          completed = true;
          printSummaryAndFinish();
        });
        return;
      }
      if (idle > IDLE_TIMEOUT_SEC) {
        log("WARN", `No activity ${Math.floor(idle)}s | ${phase} | round ${round} | ${agentStreaming.size} streaming | agents: ${[...agentStatuses.entries()].map(([id, s]) => `${id}=${s}`).join(" ")}`);
      }
    }, 15000);

    function printSummaryAndFinish() {
      const totalTurns = [...agentTurns.values()].reduce((a, b) => a + b, 0);
      const elapsed = fmtMs(Date.now() - startTime);
      console.log("\n" + "=".repeat(70));
      console.log(`  RUN #${runNumber} POST-MORTEM SUMMARY`);
      console.log("=".repeat(70));
      console.log(`  Run ID:       ${runId}`);
      console.log(`  Phase:        ${phase}`);
      console.log(`  Rounds:       ${round}`);
      console.log(`  Turns:        ${totalTurns}`);
      console.log(`  Transcript:   ${transcriptEntries} entries`);
      console.log(`  Commits:      ${commitCount}`);
      console.log(`  Errors:       ${errors.length}`);
      console.log(`  Parse errors: ${parsedErrors}`);
      console.log(`  Parse repairs: ${parsedRepairs}`);
      console.log(`  Model failovers: ${modelFailovers.length}`);
      console.log(`  Contract tiers: ${[...contractTiers].sort().join(", ") || "none"}`);
      console.log(`  Elapsed:       ${elapsed}`);
      if (stopDetail) console.log(`  Stop detail:  ${stopDetail}`);
      if (deliverablePath) console.log(`  Deliverable:  ${deliverablePath}`);
      if (outcomeScore !== null) {
        console.log(`  Outcome:      ${(outcomeScore * 10).toFixed(1)}/10 (${outcomeVerdict})`);
        if (outcomeDimensions.length > 0) {
          console.log(`  Dimensions:`);
          for (const d of outcomeDimensions) {
            console.log(`    ${d.label}: ${d.score}/10 — ${d.note?.slice(0, 80) || ""}`);
          }
        }
      } else {
        console.log(`  Outcome:      (not scored)`);
      }
      if (alerts.length > 0) {
        console.log(`  ALERTS (${alerts.length}):`);
        for (const a of alerts) console.log(`    [${a.ts.slice(11, 19)}] ${a.type}: ${a.message?.slice(0, 120)}`);
      }
      // Follow-up recommendations
      console.log("\n  FOLLOW-UP RECOMMENDATIONS:");
      if (errors.length > 0) {
        console.log(`    - Investigate ${errors.length} error(s) — check transcript for root cause`);
      }
      if (parsedErrors > 0) {
        console.log(`    - ${parsedErrors} JSON parse failure(s) — model may need constrained decoding or prompt fix`);
      }
      if (modelFailovers.length > 0) {
        console.log(`    - ${modelFailovers.length} model failover(s) — check model availability and rate limits`);
      }
      if (phase === "stopped" && stopDetail?.includes("no-progress")) {
        console.log(`    - No-progress stop — planner may need a more specific directive or model upgrade`);
      }
      if (outcomeScore !== null && outcomeScore < 0.4) {
        console.log(`    - Low outcome score (${(outcomeScore * 10).toFixed(1)}/10) — consider different preset or directive`);
      }
      if (commitCount === 0) {
        console.log(`    - Zero commits — preset may not produce file changes in this configuration`);
      }
      console.log("=".repeat(70) + "\n");
      completed = true;
      const logPath = flushRunLog(runId, PRESETS[runNumber % PRESETS.length] || "unknown");
      log("INFO", `Run log flushed → ${logPath}`);
      cleanup();
      resolve({
        outcomeScore, outcomeVerdict, outcomeDimensions,
        errors: errors.length, rounds: round, elapsed: Date.now() - startTime,
        commitCount, transcriptEntries, parsedErrors, parsedRepairs,
        modelFailovers: modelFailovers.length, alerts: alerts.length,
        stopDetail, deliverablePath,
      });
    }
  });
}

// ── Main loop ────────────────────────────────────────────────────────

async function runLoop() {
  while (!shuttingDown) {
    runNumber++;
    const { preset, directive } = pickPresetAndDirective();
    log("RUN", `\n${"═".repeat(70)}`);
    log("RUN", `Run #${runNumber}: ${preset} × ${ROUNDS} rounds × ${AGENT_COUNT} agents × ${MODEL}`);
    log("RUN", `Directive: ${directive.slice(0, 100)}${directive.length > 100 ? "..." : ""}`);
    log("RUN", `Rubric: ${RUBRIC_GRADING ? "ON" : "OFF"} | Write: ${WRITE_MODE} | Idle TL: ${IDLE_TIMEOUT_SEC}s`);
    log("RUN", `${"═".repeat(70)}`);

    let result;
    try {
      const startData = await startRun(preset, directive);
      const rid = startData.status?.runId;
      log("OK", `Started: ${rid}`);
      result = await monitorRun(rid);
    } catch (e) {
      log("ERR", `Failed: ${e.message}`);
      log("INFO", `Retrying in ${PAUSE_SEC}s...`);
      await sleep(PAUSE_SEC * 1000);
      continue;
    }

    if (SINGLE_RUN) {
      log("INFO", "Single-run mode. Exiting.");
      shuttingDown = true;
      break;
    }

    const pause = result?.errors > 3 ? PAUSE_SEC * 3 : PAUSE_SEC;
    log("OK", `Run #${runNumber} done. Next in ${pause}s.`);
    await sleep(pause * 1000);
  }
}

process.on("SIGINT", () => {
  log("INFO", "SIGINT — finishing current run then exiting.");
  shuttingDown = true;
});
process.on("SIGTERM", () => {
  log("INFO", "SIGTERM — finishing current run then exiting.");
  shuttingDown = true;
});

console.log("\n" + "═".repeat(70));
console.log("  OLLAMA SWARM — ENHANCED MONITOR");
console.log("═".repeat(70));
console.log(`  Server:    ${SERVER}`);
console.log(`  Repo:      ${REPO_URL}`);
console.log(`  Presets:   ${PRESETS.join(" → ")}`);
console.log(`  Agents:    ${AGENT_COUNT} | Rounds: ${ROUNDS} | Model: ${MODEL}`);
console.log(`  Write:     ${WRITE_MODE} | Rubric: ${RUBRIC_GRADING ? "ON" : "OFF"}`);
console.log(`  Idle TL:   ${IDLE_TIMEOUT_SEC}s | Max: ${MAX_RUNTIME_MIN}m | Pause: ${PAUSE_SEC}s`);
console.log(`  Log dir:   ${LOG_DIR}`);
console.log(`  Single:    ${SINGLE_RUN ? "yes" : "no (continuous)"}`);
console.log("═".repeat(70) + "\n");

runLoop().catch(e => { log("ERR", `Fatal: ${e.message}`); process.exit(1); });