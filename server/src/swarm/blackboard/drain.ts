// Extracted drain / stop lifecycle logic from lifecycleRunner.ts
// Goal: reduce size of the main lifecycle file and isolate drain coordination.

import {
  DRAIN_DEADLINE_MS,
  DRAIN_STUCK_PROMPT_MS,
  DRAIN_STUCK_PROMPT_NO_CLAIMS_MS,
  DRAIN_WATCHER_INTERVAL_MS,
} from "./BlackboardRunnerConstants.js";
import { isStopping as lifecycleIsStopping, isDraining as lifecycleIsDraining } from "./lifecycleState.js";
import type { LifecycleContext } from "./lifecycleRunner.js";
import { drainIneligibleReason, isDrainEligible } from "./drainEligibility.js";

export async function drain(ctx: LifecycleContext): Promise<void> {
  if (lifecycleIsStopping(ctx.getLifecycleState()) || lifecycleIsDraining(ctx.getLifecycleState())) return;

  const counts = ctx.boardCounts();
  const qCounts = ctx.getTodoQueueCounts();
  const eligibility = ctx.getDrainEligibilityInput({
    claimed: counts.claimed,
    pendingCommit: qCounts.pendingCommit,
  });
  if (!isDrainEligible(eligibility)) {
    ctx.appendSystem(
      `Drain not applicable (${drainIneligibleReason(eligibility)}). Stopping immediately.`,
    );
    await stop(ctx);
    return;
  }

  ctx.setLifecycleState("draining");
  ctx.setDrainStartedAt(Date.now());
  // Task #168: marker for the post-run gate — drained runs ARE
  // allowed to fire memory distillation + stretch reflection (the
  // user opted in to "finish work then stop", which is closer to
  // a natural completion than to a hard abort).
  ctx.setWasDrained(true);
  // V2 Step 3b: feed drain event to the parallel reducer.
  ctx.v2ObserverApply({ type: "drain-requested", ts: ctx.getDrainStartedAt()! });
  ctx.setPhase("draining");
  const claimed = counts.claimed;
  ctx.appendSystem(
    `Drain & Stop requested. Workers will finish their current claim (${claimed} in-flight); no new claims. ` +
      `Hung prompts abort after ${DRAIN_STUCK_PROMPT_MS / 60_000} min; full backstop ${DRAIN_DEADLINE_MS / 60_000} min. ` +
      `Press Stop to escalate immediately.`,
  );
  // Cancel pause probe (no point continuing to poll upstream
  // during drain — we're committed to stopping).
  if (ctx.getPauseProbeTimer()) {
    clearTimeout(ctx.getPauseProbeTimer()!);
    ctx.setPauseProbeTimer(undefined);
  }
  ctx.setPaused(false);
  // Task #199: surface unhandled rejections so a single bad tick doesn't
  // become a silent stream of unhandled errors firing every 2s.
  ctx.setDrainWatcherTimer(setInterval(() => {
    checkDrainComplete(ctx).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.appendSystem(`Drain watcher tick failed: ${msg}`);
    });
  }, DRAIN_WATCHER_INTERVAL_MS));
}

export async function checkDrainComplete(ctx: LifecycleContext): Promise<void> {
  if (lifecycleIsStopping(ctx.getLifecycleState()) || !lifecycleIsDraining(ctx.getLifecycleState())) {
    if (ctx.getDrainWatcherTimer()) {
      clearInterval(ctx.getDrainWatcherTimer()!);
      ctx.setDrainWatcherTimer(undefined);
    }
    return;
  }
  const counts = ctx.boardCounts();
  const qCounts = ctx.getTodoQueueCounts();
  const elapsed = Date.now() - (ctx.getDrainStartedAt() ?? Date.now());
  const overDeadline = elapsed >= DRAIN_DEADLINE_MS;
  const stuckMs =
    counts.claimed === 0 && qCounts.pendingCommit === 0
      ? DRAIN_STUCK_PROMPT_NO_CLAIMS_MS
      : DRAIN_STUCK_PROMPT_MS;
  const stuckPrompts =
    elapsed >= stuckMs && ctx.getActiveAborts().size > 0;
  if (stuckPrompts) {
    ctx.appendSystem(
      `Drain: in-flight prompt(s) still running after ${Math.round(elapsed / 1000)}s with no completion — aborting to unblock exit.`,
    );
    for (const ctrl of ctx.getActiveAborts()) {
      try {
        ctrl.abort(new Error("drain: stuck prompt"));
      } catch (err) {
        ctx.appendSystem(`⚠ drain stuck-prompt abort: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  if (counts.claimed === 0 && ctx.getActiveAborts().size === 0) {
    ctx.appendSystem(`Drain complete (${Math.round(elapsed / 1000)}s); escalating to hard stop.`);
    if (ctx.getDrainWatcherTimer()) {
      clearInterval(ctx.getDrainWatcherTimer()!);
      ctx.setDrainWatcherTimer(undefined);
    }
    await ctx.stop();
    return;
  }
  if (overDeadline) {
    ctx.appendSystem(
      `Drain deadline reached (${DRAIN_DEADLINE_MS / 60_000} min) with ${counts.claimed} claim(s) + ${ctx.getActiveAborts().size} prompt(s) still in-flight. Forcing hard stop.`,
    );
    if (ctx.getDrainWatcherTimer()) {
      clearInterval(ctx.getDrainWatcherTimer()!);
      ctx.setDrainWatcherTimer(undefined);
    }
    await ctx.stop();
  }
}

export async function stop(ctx: LifecycleContext): Promise<void> {
  ctx.setUserStopRequested(true);
  ctx.setLifecycleState("stopping");
  // V2 Step 3b: feed user-stop event to the parallel reducer.
  ctx.v2ObserverApply({ type: "stop-requested", ts: Date.now() });
  ctx.setPhase("stopping");
  ctx.stopQueueReaper();
  ctx.stopCapWatchdog();
  ctx.stopReplanWatcher();
  // Task #165: cancel any in-flight quota-pause probe so it doesn't
  // try to resume a run that's being torn down.
  if (ctx.getPauseProbeTimer()) {
    clearTimeout(ctx.getPauseProbeTimer()!);
    ctx.setPauseProbeTimer(undefined);
  }
  ctx.setPaused(false);
  // Task #167: cancel drain watcher if soft-stop is being escalated
  // to hard stop (either by completion or by user clicking Stop
  // during drain).
  if (ctx.getDrainWatcherTimer()) {
    clearInterval(ctx.getDrainWatcherTimer()!);
    ctx.setDrainWatcherTimer(undefined);
  }
  for (const ctrl of ctx.getActiveAborts()) {
    try {
      ctrl.abort(new Error("user stop"));
    } catch (err) {
      ctx.appendSystem(`⚠ lifecycle abortDuringStop: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  ctx.getActiveAborts().clear();
  await ctx.killAll();
  ctx.disposeBoardBroadcaster();
  ctx.setPhase("stopped");

  // Ensure deliverable + run summary are produced even for early stops (e.g. during
  // cloning or spawning, before planAndExecute's finally runs). Late stops will
  // also hit it via the main path, but calling twice is harmless.
  try {
    await ctx.writeBlackboardDeliverable();
  } catch (err) {
    ctx.appendSystem(`Deliverable write on stop failed (best-effort): ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    await ctx.writeRunSummary(ctx.getStartupCrashMessage());
  } catch (err) {
    ctx.appendSystem(`Summary write on stop failed (best-effort): ${err instanceof Error ? err.message : String(err)}`);
  }
}
