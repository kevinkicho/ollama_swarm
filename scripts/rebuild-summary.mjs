#!/usr/bin/env node
/**
 * Re-run buildSummary on an on-disk summary.json (fixes stopReason after classifier changes).
 *
 * Usage: node --import tsx scripts/rebuild-summary.mjs <path-to-summary.json>
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildSummary } from "../server/src/swarm/blackboard/summary.ts";

const summaryPath = process.argv[2];
if (!summaryPath) {
  console.error("Usage: node --import tsx scripts/rebuild-summary.mjs <summary.json>");
  process.exit(1);
}

const raw = JSON.parse(readFileSync(summaryPath, "utf8"));
const rebuilt = buildSummary({
  config: {
    repoUrl: raw.repoUrl ?? "",
    localPath: raw.localPath ?? "",
    preset: raw.preset ?? "blackboard",
    model: raw.model ?? "",
    runId: raw.runId,
    startCommand: raw.startCommand,
    userDirective: raw.userDirective,
    plannerTools: raw.plannerTools,
    webTools: raw.webTools,
  },
  agentCount: raw.agentCount,
  rounds: raw.rounds,
  startedAt: raw.startedAt,
  endedAt: raw.endedAt,
  stopping: false,
  completionDetail: raw.stopDetail,
  board: {
    committed: raw.commits ?? 0,
    skipped: raw.skippedTodos ?? 0,
    stale: raw.staleEvents ?? 0,
    total: raw.totalTodos ?? 0,
  },
  staleEvents: raw.staleEvents ?? 0,
  filesChanged: raw.filesChanged ?? 0,
  finalGitStatus: raw.finalGitStatus ?? "",
  agents: raw.agents ?? [],
  contract: raw.contract,
  transcript: raw.transcript,
  v2State: raw.v2State,
  v2QueueState: raw.v2QueueState,
  topology: raw.topology,
  deliverables: raw.deliverables,
  controlAdvice: raw.controlAdvice,
  errors: raw.errors,
});

const merged = {
  ...raw,
  stopReason: rebuilt.stopReason,
  stopDetail: rebuilt.stopDetail,
};
const json = JSON.stringify(merged, null, 2);
writeFileSync(summaryPath, json, "utf8");
console.log(`Rebuilt ${summaryPath}: stopReason=${merged.stopReason}`);
const latest = path.join(path.dirname(summaryPath), "summary.json");
if (latest !== path.resolve(summaryPath)) {
  writeFileSync(latest, json, "utf8");
  console.log(`Also wrote ${latest}`);
}