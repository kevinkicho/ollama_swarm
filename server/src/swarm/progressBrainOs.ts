/**
 * Shared Brain OS unstick for zero-progress / fragile runs.
 * Used by blackboard tierRunner and (optionally) council audit.
 */

import {
  shouldEarlyBrainOsUnstick,
  zeroProgressLimitForResilience,
  type ResilienceRollup,
} from "@ollama-swarm/shared/swarmControl/controlAdvice";
import { DEFAULT_ZERO_PROGRESS_LIMIT } from "./productiveProgress.js";
import { rollupResilienceForRun } from "./resilienceAdviceRegistry.js";
import {
  createRunBrainOs,
  dispatchBrainOsConflict,
  resolveBrainOsConfig,
} from "./brainOs/adapter.js";

export interface ProgressBrainOsHooks {
  appendSystem: (msg: string) => void;
  emit?: (e: unknown) => void;
  setZeroProgressStreak: (n: number) => void;
}

export interface ProgressBrainOsRunCfg {
  runId?: string;
  localPath?: string;
  autoApprove?: boolean;
  brainOs?: boolean | object;
  auditorModel?: string;
  model?: string;
}

export function effectiveZeroProgressLimit(
  runId: string | undefined,
  base: number = DEFAULT_ZERO_PROGRESS_LIMIT,
): { limit: number; rollup: ResilienceRollup } {
  const rollup = rollupResilienceForRun(runId);
  return {
    limit: zeroProgressLimitForResilience(base, rollup),
    rollup,
  };
}

/**
 * Recruit Brain OS for progress_stuck. Returns true if streak was reset
 * (caller should continue the run).
 */
export async function tryBrainOsProgressUnstick(
  cfg: ProgressBrainOsRunCfg,
  opts: {
    reason: string;
    board: {
      pending: number;
      inProgress: number;
      pendingCommit: number;
      completed: number;
      skipped: number;
    };
    openWork: boolean;
    phase?: string;
  },
  hooks: ProgressBrainOsHooks,
): Promise<boolean> {
  const bcfg = resolveBrainOsConfig({
    autoApprove: cfg.autoApprove,
    brainOs: cfg.brainOs as boolean | undefined,
  });
  if (!bcfg.enabled || !opts.openWork || !cfg.localPath || !cfg.runId) {
    return false;
  }
  hooks.appendSystem(
    `[progress] ${opts.reason} — recruiting Brain OS (resilience unstick).`,
  );
  const bos = createRunBrainOs(
    {
      autoApprove: cfg.autoApprove,
      brainOs: bcfg,
      auditorModel: cfg.auditorModel,
      model: cfg.model,
    },
    { appendSystem: (t) => hooks.appendSystem(t) },
  );
  const r = await dispatchBrainOsConflict(
    bos,
    {
      runId: cfg.runId,
      kind: "progress_stuck",
      clonePath: cfg.localPath,
      privileges: "arbiter",
      boardSnapshot: opts.board,
      autoApprove: cfg.autoApprove,
      lastErrors: [opts.reason],
      helperModel: cfg.auditorModel ?? cfg.model,
      phase: opts.phase ?? "progress_stuck",
    },
    {
      appendSystem: (t) => hooks.appendSystem(t),
      emit: hooks.emit
        ? (e) => {
            try {
              hooks.emit?.(e);
            } catch {
              /* */
            }
          }
        : undefined,
    },
  );
  if (r.status === "resolved" || r.status === "partial") {
    hooks.setZeroProgressStreak(0);
    hooks.appendSystem(
      `[progress] Brain OS unstuck (${r.status}): ${r.summary.slice(0, 200)} — continuing`,
    );
    return true;
  }
  hooks.appendSystem(
    `[progress] Brain OS unstick ${r.status}: ${r.summary.slice(0, 160)}`,
  );
  return false;
}

export function wantEarlyUnstick(
  streak: number,
  effectiveLimit: number,
  rollup: ResilienceRollup,
): boolean {
  return shouldEarlyBrainOsUnstick(streak, effectiveLimit, rollup);
}
