// Unit 31: live blackboard state snapshots on disk.
//
// Written to `<clone>/blackboard-state.json` on every phase change, board
// event, and contract update (debounced trailing-edge inside the runner).
// Gives us two things Phase 9's summary.json and Phase 7's board-final.json
// don't:
//
//   1. MID-RUN VISIBILITY. `cat blackboard-state.json` tells you what the
//      swarm is doing RIGHT NOW — phase, todos, findings, which agent holds
//      what claim — without scraping the WS stream or the JSONL log.
//   2. CRASH FORENSICS beyond board-final.json. `board-final.json` is only
//      written by the crash handler; a truly violent termination (OS kill,
//      power loss, process segfault before the handler fires) doesn't reach
//      it. The live state file is whatever the last debounced write flushed,
//      so a post-mortem always has SOMETHING to read.
//
// What this file is NOT: a "resume" format. Session state for spawned
// opencode subprocesses isn't captured (ports are meaningless after restart;
// sessions can't reattach across server lifetimes). A future unit may read
// this file to drive a fresh-agent resume flow — the contract shape is
// designed to support that — but this unit doesn't implement the read path.
//
// Pure shape-assembly, matching the crashSnapshot pattern. I/O lives in the
// runner.

import type { SwarmPhase } from "../../types.js";
import type { RunConfig } from "../SwarmRunner.js";
import type { PerAgentStat } from "./summary.js";
import type { BoardSnapshot, ExitContract } from "./types.js";

// Bump when the shape changes in a non-backward-compatible way so future
// tooling can gate on version.
export const STATE_SNAPSHOT_VERSION = 1;

export interface StateSnapshotAgentRosterEntry {
  agentId: string;
  agentIndex: number;
}

// Unit 34: per-tier stats captured by the ambition ratchet. Included in
// the state snapshot so mid-run observers + crash-forensics see the
// tier progression, and echoed into the summary at termination.
export interface StateSnapshotTierEntry {
  tier: number;
  missionStatement: string;
  criteriaTotal: number;
  criteriaMet: number;
  criteriaWontDo: number;
  criteriaUnmet: number;
  wallClockMs: number;
  startedAt: number;
  endedAt: number;
}

export interface BlackboardStateSnapshotInput {
  writtenAt: number;
  phase: SwarmPhase;
  round: number;
  /** `Date.now()` when start() began the run (covers clone + seed + plan + exec). */
  runBootedAt?: number;
  /** `Date.now()` when the executing phase began (worker loop origin). */
  runStartedAt?: number;
  /** Unit 27 tick accumulator's `activeElapsedMs` at snapshot time. */
  activeElapsedMs?: number;
  /** Run config stashed at start(). Useful for post-mortem "what was the user trying?" */
  config?: RunConfig;
  contract?: ExitContract;
  board: BoardSnapshot;
  perAgent: PerAgentStat[];
  staleEventCount: number;
  auditInvocations: number;
  agentRoster: StateSnapshotAgentRosterEntry[];
  terminationReason?: string;
  completionDetail?: string;
  // Unit 34: ambition-ratchet state. Absent for pre-Unit-34 snapshots;
  // present (even if tierHistory is empty) for all Unit-34+ runs.
  currentTier?: number;
  tiersCompleted?: number;
  tierHistory?: StateSnapshotTierEntry[];
}

export interface BlackboardStateSnapshot extends BlackboardStateSnapshotInput {
  version: typeof STATE_SNAPSHOT_VERSION;
}

export function buildStateSnapshot(
  input: BlackboardStateSnapshotInput,
): BlackboardStateSnapshot {
  return {
    version: STATE_SNAPSHOT_VERSION,
    ...input,
  };
}

// Debounce interval for the write loop. 1 s is small enough that the
// on-disk view lags the in-memory view by no more than a second under any
// realistic event rate, and large enough that a burst of board events
// (e.g., a planner emitting 12 todos at once) coalesces into ONE write.
// Trailing-edge: every schedule() call resets the timer so only the
// LATEST state gets written.
export const STATE_SNAPSHOT_DEBOUNCE_MS = 1_000;

// Unit 51: read the on-disk snapshot for the resume-contract flow.
// Returns null if the file is missing, unparseable, or doesn't carry
// a valid contract. Best-effort — runner falls back to the normal
// first-pass-contract path on any failure.
//
// Lives in this module so the read path stays next to the write
// path that produced the file (single source of shape truth).
import { promises as fs } from "node:fs";
import path from "node:path";

export async function readBlackboardStateSnapshot(
  clonePath: string,
): Promise<BlackboardStateSnapshot | null> {
  const file = path.join(clonePath, "blackboard-state.json");
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!looksLikeStateSnapshot(parsed)) return null;
  // Future schema bumps: gate here on `version` if we ever ship a
  // breaking change. v1 is the only shape today.
  if ((parsed as BlackboardStateSnapshot).version !== STATE_SNAPSHOT_VERSION) {
    return null;
  }
  return parsed as BlackboardStateSnapshot;
}

// Conservative shape check: just enough to know the snapshot has a
// usable contract. Doesn't validate every optional field.
function looksLikeStateSnapshot(x: unknown): boolean {
  if (typeof x !== "object" || x === null) return false;
  const obj = x as Record<string, unknown>;
  if (typeof obj.version !== "number") return false;
  if (typeof obj.phase !== "string") return false;
  // The resume path needs an actual contract — snapshots from runs
  // that died before first-pass-contract are useless to us.
  const contract = obj.contract as Record<string, unknown> | undefined;
  if (!contract) return false;
  if (typeof contract.missionStatement !== "string") return false;
  if (!Array.isArray(contract.criteria)) return false;
  return true;
}
