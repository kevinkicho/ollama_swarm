// Council progress ledger + terminal messaging — extracted from CouncilRunner.

import type { Agent } from "../services/AgentManager.js";
import type { SwarmEvent, TranscriptEntry } from "../types.js";
import type { StallGateVerdict } from "@ollama-swarm/shared/swarmControl/types";
import type { CouncilAdapterState } from "./councilAdapter.js";
import {
  appendLedgerObservation,
  buildProgressContextBlock,
  saveCouncilProgressLedger,
  wrapProgressContextForPrompt,
  type CouncilProgressLedger,
} from "./councilProgressLedger.js";
import { v2QueueCountsToWireCounts } from "./blackboard/boardWireCompat.js";
import type { SwarmControlCenter } from "./control/SwarmControlCenter.js";

export interface CouncilProgressHost {
  progressLedger: CouncilProgressLedger;
  state: CouncilAdapterState;
  transcript: TranscriptEntry[];
  cycleTranscriptStart: number;
  stuckCycleCount: number;
  swarmControl: SwarmControlCenter;
  getActiveLocalPath: () => string | undefined;
  getActiveRunId: () => string | undefined;
  appendSystem: (text: string) => void;
  emit: (e: SwarmEvent) => void;
  closingRequested: () => boolean;
  getEarlyStopDetail: () => string | undefined;
}

export function appendCouncilTerminalMessage(host: CouncilProgressHost): void {
  const detail = host.getEarlyStopDetail();
  if (host.closingRequested() && !detail) {
    host.appendSystem("[audit] Council stopped: user stop/drain.");
    host.emit({
      type: "error",
      message: "council_stop_reason: user stop/drain",
    } as SwarmEvent);
    return;
  }
  if (detail) {
    host.appendSystem(`[audit] Council stopped: ${detail}`);
    host.emit({
      type: "error",
      message: `council_stop_reason: ${detail}`,
    } as SwarmEvent);
    return;
  }
  host.appendSystem("Council complete.");
  host.emit({
    type: "error",
    message: "council_stop_reason: complete",
  } as SwarmEvent);
}

export function syncProgressContext(host: CouncilProgressHost): void {
  const block = buildProgressContextBlock(host.progressLedger);
  const wrapped = wrapProgressContextForPrompt(block);
  host.state.progressContext = wrapped || undefined;
}

export function prependCouncilControlHints(host: CouncilProgressHost): void {
  const sessionHint = host.swarmControl.consumeSessionPlannerHint();
  if (!sessionHint) return;
  const tag = `[Swarm control — session]\n${sessionHint}\n[End swarm control]\n\n`;
  host.state.progressContext = tag + (host.state.progressContext ?? "");
}

export async function evaluateCouncilStallGate(
  host: CouncilProgressHost,
  planner: Agent,
  providerStall?: string,
): Promise<StallGateVerdict | null> {
  const wire = v2QueueCountsToWireCounts(host.state.todoQueue.counts());
  return host.swarmControl.evaluateStallGate({
    board: {
      open: wire.open + wire.claimed,
      stale: wire.stale,
      skipped: wire.skipped,
      committed: wire.committed,
      total: wire.total,
    },
    contract: host.state.contract,
    stuckCycles: host.stuckCycleCount,
    providerStall,
    todos: host.state.todoQueue.list() as unknown as import("./blackboard/types.js").Todo[],
    coachAgent: planner,
    clonePath: host.getActiveLocalPath(),
    runId: host.getActiveRunId(),
    appendSystem: (msg) => host.appendSystem(msg),
    emit: (e) => host.emit(e),
  });
}

export function persistProgressLedger(host: CouncilProgressHost): void {
  const clonePath = host.getActiveLocalPath();
  const runId = host.getActiveRunId();
  if (!clonePath || !runId) return;
  saveCouncilProgressLedger(clonePath, host.progressLedger);
}

export function cycleTranscriptSlice(host: CouncilProgressHost): TranscriptEntry[] {
  return host.transcript.slice(host.cycleTranscriptStart);
}

export function recordTodoSettled(
  host: CouncilProgressHost,
  cycle: number,
  info: {
    description: string;
    expectedFiles?: readonly string[] | null;
    outcome: "completed" | "skipped" | "failed";
    detail?: string;
  },
): void {
  // Guard: missing/non-array expectedFiles crashed runs (88f8c1e5) when
  // settlement callback omitted the field.
  const files = Array.isArray(info.expectedFiles) ? [...info.expectedFiles] : [];
  if (info.outcome === "completed") {
    appendLedgerObservation(host.progressLedger, {
      kind: "commit",
      text: info.description.slice(0, 400),
      cycle,
      files: files.length ? files : undefined,
    });
    for (const f of files) {
      if (!host.state.committedFiles.includes(f)) host.state.committedFiles.push(f);
    }
    return;
  }
  if (info.outcome === "skipped") {
    appendLedgerObservation(host.progressLedger, {
      kind: "skip",
      text: info.detail
        ? `${info.description.slice(0, 200)} — ${info.detail.slice(0, 180)}`
        : info.description.slice(0, 400),
      cycle,
      files: files.length ? files : undefined,
    });
    return;
  }
  appendLedgerObservation(host.progressLedger, {
    kind: "fail",
    text: info.detail
      ? `${info.description.slice(0, 160)} — ${info.detail.slice(0, 200)}`
      : info.description.slice(0, 400),
    cycle,
    files: files.length ? files : undefined,
  });
}

export function finalizeCycleProgress(host: CouncilProgressHost, cycle: number): void {
  host.progressLedger.lastCycle = cycle;
  syncProgressContext(host);
  persistProgressLedger(host);
}
