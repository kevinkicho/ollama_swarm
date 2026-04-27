#!/usr/bin/env node
// Monitor a blackboard E2E run for the 5 specific issues we're investigating
// post-V2-substrate (sourced from c3fb0fa7 run analysis 2026-04-27):
//
//   #1 — OllamaClient 60s idle timer kills cold-start prompts
//   #2 — stopReason="completed" on 0-commit / 0-todo runs
//   #3 — Planner empty → repair → [] accepted as natural run end
//   #4 — WebUI bubble routing (out of scope for this script — handled by Playwright)
//   #5 — Silent / buried per-agent model selection
//
// Usage (after dev server is up + a run has been POSTed):
//   node scripts/monitor-blackboard-issues.mjs --runId=<uuid> --runDir=runs/_monitor/<uuid>
//
// Args:
//   --port           server port (default 8243)
//   --runId          runId to filter event log; required
//   --runDir         where to write monitor-log.jsonl + issues-report.md
//   --pollMs         poll interval (default 3000)
//   --maxWaitMin     exit if no terminal within this window (default 30)

import { writeFile, mkdir, appendFile, copyFile, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// Small helper: list files in a directory matching a regex. Returns
// absolute-ish paths (the dir prefix re-applied). Resolves to []
// if the directory doesn't exist.
async function listFiles(dir, pattern) {
  try {
    const entries = await readdir(dir);
    return entries.filter((n) => pattern.test(n)).map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ""), true];
  }),
);
const PORT = Number(args.port ?? 8243);
const RUN_ID = args.runId;
const RUN_DIR = args.runDir ?? `runs/_monitor/${RUN_ID ?? "unspecified"}`;
const POLL_MS = Number(args.pollMs ?? 3000);
const MAX_WAIT_MS = Number(args.maxWaitMin ?? 30) * 60 * 1000;

if (!RUN_ID) {
  console.error("--runId=<uuid> is required");
  process.exit(2);
}

const STATUS_URL = `http://127.0.0.1:${PORT}/api/swarm/status`;
const RUN_DIR_ABS = path.resolve(RUN_DIR);
const LOG_PATH = path.join(RUN_DIR_ABS, "monitor-log.jsonl");
const REPORT_PATH = path.join(RUN_DIR_ABS, "issues-report.md");
const TRANSCRIPT_SNAPSHOT_PATH = path.join(RUN_DIR_ABS, "transcript-final.json");
const SUMMARY_COPY_PATH = path.join(RUN_DIR_ABS, "summary.json");
const EVENT_LOG_COPY_PATH = path.join(RUN_DIR_ABS, "event-log-slice.jsonl");
const TERMINAL = new Set(["completed", "stopped", "failed"]);

// ---- evidence accumulators ----
const evidence = {
  // Issue 1: idle-timeout strings in transcript
  ollamaIdleTimeouts: [],
  // Issue 3: planner empty → repair → [] sequence detection
  emptyResponses: [],
  jsonRepairAttempts: [],
  zeroTodosAfterGrounding: false,
  modelFallbackAttempts: [],
  // Issue 5: per-agent model surface
  perAgentModelLines: [],
  // 2026-04-27: per-agent state-transition tracking. Catches the
  // multi-worker death class (e.g. dev server restart killed all
  // child opencode subprocesses → each agent flips to "stopped" with
  // exit code 1). Without proactive alerting we only saw it via the
  // user's UI; the snapshot capturer recorded it but didn't flag it.
  agentDeaths: [],
  // Multiple agents transitioning to stopped/failed in the same poll
  // strongly suggests a dev server restart vs an isolated agent issue.
  // Tracked so the report can call out "likely dev server restart"
  // when ≥2 agents die within a few seconds.
  multiAgentDeathEvents: [],
  // General run state
  finalSummary: null,
  finalPhase: null,
  finalTranscriptLen: 0,
};

