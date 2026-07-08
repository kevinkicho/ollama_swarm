// Extracted from BlackboardRunner.ts — cap/pause/watchdog subsystem.
// Manages wall-clock/token/cost cap enforcement, quota-wall pause/resume,
// memory-pressure pause, subscriber-disconnect pause, and the cap watchdog.
// Takes a narrow context object instead of referencing `this.*`.

import type { LifecycleState } from "./lifecycleState.js";
import type { Agent } from "../../services/AgentManager.js";
import type { RunConfig } from "../SwarmRunner.js";
import type { TranscriptEntrySummary } from "../../types.js";
import type { BoardCounts } from "./types.js";
import type { TickAccumulator } from "./caps.js";
import {
  MAX_PAUSE_TOTAL_MS,
} from "./BlackboardRunnerConstants.js";
import {
  advanceTickAccumulator,
  checkCaps,
  WALL_CLOCK_CAP_MS,
} from "./caps.js";
import {
  nextQuotaProbeDelayMs,
  formatProbeDelayLabel,
} from "../quotaProbeBackoff.js";
import {
  shouldHaltOnQuota,
  tokenBudgetExceeded,
  tokenTracker,
} from "../../services/ollamaProxy.js";
import { costCapExceeded } from "../../services/CostTracker.js";
import { chatOnce } from "../chatOnce.js";
import { checkMemoryPressure } from "../memoryPressure.js";
import { type ErrorCategory } from "../errorTaxonomy.js";
import { config as appConfig } from "../../config.js";

export interface CapContext {
  // --- state getters / setters (field backings stay on BlackboardRunner) ---
  getPaused: () => boolean;
  setPaused: (v: boolean) => void;
  getPauseStartedAt: () => number | undefined;
  setPauseStartedAt: (v: number | undefined) => void;
  getTotalPausedMs: () => number;
  setTotalPausedMs: (v: number) => void;
  getPauseProbeTimer: () => NodeJS.Timeout | undefined;
  setPauseProbeTimer: (v: NodeJS.Timeout | undefined) => void;
  getPauseProbeAttempt: () => number;
  setPauseProbeAttempt: (v: number) => void;
  getCapWatchdog: () => NodeJS.Timeout | undefined;
  setCapWatchdog: (v: NodeJS.Timeout | undefined) => void;
  getMemoryPaused: () => boolean;
  setMemoryPaused: (v: boolean) => void;
  getLastMemoryPressureLevel: () => "ok" | "throttle" | "pause";
  setLastMemoryPressureLevel: (v: "ok" | "throttle" | "pause") => void;
  getSubscriberPaused: () => boolean;
  setSubscriberPaused: (v: boolean) => void;
  getLifecycleState: () => LifecycleState;
  setLifecycleState: (v: LifecycleState) => void;
  getTickAccumulator: () => TickAccumulator | undefined;
  setTickAccumulator: (v: TickAccumulator | undefined) => void;
  getRunStartedAt: () => number | undefined;
  getTokenBaselineForRun: () => number | undefined;
  getTerminationReason: () => string | undefined;
  setTerminationReason: (v: string | undefined) => void;

  // --- activeAbort controller set (mutate in place via .abort) ---
  getActiveAborts: () => Set<AbortController>;

  // --- run config / per-run overrides ---
  getActive: () => RunConfig | undefined;

  // --- board helpers ---
  boardCounts: () => BoardCounts;

  // --- planner for pause probe ---
  getPlanner: () => Agent | undefined;

  // --- misc ---
  isStopping: () => boolean;
  // shorthand: isStopping() === lifecycleState === "stopping"
  appendSystem: (msg: string, summary?: TranscriptEntrySummary) => void;
  setPhase: (phase: string) => void;
  v2ObserverApply: (event: { type: string; ts: number; reason?: string }) => void;
  recordError: (err: unknown, opts: { causeHint?: ErrorCategory; statusCode?: number }) => void;
}

export function isOverWallClockCap(ctx: CapContext): boolean {
  const acc = ctx.getTickAccumulator();
  if (acc === undefined) return false;
  const cap = ctx.getActive()?.wallClockCapMs ?? WALL_CLOCK_CAP_MS;
  const { next } = advanceTickAccumulator(acc, Date.now());
  ctx.setTickAccumulator(next);
  return next.activeElapsedMs >= cap;
}

