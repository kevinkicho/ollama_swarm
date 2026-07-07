#!/usr/bin/env node
/** One-off: patch a recovered crash summary with inferred phase + git stats. */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const clonePath = process.argv[2];
const summaryPath = process.argv[3];
if (!clonePath || !summaryPath) {
  console.error("Usage: fix-crash-summary.mjs <clonePath> <summaryJsonPath>");
  process.exit(1);
}

const raw = JSON.parse(readFileSync(summaryPath, "utf8"));
const transcript = raw.transcript ?? [];

let phase;
for (let i = transcript.length - 1; i >= 0; i--) {
  const e = transcript[i];
  const summary = e.summary;
  if (summary?.kind === "council_stage" && summary.stage === "execution") {
    phase = "executing";
    break;
  }
  if (summary?.kind === "council_cycle" && summary.executionOnly) {
    phase = "executing";
    break;
  }
  if (e.text?.includes("[execution] Starting")) {
    phase = "executing";
    break;
  }
}
phase ??= "discussing";

let porcelain = "";
let changedFiles = 0;
const git = spawnSync("git", ["-C", clonePath, "status", "--porcelain"], { encoding: "utf8" });
if (git.status === 0) {
  porcelain = git.stdout.trim();
  changedFiles = porcelain ? porcelain.split("\n").filter(Boolean).length : 0;
}

// Count commits made during this run (agent-* commits after startedAt) as a floor.
const log = spawnSync(
  "git",
  ["-C", clonePath, "log", "--oneline", `--since=${new Date(raw.startedAt).toISOString()}`],
  { encoding: "utf8" },
);
if (log.status === 0) {
  const agentCommits = log.stdout.split("\n").filter((l) => /agent-\d/.test(l));
  if (agentCommits.length > changedFiles) {
    changedFiles = agentCommits.length;
    porcelain = agentCommits.join("\n");
  }
}

raw.stopDetail = `Run interrupted during "${phase}" (no graceful close-out — e.g. server restart or stop timeout)`;
raw.filesChanged = changedFiles;
raw.finalGitStatus = porcelain;
raw.finalGitStatusTruncated = false;

writeFileSync(summaryPath, JSON.stringify(raw, null, 2), "utf8");
console.log(`Patched ${summaryPath}: phase=${phase}, filesChanged=${changedFiles}`);
if (existsSync(path.join(clonePath, "logs", "summary.json"))) {
  const rootSummary = path.join(clonePath, "logs", "summary.json");
  writeFileSync(rootSummary, JSON.stringify(raw, null, 2), "utf8");
  console.log(`Also updated ${rootSummary}`);
}