let monitorStartedAt = Date.now();
let runStartedAt = null;
let lastPhase = null;
let seenEntries = new Set();
// Per-agent last-known status. Used to detect transitions ABOVE the
// snapshot level — if status flips from "ready"/"thinking" → "stopped"
// or "failed", that's a death event we want to capture immediately.
const lastAgentStatus = new Map();

async function ensureRunDir() {
  if (!existsSync(RUN_DIR_ABS)) await mkdir(RUN_DIR_ABS, { recursive: true });
}

async function log(kind, data) {
  const line = JSON.stringify({ kind, at: Date.now(), ...data });
  console.log(line);
  await appendFile(LOG_PATH, line + "\n");
}

function classifyEntry(e) {
  // Issue #1: OllamaClient idle timeout
  if (typeof e.text === "string" && e.text.includes("Ollama idle timeout")) {
    evidence.ollamaIdleTimeouts.push({ id: e.id, ts: e.ts, text: e.text });
    return "issue1_idle_timeout";
  }
  // Issue #3: empty response
  if (e.role === "agent" && (e.text === "(empty response)" || e.text?.trim() === "")) {
    evidence.emptyResponses.push({ id: e.id, ts: e.ts, agentId: e.agentId, agentIndex: e.agentIndex });
    return "issue3_empty";
  }
  // Issue #3: JSON repair invocation
  if (typeof e.text === "string" && e.text.includes("JSON parse failed") && e.text.includes("repair")) {
    evidence.jsonRepairAttempts.push({ id: e.id, ts: e.ts, text: e.text });
    return "issue3_repair";
  }
  // Issue #3: 0 todos terminal
  if (typeof e.text === "string" && e.text.includes("Planner produced 0 valid todos after grounding")) {
    evidence.zeroTodosAfterGrounding = true;
    return "issue3_zero_todos";
  }
  // Issue #3: model fallback (the FIXED behavior we're looking for)
  if (typeof e.text === "string" && /retry.*with.*model|fall.*back.*model|trying.*model/i.test(e.text)) {
    evidence.modelFallbackAttempts.push({ id: e.id, ts: e.ts, text: e.text });
    return "issue3_fallback_attempt";
  }
  // Issue #5: per-agent model lines
  if (typeof e.text === "string" && e.text.startsWith("Per-agent models:")) {
    evidence.perAgentModelLines.push({ id: e.id, ts: e.ts, text: e.text });
    return "issue5_model_line";
  }
  return null;
}

