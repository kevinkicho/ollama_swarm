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
  setPhase as setPhaseExtracted,
  setPlanningSubphase as setPlanningSubphaseExtracted,
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
  type TodoQueueWrappers,
} from "./todoQueueWrappers.js";
import {
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
import { type BoardBroadcaster } from "./boardBroadcaster.js";
import { bootstrapBlackboardRunner } from "./blackboardBootstrap.js";
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
import { buildWriteRunSummaryContext } from "./writeRunSummaryBag.js";
import { InteractionTracker } from "./brainOverseer/interactionTracker.js";
import { ExceptionCollector } from "./brainOverseer/exceptionCollector.js";
import { SwarmControlCenter } from "../control/SwarmControlCenter.js";
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
import type { BlackboardRunnerFields } from "./runnerContextTypes.js";
import {
  buildBlackboardContexts,
  type BlackboardContexts,
} from "./blackboardContextAccessors.js";
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
import {
  clearExplorationCache as clearExplorationCacheExtracted,
  getExplorationCache as getExplorationCacheExtracted,
  getRepoFiles as getRepoFilesExtracted,
  setExplorationCache as setExplorationCacheExtracted,
  syncExplorationCacheFromSeed as syncExplorationCacheFromSeedExtracted,
} from "./explorationCache.js";
import { getDrainEligibilityInput as getDrainEligibilityInputExtracted } from "./drainEligibilityHost.js";

export class BlackboardRunner implements SwarmRunner {
  private transcript: TranscriptEntry[] = [];
  private phase: SwarmPhase = "idle";
  private round = 0;
  private lifecycleState: LifecycleState = "idle";
  /** Sticky marker: true once `draining` entered, survives into `stopping`/`stopped`. */
  private _wasDrained = false;
  /** Sticky marker: true once user hard-stops; survives summary races in planAndExecute finally. */
  private _userStopRequested = false;
  /** Set when start() throws before planAndExecute; surfaced in stop() summary. */
  private _startupCrashMessage: string | undefined;
  private isStopping(): boolean { return this.lifecycleState === "stopping"; }
  private isDraining(): boolean { return this.lifecycleState === "draining"; }
  private isWasDrained(): boolean { return this._wasDrained; }
  private isUserStopRequested(): boolean { return this._userStopRequested; }
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
  private planningStartedAt?: number;
  private planningSubphase?: import("@ollama-swarm/shared/planningSubphase").PlanningSubphase;
  private explorationCache: import("@ollama-swarm/shared/explorationCache").ExplorationCacheEntry[] = [];
  private repoFilesCache: string[] = [];
  private contractDerivationFailure?: string;
  private replanTickTimer?: NodeJS.Timeout;
  // Plan 4: brain system overseer — tracks interaction chains and exceptions
  private interactionTracker = new InteractionTracker();
  private exceptionCollector: ExceptionCollector | null = null;
  private swarmControl = new SwarmControlCenter();
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
  // W13/W14/W15: per-run failover state carrying per-model attempt-history.
  private failoverState: FailoverState = { modelHealth: new Map() };
  // W14: local Ollama tags discovered at run-start for local fallback.
  private localOllamaTags: readonly string[] = [];
  // W16/R7: subscriber-disconnect pause flag.
  private subscriberPaused = false;
  // W17/R13: heap-pressure pause flag.
  private memoryPaused = false;
  private consecutiveStuckCycles = 0;
  /** Last planner/auditor transport stall — tier loop must not count quota hits as stuck. */
  private lastProviderStallReason?: string;

  noteProviderStall(msg: string): void {
    this.lastProviderStallReason = msg;
  }

  consumeProviderStall(): string | undefined {
    const msg = this.lastProviderStallReason;
    this.lastProviderStallReason = undefined;
    return msg;
  }
  // #167: drain/soft-stop state (timing metadata only; primary state in lifecycleState).
  private drainStartedAt?: number;
  private drainWatcherTimer?: NodeJS.Timeout;
  private terminationReason?: string;
  // Phase 9: run-summary counters + per-agent stats.
  private runBootedAt?: number;
  /** `git status --porcelain` captured after clone setup; scopes summary git stats to this run. */
  private gitPorcelainAtRunStart = "";
  private staleEventCount = 0;
  private turnsPerAgent = new Map<string, number>();
  /** Stashed in promptAgent, consumed in appendAgent for transcript promptText. */
  private pendingPromptByAgent = new Map<string, { text: string; label?: string }>();
  /** Buffered onTool callbacks; consumed in appendAgent as entry.toolTrace. */
  private pendingToolTraceByAgent = new Map<string, import("../toolCallTranscript.js").ToolTraceEntry[]>();
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
  /** True when resumeContract restored todos from blackboard-state.json. */
  private boardRestoredFromSnapshot = false;
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
    const boot = bootstrapBlackboardRunner({
      emit: this.opts.emit,
      todoQueue: this.todoQueue,
      v2Observer: this.v2Observer,
      getPhase: () => this.phase,
      getRound: () => this.round,
      getRunBootedAt: () => this.runBootedAt,
      getRunStartedAt: () => this.runStartedAt,
      getTickAccumulatorActiveElapsedMs: () => this.tickAccumulator?.activeElapsedMs,
      getActive: () => this.active,
      getContract: () => this.contract,
      cloneContract: (c) => this.cloneContract(c),
      boardSnapshot: () => this.boardSnapshot(),
      buildPerAgentStats: () => this.buildPerAgentStats(),
      getStaleEventCount: () => this.staleEventCount,
      getAuditInvocations: () => this.auditInvocations,
      getAgentRoster: () => this.agentRoster,
      getTerminationReason: () => this.terminationReason,
      getCompletionDetail: () => this.completionDetail,
      getCurrentTier: () => this.currentTier,
      getTiersCompleted: () => this.tiersCompleted,
      getTierHistory: () => this.tierHistory,
      scheduleStateWrite: () => this.scheduleStateWrite(),
      bumpStaleAndEnqueueReplan: (todoId) => {
        this.staleEventCount++;
        this.enqueueReplan(todoId);
      },
    });
    this.boardBroadcaster = boot.boardBroadcaster;
    this.findings = boot.findings;
    this.stateSnapshotScheduler = boot.stateSnapshotScheduler;
    this.wrappers = boot.wrappers;
  }

  private asFields(): BlackboardRunnerFields {
    return this as unknown as BlackboardRunnerFields;
  }

  private contexts(): BlackboardContexts {
    return buildBlackboardContexts(this.asFields());
  }

  private utilCtx(): RunnerUtilContext {
    return this.contexts().util();
  }

  private allCriteriaResolvedSnapshot(): boolean { return allCriteriaResolvedSnapshotExtracted(this.tierContext()); }

  status(): SwarmStatus {
    const v2 = this.v2Observer.getState();
    return statusExtracted({
      phase: this.phase,
      v2Phase: v2.phase,
      v2PausedReason: v2.pausedReason,
      planningSubphase: this.planningSubphase,
      getDrainEligibilityInput: (partial) => this.getDrainEligibilityInput(partial),
      getTodoQueueCounts: () => this.todoQueue.counts(),
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
      getActivitySnapshot: () =>
        typeof this.opts.manager.getActivitySnapshot === "function"
          ? this.opts.manager.getActivitySnapshot()
          : {},
      getTerminationReason: () => this.terminationReason,
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

  /** start() blocks until the blackboard lifecycle finishes. */
  async waitUntilSettled(): Promise<void> {
    /* no-op — lifecycleStart is fully awaited inside start() */
  }

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

  // --- Context builders (via blackboardContextAccessors) ---

  private lifecycleContext(): LifecycleContext { return this.contexts().lifecycle(); }
  private contractContext(): ContractContext { return this.contexts().contract(); }
  private tierContext(): TierContext { return this.contexts().tier(); }
  private plannerContext(): PlannerContext { return this.contexts().planner(); }
  private workerContext(): WorkerContext { return this.contexts().worker(); }
  private promptContext(): PromptContext { return this.contexts().prompt(); }
  private capContext(): CapContext { return this.contexts().cap(); }
  private replanContext(): ReplanContext { return this.contexts().replan(); }
  private auditorContext(): AuditorContext { return this.contexts().auditor(); }
  private adaptiveWatchdogCtx(): AdaptiveWatchdogContext { return this.contexts().adaptiveWatchdog(); }

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
  private async executeBuildTodo(agent: Agent, todo: Todo): Promise<"committed" | "stale" | "lost-race" | "aborted" | "pending-commit" | "released" | "skipped"> { return executeBuildTodoExtracted(this.workerContext(), agent, todo); }
  private maybeSettleHypothesisGroup(todoId: string): void { maybeSettleHypothesisGroupExtracted(this.workerContext(), todoId); }
  private async executeWorkerTodo(agent: Agent, todo: Todo): Promise<"committed" | "stale" | "lost-race" | "aborted" | "pending-commit" | "released" | "skipped"> { return executeWorkerTodoExtracted(this.workerContext(), agent, todo); }

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
    const advice = this.swarmControl.getAdviceHistory();

    await writeRunSummaryExtracted(
      buildWriteRunSummaryContext(
        {
          active: cfg,
          runBootedAt: this.runBootedAt!,
          gitPorcelainAtRunStart: this.gitPorcelainAtRunStart,
          runStartedAt: this.runStartedAt,
          tickAccumulatorActiveElapsedMs: this.tickAccumulator?.activeElapsedMs,
          isStopping: () => this.isStopping(),
          isUserStopRequested: () => this.isUserStopRequested(),
          isWasDrained: () => this.isWasDrained(),
          getLastSummary: () => this.lastSummary,
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
          boardCounts: {
            committed: counts.committed,
            skipped: counts.skipped,
            stale: counts.stale,
            total: counts.total,
          },
          gitStatus,
          errorTracker: this.errorTracker,
          controlAdvice: advice.length > 0 ? [...advice] : undefined,
          v2Observer: this.v2Observer,
          todoQueue: this.todoQueue,
          cloneContract: (c) => this.cloneContract(c),
          lastSummarySetter: (s) => {
            this.lastSummary = s;
          },
          emit: this.opts.emit,
          appendSystem: (msg, summary) => this.appendSystem(msg, summary),
        },
        crashMessage,
      ),
    );
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
      manager: this.opts.manager,
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

  // Plan 4: initialize brain overseer components for this run.
  // Phase 10: brain enablement is solely via enableBrainAnalysis flag.
  initRunControl(runId: string): void {
    this.swarmControl.reset();
    const clonePath = this.active?.localPath;
    if (clonePath) void this.swarmControl.loadPriorPatterns(clonePath);
    void runId;
  }

  getSwarmControl(): SwarmControlCenter {
    return this.swarmControl;
  }

  initBrainOverseer(runId: string): void {
    const cfg = this.active as any;
    if (cfg?.enableBrainAnalysis === false) return;
    this.exceptionCollector = new ExceptionCollector(runId);
    this.interactionTracker = new InteractionTracker();
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
    } satisfies QueueReaperContext;
  }

  private startQueueReaper(): void { startQueueReaperExtracted(this.queueReaperCtx()); }

  private stopQueueReaper(): void { stopQueueReaperExtracted(this.queueReaperCtx()); }

  private stopCapWatchdog(): void { stopCapWatchdogExtracted(this.capContext()); }

  private async promptPlannerSafely(
    primaryAgent: Agent,
    promptText: string,
    agentName: import("../../tools/ToolDispatcher.js").ProfileName = "swarm",
    ollamaFormat?: "json" | Record<string, unknown>,
    activity?: {
      kind?: string;
      label?: string;
      maxToolTurns?: number;
      mode?: "explore" | "emit";
      promptWallClockMs?: number;
    },
  ): Promise<{ response: string; agentUsed: Agent }> {
    return promptPlannerSafelyExtracted(this.promptContext(), primaryAgent, promptText, agentName, ollamaFormat, activity);
  }

  private explorationHost(): import("./explorationCache.js").ExplorationCacheHost {
    return this as unknown as import("./explorationCache.js").ExplorationCacheHost;
  }

  getExplorationCache(): import("@ollama-swarm/shared/explorationCache").ExplorationCacheEntry[] {
    return getExplorationCacheExtracted(this.explorationHost());
  }

  setExplorationCache(
    cache: import("@ollama-swarm/shared/explorationCache").ExplorationCacheEntry[],
  ): void {
    setExplorationCacheExtracted(this.explorationHost(), cache);
  }

  clearExplorationCache(): void {
    clearExplorationCacheExtracted(this.explorationHost());
  }

  syncExplorationCacheFromSeed(seed: PlannerSeed): void {
    syncExplorationCacheFromSeedExtracted(this.explorationHost(), seed);
  }

  getRepoFiles(): readonly string[] {
    return getRepoFilesExtracted(this.explorationHost());
  }

  getDrainEligibilityInput(partial: { claimed: number; pendingCommit: number }): import("./drainEligibility.js").DrainEligibilityInput {
    return getDrainEligibilityInputExtracted(
      {
        phase: this.phase,
        replanPending: this.replanPending,
        replanRunning: this.replanRunning,
        managerToStates: () => this.opts.manager.toStates(),
      },
      partial,
    );
  }

  private async promptAgent(agent: Agent, prompt: string, agentName: import("../../tools/ToolDispatcher.js").ProfileName = "swarm", formatExpect: "json" | "free" = "json", ollamaFormat?: "json" | Record<string, unknown>, activity?: { kind?: string; label?: string; maxToolTurns?: number; mode?: "explore" | "emit"; promptWallClockMs?: number }): Promise<string> { return promptAgentExtracted(this.promptContext(), agent, prompt, agentName, formatExpect, ollamaFormat, activity); }

  /** Brain fallback prompt function. Uses the passed agent (the caller's
   *  agent) for model, tools, and session context. Falls back to a
   *  dedicated brain agent when no caller agent is provided. */
  private async brainPromptFn(prompt: string, _model: string, maxTokens: number, _timeoutMs: number, callerAgent?: Agent): Promise<string> {
    const cfg = this.active as any;
    if (cfg?.enableBrainAnalysis === false) {
      throw new Error("brain disabled (enableBrainAnalysis=false)");
    }
    // Use the caller's agent when provided — this gives the brain real
    // model context, tools, and session instead of a fake agent.
    const agent: Agent = callerAgent ?? {
      id: "brain",
      index: -1,
      model: brainConfigFromApp(this.active?.brainModel).brainModel,
      port: 0,
      sessionId: "brain",
      status: "idle",
      thinkingSince: undefined,
      lastChunkAt: undefined,
      pid: undefined,
      cwd: "",
    } as any;
    return this.promptAgent(agent, prompt, "swarm-read", "json", { type: "object" });
  }

  // --- Misc helpers ---

  private sleep(ms: number): Promise<void> { return sleepExtracted(ms); }

  private appendSystem(text: string, summary?: TranscriptEntrySummary): void {
    const entry: TranscriptEntry = { id: randomUUID(), role: "system", text, ts: Date.now(), summary };
    this.transcript.push(entry);
    this.opts.emit({ type: "transcript_append", entry });
  }

  appendSystemMessage(text: string, summary?: TranscriptEntrySummary): void {
    this.appendSystem(text, summary);
  }

  reconfig(_changes: import("../runReconfig.js").RunReconfigChanges): void {
    // Cap checks read this.active live — cfg mutation is sufficient.
  }

  private recordError(err: unknown, opts: { causeHint?: ErrorCategory; statusCode?: number } = {}): ClassifiedError {
    return recordErrorExtracted({ errorTracker: this.errorTracker, maxTrackedErrors: BlackboardRunner.MAX_TRACKED_ERRORS }, err, opts);
  }

  private directiveWithAmendments(): string | undefined { return directiveWithAmendmentsExtracted(this.utilCtx()); }

  private appendAgent(agent: Agent, text: string, options?: import("./runnerUtil.js").AppendAgentOptions): void {
    const ctx = this.utilCtx();
    appendAgentExtracted(ctx, agent, text, options);
    this.lifecycleState = ctx.lifecycleState;
    this.terminationReason = ctx.terminationReason;
  }

  private setPhase(phase: SwarmPhase): void {
    const ctx = this.utilCtx();
    setPhaseExtracted(ctx, phase);
    this.phase = phase;
    this.planningSubphase = ctx.planningSubphase;
  }

  private setPlanningSubphase(
    subphase: import("@ollama-swarm/shared/planningSubphase").PlanningSubphase | undefined,
  ): void {
    const ctx = this.utilCtx();
    setPlanningSubphaseExtracted(ctx, subphase);
    this.planningSubphase = subphase;
  }

  private emitAgentState(s: AgentState): void { emitAgentStateExtracted(this.opts.manager, s); }

  private extractText(res: unknown): string | undefined { return extractTextExtracted(res); }
}

export { parseGoalList } from "./goalListParser.js";
