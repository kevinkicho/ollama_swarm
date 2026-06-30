import { randomUUID } from "node:crypto";
import path from "node:path";
import { brainConfigFromApp } from "./prompts/brainIntegration.js";
import {
  runPlanner as runPlannerExtracted,
  runPlannerFallbackForUnmetCriteria as runPlannerFallbackForUnmetCriteriaExtracted,
  type PlannerContext,
} from "./plannerRunner.js";
import {
  writeCrashSnapshot as writeCrashSnapshotExtracted,
  boardCounts as boardCountsExtracted,
  boardListTodos as boardListTodosExtracted,
  boardSnapshot as boardSnapshotExtracted,
  boardGetTodo as boardGetTodoExtracted,
  readExpectedFiles as readExpectedFilesExtracted,
  resolveSafePath as resolveSafePathExtracted,
  sleep as sleepExtracted,
  directiveWithAmendments as directiveWithAmendmentsExtracted,
  appendAgent as appendAgentExtracted,
  maybeEmitLoopWarning as maybeEmitLoopWarningExtracted,
  setPhase as setPhaseExtracted,
  emitAgentState as emitAgentStateExtracted,
  extractText as extractTextExtracted,
  type RunnerUtilContext,
} from "./runnerUtil.js";
import { AgentManager, type Agent } from "../../services/AgentManager.js";
import { toOpenCodeModelRef } from "../../../../shared/src/providers.js";
import { type ClassifiedError, type ErrorCategory } from "../errorTaxonomy.js";
import { recordError as recordErrorExtracted, type ErrorRecorderContext } from "./errorRecorder.js";
import { startQueueReaper as startQueueReaperExtracted, stopQueueReaper as stopQueueReaperExtracted, type QueueReaperContext } from "./queueReaper.js";

import {
  type FailoverState,
  type FailoverConfig,
} from "../promptWithFailover.js";
import type { ReflectionContext } from "./reflectionPasses.js";
import type {
  AgentState,
  SwarmEvent,
  SwarmPhase,
  SwarmStatus,
  TranscriptEntry,
  TranscriptEntrySummary,
} from "../../types.js";
import type { RunConfig, RunnerOpts, SwarmRunner } from "../SwarmRunner.js";
// V2 cutover Phase 2c (2026-04-28): Board.ts is unreferenced from
// BlackboardRunner. See docs/known-limitations.md.
import { FindingsLog } from "./FindingsLog.js";
import {
  makeTodoQueueWrappers,
  type TodoQueueWrappers,
} from "./todoQueueWrappers.js";
import {
  buildWireSnapshot,
  v2QueueCountsToWireCounts,
  v2QueueTodoToWireTodo,
} from "./boardWireCompat.js";
import { RunStateObserver } from "./RunStateObserver.js";
import {
  TodoQueue,
  type PostTodoInput,
  type QueuedTodo,
} from "./TodoQueue.js";
import { applyAndCommit } from "./WorkerPipeline.js";
import {
  evaluateConflictDispatch,
  updateDeferralTimestamps,
  type CandidateForConflict,
} from "./hypothesisGrouping.js";
import type { Hunk } from "./applyHunks.js";
import { voteOnHunks, voteOnHunksWithJudge, type HunkVote, type JudgeFn } from "./hunkVoting.js";
import { buildJudgePrompt } from "./hunkJudgePrompt.js";
import { realFilesystemAdapter, realGitAdapter, realVerifyAdapter } from "./v2Adapters.js";
import { createBoardBroadcaster, type BoardBroadcaster } from "./boardBroadcaster.js";
import {
  type TickAccumulator,
} from "./caps.js";
import {
  buildStateSnapshot,
  STATE_SNAPSHOT_DEBOUNCE_MS,
  type BlackboardStateSnapshot,
} from "./stateSnapshot.js";
import { StateSnapshotScheduler } from "./stateSnapshotScheduler.js";
import { buildPerAgentStats as buildPerAgentStatsExtracted, type PerAgentCounters, writeRunSummary as writeRunSummaryExtracted } from "./runSummaryWriter.js";
import { buildSummary, computeLatencyStats, type PerAgentStat, type RunSummary } from "./summary.js";
import { applyHunks } from "./applyHunks.js";
import { findBomPrefixed, findZeroedFiles } from "./diffValidation.js";
import { buildPerRunSummaryFileName, buildRunFinishedSummary, findAndReadNewestPriorSummary, formatPortReleaseLine, formatRunFinishedBanner } from "../runSummary.js";
import type { PriorRunSummary, PlannerSeed } from "./prompts/planner.js";