async function poll() {
  let resp;
  try {
    resp = await fetch(STATUS_URL);
  } catch (e) {
    await log("poll_error", { error: String(e) });
    return null;
  }
  if (!resp.ok) {
    await log("poll_non_ok", { status: resp.status });
    return null;
  }
  const s = await resp.json();
  if (runStartedAt == null && s.phase !== "idle") runStartedAt = Date.now();
  if (s.phase !== lastPhase) {
    await log("phase_change", { from: lastPhase, to: s.phase });
    lastPhase = s.phase;
  }
  for (const e of s.transcript ?? []) {
    if (seenEntries.has(e.id)) continue;
    seenEntries.add(e.id);
    const kind = classifyEntry(e);
    if (kind) await log("evidence_capture", { kind, entryId: e.id });
  }
  // 2026-04-27: per-agent state-transition tracking. Detect when an
  // agent dies mid-run (stopped / failed with exit code) — pre-fix we
  // only saw this via the user's UI; the monitor knew but didn't flag.
  const deathsThisPoll = [];
  for (const a of s.agents ?? []) {
    const id = a.id;
    if (!id) continue;
    const prev = lastAgentStatus.get(id);
    if (prev === a.status) continue;
    lastAgentStatus.set(id, a.status);
    await log("agent_state_change", {
      agentId: id,
      index: a.index,
      from: prev ?? "(initial)",
      to: a.status,
      port: a.port,
      error: a.error,
    });
    // Death = transition to stopped/failed AFTER we've seen a non-
    // dead state for this agent. Pre-launch states (spawning →
    // ready) don't count.
    if ((a.status === "stopped" || a.status === "failed") && prev && prev !== "spawning") {
      const death = {
        agentId: id,
        index: a.index,
        prevStatus: prev,
        nowStatus: a.status,
        error: a.error ?? "(no error string)",
        at: Date.now(),
      };
      evidence.agentDeaths.push(death);
      deathsThisPoll.push(death);
      await log("agent_death", death);
    }
  }
  // Multiple deaths in the same poll cycle = simultaneous = strongly
  // suggests a parent-process event (dev server restart, SIGTERM
  // cascade) rather than independent agent failures.
  if (deathsThisPoll.length >= 2) {
    const event = {
      at: Date.now(),
      count: deathsThisPoll.length,
      agents: deathsThisPoll.map((d) => `${d.agentId}(${d.error})`),
      suspect: "dev server restart / SIGTERM cascade — child opencode subprocesses all killed at once",
    };
    evidence.multiAgentDeathEvents.push(event);
    await log("multi_agent_death", event);
  }

  evidence.finalPhase = s.phase;
  evidence.finalTranscriptLen = s.transcript?.length ?? 0;

  if (TERMINAL.has(s.phase)) {
    evidence.finalSummary = s;
    // Persist a snapshot of the final transcript for offline analysis.
    await writeFile(TRANSCRIPT_SNAPSHOT_PATH, JSON.stringify(s.transcript ?? [], null, 2));
    return "done";
  }
  if (Date.now() - monitorStartedAt > MAX_WAIT_MS) return "timeout";
  return null;
}

async function copyEvidenceArtifacts() {
  // Find the summary by runId match instead of trusting the file path.
  // Path mangling from a buggy parentPath (run 0254ca7c era) used to
  // land summaries at C:\mnt\c\... while we looked under runs/. The
  // pathNormalize fix prevents that for new runs, but defending here
  // means we still find the right summary if the bug ever recurs OR
  // if summary.json was overwritten by a newer run between writes.
  const repoSlug = evidence.finalSummary?.repoUrl?.split("/").pop() ?? "unknown";
  const candidates = [
    `runs/${repoSlug}/summary.json`,
    // Glob per-run summaries too — these are timestamp-suffixed and
    // never overwritten, so they're the most reliable lookup.
    ...(await listFiles(`runs/${repoSlug}`, /^summary-.*\.json$/)),
    // Defensive: probe the historical mangled-path location.
    `C:\\mnt\\c\\Users\\kevin\\Desktop\\ollama_swarm\\runs\\${repoSlug}\\summary.json`,
  ];
  let foundSrc = null;
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const raw = await readFile(candidate, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed?.runId === RUN_ID) {
        foundSrc = candidate;
        break;
      }
    } catch {
      // unparseable / unreadable — try the next candidate
    }
  }
  if (foundSrc) {
    try {
      await copyFile(foundSrc, SUMMARY_COPY_PATH);
      await log("artifact_copied", { from: foundSrc, to: SUMMARY_COPY_PATH, matchedBy: "runId" });
    } catch (e) {
      await log("artifact_copy_error", { src: foundSrc, error: String(e) });
    }
  } else {
    await log("artifact_no_match", {
      runId: RUN_ID,
      candidatesProbed: candidates.length,
    });
  }
  // Slice logs/current.jsonl to just our run's entries.
  const eventLogSrc = "logs/current.jsonl";
  if (existsSync(eventLogSrc)) {
    try {
      const all = await readFile(eventLogSrc, "utf8");
      const sliced = all
        .split("\n")
        .filter((line) => line.includes(RUN_ID))
        .join("\n");
      await writeFile(EVENT_LOG_COPY_PATH, sliced + "\n");
      await log("event_log_sliced", { lines: sliced.split("\n").length });
    } catch (e) {
      await log("event_log_slice_error", { error: String(e) });
    }
  }
}

