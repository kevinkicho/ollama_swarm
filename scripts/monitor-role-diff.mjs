#!/usr/bin/env node
// Monitor a role-diff E2E run. Polls /api/swarm/status, logs irregularities,
// writes a compliance report when the run terminates.
//
// Usage (after `npm run dev` is up and a run has been POSTed to start):
//   node scripts/monitor-role-diff.mjs --runDir=runs/role-diff-v1 --expectedRoles=5
//
// Args:
//   --port           server port (default 52243)
//   --runDir         where to write monitor-log.jsonl + compliance-report.md
//   --expectedRoles  how many of the 7-role catalog to require (default 5, matches UI's "recommended")
//   --pollMs         poll interval (default 5000)
//   --maxWaitMin     exit with "monitor_timeout" if no terminal phase within this window (default 75)

import { writeFile, mkdir, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// ---- args ----
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ""), true];
  }),
);
const PORT = Number(args.port ?? 52243);
const RUN_DIR = args.runDir ?? "runs/role-diff-v1";
const EXPECTED_ROLES = Number(args.expectedRoles ?? 5);
const POLL_MS = Number(args.pollMs ?? 5000);
const MAX_WAIT_MS = Number(args.maxWaitMin ?? 75) * 60 * 1000;
const STALL_LIMIT_MS = 8 * 60 * 1000; // no new transcript entry for 8 min

const STATUS_URL = `http://127.0.0.1:${PORT}/api/swarm/status`;
const RUN_DIR_ABS = path.resolve(RUN_DIR);
const LOG_PATH = path.join(RUN_DIR_ABS, "monitor-log.jsonl");
const REPORT_PATH = path.join(RUN_DIR_ABS, "compliance-report.md");
const TERMINAL = new Set(["completed", "stopped", "failed"]);

// Mirrors server/src/swarm/roles.ts DEFAULT_ROLES, in order. If the server
// catalog changes, update here too — or the report's role coverage will
// mislabel agents.
const ROLE_TABLE = [
  "Architect",
  "Tester",
  "Security reviewer",
  "Performance critic",
  "Docs reader",
  "Dependency auditor",
  "Devil's advocate",
];
const roleForIndex = (index) => ROLE_TABLE[(index - 1) % ROLE_TABLE.length];

// ---- state ----
const seenEntries = new Set();
const rolesHeard = new Map();
const agentStatuses = new Map();
const retries = [];
const failures = [];
let lastPhase = null;
let lastTranscriptLen = 0;
let lastTranscriptGrowthAt = Date.now();
let transcriptStalled = false;
let startedAt = null;
let monitorStartedAt = Date.now();

// ---- helpers ----
async function ensureRunDir() {
  if (!existsSync(RUN_DIR_ABS)) await mkdir(RUN_DIR_ABS, { recursive: true });
}

async function log(kind, data) {
  const line = JSON.stringify({ kind, at: Date.now(), ...data });
  console.log(line);
  await appendFile(LOG_PATH, line + "\n");
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
  if (startedAt == null && s.phase !== "idle") startedAt = Date.now();

  // phase transitions
  if (s.phase !== lastPhase) {
    await log("phase_change", { from: lastPhase, to: s.phase, round: s.round });
    lastPhase = s.phase;
  }

  // transcript growth / stall
  const curLen = s.transcript?.length ?? 0;
  if (curLen > lastTranscriptLen) {
    lastTranscriptLen = curLen;
    lastTranscriptGrowthAt = Date.now();
    transcriptStalled = false;
  } else if (
    !transcriptStalled &&
    Date.now() - lastTranscriptGrowthAt > STALL_LIMIT_MS &&
    !TERMINAL.has(s.phase)
  ) {
    await log("irregularity_transcript_stall", {
      phase: s.phase,
      stall_ms: Date.now() - lastTranscriptGrowthAt,
    });
    transcriptStalled = true;
  }

  // agent status changes
  for (const a of s.agents ?? []) {
    const prev = agentStatuses.get(a.id);
    if (prev !== a.status) {
      agentStatuses.set(a.id, a.status);
      await log("agent_status", {
        id: a.id,
        index: a.index,
        role: roleForIndex(a.index),
        status: a.status,
        retryAttempt: a.retryAttempt,
        retryMax: a.retryMax,
        retryReason: a.retryReason,
        error: a.error,
      });
      if (a.status === "retrying") {
        retries.push({
          agentId: a.id,
          index: a.index,
          attempt: a.retryAttempt,
          max: a.retryMax,
          reason: a.retryReason,
          at: Date.now(),
        });
      }
      if (a.status === "failed") {
        failures.push({
          agentId: a.id,
          index: a.index,
          error: a.error,
          at: Date.now(),
        });
        await log("irregularity_agent_failed", {
          id: a.id,
          index: a.index,
          role: roleForIndex(a.index),
          error: a.error,
        });
      }
    }
  }

  // new transcript entries
  for (const e of s.transcript ?? []) {
    if (seenEntries.has(e.id)) continue;
    seenEntries.add(e.id);
    if (e.role === "agent" && typeof e.agentIndex === "number") {
      const role = roleForIndex(e.agentIndex);
      rolesHeard.set(role, (rolesHeard.get(role) ?? 0) + 1);
      const preview = (e.text ?? "").slice(0, 90).replace(/\s+/g, " ");
      await log("agent_turn", {
        agentIndex: e.agentIndex,
        role,
        chars: (e.text ?? "").length,
        preview,
      });
    }
  }

  if (TERMINAL.has(s.phase)) {
    await writeReport(s, "terminal");
    return "done";
  }
  if (Date.now() - monitorStartedAt > MAX_WAIT_MS) {
    await writeReport(s, "monitor_timeout");
    return "timeout";
  }
  return null;
}

