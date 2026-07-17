import type { Agent, AgentManager, KillAllResult, SpawnOpts } from "../../services/AgentManager.js";
import type { RunConfig } from "../SwarmRunner.js";
import type { PlannerSeed } from "./prompts/planner.js";
import type { ExitContract } from "./types.js";
import type { SwarmPhase, TranscriptEntry, TranscriptEntrySummary } from "../../types.js";
import type { BlackboardStateSnapshot } from "./stateSnapshot.js";
import type { ClassifiedError, ErrorCategory } from "../errorTaxonomy.js";
import type { FailoverState } from "../promptWithFailover.js";
import type { TickAccumulator } from "./caps.js";
import type { TierHistoryEntry } from "./tierRunner.js";
import { resolveRunSpawnModel } from "../resolveRunSpawnModel.js";

import { formatCloneMessage } from "../cloneMessage.js";
import { formatPortReleaseLine } from "../runSummary.js";
import { readBlackboardStateSnapshot } from "./stateSnapshot.js";
import { assignWorkerRole } from "./workerRoles.js";
import { runBrainAnalysis } from "./brainOverseer/brainOverseer.js";
import type { BrainService } from "./brainOverseer/brainService.js";
import type { InteractionTracker } from "./brainOverseer/interactionTracker.js";
import type { ExceptionCollector } from "./brainOverseer/exceptionCollector.js";
import { shouldRunFinalAudit } from "./finalAudit.js";
import { snapshotLifetimeTokens } from "../../services/ollamaProxy.js";
import { createTickAccumulator, WALL_CLOCK_CAP_MS } from "./caps.js";
import { runGoalGenerationPrePass } from "./goalGenerationPrePass.js";
import {

  shouldRunGoalPrePass,
  shouldSkipPlannerAfterContractFailure,
} from "./planningPolicy.js";
import { runResearchPrePass } from "./researchPrePass.js";
import { makeBufferedToolHandler } from "../toolCallTranscript.js";
import {
  runStretchGoalReflectionPass,
  runMemoryDistillationPass,
  runDesignMemoryUpdatePass,
  type ReflectionContext,
} from "./reflectionPasses.js";
import type { LifecycleState } from "./lifecycleState.js";
import { isStopping as lifecycleIsStopping, isDraining as lifecycleIsDraining } from "./lifecycleState.js";
import {
  DRAIN_DEADLINE_MS,
  DRAIN_WATCHER_INTERVAL_MS,
} from "./BlackboardRunnerConstants.js";
import { drain as doDrain, checkDrainComplete as doCheckDrainComplete, stop as doStop } from "./drain.js";
import { runLifecycleCloseout } from "./lifecycleCloseout.js";
import {
  lifecycleChatSurface,
  assertPlanningWithinWallClock,
} from "./lifecycleHelpers.js";
import { resetLifecycleStateForStart } from "./lifecycleStartReset.js";

// ---------------------------------------------------------------------------
// LifecycleContext — everything the extracted lifecycle methods need
// ---------------------------------------------------------------------------

export interface LifecycleContext {
  // --- lifecycle state machine (replaces stopping/draining/wasDrained booleans) ---
  isRunning(): boolean;
  getLifecycleState(): LifecycleState;
  setLifecycleState(v: LifecycleState): void;
  getWasDrained(): boolean;
  setWasDrained(v: boolean): void;
  getUserStopRequested(): boolean;
  setUserStopRequested(v: boolean): void;
  getStartupCrashMessage(): string | undefined;
  setStartupCrashMessage(v: string | undefined): void;
  getPaused(): boolean;
  setPaused(v: boolean): void;