import {
  type ParsedContract,
} from "./prompts/firstPassContract.js";
import {
  runFirstPassContract as runFirstPassContractExtracted,
  runFirstPassContractOrchestrator as runFirstPassContractOrchestratorExtracted,
  tryCouncilContract as tryCouncilContractExtracted,
  finalizeContract as finalizeContractExtracted,
  buildContract as buildContractExtracted,
  cloneContract as cloneContractExtracted,
  tryResumeContract as tryResumeContractExtracted,
  loadPriorRunSummary as loadPriorRunSummaryExtracted,
  buildSeed as buildSeedExtracted,
  type ContractContext,
} from "./contractBuilder.js";
// Auditor prompt imports moved to auditorRunner.ts
import {
  enqueueReplan as enqueueReplanExtracted,
  processReplanQueue as processReplanQueueExtracted,
  replanOne as replanOneExtracted,
  startReplanWatcher as startReplanWatcherExtracted,
  stopReplanWatcher as stopReplanWatcherExtracted,
  type ReplanContext,
} from "./replanManager.js";
import {
  runAuditedExecution as runAuditedExecutionExtracted,
  allCriteriaResolved as allCriteriaResolvedExtracted,
  allCriteriaMet as allCriteriaMetExtracted,
  allCriteriaResolvedSnapshot as allCriteriaResolvedSnapshotExtracted,
  resolvedMaxTiers as resolvedMaxTiersExtracted,
  recordTierCompletion as recordTierCompletionExtracted,
  tryPromoteNextTier as tryPromoteNextTierExtracted,
  largestCriterionIdNumber as largestCriterionIdNumberExtracted,
  maxAuditInvocations as maxAuditInvocationsExtracted,
  type TierContext,
  type TierHistoryEntry,
} from "./tierRunner.js";
import {
  runAuditor as runAuditorExtracted,
  applyAuditorResult as applyAuditorResultExtracted,
  type AuditorContext,
  type AuditorResult,
} from "./auditorRunner.js";
import {
  promptAgent as promptAgentExtracted,
  promptPlannerSafely as promptPlannerSafelyExtracted,
  markPlannerStatus as markPlannerStatusExtracted,
  type PromptContext,
} from "./promptRunner.js";
import {
  discoverLocalOllamaTags as discoverLocalOllamaTagsExtracted,
  buildFailoverConfig as buildFailoverConfigExtracted,
} from "./failoverDiscovery.js";
import {
  injectUser as injectUserExtracted,
} from "./userInputHandler.js";
import {
  status as statusExtracted,
  type StatusContext,
} from "./statusBuilder.js";
import {
  utilCtx as utilCtxBuilder,
  lifecycleContext as lifecycleContextBuilder,
  contractContext as contractContextBuilder,
  tierContext as tierContextBuilder,
  plannerContext as plannerContextBuilder,
  workerContext as workerContextBuilder,
  promptContext as promptContextBuilder,
  capContext as capContextBuilder,
  replanContext as replanContextBuilder,
  auditorContext as auditorContextBuilder,
  adaptiveWatchdogCtx as adaptiveWatchdogCtxBuilder,
} from "./contextBuilders.js";
import type { BlackboardRunnerFields } from "./runnerContextTypes.js";
import {
  startAdaptiveWorkerWatchdog as startAdaptiveWorkerWatchdogExtracted,
  scaleUpAdaptive as scaleUpAdaptiveExtracted,
  scaleDownAdaptive as scaleDownAdaptiveExtracted,
  type AdaptiveWatchdogContext,
  type AdaptiveWatchdogOpts,
} from "./adaptiveWorkerWatchdog.js";
import {
  isOverWallClockCap as isOverWallClockCapExtracted,
  checkAndApplyCaps as checkAndApplyCapsExtracted,
  enterPause as enterPauseExtracted,
  schedulePauseProbe as schedulePauseProbeExtracted,
  runPauseProbe as runPauseProbeExtracted,
  exitPause as exitPauseExtracted,
  startCapWatchdog as startCapWatchdogExtracted,
  stopCapWatchdog as stopCapWatchdogExtracted,
  checkMemoryPressureTick as checkMemoryPressureTickExtracted,
  setSubscriberPaused as setSubscriberPausedExtracted,
  type CapContext,
} from "./capManager.js";

import type { BoardEvent, ExitContract, Todo } from "./types.js";
import {
  buildHunkRepairPrompt,
  buildWorkerRepairPrompt,
  buildWorkerUserPrompt,
  parseWorkerResponse,
  WORKER_SYSTEM_PROMPT,
  type WorkerSeed,
} from "./prompts/worker.js";
import {
  readRecentMemory,
  renderMemoryForSeed,
} from "./memoryStore.js";
// Task #177: design memory (north-star + decisions + roadmap).
import {
  readDesignMemory,
  renderDesignMemoryForSeed,
} from "./designMemoryStore.js";
// Task #164 (refactor): goal-list parser split out (used by both
// goal-generation pre-pass and stretch reflection).
import { parseGoalList } from "./goalListParser.js";
// V2 cutover (2026-04-28): per-commit critic + verifier modules were
// deleted with the V1 worker pipeline. cfg.critic / cfg.verifier /
// cfg.criticEnsemble route flags are accepted but no-op. Re-wiring
// either feature into the V2 worker is a separate enhancement; revive
// from git history (1110084 + prior) when needed.
// Task #164 (refactor): goal-generation pre-pass split out.
// Task #164 (refactor): auditor seed builder + UI snapshot capture split out.
// buildAuditorSeed import moved to auditorRunner.ts
import { truncate } from "./truncate.js";

import { formatChatReceipt } from "../chatReceipt.js";
import { writeBlackboardDeliverable as writeBlackboardDeliverableExtracted } from "./deliverableWriter.js";
import { runAutoRollbacks as runAutoRollbacksExtracted } from "./autoRollbackOrchestrator.js";
import {
  runWorkers as runWorkersExtracted,
  runWorker as runWorkerExtracted,
  executeBuildTodo as executeBuildTodoExtracted,
  maybeSettleHypothesisGroup as maybeSettleHypothesisGroupExtracted,
  executeWorkerTodo as executeWorkerTodoExtracted,
  type WorkerContext,
} from "./workerRunner.js";

