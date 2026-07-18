/**
 * Blackboard planAndExecute close-out: final audit, reflection, brain,
 * deliverable, summary, killAll, terminal phase.
 * Extracted from lifecycleRunner.ts.
 */

import type { Agent } from "../../services/AgentManager.js";
import { formatPortReleaseLine } from "../runSummary.js";
import { runBrainAnalysis } from "./brainOverseer/brainOverseer.js";
import { shouldRunFinalAudit } from "./finalAudit.js";
import { WALL_CLOCK_CAP_MS } from "./caps.js";
import {
  runStretchGoalReflectionPass,
  runMemoryDistillationPass,
  runDesignMemoryUpdatePass,
} from "./reflectionPasses.js";
import { isStopping as lifecycleIsStopping } from "./lifecycleState.js";
import { resolveToolProfile } from "../toolProfiles.js";
import type { LifecycleContext } from "./lifecycleRunner.js";

export async function runLifecycleCloseout(
  ctx: LifecycleContext,
  planner: Agent,
  opts: { errored: boolean; crashMessage: string | undefined },
): Promise<void> {
  const { errored, crashMessage } = opts;
    ctx.stopQueueReaper();
    ctx.stopCapWatchdog();
    ctx.stopReplanWatcher();
    // Cap-trip audit: one last pass so the summary's contract reflects
    // true met/wont-do/unmet distribution instead of leaving every
    // unresolved criterion at the default "unmet". shouldRunFinalAudit
    // narrows this to the exact case that benefits — cap trip, no crash,
    // no user stop, budget remaining, unresolved criteria still present.
    // Errors here are swallowed: a missing final audit is worse than
    // "all unmet" but better than trading a useful summary for a crash.
    if (
      shouldRunFinalAudit({
        errored,
        hasContract: !!ctx.getContract() && ctx.getContract()!.criteria.length > 0,
        allCriteriaResolved: ctx.allCriteriaResolved(),
        terminationReason: ctx.getTerminationReason(),
        auditInvocations: ctx.getAuditInvocations(),
        maxInvocations: ctx.maxAuditInvocations,
        // Task #168: drained runs should run the final audit (the
        // user opted into a clean exit + wants final criterion
        // status). Hard user-stop still suppresses.
        userStopped: lifecycleIsStopping(ctx.getLifecycleState()) && !ctx.getTerminationReason() && !ctx.getWasDrained(),
      })
    ) {
      try {
        await ctx.runAuditor(planner, { allowWhenStopping: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.appendSystem(`Final audit failed: ${msg}`);
      }
    }
    // Task #129: stretch-goal reflection pass. Asks the planner one
    // meta-question — "what would the BEST version of this work have
    // done?" — so the next run (or the user) has a launchpad for a
    // more ambitious follow-up. Gated on:
    //   - run did NOT error (a crashed run can't reflect honestly)
    //   - was NOT stopped manually by the user (they explicitly opted
    //     out of finishing — pestering them with reflection is rude)
    //   - has substantive output (committed > 0 OR a contract exists)
    //   - autoStretchReflection !== false (default ON)
    //   - wall-clock cap not exceeded (each pass is a 1-3 min planner
    //     prompt; running them past the user's cap defeats the cap
    //     entirely — see run 0254ca7c which overshot 15-min by 4 min
    //     because reflection happened post-audit unconditionally).
    // Errors are swallowed for the same reason as the final audit:
    // a missing reflection is annoying, not run-fatal.
    // Task #168: differentiate hard-user-stop from drain-stop. Drained
    // runs ARE "the user opted into a clean exit" — let memory +
    // stretch reflection fire so the work isn't lost. Only hard
    // user-stop (Stop button, no drain) suppresses both passes.
    const userStoppedHard =
      lifecycleIsStopping(ctx.getLifecycleState()) && !ctx.getTerminationReason() && !ctx.getWasDrained();
    const counts2 = ctx.boardCounts();
    const hasOutput =
      counts2.committed > 0 ||
      (ctx.getContract()?.criteria.length ?? 0) > 0;
    const overWallClockCap = ctx.isOverWallClockCap();
    if (overWallClockCap) {
      const capMin = Math.round(
        (ctx.getActive()?.wallClockCapMs ?? WALL_CLOCK_CAP_MS) / 60_000,
      );
      ctx.appendSystem(
        `Wall-clock cap (${capMin} min) already exceeded by the time the audit loop ended; skipping post-audit reflection passes (stretch goals, memory distillation, design memory) to honor the cap. Set wallClockCapMs higher to allow them.`,
      );
    }
    // Issue B (2026-04-27): hard-cap watchdog for the reflection
    // block. Pre-fix, isOverWallClockCap was checked PER-PASS so a
    // pass starting at 19m30s with cap=20m would run for 3-5 more
    // min past cap (run 04575ce4 overshot 20-min cap to 25.6 min).
    // Now: a 5s-tick interval polls isOverWallClockCap and aborts
    // the shared signal as soon as cap is hit. Each reflection pass
    // forwards the signal to its session.prompt call, so an
    // in-flight prompt past cap gets aborted promptly.
    const reflectionAbort = new AbortController();
    const reflectionWatchdog = setInterval(() => {
      if (ctx.isOverWallClockCap() && !reflectionAbort.signal.aborted) {
        const capMin = Math.round(
          (ctx.getActive()?.wallClockCapMs ?? WALL_CLOCK_CAP_MS) / 60_000,
        );
        ctx.appendSystem(
          `Wall-clock cap (${capMin} min) hit during reflection passes — aborting any in-flight reflection prompt to honor the cap.`,
        );
        reflectionAbort.abort(new Error("wallClockCapMs hit during reflection passes"));
      }
    }, 5_000);
    reflectionWatchdog.unref?.();
    // Task #164 (refactor): build the reflection context once and
    // pass to both extracted helpers.
    const reflectionCtx = ctx.buildReflectionContext(planner, reflectionAbort.signal);
    if (
      !errored &&
      !userStoppedHard &&
      hasOutput &&
      !overWallClockCap &&
      ctx.getActive()?.autoStretchReflection !== false
    ) {
      try {
        await runStretchGoalReflectionPass(planner, reflectionCtx);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.appendSystem(`Stretch-goal reflection failed: ${msg}`);
      }
    }
    // Task #130: persistent memory write. Runs AFTER the stretch
    // reflection so the planner has the most context (commits +
    // contract resolution + stretch goals all in transcript) when
    // distilling lessons. Same gating as stretch reflection plus
    // autoMemory !== false. Errors swallowed; missing memory write
    // is annoying, not run-fatal.
    if (
      !errored &&
      !userStoppedHard &&
      hasOutput &&
      !overWallClockCap &&
      ctx.getActive()?.autoMemory !== false
    ) {
      try {
        await runMemoryDistillationPass(planner, ctx.getActive()?.localPath, reflectionCtx);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.appendSystem(`Memory distillation failed: ${msg}`);
      }
    }
    // Task #177: design memory update pass. Runs AFTER memory
    // distillation so the planner has the freshest engineering
    // lessons to inform its creative/product update. Same gates
    // as the other reflection passes plus autoDesignMemory !== false.
    if (
      !errored &&
      !userStoppedHard &&
      hasOutput &&
      !overWallClockCap &&
      ctx.getActive()?.autoDesignMemory !== false
    ) {
      try {
        await runDesignMemoryUpdatePass(planner, ctx.getActive()?.localPath, reflectionCtx);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.appendSystem(`Design memory update failed: ${msg}`);
      }
    }
    // Plan 4: brain system overseer — run post-run analysis after design memory.
    // This analyzes interaction chains and exception patterns, then generates
    // improvement proposals. Best-effort — never blocks the summary write.
    if (
      !errored &&
      !userStoppedHard &&
      hasOutput &&
      !overWallClockCap
    ) {
      try {
        // Create a prompt function that uses promptPlannerSafely
        const brainModel = ctx.getActive()?.model ?? "deepseek-v4-flash:cloud";
        const brainPromptFn = async (prompt: string, model: string, maxTokens: number, timeoutMs: number): Promise<string> => {
          const activeForTools = ctx.getActive();
          // RR-C PR5: honor webTools/plannerTools instead of always swarm-planner.
          const brainProfile = resolveToolProfile("planner", activeForTools);
          const plannerAgent: Agent = { id: "brain", index: 0, model, port: 0, sessionId: "brain", cwd: activeForTools?.localPath ?? "" };
          const { response } = await ctx.promptPlannerSafely(
            plannerAgent,
            prompt,
            brainProfile,
          );
          return response;
        };

        const activeCfg = ctx.getActive();
        const clonePath = activeCfg?.localPath ?? "";
        const activeRunId = activeCfg?.runId ?? "";
        const enableBrain = activeCfg?.enableBrainAnalysis !== false;
        const brainService = ctx.getBrainService();
        let brainResult: any = null;
        if (enableBrain && activeCfg) {
          brainResult = brainService
            ? await brainService.analyzeRun(
                ctx.getInteractionTracker(),
                ctx.getExceptionCollector(),
                clonePath,
                activeRunId,
                brainPromptFn,
                brainModel,
              )
            : await runBrainAnalysis(
                ctx.getInteractionTracker(),
                ctx.getExceptionCollector(),
                clonePath,
                activeRunId,
                [],
                brainPromptFn,
                brainModel,
              );
        }
        if (brainResult) {
          const insightCount = brainResult.insights?.length ?? 0;
          ctx.appendSystem(
            `[brain-overseer] Analysis complete: ${brainResult.exceptions.totalExceptions} exceptions, ${brainResult.chains.length} chains, ${insightCount} insights.`,
          );
          // Log insights (librarian final analysis)
          for (const p of (brainResult.insights || [])) {
            ctx.appendSystem(`[brain-overseer] Insight: ${p.title} (${p.priority}${p.category ? " / " + p.category : ""})`);
          }
          // Log summary analysis
          ctx.appendSystem(
            `[brain-overseer] Historical: ${brainResult.summaryAnalysis.totalRuns} runs, ${(brainResult.summaryAnalysis.successRate * 100).toFixed(0)}% success, trend: ${brainResult.summaryAnalysis.recentTrend}`,
          );
        } else {
          ctx.appendSystem(`[brain-overseer] Analysis skipped (enableBrainAnalysis=false).`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.appendSystem(`Brain overseer analysis failed: ${msg}`);
      }
    }
    // Issue B: stop the reflection-cap watchdog now that all
    // reflection passes are done. The setInterval would otherwise
    // keep firing isOverWallClockCap probes until process exit.
    clearInterval(reflectionWatchdog);
    // 2026-05-02 (blackboard feature #4 — auto-rollback): fire
    // BEFORE the deliverable so the audit trail appears in the
    // deliverable's "Auto-rollbacks fired" section. Decision rules:
    //   - cfg.autoRollback === true (decision #5: opt-in)
    //   - !user-stop && !cap-trip (decision #4: never on intentional exit)
    //   - per-criterion granularity (decision #2)
    //   - refuse-on-collateral safety (decision #3)
    if (
      !errored &&
      ctx.getActive()?.autoRollback === true &&
      !(lifecycleIsStopping(ctx.getLifecycleState()) && !ctx.getTerminationReason()) &&
      !ctx.getTerminationReason()
    ) {
      try {
        await ctx.runAutoRollbacks();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.appendSystem(`[auto-rollback] orchestrator failed (best-effort): ${msg}`);
      }
    }
    // 2026-05-02 (blackboard features #1, #2, #3, #5): structured
    // markdown deliverable with PR-shaped output, diff-aware critic,
    // and coverage-gap detection. Best-effort — never blocks the
    // summary write below.
    // Always attempt (even on early stop or error) so deliverable + next-actions
    // are generated from final transcript/contract state.
    try {
      await ctx.writeBlackboardDeliverable();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.appendSystem(`Deliverable write failed (best-effort): ${msg}`);
    }
    // Pattern cache write-back: persist in-run exception fingerprints even
    // when brain analysis is disabled (read path exists at run start).
    try {
      const clonePath = ctx.getActive()?.localPath ?? "";
      const runId = ctx.getActive()?.runId ?? "";
      const events = ctx.getExceptionCollector().getAll();
      if (clonePath && events.length > 0) {
        const { persistExceptionPatterns } = await import("./brainOverseer/patternCache.js");
        await persistExceptionPatterns(clonePath, runId, events);
      }
    } catch {
      // best-effort — never block summary write
    }
    // Phase 9: always try to write a summary, regardless of how we got
    // here (completed / stopped / failed / cap). Awaited so the file and
    // the broadcast event land before the terminal phase transition, so
    // a UI consumer reacting to `completed|stopped|failed` can trust the
    // summary is already available.
  await ctx.writeRunSummary(crashMessage);
  // Ensure the final snapshot lands even if the debounce timer hasn't fired.
  ctx.flushBoardBroadcasterSnapshot();
  // User-initiated stop: stop() sets phase to "stopping" → "stopped" itself,
  // so we bail. Cap-initiated stop also sets this.stopping, but we detect
  // that via terminationReason and fall through to setPhase("completed")
  // so the UI reflects the run actually finishing at the cap boundary.
  if (lifecycleIsStopping(ctx.getLifecycleState()) && !ctx.getTerminationReason()) {
    await ctx.flushStateWrite();
    return;
  }
  // Unit 55: auto-killAll on natural completion (and on errored
  // termination). Before this unit, only stop() killed agents — a
  // run that finished naturally ("auditor produced no new work,"
  // all-met, cap reached) left every opencode subprocess and cloud
  // session alive, holding ports + paying cloud upkeep until the
  // user/Claude manually intervened. Mirrors the killAll inside
  // stop(): same verified-kill semantics from Unit 41 (poll +
  // taskkill escalation + pidTracker.remove). Idempotent if a
  // sibling code path already cleared the roster.
  // Task #68: surface the kill result in the transcript.
  const killResult = await ctx.killAll();
  ctx.appendSystem(formatPortReleaseLine(killResult));
  // V2 Step 3b: feed terminal event to the parallel reducer.
  if (errored) {
    ctx.v2ObserverApply({
      type: "fatal-error",
      ts: Date.now(),
      message: crashMessage ?? "(no message)",
    });
  }
  ctx.setPhase(errored ? "failed" : "completed");
  // Unit 31: final non-debounced write so the on-disk state reflects the
  // terminal phase even if the debounced timer hasn't fired yet.
  ctx.clearStateSnapshotScheduler();
  await ctx.flushStateWrite();
}