  // --- simple value fields ---
  getRound(): number;
  setRound(v: number): void;
  getRunStartedAt(): number | undefined;
  setRunStartedAt(v: number | undefined): void;
  getRunBootedAt(): number | undefined;
  setRunBootedAt(v: number | undefined): void;
  getGitPorcelainAtRunStart(): string;
  setGitPorcelainAtRunStart(v: string): void;
  getTokenBaselineForRun(): number | undefined;
  setTokenBaselineForRun(v: number | undefined): void;
  getTickAccumulator(): TickAccumulator | undefined;
  setTickAccumulator(v: TickAccumulator | undefined): void;
  getTerminationReason(): string | undefined;
  setTerminationReason(v: string | undefined): void;
  getDrainStartedAt(): number | undefined;
  setDrainStartedAt(v: number | undefined): void;
  getPauseProbeTimer(): NodeJS.Timeout | undefined;
  setPauseProbeTimer(v: NodeJS.Timeout | undefined): void;
  getDrainWatcherTimer(): NodeJS.Timeout | undefined;
  setDrainWatcherTimer(v: NodeJS.Timeout | undefined): void;
  getPauseStartedAt(): number | undefined;
  setPauseStartedAt(v: number | undefined): void;
  getTotalPausedMs(): number;
  setTotalPausedMs(v: number): void;
  getSubscriberPaused(): boolean;
  setSubscriberPaused(v: boolean): void;
  getMemoryPaused(): boolean;
  setMemoryPaused(v: boolean): void;
  getLastMemoryPressureLevel(): "ok" | "throttle" | "pause";
  setLastMemoryPressureLevel(v: "ok" | "throttle" | "pause"): void;

  // --- complex fields ---
  getActive(): RunConfig | undefined;
  setActive(v: RunConfig): void;
  getContract(): ExitContract | undefined;
  setContract(v: ExitContract | undefined): void;
  getPriorSnapshot(): BlackboardStateSnapshot | null | undefined;
  setPriorSnapshot(v: BlackboardStateSnapshot | null | undefined): void;
  getTranscript(): TranscriptEntry[];
  setTranscript(v: TranscriptEntry[]): void;

  // --- maps / collections ---
  getTurnsPerAgent(): Map<string, number>;
  getAttemptsPerAgent(): Map<string, number>;
  getCommitsPerAgent(): Map<string, number>;
  getLinesAddedPerAgent(): Map<string, number>;
  getLinesRemovedPerAgent(): Map<string, number>;
  getRejectedAttemptsPerAgent(): Map<string, number>;
  getJsonRepairsPerAgent(): Map<string, number>;
  getPromptErrorsPerAgent(): Map<string, number>;
  getPromptTokensPerAgent(): Map<string, number>;
  getResponseTokensPerAgent(): Map<string, number>;
  getRetriesPerAgent(): Map<string, number>;
  getLatenciesPerAgent(): Map<string, number[]>;
  getErrorTracker(): ClassifiedError[];
  getFailoverState(): FailoverState;
  setFailoverState(v: FailoverState): void;
  getLocalOllamaTags(): readonly string[];
  setLocalOllamaTags(v: readonly string[]): void;
  getStaleEventCount(): number;
  setStaleEventCount(v: number): void;
  getHypothesisGroupAborts(): Map<string, AbortController>;
  getFileCommitCounts(): Map<string, number>;
  getHypothesisDeferralTimestamps(): Map<string, number>;
  getActiveAborts(): Set<AbortController>;

  // --- agents ---
  getAuditor(): Agent | undefined;
  setAuditor(v: Agent | undefined): void;
  getPlanner(): Agent | undefined;
  setPlanner(v: Agent | undefined): void;
  getAgentRoster(): Array<{ id: string; index: number }>;
  setAgentRoster(v: Array<{ id: string; index: number }>): void;
  getWorkerRoles(): Map<string, string>;

  // --- audit / tier ---
  getAuditInvocations(): number;
  setAuditInvocations(v: number): void;
  getCompletionDetail(): string | undefined;
  setCompletionDetail(v: string | undefined): void;
  getCurrentTier(): number;
  setCurrentTier(v: number): void;
  getTiersCompleted(): number;
  setTiersCompleted(v: number): void;
  getTierHistory(): TierHistoryEntry[];
  setTierHistory(v: TierHistoryEntry[]): void;
  getTierStartedAt(): number | undefined;
  setTierStartedAt(v: number | undefined): void;
  getTierUpFailures(): number;
  setTierUpFailures(v: number): void;