async function writeReport(finalStatus, reason) {
  const expected = ROLE_TABLE.slice(0, EXPECTED_ROLES);
  const missing = expected.filter((r) => (rolesHeard.get(r) ?? 0) === 0);
  const runMs = startedAt ? Date.now() - startedAt : 0;
  const lines = [];
  lines.push(`# role-diff E2E compliance report`);
  lines.push("");
  lines.push(`- Preset: **role-diff**`);
  lines.push(`- Final phase: **${finalStatus.phase}**`);
  lines.push(`- Monitor exit reason: **${reason}**`);
  lines.push(`- Rounds completed: ${finalStatus.round}`);
  lines.push(`- Run wall clock: ${runMs ? (runMs / 1000).toFixed(1) + "s" : "(unknown)"}`);
  lines.push(`- Transcript entries: ${finalStatus.transcript?.length ?? 0}`);
  lines.push(`- Agents configured: ${finalStatus.agents?.length ?? 0}`);
  lines.push("");
  lines.push(`## Role coverage (expected first ${EXPECTED_ROLES} of catalog)`);
  lines.push("");
  lines.push(`| Role | Turns | Coverage |`);
  lines.push(`|---|---|---|`);
  for (const role of expected) {
    const n = rolesHeard.get(role) ?? 0;
    lines.push(`| ${role} | ${n} | ${n > 0 ? "ok" : "MISSING"} |`);
  }
  lines.push("");
  lines.push(
    missing.length === 0
      ? `**All ${EXPECTED_ROLES} expected roles spoke at least once.**`
      : `**MISSING roles (${missing.length}):** ${missing.join(", ")}`,
  );
  lines.push("");
  lines.push(`## Agent statuses (final)`);
  lines.push("");
  for (const a of finalStatus.agents ?? []) {
    lines.push(
      `- Agent ${a.index} (${roleForIndex(a.index)}) — ${a.status}${a.error ? " — " + a.error : ""}`,
    );
  }
  lines.push("");
  lines.push(`## Irregularities`);
  lines.push("");
  if (failures.length === 0 && retries.length === 0 && !transcriptStalled) {
    lines.push("_None._");
  } else {
    if (failures.length) {
      lines.push(`**Failures (${failures.length}):**`);
      for (const f of failures) lines.push(`- Agent ${f.index}: ${f.error}`);
      lines.push("");
    }
    if (retries.length) {
      lines.push(`**Retry events (${retries.length}):**`);
      for (const r of retries)
        lines.push(`- Agent ${r.index}: ${r.attempt}/${r.max} — ${r.reason}`);
      lines.push("");
    }
    if (transcriptStalled) {
      lines.push(`**Transcript stalled** for more than ${STALL_LIMIT_MS / 60000} min at some point.`);
    }
  }
  lines.push("");
  lines.push(`## Verdict`);
  lines.push("");
  const ok = missing.length === 0 && failures.length === 0 && reason === "terminal";
  lines.push(
    ok
      ? `**PASS** — every expected role spoke, no agents failed, run reached a terminal phase.`
      : `**FAIL** — see sections above.`,
  );
  await writeFile(REPORT_PATH, lines.join("\n") + "\n");
  await log("report_written", { path: REPORT_PATH, ok, reason });
}

// ---- main ----
await ensureRunDir();
await log("monitor_start", {
  statusUrl: STATUS_URL,
  runDir: RUN_DIR_ABS,
  expectedRoles: EXPECTED_ROLES,
  pollMs: POLL_MS,
  maxWaitMin: MAX_WAIT_MS / 60000,
});
while (true) {
  const r = await poll();
  if (r === "done" || r === "timeout") break;
  await sleep(POLL_MS);
}
await log("monitor_end", {});
console.log(`\nMonitor finished. Report: ${REPORT_PATH}`);