import {
  bumpAgentCounter,
} from "./runnerHelpers.js";

import {
  computeWorkerTagCounts,
} from "./BlackboardRunnerConstants.js";
import {
  start as lifecycleStart,
  planAndExecute as lifecyclePlanAndExecute,
  drain as lifecycleDrain,
  checkDrainComplete as lifecycleCheckDrainComplete,
  stop as lifecycleStop,
  type LifecycleContext,
} from "./lifecycleRunner.js";
import type { LifecycleState } from "./lifecycleState.js";

export class BlackboardRunner implements SwarmRunner {
  private transcript: TranscriptEntry[] = [];
  private phase: SwarmPhase = "idle";
  private round = 0;
  private lifecycleState: LifecycleState = "idle";
  /** Sticky marker: true once `draining` entered, survives into `stopping`/`stopped`. */
  private _wasDrained = false;
  private isStopping(): boolean { return this.lifecycleState === "stopping"; }
  private isDraining(): boolean { return this.lifecycleState === "draining"; }
  private isWasDrained(): boolean { return this._wasDrained; }
  private active?: RunConfig;
  private boardBroadcaster: BoardBroadcaster;
  // V2: append-only findings log alongside the V2 TodoQueue.
  private findings: FindingsLog;
  // Mutation wrappers bundling queue/findings ops with state-write + emit + lifecycle callbacks.
  private wrappers!: TodoQueueWrappers;
  // In-flight prompt AbortControllers so stop() can abort them all.
  private activeAborts = new Set<AbortController>();
  // Periodic sweep: fails in-progress todos idle past IN_PROGRESS_TTL_MS.
  private reaperTimer?: NodeJS.Timeout;
  // #305: cap watchdog polls isOverWallClockCap every 5s; aborts in-flight prompts on cap fire.
  private capWatchdog?: NodeJS.Timeout;
  // Planner agent captured during executing; reused for replans.
  private planner?: Agent;
  // Dedicated auditor agent (cfg.dedicatedAuditor); undefined = planner wears auditor hat.
  private auditor?: Agent;
  // #97: full worker pool for self-consistency K-fan-out across different agents.
  private workerPool: Agent[] = [];
  // #59: per-worker role guidance (correctness/simplicity/consistency).
  private workerRoles = new Map<string, string>();
  // #62: per-agent rolling latency window for page-refresh catch-up snapshot.
  private recentLatencySamples = new Map<
    string,
    Array<{ ts: number; elapsedMs: number; success: boolean; attempt: number }>
  >();
  // #62: cloneState payload stashed at clone time for page-refresh catch-up.
  private cloneStateForStatus?: {
    alreadyPresent: boolean;
    clonePath: string;
    priorCommits: number;
    priorChangedFiles: number;
    priorUntrackedFiles: number;
  };
  private replanPending = new Set<string>();
  private replanRunning = false;
  private replanTickTimer?: NodeJS.Timeout;
  // Phase 7: hard-cap state. runStartedAt scopes wall-clock cap to worker loop.
  private runStartedAt?: number;
  // #124: lifetime token total at run-start for per-run token accounting.
  private tokenBaselineForRun?: number;
  // #27: host-sleep-proof tick accumulator; deltas clamped so host suspend doesn't blow caps.
  private tickAccumulator?: TickAccumulator;
  // #165: pause-on-quota state.
  private paused = false;
  private pauseStartedAt?: number;
  private totalPausedMs = 0;
  private pauseProbeTimer?: NodeJS.Timeout;
  // R2: exponential probe back-off counter; reset on exitPause.
  private pauseProbeAttempt = 0;
  // R17: per-run ClassifiedError tracker; bounded at MAX_TRACKED_ERRORS.
  private errorTracker: ClassifiedError[] = [];
  private static readonly MAX_TRACKED_ERRORS = 200;
  // R13: last emitted memory-pressure level for one-shot warnings.
  private lastMemoryPressureLevel: "ok" | "throttle" | "pause" = "ok";
  // R9: turn of last loop-detector warning; -1 = never.
  private lastLoopWarningAtTurn = -1;
  // W13/W14/W15: per-run failover state carrying per-model attempt-history.
  private failoverState: FailoverState = { modelHealth: new Map() };
  // W14: local Ollama tags discovered at run-start for local fallback.
  private localOllamaTags: readonly string[] = [];
  // W16/R7: subscriber-disconnect pause flag.
  private subscriberPaused = false;
  // W17/R13: heap-pressure pause flag.
  private memoryPaused = false;
  // W18/R9: consecutive loop detections; halts after LOOP_DETECTIONS_TO_HALT.
  private consecutiveLoopDetections = 0;
  private static readonly LOOP_DETECTIONS_TO_HALT = 3;
  private consecutiveStuckCycles = 0;
  // #167: drain/soft-stop state (timing metadata only; primary state in lifecycleState).
  private drainStartedAt?: number;
  private drainWatcherTimer?: NodeJS.Timeout;
  private terminationReason?: string;
  // Phase 9: run-summary counters + per-agent stats.
  private runBootedAt?: number;
  private staleEventCount = 0;
  private turnsPerAgent = new Map<string, number>();
  // #21: per-agent attempt/retry/latency tallies from promptWithRetry callbacks.
  private attemptsPerAgent = new Map<string, number>();
  private retriesPerAgent = new Map<string, number>();
  private latenciesPerAgent = new Map<string, number[]>();
  // #66: per-agent commit + line attribution.
  private commitsPerAgent = new Map<string, number>();
  private linesAddedPerAgent = new Map<string, number>();
  // auto-rollback: per-criterion commit attribution + audit trail.
  private commitsByCriterion = new Map<string, string[]>();
  // auto-rollback audit trail.
  private autoRollbacks: Array<{
    criterionId: string;
    resetTo: string;
    commitsUnwound: string[];
    reason: string;
    refusedCollateral?: string[];
    timestamp: number;
  }> = [];
  private linesRemovedPerAgent = new Map<string, number>();
  // #67: per-agent rejected-work + recovery counters.
  private rejectedAttemptsPerAgent = new Map<string, number>();
  private jsonRepairsPerAgent = new Map<string, number>();
  private promptErrorsPerAgent = new Map<string, number>();
  // #163: per-agent token accumulators from promptWithRetry's onTokens hook.
  private promptTokensPerAgent = new Map<string, number>();
  private responseTokensPerAgent = new Map<string, number>();
  // Stashed at spawn time so writeRunSummary works after killAll.
  private agentRoster: Array<{ id: string; index: number }> = [];
  // Phase 11b: first-pass exit contract.
  private contract?: ExitContract;
  // #57: cached prior run snapshot (read before any setPhase fires).
  private priorSnapshot?: BlackboardStateSnapshot | null;
  // Phase 11c: drain-audit-repeat bookkeeping.
  private auditInvocations = 0;
  private completionDetail?: string;
  // Stashed by writeRunSummary for WS catch-up on reconnect.
  private lastSummary?: RunSummary;
  // #31: state-snapshot debounce via StateSnapshotScheduler.
  private stateSnapshotScheduler: StateSnapshotScheduler;
  // #34: ambition ratchet tier state.
  private currentTier = 0;
  private tiersCompleted = 0;
  private tierHistory: TierHistoryEntry[] = [];
  private tierStartedAt?: number;
  private tierUpFailures = 0;
  // V2: parallel-track state observer.
  // The swarm's todo store — source of truth for all in-flight work.
  private todoQueue = new TodoQueue();
  // #3/Item: per-hypothesis-group AbortController for race settlement.
  private hypothesisGroupAborts = new Map<string, AbortController>();
  // Stigmergy: per-file commit count for worker dispatch.
  private fileCommitCounts = new Map<string, number>();
  // Plan 6: per-worker disposition cycle count (critic/synthesizer/gap-finder/builder rotation).
  private dispositionCycle: Map<string, number> = new Map();
  // Hypothesis deferral timestamps for conflict detection.
  private hypothesisDeferralTimestamps = new Map<string, number>();
  private v2Observer = new RunStateObserver({
    getCtx: () => {
      const c = this.boardCounts();
      return {
        openTodos: c.open,
        claimedTodos: c.claimed,
        staleTodos: c.stale,
        auditInvocations: this.auditInvocations,
        maxAuditInvocations: this.maxAuditInvocations,
        currentTier: this.currentTier,
        maxTiers: this.resolvedMaxTiers(),
        allCriteriaResolved: this.allCriteriaResolvedSnapshot(),
      };
    },
  });

