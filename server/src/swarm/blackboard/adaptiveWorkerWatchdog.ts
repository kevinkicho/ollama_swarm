// Extracted from BlackboardRunner.ts — adaptive worker watchdog subsystem.
// Manages the adaptive worker pool: periodic backlog/depth polling,
// hysteresis-based scale-up/scale-down, and teardown.
// Takes a narrow context object instead of referencing `this.*`.

import type { Agent as AgentType } from "../../services/AgentManager.js";
import type { AgentManager } from "../../services/AgentManager.js";
import type { RunConfig } from "../SwarmRunner.js";
import type { TodoQueue } from "./TodoQueue.js";

export const ADAPTIVE_SUSTAINED_POLLS = 2;

export const ADAPTIVE_WATCHDOG_INTERVAL_MS = 30_000;

export interface AdaptiveWatchdogOpts {
  min: number;
  max: number;
}

export interface AdaptiveWatchdogContext {
  getAdaptiveWatchdog: () => NodeJS.Timeout | undefined;
  setAdaptiveWatchdog: (v: NodeJS.Timeout | undefined) => void;
  getAdaptiveHysteresis: () => { upPolls: number; downPolls: number };
  setAdaptiveHysteresis: (v: { upPolls: number; downPolls: number }) => void;
  getAdaptiveScaleInFlight: () => boolean;
  setAdaptiveScaleInFlight: (v: boolean) => void;
  getActive: () => RunConfig | undefined;
  getManager: () => AgentManager;
  getTodoQueue: () => TodoQueue;
  isStopping: () => boolean;
  appendSystem: (msg: string) => void;
  getBrainService?: () => any; // optional for proactive brain inject
}

export function startAdaptiveWorkerWatchdog(
  ctx: AdaptiveWatchdogContext,
  opts: AdaptiveWatchdogOpts,
): void {
  if (ctx.getAdaptiveWatchdog()) return;
  ctx.setAdaptiveWatchdog(
    setInterval(() => {
      tickAdaptiveWatchdog(ctx, opts);
    }, ADAPTIVE_WATCHDOG_INTERVAL_MS),
  );
  ctx.getAdaptiveWatchdog()!.unref?.();
}

export function tickAdaptiveWatchdog(
  ctx: AdaptiveWatchdogContext,
  opts: AdaptiveWatchdogOpts,
): void {
  if (ctx.getAdaptiveScaleInFlight()) return;
  const counts = ctx.getTodoQueue().counts();
  const openTodos = counts.pending;
  const inProgress = counts.inProgress;
  const totalLive = openTodos + inProgress;
  const workers = ctx
    .getManager()
    .list()
    .filter((a: AgentType) => a.index > 1).length;
  const h = ctx.getAdaptiveHysteresis();
  if (totalLive > workers * 2 && workers < opts.max) {
    ctx.setAdaptiveHysteresis({
      upPolls: h.upPolls + 1,
      downPolls: 0,
    });
    if (h.upPolls + 1 >= ADAPTIVE_SUSTAINED_POLLS) {
      ctx.setAdaptiveHysteresis({ upPolls: 0, downPolls: 0 });
      ctx.setAdaptiveScaleInFlight(true);
      void scaleUpAdaptive(ctx, opts, totalLive)
        .catch((err: unknown) => {
          ctx.appendSystem(
            `[T-Item-4 adaptive workers] scale-up error: ${err instanceof Error ? err.message : String(err)}`,
          );
        })
        .finally(() => {
          ctx.setAdaptiveScaleInFlight(false);
        });
    }
  } else if (totalLive === 0 && workers > opts.min) {
    ctx.setAdaptiveHysteresis({
      upPolls: 0,
      downPolls: h.downPolls + 1,
    });
    if (h.downPolls + 1 >= ADAPTIVE_SUSTAINED_POLLS) {
      ctx.setAdaptiveHysteresis({ upPolls: 0, downPolls: 0 });
      ctx.setAdaptiveScaleInFlight(true);
      void scaleDownAdaptive(ctx, opts)
        .catch((err: unknown) => {
          ctx.appendSystem(
            `[T-Item-4 adaptive workers] scale-down error: ${err instanceof Error ? err.message : String(err)}`,
          );
        })
        .finally(() => {
          ctx.setAdaptiveScaleInFlight(false);
        });
    }
  } else {
    ctx.setAdaptiveHysteresis({ upPolls: 0, downPolls: 0 });
  }
}