  // --- clone state ---
  cloneStateForStatus?: {
    alreadyPresent: boolean;
    clonePath: string;
    priorCommits: number;
    priorChangedFiles: number;
    priorUntrackedFiles: number;
  };

  // --- methods ---
  setPhase(phase: SwarmPhase): void;
  setPlanningSubphase(
    subphase: import("@ollama-swarm/shared/planningSubphase").PlanningSubphase | undefined,
  ): void;
  clearExplorationCache(): void;
  syncExplorationCacheFromSeed(seed: PlannerSeed): void;
  appendSystem(text: string, summary?: TranscriptEntrySummary): void;
  appendAgent(agent: Agent, text: string, options?: import("./runnerUtil.js").AppendAgentOptions): void;
  pendingToolTraceByAgent: Map<string, import("../toolCallTranscript.js").ToolTraceEntry[]>;
  discoverLocalOllamaTags(): Promise<void>;
  clearStateSnapshotScheduler(): void;
  emit(ev: { type: string; [key: string]: unknown }): void;
  initRunControl(runId: string): void;
  initBrainOverseer(runId: string): void;
  getBrainService(): BrainService | null;
  getInteractionTracker(): InteractionTracker;
  getExceptionCollector(): ExceptionCollector;
  promptPlannerSafely(agent: Agent, prompt: string, name?: import("../../tools/ToolDispatcher.js").ProfileName, format?: "json" | Record<string, unknown>): Promise<{ response: string; agentUsed: Agent }>;
  excludeRunnerArtifacts(destPath: string): Promise<void>;
  captureGitBaseline(clonePath: string): Promise<void>;
  buildSeed(clonePath: string, cfg: RunConfig): Promise<PlannerSeed>;
  spawnAgent(opts: SpawnOpts): Promise<Agent>;
  getManager(): AgentManager;
  emitAgentState(s: import("../../types.js").AgentState): void;
  markPlannerStatus(planner: Agent, status: "thinking" | "ready"): void;
  v2ObserverApply(ev: Record<string, unknown>): void;
  v2ObserverReset(): void;
  flushBoardBroadcasterSnapshot(): void;
  boardCounts(): { open: number; claimed: number; stale: number; committed: number; skipped: number; total: number };
  getTodoQueueCounts(): { pending: number; inProgress: number; pendingCommit: number; completed: number; failed: number; skipped: number; total: number };
  getBoardRestoredFromSnapshot(): boolean;
  allCriteriaResolved(): boolean;
  readonly maxAuditInvocations: number;
  runAuditor(planner: Agent, opts?: { allowWhenStopping?: boolean }): Promise<void>;
  writeRunSummary(crashMessage: string | undefined): Promise<void>;
  writeBlackboardDeliverable(): Promise<void>;
  runAutoRollbacks(): Promise<void>;
  runPlanner(planner: Agent, seed: PlannerSeed, isFallbackAttempt?: boolean): Promise<void>;
  runFirstPassContractOrchestrator(planner: Agent, workers: Agent[], seed: PlannerSeed): Promise<void>;
  tryResumeContract(clonePath: string): Promise<boolean>;
  runAuditedExecution(planner: Agent, workers: Agent[]): Promise<void>;
  recordError(err: unknown, opts?: { causeHint?: ErrorCategory; statusCode?: number }): ClassifiedError;
  writeCrashSnapshot(err: unknown): Promise<void>;
  killAll(): Promise<KillAllResult>;
  flushStateWrite(): Promise<void>;
  stop(): Promise<void>;
  stopQueueReaper(): void;
  stopCapWatchdog(): void;
  stopReplanWatcher(): void;
  startQueueReaper(): void;
  startCapWatchdog(): void;
  startReplanWatcher(): void;
  isOverWallClockCap(): boolean;
  startAdaptiveWorkerWatchdog(opts: unknown): void;
  disposeBoardBroadcaster(): void;

  // --- repos ---
  clone(opts: { url: string; destPath: string }): Promise<{
    destPath: string;
    alreadyPresent: boolean;
    priorCommits: number;
    priorChangedFiles: number;
    priorUntrackedFiles: number;
  }>;