  constructor(private readonly opts: RunnerOpts) {
    this.boardBroadcaster = createBoardBroadcaster(this.opts.emit);
    this.findings = new FindingsLog();
    this.stateSnapshotScheduler = new StateSnapshotScheduler(
      () => ({
        phase: this.phase,
        round: this.round,
        runBootedAt: this.runBootedAt,
        runStartedAt: this.runStartedAt,
        tickAccumulatorActiveElapsedMs: this.tickAccumulator?.activeElapsedMs,
        active: this.active,
        contract: this.contract,
        cloneContract: (c) => this.cloneContract(c),
        boardSnapshot: () => this.boardSnapshot(),
        buildPerAgentStats: () => this.buildPerAgentStats(),
        staleEventCount: this.staleEventCount,
        auditInvocations: this.auditInvocations,
        agentRoster: this.agentRoster,
        terminationReason: this.terminationReason,
        completionDetail: this.completionDetail,
        currentTier: this.currentTier,
        tiersCompleted: this.tiersCompleted,
        tierHistory: this.tierHistory,
      }),
      () => this.active?.localPath,
    );
    // boardBroadcaster pulls live snapshots from the todo queue +
    // findings log, translated to wire shape via boardWireCompat.
    this.boardBroadcaster.bindSnapshotSource(() => ({
      snapshot: buildWireSnapshot(this.todoQueue.list(), this.findings.list()),
      counts: v2QueueCountsToWireCounts(this.todoQueue.counts()),
    }));
    // Mutation wrappers — see todoQueueWrappers.ts. The onTerminal
    // callback feeds the V2 reducer's drain transition; onFailed
    // routes through replan + bumps stale-events telemetry.
    this.wrappers = makeTodoQueueWrappers({
      todoQueue: this.todoQueue,
      findings: this.findings,
      emit: (ev) => this.boardBroadcaster.emit(ev),
      scheduleStateWrite: () => this.scheduleStateWrite(),
      onTerminal: (kind, remaining) => {
        this.v2Observer.apply({
          type: kind === "committed" ? "todo-committed" : "todo-skipped",
          ts: Date.now(),
          remainingTodos: remaining,
        });
      },
      onFailed: (todoId) => {
        this.staleEventCount++;
        this.enqueueReplan(todoId);
      },
    });
  }

