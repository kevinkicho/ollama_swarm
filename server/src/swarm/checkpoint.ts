// Direction 6 Phase 1: run checkpoint persistence.
//
// After each agent's turn completes (discussion presets) or after each
// todo commit cycle (blackboard), a lightweight checkpoint is written
// to disk. Checkpoints enable:
//   - Timeline scrubbing ("what did agent 2 see at round 1?")
//   - Replay from any checkpoint (restart the run from that state)
//   - Crash recovery with minimal lost work
//
// For discussion presets, the checkpoint captures:
//   - transcript snapshot (all entries up to this point)
//   - phase, round, agentIndex
//   - agent states
//
// For blackboard, additionally captures:
//   - board snapshot (todos, claims, findings, counts)
//
// Checkpoints are written to <clonePath>/.swarm-checkpoints/<runId>/.
// File format: checkpoint-<round>-<agentIndex>-<ts>.json
//
// Replay from checkpoint is discussion-preset-only for now (blackboard
// state is more complex — deferred).

import { promises as fs } from "node:fs";
import path from "node:path";

import type { TranscriptEntry, AgentState, SwarmPhase } from "../types.js";
import type { RunConfig } from "./SwarmRunner.js";

export interface RunCheckpoint {
  runId: string;
  phase: SwarmPhase;
  round: number;
  agentIndex: number;
  timestamp: number;
  transcriptSnapshot: TranscriptEntry[];
  agentStates: AgentState[];
  configSnapshot: {
    preset: string;
    agentCount: number;
    rounds: number;
    model?: string;
    userDirective?: string;
  };
}

export interface CheckpointDir {
  dir: string;
  checkpoints: RunCheckpoint[];
}

const CHECKPOINTS_DIR = ".swarm-checkpoints";

function checkpointDir(clonePath: string, runId: string): string {
  return path.join(clonePath, CHECKPOINTS_DIR, runId);
}

function checkpointFileName(round: number, agentIndex: number, ts: number): string {
  return `checkpoint-${round}-${agentIndex}-${ts}.json`;
}

export async function writeCheckpoint(
  clonePath: string,
  checkpoint: RunCheckpoint,
): Promise<string> {
  const dir = checkpointDir(clonePath, checkpoint.runId);
  await fs.mkdir(dir, { recursive: true });
  const fileName = checkpointFileName(checkpoint.round, checkpoint.agentIndex, checkpoint.timestamp);
  const filePath = path.join(dir, fileName);
  const json = JSON.stringify(checkpoint);
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, json, "utf8");
  await fs.rename(tmp, filePath);
  return filePath;
}

export async function listCheckpoints(
  clonePath: string,
  runId: string,
): Promise<RunCheckpoint[]> {
  const dir = checkpointDir(clonePath, runId);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const checkpoints: RunCheckpoint[] = [];
  for (const entry of entries) {
    if (!entry.startsWith("checkpoint-") || !entry.endsWith(".json")) continue;
    const abs = path.join(dir, entry);
    try {
      const raw = await fs.readFile(abs, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && typeof parsed.runId === "string" && typeof parsed.round === "number") {
        checkpoints.push(parsed as RunCheckpoint);
      }
    } catch {
      // skip malformed
    }
  }
  checkpoints.sort((a, b) => a.timestamp - b.timestamp);
  return checkpoints;
}

function sanitizeCheckpointFileName(fileName: string): string | null {
  if (fileName.includes("..") || fileName.includes("/") || fileName.includes("\\")) {
    return null;
  }
  const base = path.basename(fileName);
  if (base !== fileName || base.length === 0) return null;
  return base;
}

export async function readCheckpoint(
  clonePath: string,
  runId: string,
  fileName: string,
): Promise<RunCheckpoint | null> {
  const safeName = sanitizeCheckpointFileName(fileName);
  if (!safeName) return null;
  const dir = checkpointDir(clonePath, runId);
  const filePath = path.join(dir, safeName);
  const resolvedDir = path.resolve(dir);
  const resolvedFile = path.resolve(filePath);
  if (
    resolvedFile !== resolvedDir &&
    !resolvedFile.startsWith(resolvedDir + path.sep)
  ) {
    return null;
  }
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && typeof parsed.runId === "string") {
      return parsed as RunCheckpoint;
    }
  } catch {
    // not found or malformed
  }
  return null;
}

export function buildCheckpoint(
  runId: string,
  phase: SwarmPhase,
  round: number,
  agentIndex: number,
  transcript: TranscriptEntry[],
  agentStates: AgentState[],
  cfg: RunConfig,
): RunCheckpoint {
  return {
    runId,
    phase,
    round,
    agentIndex,
    timestamp: Date.now(),
    transcriptSnapshot: transcript.slice(),
    agentStates: agentStates.slice(),
    configSnapshot: {
      preset: cfg.preset,
      agentCount: cfg.agentCount,
      rounds: cfg.rounds,
      model: cfg.model,
      userDirective: cfg.userDirective,
    },
  };
}