  // --- todo queue / findings ---
  clearTodoQueue(): void;
  clearFindings(): void;

  // --- reflection context helper ---
  buildReflectionContext(planner: Agent, abortSignal: AbortSignal): ReflectionContext;
  getPhase(): SwarmPhase;
  getPlanningStartedAt(): number | undefined;
  setPlanningStartedAt(v: number | undefined): void;
  getContractDerivationFailure(): string | undefined;
  setContractDerivationFailure(v: string | undefined): void;
  getDrainEligibilityInput(partial: {
    claimed: number;
    pendingCommit: number;
  }): import("./drainEligibility.js").DrainEligibilityInput;
}

// ---------------------------------------------------------------------------
// start()
// ---------------------------------------------------------------------------

export async function start(ctx: LifecycleContext, cfg: RunConfig): Promise<void> {
  if (ctx.isRunning()) throw new Error("A swarm is already running. Stop it first.");
  resetLifecycleStateForStart(ctx, cfg);

  try {
  // Skip the "cloning" phase (and actual clone op) when a local filepath was provided
  // instead of a git URL. We still want clone_state for the UI banner, but no "cloning".
  const isRemoteClone = !!(cfg.repoUrl && (cfg.repoUrl.startsWith("http://") || cfg.repoUrl.startsWith("https://")));
  if (isRemoteClone) {
    ctx.setPhase("cloning");
  }
  const cloneResult = await ctx.clone({
    url: cfg.repoUrl,
    destPath: cfg.localPath,
  });
  const { destPath } = cloneResult;
  // Unit 47: tell the UI whether this is a fresh clone or a resume,
  // and how much prior work it's building on. The build-on-existing
  // pattern (Units 47-51) makes this distinction load-bearing —
  // user shouldn't be confused when their re-run silently picks up
  // 4 prior commits + 5 modified files.
  // Unit 62: ALSO stash for the page-refresh catch-up snapshot so a
  // reload re-renders the banner instead of forgetting we resumed.
  ctx.cloneStateForStatus = {
    alreadyPresent: cloneResult.alreadyPresent,
    clonePath: destPath,
    priorCommits: cloneResult.priorCommits,
    priorChangedFiles: cloneResult.priorChangedFiles,
    priorUntrackedFiles: cloneResult.priorUntrackedFiles,
  };
  ctx.emit({
    type: "clone_state",
    ...ctx.cloneStateForStatus,
  });
  // Unit 42: per-agent model overrides. Topology row provider pins API
  // routing even when the model field is empty (otherwise :cloud defaults
  // would still hit Ollama Cloud after switching the grid to OpenCode).
  const plannerFallback = cfg.plannerModel ?? cfg.model;
  const workerFallback = cfg.workerModel ?? cfg.model;
  const auditorFallback = cfg.auditorModel ?? plannerFallback;
  const plannerModel = resolveRunSpawnModel(cfg, 1);
  const workerModel = workerFallback;
  const auditorModel = auditorFallback;
  // Unit 48: hide runner-written artifacts (opencode.json,
  // blackboard-state.json, summary.json, summary-*.json) from
  // `git status` via the clone's local .git/info/exclude — NOT the
  // user's .gitignore. See RepoService.excludeRunnerArtifacts.
  await ctx.excludeRunnerArtifacts(destPath);
  await ctx.captureGitBaseline(destPath);
  // E3 Phase 5: opencode.json no longer needed — prompts route through pickProvider directly.
  ctx.appendSystem(formatCloneMessage(cfg.repoUrl, destPath, cloneResult));
  if (plannerModel !== workerModel) {
    ctx.appendSystem(`Per-agent models: planner=${plannerModel}, workers=${workerModel}`);
  }
  if (cfg.dedicatedAuditor && auditorModel !== plannerModel) {
    ctx.appendSystem(`Per-agent models: auditor=${auditorModel}`);
  }

  // Unit 57: cache the prior run's blackboard-state.json BEFORE the
  // spawning phase fires its scheduled snapshot write. See the field
  // declaration for the race details. Read here (clone exists, no
  // snapshot writes have fired yet because cloning phase skips
  // scheduleStateWrite). Always reads — Unit 51's tryResumeContract
  // uses the cached value when cfg.resumeContract is true; cheap
  // I/O when it's not.
  ctx.setPriorSnapshot(await readBlackboardStateSnapshot(destPath));

  ctx.setPhase("spawning");
  // Planner is always index 1. Workers take 2..N. If the user picks
  // agentCount=1 there are no workers — planner posts TODOs, nothing drains
  // them, and we transition straight to completed. Documented in README.
  // E3 Phase 5: opencode subprocess is gone. spawnAgent is
  // the only spawn path. The auxiliary direct-prompt helpers
  // (auditorSeedBuilder, goalGenerationPrePass, reflectionPasses,
  // runEndReflection, promptAndExtract) all migrated to chatOnce in
  // earlier cleanup commits.
  const planner = await ctx.spawnAgent({
    cwd: destPath,
    index: 1,
    model: plannerModel,
  });
  ctx.appendSystem(`Planner agent ${planner.id} ready (model=${planner.model})`);

  const workerCount = Math.max(0, cfg.agentCount - 1);
  const workers: Agent[] = [];
  if (workerCount > 0) {
    // Parallel spawn: each opencode serve takes a few seconds to boot,
    // sequential would compound that for every extra worker.
    const workerSpawns = Array.from({ length: workerCount }, (_, i) => {
      const agentIndex = 2 + i;
      return ctx.spawnAgent({
        cwd: destPath,
        index: agentIndex,
        model: resolveRunSpawnModel(cfg, agentIndex),
      });
    });
    const spawned = await Promise.all(workerSpawns);
    workers.push(...spawned);
    // Unit 59 (59a): assign a static role bias to each worker when
    // specializedWorkers is on. workerOrdinal is 1-based (worker-2 is
    // ordinal 1). Roles cycle through workerRoles.ts catalog.
    ctx.getWorkerRoles().clear();
    if (cfg.specializedWorkers) {
      spawned.forEach((w, i) => {
        const role = assignWorkerRole(i + 1);
        ctx.getWorkerRoles().set(w.id, role.guidance);
        ctx.appendSystem(
          `Worker agent ${w.id} ready (model=${w.model}, role: ${role.name})`,
        );
      });
    } else {
      for (const w of workers) ctx.appendSystem(`Worker agent ${w.id} ready (model=${w.model})`);
    }
  } else {
    ctx.appendSystem("No workers spawned (agentCount=1). Planner will post TODOs, nothing will drain them.");
  }

  // Unit 58: spawn the dedicated auditor agent (opt-in). Index is
  // agentCount + 1 so it doesn't collide with workers (1=planner,
  // 2..N=workers, N+1=auditor). Total agents = agentCount + 1.
  if (cfg.dedicatedAuditor) {
    const auditorIndex = cfg.agentCount + 1;
    ctx.setAuditor(await ctx.spawnAgent({
      cwd: destPath,
      index: auditorIndex,
      model: resolveRunSpawnModel(cfg, auditorIndex),
    }));
    ctx.appendSystem(
      `Auditor agent ${ctx.getAuditor()!.id} ready (model=${auditorModel}). Audit calls will route here in parallel with workers.`,
    );
  } else {
    ctx.setAuditor(undefined);
  }

  // Freeze the roster for the summary artifact — killAll() will later
  // empty AgentManager's own map.
  ctx.setAgentRoster([
    planner,
    ...workers,
    ...(ctx.getAuditor() ? [ctx.getAuditor()!] : []),
  ].map((a) => ({ id: a.id, index: a.index })));

  ctx.setPhase("seeding");
  ctx.setPlanningSubphase("seeding");
  ctx.setPlanningStartedAt(Date.now());
  const seed = await ctx.buildSeed(destPath, cfg);
  ctx.syncExplorationCacheFromSeed?.(seed);
  if (cfg.suppressSeedMessages !== true) {
    const directiveTrimmed = (cfg.userDirective ?? "").trim();
    if (directiveTrimmed.length > 0) {
      const preview =
        directiveTrimmed.length > 200
          ? `${directiveTrimmed.slice(0, 200)}…`
          : directiveTrimmed;
      ctx.appendSystem(`User directive: "${preview}"`);
    } else {
      ctx.appendSystem(
        "No user directive — planner will propose goals from the codebase.",
      );
    }
    ctx.appendSystem(
      `Seed: ${seed.topLevel.length} top-level entries, README ${
        seed.readmeExcerpt ? `${seed.readmeExcerpt.length} chars` : "(missing)"
      }.`,
    );
  }

  // Task #127 + direction-aware goal generation:
  // When a directive IS provided, run goal generation to ANALYZE the codebase
  // and find concrete gaps that the directive should address. The goals
  // ENHANCE the directive — they don't replace it.
  // When NO directive is provided, goal generation proposes ambitious goals
  // as before (the top one becomes the directive).
  const shouldGenerateGoals = shouldRunGoalPrePass(cfg, seed.userDirective);
  if (shouldGenerateGoals && cfg.suppressSeedMessages !== true) {
    assertPlanningWithinWallClock(ctx);
    ctx.setPlanningSubphase("goal-pre-pass");
    const generatedGoals = await runGoalGenerationPrePass(
      planner,
      seed,
      (text) => ctx.appendSystem(text),
      {
        cfg,
        onTool: makeBufferedToolHandler(ctx.pendingToolTraceByAgent, planner.id),
        onAgentOutput: (text) => ctx.appendAgent(planner, text, { briefKind: "goal_analysis" }),
        streaming: lifecycleChatSurface(ctx, { kind: "seeding", label: "goal analysis" }),
      },
    );
    if (lifecycleIsStopping(ctx.getLifecycleState())) return;
    if (generatedGoals && generatedGoals.length > 0) {
      if (seed.userDirective && seed.userDirective.length > 0) {
        // Directive exists — goals ENHANCE it, not replace it.
        // Append goals as context for the contract derivation.
        const goalsText = generatedGoals.map((g, i) => `${i + 1}. ${g}`).join("\n");
        seed.userDirective = `${seed.userDirective}\n\n=== CODEBASE ANALYSIS (concrete gaps found by goal-generation) ===\n${goalsText}\n=== Use these to produce grounded criteria that advance the directive ===`;
        ctx.appendSystem(
          `Goal-generation pre-pass: enriched directive with ${generatedGoals.length} code-grounded goal(s).`,
        );
      } else {
        // No directive — goal generation proposes the directive.
        seed.userDirective = generatedGoals[0];
        ctx.appendSystem(
          `Goal-generation pre-pass: directive set to "${generatedGoals[0].length > 200 ? generatedGoals[0].slice(0, 200) + "…" : generatedGoals[0]}"`,
        );
      }
    } else {
      ctx.appendSystem(
        `Goal-generation pre-pass: no usable goals returned — continuing without enrichment.`,
      );
    }
  } else if (
    cfg.suppressSeedMessages !== true
    && (cfg.userDirective ?? "").trim().length >= 80
    && cfg.autoGenerateGoals !== true
  ) {
    ctx.appendSystem(
      "Goal-generation pre-pass skipped — user directive is already specific (set autoGenerateGoals:true to force enrichment).",
    );
  }

  if (lifecycleIsStopping(ctx.getLifecycleState())) return;

  // V2 Step 3b.2: agents are ready — fire spawned event so the V2
  // reducer can advance from "spawning" to "planning".
  ctx.v2ObserverApply({
    type: "spawned",
    ts: Date.now(),
    agentCount: ctx.getAgentRoster().length,
  });
  ctx.setPhase("planning");
  ctx.setPlanningSubphase("contract");
  // Background so the HTTP POST that triggered start() returns immediately.
  // The UI watches progress over /ws.
  // Task #198: planAndExecute has internal try/catch (line ~676), but its
  // finally block runs async ops (writeRunSummary, runAuditor) that can
  // throw on their own. Defense in depth: surface any leak as an error
  // event so the UI doesn't hang in "planning" forever.
  planAndExecute(ctx, planner, workers, seed).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.emit({ type: "error", message: `Run aborted (unhandled): ${msg}` });
    ctx.appendSystem(`Run aborted (unhandled): ${msg}`);
    void ctx.stop().catch((err) => {
      ctx.appendSystem(`⚠ lifecycle stopAfterAbort: ${err instanceof Error ? err.message : String(err)}`);
    });
  });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.setStartupCrashMessage(msg);
    ctx.appendSystem(`Run failed during startup: ${msg}`);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// planAndExecute()