  private asFields(): BlackboardRunnerFields {
    return this as unknown as BlackboardRunnerFields;
  }

  private utilCtx(): RunnerUtilContext {
    return utilCtxBuilder(this.asFields());
  }

  private allCriteriaResolvedSnapshot(): boolean { return allCriteriaResolvedSnapshotExtracted(this.tierContext()); }

  status(): SwarmStatus {
    return statusExtracted({
      phase: this.phase,
      round: this.round,
      active: this.active,
      transcript: this.transcript,
      lastSummary: this.lastSummary,
      contract: this.contract,
      cloneStateForStatus: this.cloneStateForStatus,
      runBootedAt: this.runBootedAt,
      recentLatencySamples: this.recentLatencySamples,
      cloneContract: (c) => this.cloneContract(c),
      agentStates: () => this.opts.manager.toStates(),
      getPartialStreams: () => this.opts.manager.getPartialStreams(),
      utilCtx: () => this.utilCtx(),
    });
  }

  injectUser(
    text: string,
    opts?: { intent?: "suggest" | "steer" | "ask"; targetAgent?: string },
  ): void {
    injectUserExtracted(
      {
        transcript: this.transcript,
        emit: (e) => this.opts.emit(e as SwarmEvent),
        appendSystem: (t, s?) => this.appendSystem(t, s),
        tierContext: () => this.tierContext(),
      },
      text,
      opts,
    );
  }

  isRunning(): boolean {
    // Terminal phases must not count as running.
    return (
      this.phase !== "idle" &&
      this.phase !== "stopped" &&
      this.phase !== "completed" &&
      this.phase !== "failed"
    );
  }

  async start(cfg: RunConfig): Promise<void> { await lifecycleStart(this.lifecycleContext(), cfg); }

  private async planAndExecute(planner: Agent, workers: Agent[], seed: PlannerSeed): Promise<void> { await lifecyclePlanAndExecute(this.lifecycleContext(), planner, workers, seed); }

  async drain(): Promise<void> { await lifecycleDrain(this.lifecycleContext()); }

  private async checkDrainComplete(): Promise<void> { await lifecycleCheckDrainComplete(this.lifecycleContext()); }

  async stop(): Promise<void> { await lifecycleStop(this.lifecycleContext()); }

  private async buildSeed(clonePath: string, cfg: RunConfig): Promise<PlannerSeed> { return buildSeedExtracted(this.contractContext(), clonePath, cfg); }

  private async tryResumeContract(_clonePath: string): Promise<boolean> { return tryResumeContractExtracted(this.contractContext()); }

  private async loadPriorRunSummary(clonePath: string): Promise<PriorRunSummary | undefined> { return loadPriorRunSummaryExtracted(clonePath); }

  // --- Phase 11b: first-pass exit contract ---

  private async runFirstPassContract(agent: Agent, seed: PlannerSeed): Promise<void> { return runFirstPassContractExtracted(this.contractContext(), agent, seed); }

  private async runFirstPassContractOrchestrator(planner: Agent, workers: Agent[], seed: PlannerSeed): Promise<void> {
    return runFirstPassContractOrchestratorExtracted(this.contractContext(), planner, workers, seed);
  }

  private async tryCouncilContract(planner: Agent, workers: Agent[], seed: PlannerSeed): Promise<ParsedContract | null> {
    return tryCouncilContractExtracted(this.contractContext(), planner, workers, seed);
  }

  private finalizeContract(parsed: ParsedContract, seed: PlannerSeed, ownerAgent: Agent): void { finalizeContractExtracted(this.contractContext(), parsed, seed, ownerAgent); }

  private buildContract(parsed: ParsedContract): ExitContract { return buildContractExtracted(parsed); }

  private cloneContract(c: ExitContract): ExitContract { return cloneContractExtracted(c); }

  // --- Context builders ---

  private lifecycleContext(): LifecycleContext { return lifecycleContextBuilder(this.asFields()); }
  private contractContext(): ContractContext { return contractContextBuilder(this.asFields()); }
  private tierContext(): TierContext { return tierContextBuilder(this.asFields()); }
  private plannerContext(): PlannerContext { return plannerContextBuilder(this.asFields()); }
  private workerContext(): WorkerContext { return workerContextBuilder(this.asFields()); }
  private promptContext(): PromptContext { return promptContextBuilder(this.asFields()); }
  private capContext(): CapContext { return capContextBuilder(this.asFields()); }
  private replanContext(): ReplanContext { return replanContextBuilder(this.asFields()); }
  private auditorContext(): AuditorContext { return auditorContextBuilder(this.asFields()); }
  private adaptiveWatchdogCtx(): AdaptiveWatchdogContext { return adaptiveWatchdogCtxBuilder(this.asFields()); }

  private async runPlanner(agent: Agent, seed: PlannerSeed, isFallbackAttempt = false): Promise<void> { return runPlannerExtracted(this.plannerContext(), agent, seed, isFallbackAttempt); }