export function checkAndApplyCaps(ctx: CapContext): boolean {
  if (ctx.isStopping()) return true;
  if (ctx.getRunStartedAt() === undefined || ctx.getTickAccumulator() === undefined) {
    return false;
  }
  if (ctx.getPaused()) return false;
  const now = Date.now();
  const acc = ctx.getTickAccumulator()!;
  const { next, jumpMs } = advanceTickAccumulator(acc, now);
  ctx.setTickAccumulator(next);
  if (jumpMs > 60_000) {
    const skippedMin = Math.round(jumpMs / 60_000);
    ctx.appendSystem(
      `Clock jump detected: ~${skippedMin} min skipped from cap math (host sleep?).`,
    );
  }
  const counts = ctx.boardCounts();
  const reason = checkCaps({
    startedAt: 0,
    now: next.activeElapsedMs,
    committed: counts.committed,
    wallClockCapMs: ctx.getActive()?.wallClockCapMs,
  });
  const tokenBaseline = ctx.getTokenBaselineForRun();
  const tokenReason = (
    tokenBaseline !== undefined &&
    tokenBudgetExceeded(tokenBaseline, ctx.getActive()?.tokenBudget)
  )
    ? `token-budget reached (${ctx.getActive()?.tokenBudget?.toLocaleString()} tokens)`
    : null;
  const costReason = (
    ctx.getRunStartedAt() !== undefined &&
    costCapExceeded(tokenTracker.recordsSinceTs(ctx.getRunStartedAt()!), ctx.getActive()?.maxCostUsd)
  )
    ? `cost-cap reached ($${ctx.getActive()?.maxCostUsd?.toFixed(2)} USD)`
    : null;
  const runId = ctx.getActive()?.runId;
  if (tokenBaseline !== undefined && shouldHaltOnQuota(runId)) {
    const quotaState = tokenTracker.getQuotaState(runId);
    enterPause(ctx, quotaState);
    return false;
  }
  const finalReason = reason ?? tokenReason ?? costReason;
  if (!finalReason) return false;
  ctx.setTerminationReason(finalReason);
  ctx.appendSystem(`Stopping: ${finalReason}`);
  ctx.setLifecycleState("stopping");
  for (const ctrl of ctx.getActiveAborts()) {
    try {
      ctrl.abort(new Error(`cap: ${finalReason}`));
    } catch {
      // best-effort
    }
  }
  return true;
}

export function enterPause(
  ctx: CapContext,
  quotaState: { statusCode: number; reason: string } | null,
): void {
  if (ctx.getPaused()) return;
  ctx.setPaused(true);
  const now = Date.now();
  ctx.setPauseStartedAt(now);
  ctx.v2ObserverApply({
    type: "pause-on-quota",
    ts: now,
    reason: quotaState
      ? `${quotaState.statusCode}: ${quotaState.reason.slice(0, 60)}`
      : "(no quota detail)",
  });
  ctx.setPhase("paused");
  const detail = quotaState
    ? `${quotaState.statusCode}: ${quotaState.reason.slice(0, 120)}`
    : "(no quota detail)";
  ctx.appendSystem(
    `Ollama quota wall hit (${detail}). Pausing run; will probe upstream on exponential back-off (1m → 2m → 4m → 8m → 16m, capped at 30m) and resume when it clears. Total pause cap: ${MAX_PAUSE_TOTAL_MS / 60_000} min.`,
    { kind: "quota_paused", statusCode: quotaState?.statusCode, reason: quotaState?.reason },
  );
  for (const ctrl of ctx.getActiveAborts()) {
    try {
      ctrl.abort(new Error("paused: quota wall"));
    } catch {
      // best-effort
    }
  }
  schedulePauseProbe(ctx);
}

export function schedulePauseProbe(ctx: CapContext): void {
  if (ctx.getPauseProbeTimer()) return;
  const delayMs = nextQuotaProbeDelayMs(ctx.getPauseProbeAttempt());
  ctx.setPauseProbeAttempt(ctx.getPauseProbeAttempt() + 1);
  const timer = setTimeout(() => {
    ctx.setPauseProbeTimer(undefined);
    runPauseProbe(ctx).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.appendSystem(`Pause probe failed: ${msg}. Will retry.`);
      if (ctx.getPaused() && !ctx.isStopping()) schedulePauseProbe(ctx);
    });
  }, delayMs);
  ctx.setPauseProbeTimer(timer);
}

export async function runPauseProbe(ctx: CapContext): Promise<void> {
  if (!ctx.getPaused() || ctx.isStopping()) return;
  const pauseStartedAt = ctx.getPauseStartedAt();
  const totalSoFar = ctx.getTotalPausedMs() + (pauseStartedAt ? Date.now() - pauseStartedAt : 0);
  if (totalSoFar >= MAX_PAUSE_TOTAL_MS) {
    ctx.setTotalPausedMs(totalSoFar);
    ctx.setPauseStartedAt(undefined);
    ctx.setPaused(false);
    const q = tokenTracker.getQuotaState(ctx.getActive()?.runId);
    const detail = q ? `${q.statusCode}: ${q.reason.slice(0, 120)}` : "(no detail)";
    const reason = `ollama-quota-exhausted (${detail}) — pause cap exceeded after ${Math.round(totalSoFar / 60_000)} min`;
    ctx.setTerminationReason(reason);
    ctx.appendSystem(
      `Pause cap of ${MAX_PAUSE_TOTAL_MS / 60_000} min exceeded; upstream wall never cleared. Stopping permanently.`,
    );
    ctx.setLifecycleState("stopping");
    for (const ctrl of ctx.getActiveAborts()) {
      try { ctrl.abort(new Error("paused: cap exceeded")); } catch { /* */ }
    }
    return;
  }
  const planner = ctx.getPlanner();
  if (!planner) {
    schedulePauseProbe(ctx);
    return;
  }
  let probeOk = false;
  try {
    const probeRes = await chatOnce(planner, {
      agentName: "swarm-read",
      promptText: "ping",
    });
    void probeRes;
    probeOk = true;
  } catch (err) {
    ctx.recordError(err, { causeHint: "quota" });
    const msg = err instanceof Error ? err.message : String(err);
    const nextDelayLabel = formatProbeDelayLabel(nextQuotaProbeDelayMs(ctx.getPauseProbeAttempt()));
    ctx.appendSystem(`[quota-probe] still walled (${msg.slice(0, 120)}). Next probe in ${nextDelayLabel}.`);
  }
  if (!ctx.getPaused() || ctx.isStopping()) return;
  const probeRunId = ctx.getActive()?.runId;
  if (probeOk && !shouldHaltOnQuota(probeRunId)) {
    if (probeRunId) tokenTracker.clearQuotaState(probeRunId);
    else tokenTracker.clearQuotaState();
    exitPause(ctx);
    return;
  }
  if (probeOk && shouldHaltOnQuota(probeRunId)) {
    ctx.appendSystem("[quota-probe] probe succeeded but proxy re-flagged quota mid-flight; staying paused.");
  }
  schedulePauseProbe(ctx);
}