// ---------------------------------------------------------------------------

export async function planAndExecute(
  ctx: LifecycleContext,
  planner: Agent,
  workers: Agent[],
  seed: PlannerSeed,
): Promise<void> {
  let errored = false;
  let crashMessage: string | undefined;
  try {
    // Unit 51: opt-in resume from blackboard-state.json. When the
    // user set cfg.resumeContract AND the snapshot is present +
    // valid, install the prior contract directly and skip the
    // first-pass-contract round entirely. Tier counters hydrate
    // from the snapshot too. Falls through to the normal path on
    // missing/invalid snapshot — silent fallback so the user gets
    // SOMETHING even if the resume can't bind.
    const active = ctx.getActive();
    const resumed = active?.resumeContract === true
      ? await ctx.tryResumeContract(seed.clonePath)
      : false;
    if (!resumed) {
      assertPlanningWithinWallClock(ctx);
      const activeCfg = ctx.getActive();
      if (activeCfg && seed.webToolsEnabled) {
        ctx.setPlanningSubphase("research");
        const notes = await runResearchPrePass(
          planner,
          seed,
          activeCfg,
          (text) => ctx.appendSystem(text),
          {
            onTool: makeBufferedToolHandler(ctx.pendingToolTraceByAgent, planner.id),
            onAgentOutput: (text) => ctx.appendAgent(planner, text, { briefKind: "research_brief" }),
            streaming: lifecycleChatSurface(ctx, { kind: "planning", label: "web research" }),
          },
        );
        if (notes) seed.researchNotes = notes;
      }
      ctx.setPlanningSubphase("contract");
      await ctx.runFirstPassContractOrchestrator(planner, workers, seed);
      ctx.syncExplorationCacheFromSeed(seed);
    }
    if (lifecycleIsStopping(ctx.getLifecycleState())) return;
    const qAfterResume = ctx.getTodoQueueCounts();
    const skipPlanner =
      resumed
      && ctx.getBoardRestoredFromSnapshot()
      && (qAfterResume.pending > 0 || qAfterResume.pendingCommit > 0);
    if (skipPlanner) {
      ctx.appendSystem(
        `Skipping initial planner pass — resuming ${qAfterResume.pending} open + ${qAfterResume.pendingCommit} pending-commit todo(s) from snapshot.`,
      );
    } else if (shouldSkipPlannerAfterContractFailure(ctx.getContractDerivationFailure())) {
      ctx.appendSystem(
        `Skipping planner-todos — contract derivation aborted (${ctx.getContractDerivationFailure()}).`,
      );
    } else {
      assertPlanningWithinWallClock(ctx);
      ctx.setPlanningSubphase("todos");
      await ctx.runPlanner(planner, seed);
      ctx.syncExplorationCacheFromSeed(seed);
    }
    if (lifecycleIsStopping(ctx.getLifecycleState())) return;
    const counts = ctx.boardCounts();
    const qCounts = ctx.getTodoQueueCounts();
    const hasExecutableWork =
      counts.open > 0 || counts.claimed > 0 || qCounts.pendingCommit > 0;
    if (
      !hasExecutableWork
      && workers.length > 0
      && counts.total === 0
      && counts.committed === 0
      && !ctx.getCompletionDetail()
    ) {
      const emptyDetail = "planner produced no actionable todos; no commits";
      ctx.setCompletionDetail(emptyDetail);
      // RR-D parity with council empty-execution: Brain RECONFIG chip.
      try {
        const { notifyGuardTrip } = await import("../guardNotify.js");
        const { recordEmptyExecutionCycle } = await import("../cycleIntegrityStats.js");
        const { formatEmptyPlanReason } = await import("../emptyExecutionGuard.js");
        recordEmptyExecutionCycle(ctx.getActive()?.runId);
        notifyGuardTrip({
          kind: "plan-empty",
          detail: formatEmptyPlanReason(1) + " — " + emptyDetail,
          runId: ctx.getActive()?.runId,
          appendSystem: (t, s) => ctx.appendSystem(t, s),
          getBrainService: ctx.getBrainService,
        });
      } catch {
        /* non-fatal */
      }
    }
    if (workers.length > 0 && hasExecutableWork) {
      // Stamp the wall-clock origin just before caps start being checked.
      // Planning time (seeding, initial planner prompt, repair) does NOT
      // count toward the cap — the cap is a worker-loop guard, not a total
      // run guard.
      ctx.setRunStartedAt(Date.now());
      // Task #124: same baseline timing for token-budget — planner
      // tokens before this point don't count toward the budget.
      ctx.setTokenBaselineForRun(snapshotLifetimeTokens());
      ctx.setTickAccumulator(createTickAccumulator(ctx.getRunStartedAt()!));
      ctx.setPhase("executing");
      ctx.startQueueReaper();
      // T198c (2026-05-04): adaptive worker pool sizing — log-only
      // first-cut. Polls todo queue depth + worker count every 30s
      // and logs scale-up/scale-down recommendations. Real dynamic
      // spawn/teardown deferred (AgentManager surgery, days of work).
      const activeCfg = ctx.getActive();
      if (activeCfg?.adaptiveWorkers) {
        ctx.startAdaptiveWorkerWatchdog(activeCfg.adaptiveWorkers);
      }
      ctx.startCapWatchdog();
      ctx.setPlanner(planner);
      ctx.startReplanWatcher();
      await ctx.runAuditedExecution(planner, workers);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Task #168: when stop() or drain() aborted in-flight prompts,
    // the abort propagates here as an exception. That's exactly
    // what the user asked for — don't classify it as a crash.
    // Leaves errored=false + crashMessage=undefined so summary
    // classification routes to "user" / drain-completion paths
    // instead of "crash" (which previously caused user-stop runs
    // to mis-show stopReason="crash" + write a crash snapshot).
    if (lifecycleIsStopping(ctx.getLifecycleState())) {
      // R17 wiring: classify the abort with causeHint=user-stop so RCA
      // doesn't mis-categorize it as a network/timeout failure.
      ctx.recordError(err, { causeHint: "user-stop" });
      ctx.appendSystem(`Run halted: ${msg}`);
    } else {
      // Abort in-flight provider HTTP / streams BEFORE snapshot + summary
      // work so crash close-out does not leave orphan cloud calls (parity
      // with discussion runFinallyHooks.beginRunShutdown; e182 pattern).
      try {
        ctx.getManager().beginRunShutdown();
      } catch {
        /* best-effort */
      }
      // R17 wiring: classify the crash for the run-end RCA report.
      ctx.recordError(err);
      errored = true;
      crashMessage = msg;
      ctx.emit({ type: "error", message: `blackboard run failed: ${crashMessage}` });
      ctx.appendSystem(`Run failed: ${crashMessage}`);
      // Best-effort post-mortem. Awaited so the write lands before the
      // finally block flips phase to "failed" — a WS consumer watching for
      // the failed transition should be able to trust the artifact is
      // already on disk.
      await ctx.writeCrashSnapshot(err);
    }
  } finally {
    await runLifecycleCloseout(ctx, planner, { errored, crashMessage });
  }
}

// ---------------------------------------------------------------------------
// drain()
// ---------------------------------------------------------------------------

export async function drain(ctx: LifecycleContext): Promise<void> {
  return doDrain(ctx);
}

// ---------------------------------------------------------------------------
// checkDrainComplete()
// ---------------------------------------------------------------------------

export async function checkDrainComplete(ctx: LifecycleContext): Promise<void> {
  return doCheckDrainComplete(ctx);
}

// ---------------------------------------------------------------------------
// stop()
// ---------------------------------------------------------------------------

export async function stop(ctx: LifecycleContext): Promise<void> {
  return doStop(ctx);
}