  private async runAuditedExecution(planner: Agent, workers: Agent[]): Promise<void> {
    this.workerPool = workers;
    await runAuditedExecutionExtracted(this.tierContext(), planner, workers);
  }

  private async runPlannerFallbackForUnmetCriteria(planner: Agent): Promise<boolean> { return runPlannerFallbackForUnmetCriteriaExtracted(this.plannerContext(), planner); }

  private allCriteriaResolved(): boolean { return allCriteriaResolvedExtracted(this.tierContext()); }
  private allCriteriaMet(): boolean { return allCriteriaMetExtracted(this.tierContext()); }
  private resolvedMaxTiers(): number { return resolvedMaxTiersExtracted(this.tierContext()); }
  private recordTierCompletion(): void { recordTierCompletionExtracted(this.tierContext()); }
  private async tryPromoteNextTier(planner: Agent, maxTiers: number): Promise<boolean> { return tryPromoteNextTierExtracted(this.tierContext(), planner, maxTiers); }
  private largestCriterionIdNumber(): number { return largestCriterionIdNumberExtracted(this.tierContext()); }
  private get maxAuditInvocations(): number { return maxAuditInvocationsExtracted(this.tierContext()); }

  private async runAuditor(planner: Agent, opts: { allowWhenStopping?: boolean } = {}): Promise<void> { await runAuditorExtracted(this.auditorContext(), planner, opts); }

  private applyAuditorResult(result: AuditorResult, planner: Agent): void { applyAuditorResultExtracted(this.auditorContext(), result, planner); }

  // --- Workers ---

  private async runWorkers(workers: Agent[]): Promise<void> { await runWorkersExtracted(this.workerContext(), workers); }
  private async runWorker(agent: Agent): Promise<void> { await runWorkerExtracted(this.workerContext(), agent); }
  private async executeBuildTodo(agent: Agent, todo: Todo): Promise<"committed" | "stale" | "lost-race" | "aborted"> { return executeBuildTodoExtracted(this.workerContext(), agent, todo); }
  private maybeSettleHypothesisGroup(todoId: string): void { maybeSettleHypothesisGroupExtracted(this.workerContext(), todoId); }
  private async executeWorkerTodo(agent: Agent, todo: Todo): Promise<"committed" | "stale" | "lost-race" | "aborted"> { return executeWorkerTodoExtracted(this.workerContext(), agent, todo); }

  private enqueueReplan(todoId: string): void { enqueueReplanExtracted(this.replanContext(), todoId); }
  private async processReplanQueue(): Promise<void> { await processReplanQueueExtracted(this.replanContext()); }
  private async replanOne(todoId: string): Promise<void> { await replanOneExtracted(this.replanContext(), todoId); }

  private startReplanWatcher(): void {
    if (this.replanTickTimer) return;
    this.replanTickTimer = startReplanWatcherExtracted(this.replanContext());
  }

  private stopReplanWatcher(): void {
    stopReplanWatcherExtracted(this.replanTickTimer);
    this.replanTickTimer = undefined;
    this.replanPending.clear();
    this.planner = undefined;
    this.auditor = undefined;
  }

  private markPlannerStatus(planner: Agent, status: "thinking" | "ready"): void {
    markPlannerStatusExtracted(planner, status, this.opts.manager, (s) => this.emitAgentState(s));
  }

  private isOverWallClockCap(): boolean { return isOverWallClockCapExtracted(this.capContext()); }
  private checkAndApplyCaps(): boolean { return checkAndApplyCapsExtracted(this.capContext()); }
  private enterPause(quotaState: { statusCode: number; reason: string } | null): void { enterPauseExtracted(this.capContext(), quotaState); }
  private schedulePauseProbe(): void { schedulePauseProbeExtracted(this.capContext()); }
  private async runPauseProbe(): Promise<void> { await runPauseProbeExtracted(this.capContext()); }
  private exitPause(): void { exitPauseExtracted(this.capContext()); }

  private async writeCrashSnapshot(err: unknown): Promise<void> { await writeCrashSnapshotExtracted(this.utilCtx(), err); }

  private async runAutoRollbacks(): Promise<void> {
    const cfg = this.active;
    if (!cfg) return;
    await runAutoRollbacksExtracted({
      cfg,
      contract: this.contract,
      commitsByCriterion: this.commitsByCriterion,
      autoRollbacks: this.autoRollbacks,
      appendSystem: (msg) => this.appendSystem(msg),
    });
  }

  private async writeBlackboardDeliverable(): Promise<void> {
    const cfg = this.active;
    if (!cfg || !cfg.runId) return;
    const planner = this.planner;
    await writeBlackboardDeliverableExtracted({
      cfg,
      runStartedAt: this.runStartedAt,
      contract: this.contract,
      transcript: this.transcript,
      autoRollbacks: this.autoRollbacks,
      planner,
      manager: this.opts.manager,
      repos: this.opts.repos,
      appendSystem: (msg, meta) => this.appendSystem(msg, meta as any),
    });
  }