export async function scaleUpAdaptive(
  ctx: AdaptiveWatchdogContext,
  opts: AdaptiveWatchdogOpts,
  totalLive: number,
): Promise<void> {
  const cfg = ctx.getActive();
  if (!cfg) return;
  const currentWorkers = ctx
    .getManager()
    .list()
    .filter((a: AgentType) => a.index > 1);
  if (currentWorkers.length >= opts.max) return;
  const recommendedAdd = Math.max(
    1,
    Math.min(
      opts.max - currentWorkers.length,
      Math.ceil(totalLive / 2 - currentWorkers.length),
    ),
  );
  ctx.appendSystem(
    `[T-Item-4 adaptive workers] sustained backlog ≥${ADAPTIVE_SUSTAINED_POLLS} polls; scaling up by ${recommendedAdd} worker(s) (current=${currentWorkers.length}, max=${opts.max}).`,
  );
  // Proactive trigger: on worker stall/backlog, auto-inject suggestion to Brain for transcript
  if (ctx.getBrainService) {
    const brain = ctx.getBrainService();
    if (brain && brain.injectSuggestion) {
      const runId = ctx.getActive()?.runId || 'unknown';
      brain.injectSuggestion(runId, {
        title: 'Worker stall detected - consider amend',
        text: `Sustained backlog. Suggestion: amend directive or increase agents. Current workers: ${currentWorkers.length}`,
        category: 'recommendation',
      });
    }
  }
  const baseIdx = currentWorkers.length + 2;
  for (let i = 0; i < recommendedAdd; i++) {
    try {
      const newAgent = await ctx.getManager().spawnAgentNoOpencode({
        cwd: cfg.localPath,
        index: baseIdx + i,
        model: cfg.workerModel ?? cfg.model,
      });
      ctx.appendSystem(
        `[T-Item-4 adaptive workers] spawned worker ${newAgent.index} (${newAgent.id.slice(0, 8)}).`,
      );
    } catch (err) {
      ctx.appendSystem(
        `[T-Item-4 adaptive workers] spawn failed at index ${baseIdx + i}: ${err instanceof Error ? err.message : String(err)}; will retry next poll.`,
      );
      break;
    }
  }
}

export async function scaleDownAdaptive(
  ctx: AdaptiveWatchdogContext,
  opts: AdaptiveWatchdogOpts,
): Promise<void> {
  const currentWorkers = ctx
    .getManager()
    .list()
    .filter((a: AgentType) => a.index > 1);
  if (currentWorkers.length <= opts.min) return;
  const recommendedKill = currentWorkers.length - opts.min;
  const idleWorkers = currentWorkers.filter(
    (w: AgentType) => !ctx.getManager().isInFlight(w.id),
  );
  if (idleWorkers.length === 0) {
    ctx.appendSystem(
      `[T-Item-4 adaptive workers] backlog drained but all ${currentWorkers.length} workers in-flight; deferring scale-down.`,
    );
    return;
  }
  const toKill = idleWorkers.slice(
    0,
    Math.min(recommendedKill, idleWorkers.length),
  );
  ctx.appendSystem(
    `[T-Item-4 adaptive workers] sustained drain ≥${ADAPTIVE_SUSTAINED_POLLS} polls; killing ${toKill.length} idle worker(s) (min=${opts.min}).`,
  );
  for (const w of toKill) {
    try {
      await ctx.getManager().killAgent(w.id);
      ctx.appendSystem(
        `[T-Item-4 adaptive workers] killed worker ${w.index} (${w.id.slice(0, 8)}).`,
      );
    } catch (err) {
      ctx.appendSystem(
        `[T-Item-4 adaptive workers] kill failed for ${w.id.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export function stopAdaptiveWorkerWatchdog(
  ctx: AdaptiveWatchdogContext,
): void {
  const wd = ctx.getAdaptiveWatchdog();
  if (wd) clearInterval(wd);
  ctx.setAdaptiveWatchdog(undefined);
}