export function exitPause(ctx: CapContext): void {
  if (!ctx.getPaused()) return;
  const pauseStartedAt = ctx.getPauseStartedAt();
  const pauseDur = pauseStartedAt ? Date.now() - pauseStartedAt : 0;
  ctx.setTotalPausedMs(ctx.getTotalPausedMs() + pauseDur);
  ctx.setPauseStartedAt(undefined);
  ctx.setPaused(false);
  ctx.setPauseProbeAttempt(0);
  const pauseProbeTimer = ctx.getPauseProbeTimer();
  if (pauseProbeTimer) {
    clearTimeout(pauseProbeTimer);
    ctx.setPauseProbeTimer(undefined);
  }
  const acc = ctx.getTickAccumulator();
  if (acc) {
    ctx.setTickAccumulator({ ...acc, lastTickAt: Date.now() });
  }
  ctx.v2ObserverApply({ type: "resume-from-quota", ts: Date.now() });
  ctx.setPhase("executing");
  ctx.appendSystem(
    `Quota wall cleared after ${Math.round(pauseDur / 60_000)} min. Resuming run (total paused this run: ${Math.round(ctx.getTotalPausedMs() / 60_000)} min).`,
    { kind: "quota_resumed", pausedMs: pauseDur, totalPausedMs: ctx.getTotalPausedMs() },
  );
}

export function startCapWatchdog(ctx: CapContext): void {
  if (ctx.getCapWatchdog()) return;
  const timer = setInterval(() => {
    if (ctx.isStopping()) {
      if (ctx.getCapWatchdog()) {
        clearInterval(ctx.getCapWatchdog()!);
        ctx.setCapWatchdog(undefined);
      }
      return;
    }
    checkAndApplyCaps(ctx);
    if (appConfig.SWARM_MEMORY_BACKPRESSURE) {
      checkMemoryPressureTick(ctx);
    }
  }, 5_000);
  ctx.setCapWatchdog(timer);
  timer.unref?.();
}

export function stopCapWatchdog(ctx: CapContext): void {
  const wd = ctx.getCapWatchdog();
  if (wd) clearInterval(wd);
  ctx.setCapWatchdog(undefined);
}

export function checkMemoryPressureTick(ctx: CapContext): void {
  const v = checkMemoryPressure();
  if (v.level === "pause" && !ctx.getMemoryPaused()) {
    ctx.setMemoryPaused(true);
    ctx.appendSystem(
      `[memory] auto-pause: heap pressure CRITICAL (${(v.ratio * 100).toFixed(0)}%) — workers idling until GC catches up.`,
    );
  } else if (v.level === "ok" && ctx.getMemoryPaused()) {
    ctx.setMemoryPaused(false);
    ctx.appendSystem(`[memory] resume: heap pressure recovered (${(v.ratio * 100).toFixed(0)}%) — workers active again.`);
  }
  if (v.level === ctx.getLastMemoryPressureLevel()) return;
  if (v.level === "throttle") {
    ctx.appendSystem(
      `[memory] heap pressure HIGH (${(v.ratio * 100).toFixed(0)}% of ${(v.limitBytes / 1024 / 1024).toFixed(0)} MB) — GC may slow incoming prompts.`,
    );
  }
  ctx.setLastMemoryPressureLevel(v.level);
}

export function setSubscriberPaused(ctx: CapContext, paused: boolean): void {
  if (ctx.getSubscriberPaused() === paused) return;
  ctx.setSubscriberPaused(paused);
  if (paused) {
    ctx.appendSystem(`[subscribers] auto-pause: no browser watching — workers idling.`);
  } else {
    ctx.appendSystem(`[subscribers] resume: subscriber reconnected — workers active again.`);
  }
}