  private async writeRunSummary(crashMessage: string | undefined): Promise<void> {
    const cfg = this.active;
    if (!cfg) return;
    if (this.runBootedAt === undefined) return;

    const clone = cfg.localPath;
    let gitStatus = { porcelain: "", changedFiles: 0 };
    try {
      gitStatus = await this.opts.repos.gitStatus(clone);
    } catch {
      // gitStatus already swallows, but belt-and-braces.
    }

    const agentStats: PerAgentStat[] = this.buildPerAgentStats();
    const counts = this.boardCounts();

    await writeRunSummaryExtracted({
      cfg,
      runBootedAt: this.runBootedAt!,
      runStartedAt: this.runStartedAt,
      tickAccumulatorActiveElapsedMs: this.tickAccumulator?.activeElapsedMs,
      stopping: this.isStopping(),
      terminationReason: this.terminationReason,
      completionDetail: this.completionDetail,
      staleEventCount: this.staleEventCount,
      auditInvocations: this.auditInvocations,
      currentTier: this.currentTier,
      tiersCompleted: this.tiersCompleted,
      tierHistory: this.tierHistory,
      contract: this.contract,
      transcript: this.transcript,
      agentStats,
      boardCounts: { committed: counts.committed, skipped: counts.skipped, stale: counts.stale, total: counts.total },
      gitStatus,
      errorTracker: this.errorTracker,
      v2State: {
        phase: this.v2Observer.getState().phase,
        enteredAt: this.v2Observer.getState().enteredAt,
        detail: this.v2Observer.getState().detail,
        pausedReason: this.v2Observer.getState().pausedReason,
      },
      v2QueueState: { counts: this.todoQueue.counts() },
      cloneContract: (c) => this.cloneContract(c),
      lastSummarySetter: (s) => { this.lastSummary = s; },
      emit: this.opts.emit,
      appendSystem: (msg, ...args) => this.appendSystem(msg, ...args),
    });
  }

  private buildPerAgentStats(): PerAgentStat[] {
    return buildPerAgentStatsExtracted({
      agentRoster: this.agentRoster,
      turnsPerAgent: this.turnsPerAgent,
      promptTokensPerAgent: this.promptTokensPerAgent,
      responseTokensPerAgent: this.responseTokensPerAgent,
      attemptsPerAgent: this.attemptsPerAgent,
      retriesPerAgent: this.retriesPerAgent,
      latenciesPerAgent: this.latenciesPerAgent,
      commitsPerAgent: this.commitsPerAgent,
      linesAddedPerAgent: this.linesAddedPerAgent,
      linesRemovedPerAgent: this.linesRemovedPerAgent,
      rejectedAttemptsPerAgent: this.rejectedAttemptsPerAgent,
      jsonRepairsPerAgent: this.jsonRepairsPerAgent,
      promptErrorsPerAgent: this.promptErrorsPerAgent,
    });
  }

  private scheduleStateWrite(): void { this.stateSnapshotScheduler.schedule(); }
  private async flushStateWrite(): Promise<void> { await this.stateSnapshotScheduler.flush(); }

  // --- File I/O helpers ---

  private boardCounts() { return boardCountsExtracted(this.utilCtx()); }
  private boardListTodos() { return boardListTodosExtracted(this.utilCtx()); }
  private boardSnapshot() { return boardSnapshotExtracted(this.utilCtx()); }
  private boardGetTodo(id: string) { return boardGetTodoExtracted(this.utilCtx(), id); }

  buildReflectionContext(_planner: Agent, abortSignal: AbortSignal): ReflectionContext {
    const counts = this.boardCounts();
    return {
      transcript: this.transcript,
      appendSystem: (text, summary) => this.appendSystem(text, summary),
      emit: (e) => this.opts.emit(e as SwarmEvent),
      currentTier: this.currentTier,
      committedCount: counts.committed,
      contractCriteria: this.contract?.criteria ?? [],
      runId: this.active?.runId ?? "",
      signal: abortSignal,
      onPlannerStatusChange: (status) => {
        this.markPlannerStatus(_planner, status);
      },
      userDirective: this.active?.userDirective,
    };
  }

  private async readExpectedFiles(files: string[]): Promise<Record<string, string | null>> { return readExpectedFilesExtracted(this.active?.localPath, files); }

  private async resolveSafe(relPath: string): Promise<string> { return resolveSafePathExtracted(this.active?.localPath, relPath); }

  // --- Expiry + cap watchdog ---

  private startCapWatchdog(): void { startCapWatchdogExtracted(this.capContext()); }

  private async discoverLocalOllamaTags(): Promise<void> {
    await discoverLocalOllamaTagsExtracted({
      active: this.active,
      localOllamaTags: this.localOllamaTags,
      setLocalOllamaTags: (v) => { this.localOllamaTags = v; },
      getOllamaBaseUrl: () => this.opts.ollamaBaseUrl,
    });
  }

  private buildFailoverConfig(): FailoverConfig {
    return buildFailoverConfigExtracted({
      active: this.active,
      localOllamaTags: this.localOllamaTags,
      setLocalOllamaTags: (v) => { this.localOllamaTags = v; },
      getOllamaBaseUrl: () => this.opts.ollamaBaseUrl,
    });
  }

  private checkMemoryPressureTick(): void { checkMemoryPressureTickExtracted(this.capContext()); }

  setSubscriberPaused(paused: boolean): void { setSubscriberPausedExtracted(this.capContext(), paused); }