function verdict(passWhen, name, present, fixedBehavior) {
  return {
    name,
    pass: passWhen ? !present : present,
    present,
    fixedBehavior,
  };
}

async function writeReport() {
  const summary = evidence.finalSummary;
  const sumFile = existsSync(SUMMARY_COPY_PATH)
    ? JSON.parse(await readFile(SUMMARY_COPY_PATH, "utf8").catch(() => "null"))
    : null;
  const lines = [];
  lines.push(`# Blackboard issues — verification report`);
  lines.push("");
  lines.push(`- runId: \`${RUN_ID}\``);
  lines.push(`- final phase: \`${evidence.finalPhase}\``);
  lines.push(`- transcript entries: ${evidence.finalTranscriptLen}`);
  lines.push(`- monitor wall-clock: ${((Date.now() - monitorStartedAt) / 1000).toFixed(1)}s`);
  if (sumFile) {
    lines.push(`- summary.stopReason: \`${sumFile.stopReason}\``);
    lines.push(`- summary.commits: ${sumFile.commits}`);
    lines.push(`- summary.totalTodos: ${sumFile.totalTodos}`);
    lines.push(`- summary.wallClockMs: ${sumFile.wallClockMs}`);
    const unmet = (sumFile.contract?.criteria ?? []).filter((c) => c.status === "unmet").length;
    const met = (sumFile.contract?.criteria ?? []).filter((c) => c.status === "met").length;
    lines.push(`- summary.contract criteria: ${met} met / ${unmet} unmet`);
  }
  lines.push("");

  // Issue #1
  lines.push(`## #1 — OllamaClient 60s idle timer kills cold-start`);
  lines.push("");
  if (evidence.ollamaIdleTimeouts.length === 0) {
    lines.push(`**FIX VERIFIED (or not exercised)** — no \`Ollama idle timeout\` strings in transcript.`);
  } else {
    lines.push(`**STILL BROKEN** — ${evidence.ollamaIdleTimeouts.length} idle-timeout occurrence(s):`);
    for (const t of evidence.ollamaIdleTimeouts) {
      lines.push(`  - ts=${new Date(t.ts).toISOString()}: ${t.text}`);
    }
  }
  lines.push("");

  // Issue #2
  lines.push(`## #2 — stopReason="completed" on 0-work runs`);
  lines.push("");
  if (sumFile) {
    const zeroWork = sumFile.commits === 0 && sumFile.totalTodos === 0;
    const allUnmet = (sumFile.contract?.criteria ?? []).every((c) => c.status === "unmet");
    const masquerading = sumFile.stopReason === "completed" && zeroWork && allUnmet;
    if (masquerading) {
      lines.push(`**STILL BROKEN** — stopReason=completed despite commits=0, todos=0, all criteria unmet.`);
    } else if (sumFile.stopReason === "completed" && (zeroWork || allUnmet)) {
      lines.push(`**PARTIALLY** — stopReason=completed and either work=0 or criteria unmet, but not both. Investigate.`);
    } else {
      lines.push(`**FIX VERIFIED (or not exercised)** — stopReason=\`${sumFile.stopReason}\`, work=${sumFile.commits}/${sumFile.totalTodos}.`);
    }
  } else {
    lines.push(`(no summary.json captured — cannot verify)`);
  }
  lines.push("");

  // Issue #3
  lines.push(`## #3 — Planner empty → repair → [] accepted as natural end`);
  lines.push("");
  const empties = evidence.emptyResponses.length;
  const repairs = evidence.jsonRepairAttempts.length;
  const fallbacks = evidence.modelFallbackAttempts.length;
  lines.push(`- agent empty responses: ${empties}`);
  lines.push(`- JSON repair attempts: ${repairs}`);
  lines.push(`- "0 valid todos after grounding": ${evidence.zeroTodosAfterGrounding}`);
  lines.push(`- model fallback attempts: ${fallbacks}`);
  lines.push("");
  if (evidence.zeroTodosAfterGrounding && fallbacks === 0) {
    lines.push(`**STILL BROKEN** — planner produced 0 todos with no model fallback attempted.`);
  } else if (empties > 0 && fallbacks === 0 && evidence.zeroTodosAfterGrounding) {
    lines.push(`**STILL BROKEN** — empty responses, no fallback, then 0-todos termination.`);
  } else if (fallbacks > 0) {
    lines.push(`**FIX OBSERVED** — model fallback fired (${fallbacks} attempt(s)). Verify the next prompt actually used a different model.`);
  } else {
    lines.push(`**NOT EXERCISED** — no planner-empty pattern triggered this run.`);
  }
  lines.push("");

  // Issue #5
  lines.push(`## #5 — Silent / buried per-agent model selection`);
  lines.push("");
  if (evidence.perAgentModelLines.length === 0) {
    lines.push(`**MIGHT BE BROKEN** — no \`Per-agent models:\` system messages emitted.`);
  } else {
    lines.push(`**Logged** — ${evidence.perAgentModelLines.length} system message(s):`);
    for (const m of evidence.perAgentModelLines) lines.push(`  - ${m.text}`);
    lines.push("");
    lines.push(`*UI prominence verification requires Playwright snapshot — see browser-side report.*`);
  }
  lines.push("");

  // 2026-04-27: agent-death section. Surfaces the multi-worker-killed
  // class that bit run 03a22386 (dev server tsx-watch restart killed
  // all 4 worker subprocesses).
  lines.push(`## Agent deaths during the run`);
  lines.push("");
  if (evidence.agentDeaths.length === 0) {
    lines.push(`No agent transitioned to stopped/failed mid-run.`);
  } else {
    lines.push(`**${evidence.agentDeaths.length} agent death(s) recorded:**`);
    for (const d of evidence.agentDeaths) {
      const ts = new Date(d.at).toISOString();
      lines.push(`- agent-${d.index}: ${d.prevStatus} → ${d.nowStatus} at ${ts} — \`${d.error}\``);
    }
    lines.push("");
    if (evidence.multiAgentDeathEvents.length > 0) {
      lines.push(`**Multi-agent death event(s) — likely a parent-process restart, NOT independent agent failures:**`);
      for (const ev of evidence.multiAgentDeathEvents) {
        const ts = new Date(ev.at).toISOString();
        lines.push(`- ${ts}: ${ev.count} agents died simultaneously (${ev.agents.join(", ")})`);
        lines.push(`  - Suspect: ${ev.suspect}`);
        lines.push(`  - Mitigation: run \`npm run dev:nowatch\` (or \`npm run dev -- --no-watch\`) — disables tsx watch which auto-restarts on /mnt/c inotify noise`);
      }
    }
  }
  lines.push("");

  lines.push(`## Artifacts captured in this directory`);
  lines.push("");
  lines.push(`- \`monitor-log.jsonl\` — every poll observation (incl. agent_state_change + agent_death events)`);
  lines.push(`- \`transcript-final.json\` — full transcript array at run end`);
  lines.push(`- \`summary.json\` — copy of the run's summary (if found)`);
  lines.push(`- \`event-log-slice.jsonl\` — runId-filtered slice of logs/current.jsonl`);

  await writeFile(REPORT_PATH, lines.join("\n") + "\n");
  await log("report_written", { path: REPORT_PATH });
}

await ensureRunDir();
await log("monitor_start", { runId: RUN_ID, statusUrl: STATUS_URL, runDir: RUN_DIR_ABS });
let result;
while (true) {
  result = await poll();
  if (result === "done" || result === "timeout") break;
  await sleep(POLL_MS);
}
await copyEvidenceArtifacts();
await writeReport();
await log("monitor_end", { result });
console.log(`\nMonitor finished (${result}). Report: ${REPORT_PATH}`);
