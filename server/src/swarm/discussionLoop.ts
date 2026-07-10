// Shared discussion loop skeleton + round budget guard — extracted from DiscussionRunnerBase.

import type { AgentManager } from "../services/AgentManager.js";
import type { SwarmEvent, SwarmPhase } from "../types.js";
import type { RunConfig } from "./SwarmRunner.js";
import { snapshotLifetimeTokens } from "../services/ollamaProxy.js";
import { checkBudgetGuards } from "./loopGuards.js";
import { runDiscussionCloseOut } from "./runFinallyHooks.js";
import type { CloseOutHooks } from "./runFinallyHooks.js";
import type { RunOutcome } from "./outcomeScorer.js";

export interface DiscussionLoopHost {
  manager: AgentManager;
  emit: (e: SwarmEvent) => void;
  getStopping: () => boolean;
  getEarlyStopDetail: () => string | undefined;
  setEarlyStopDetail: (d: string | undefined) => void;
  getRound: () => number;
  setRound: (r: number) => void;
  getPhase: () => SwarmPhase;
  setPhase: (p: SwarmPhase) => void;
  appendSystem: (text: string) => void;
  writeSummary: (cfg: RunConfig, crashMessage?: string) => Promise<void>;
}

export type DiscussionLoopCloseOutHooks = CloseOutHooks & {
  transcript?: Array<{ text: string; role: string }>;
  deliverableText?: string;
  wallClockMs?: number;
  emitOutcome?: (outcome: RunOutcome) => void;
};

/**
 * Shared discussion loop skeleton. Handles try/catch error capture
 * and finally closeOut. The inner function receives (cfg) and runs
 * the preset-specific rounds loop.
 */
export async function runDiscussionLoop(
  host: DiscussionLoopHost,
  cfg: RunConfig,
  _presetName: string,
  runRounds: (cfg: RunConfig) => Promise<void>,
  closeOutHooks?: DiscussionLoopCloseOutHooks,
): Promise<void> {
  let crashMessage: string | undefined;
  try {
    await runRounds(cfg);
  } catch (err) {
    crashMessage = err instanceof Error ? err.message : String(err);
    host.emit({ type: "error", message: crashMessage });
  } finally {
    await runDiscussionCloseOut({
      cfg,
      crashMessage,
      stopping: host.getStopping(),
      earlyStopDetail: host.getEarlyStopDetail(),
      round: host.getRound(),
      currentPhase: host.getPhase(),
      manager: host.manager,
      appendSystem: (text: string) => host.appendSystem(text),
      setPhase: (p) => host.setPhase(p),
      writeSummary: () => host.writeSummary(cfg, crashMessage),
      hooks: closeOutHooks?.pickReflectionAgent
        ? {
            pickReflectionAgent: closeOutHooks.pickReflectionAgent,
            buildReflectionContext: closeOutHooks.buildReflectionContext,
            shouldSetCompleted: closeOutHooks.shouldSetCompleted,
          }
        : {
            onIdleAgentDetection: (idleReport: string) => {
              host.appendSystem(idleReport);
            },
          } as unknown as CloseOutHooks,
      transcript: closeOutHooks?.transcript as any,
      deliverableText: closeOutHooks?.deliverableText,
      wallClockMs: closeOutHooks?.wallClockMs,
      emitOutcome: closeOutHooks?.emitOutcome,
    });
  }
}

/**
 * Budget guard + round-state update + emit. Call at the top of each
 * round iteration. Returns true if the round should proceed.
 */
export function checkRoundBudget(
  host: DiscussionLoopHost,
  cfg: RunConfig,
  presetName: string,
  r: number,
  tokenBaseline: ReturnType<typeof snapshotLifetimeTokens>,
): boolean {
  if (host.getStopping()) return false;
  const guard = checkBudgetGuards({
    tokenBaseline,
    tokenBudget: cfg.tokenBudget,
    round: r,
    totalRounds: cfg.rounds,
    runId: cfg.runId,
    unit: (
      presetName.toLowerCase().includes("map") ||
      presetName.toLowerCase().includes("orchestrator") ||
      presetName.toLowerCase().includes("blackboard")
    )
      ? "cycle"
      : "round",
  });
  if (guard.halt) {
    host.setEarlyStopDetail(guard.earlyStopDetail);
    host.appendSystem(guard.message ?? "");
    return false;
  }
  host.setRound(r);
  host.emit({ type: "swarm_state", phase: "discussing", round: r });
  return true;
}