  // Adaptive worker pool: polls backlog vs pool size; spawn/kill with hysteresis.
  private adaptiveWatchdog: NodeJS.Timeout | undefined;
  private adaptiveHysteresis = { upPolls: 0, downPolls: 0 };
  private adaptiveScaleInFlight = false;
  private startAdaptiveWorkerWatchdog(opts: AdaptiveWatchdogOpts): void { startAdaptiveWorkerWatchdogExtracted(this.adaptiveWatchdogCtx(), opts); }
  private async scaleUpAdaptive(opts: AdaptiveWatchdogOpts, totalLive: number): Promise<void> { await scaleUpAdaptiveExtracted(this.adaptiveWatchdogCtx(), opts, totalLive); }
  private async scaleDownAdaptive(opts: AdaptiveWatchdogOpts): Promise<void> { await scaleDownAdaptiveExtracted(this.adaptiveWatchdogCtx(), opts); }

  private queueReaperCtx(): QueueReaperContext {
    return {
      getReaperTimer: () => this.reaperTimer,
      setReaperTimer: (v) => { this.reaperTimer = v; },
      todoQueue: this.todoQueue,
      appendSystem: (msg) => this.appendSystem(msg),
      boardBroadcaster: this.boardBroadcaster,
      bumpStaleEventCount: () => { this.staleEventCount++; },
      enqueueReplan: (id) => this.enqueueReplan(id),
      scheduleStateWrite: () => this.scheduleStateWrite(),
      adaptiveWatchdogCtx: () => this.adaptiveWatchdogCtx(),
    };
  }

  private startQueueReaper(): void { startQueueReaperExtracted(this.queueReaperCtx()); }

  private stopQueueReaper(): void { stopQueueReaperExtracted(this.queueReaperCtx()); }

  private stopCapWatchdog(): void { stopCapWatchdogExtracted(this.capContext()); }

  private async promptPlannerSafely(primaryAgent: Agent, promptText: string, agentName: "swarm" | "swarm-read" | "swarm-builder" = "swarm", ollamaFormat?: "json" | Record<string, unknown>): Promise<{ response: string; agentUsed: Agent }> { return promptPlannerSafelyExtracted(this.promptContext(), primaryAgent, promptText, agentName, ollamaFormat); }

  private async promptAgent(agent: Agent, prompt: string, agentName: "swarm" | "swarm-read" | "swarm-builder" = "swarm", formatExpect: "json" | "free" = "json", ollamaFormat?: "json" | Record<string, unknown>): Promise<string> { return promptAgentExtracted(this.promptContext(), agent, prompt, agentName, formatExpect, ollamaFormat); }

  /** Brain fallback prompt function. Calls the configured brain model directly
   *  via promptAgent to extract structured JSON from a failed parse. */
  private async brainPromptFn(prompt: string, model: string, maxTokens: number, _timeoutMs: number): Promise<string> {
    const brainCfg = brainConfigFromApp(this.active?.brainModel);
    const agent: Agent = {
      id: "brain",
      index: -1,
      model: brainCfg.brainModel,
      port: 0,
      sessionId: "brain",
      status: "idle",
      thinkingSince: undefined,
      lastChunkAt: undefined,
      pid: undefined,
      cwd: "",
    };
    return this.promptAgent(agent, prompt, "swarm-read", "json", { type: "object" });
  }

  // --- Misc helpers ---

  private sleep(ms: number): Promise<void> { return sleepExtracted(ms); }

  private appendSystem(text: string, summary?: TranscriptEntrySummary): void {
    const entry: TranscriptEntry = { id: randomUUID(), role: "system", text, ts: Date.now(), summary };
    this.transcript.push(entry);
    this.opts.emit({ type: "transcript_append", entry });
  }

  private recordError(err: unknown, opts: { causeHint?: ErrorCategory; statusCode?: number } = {}): ClassifiedError {
    return recordErrorExtracted({ errorTracker: this.errorTracker, maxTrackedErrors: BlackboardRunner.MAX_TRACKED_ERRORS }, err, opts);
  }

  private directiveWithAmendments(): string | undefined { return directiveWithAmendmentsExtracted(this.utilCtx()); }

  private appendAgent(agent: Agent, text: string): void {
    const ctx = this.utilCtx();
    appendAgentExtracted(ctx, agent, text);
    this.consecutiveLoopDetections = ctx.consecutiveLoopDetections;
    this.lastLoopWarningAtTurn = ctx.lastLoopWarningAtTurn;
    this.lifecycleState = ctx.lifecycleState;
    this.terminationReason = ctx.terminationReason;
  }

  private maybeEmitLoopWarning(): void {
    const ctx = this.utilCtx();
    maybeEmitLoopWarningExtracted(ctx);
    this.consecutiveLoopDetections = ctx.consecutiveLoopDetections;
    this.lastLoopWarningAtTurn = ctx.lastLoopWarningAtTurn;
    this.lifecycleState = ctx.lifecycleState;
    this.terminationReason = ctx.terminationReason;
  }

  private setPhase(phase: SwarmPhase): void { setPhaseExtracted(this.utilCtx(), phase); this.phase = phase; }

  private emitAgentState(s: AgentState): void { emitAgentStateExtracted(this.opts.manager, s); }

  private extractText(res: unknown): string | undefined { return extractTextExtracted(res); }
}

export { parseGoalList } from "./goalListParser.js";
