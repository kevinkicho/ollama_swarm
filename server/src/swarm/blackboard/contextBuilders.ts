import type { Agent, AgentManager, SpawnOpts } from "../../services/AgentManager.js";
import type { AgentState, SwarmEvent, SwarmPhase, TranscriptEntry, TranscriptEntrySummary } from "../../types.js";
import type { RunConfig, RunnerOpts } from "../SwarmRunner.js";
import type { ClassifiedError, ErrorCategory } from "../errorTaxonomy.js";
import type { FailoverState, FailoverConfig } from "../promptWithFailover.js";
import type { ExitContract, Todo } from "./types.js";
import type { FindingsLog } from "./FindingsLog.js";
import type { TodoQueue } from "./TodoQueue.js";
import type { TodoQueueWrappers } from "./todoQueueWrappers.js";
import type { TierHistoryEntry } from "./tierRunner.js";
import type { TickAccumulator } from "./caps.js";
import type { BlackboardStateSnapshot } from "./stateSnapshot.js";
import type { RunSummary } from "./summary.js";
import type { LifecycleContext } from "./lifecycleRunner.js";
import type { ContractContext } from "./contractBuilder.js";
import type { TierContext } from "./tierRunner.js";
import type { PlannerContext } from "./plannerRunner.js";
import type { WorkerContext } from "./workerRunner.js";
import type { PromptContext } from "./promptRunner.js";
import type { ReplanContext } from "./replanManager.js";
import type { CloneOptions } from "../../services/RepoService.js";
import type { AdaptiveWatchdogOpts } from "./adaptiveWorkerWatchdog.js";
import type { AuditorContext } from "./auditorRunner.js";
import type { CapContext } from "./capManager.js";
import type { AdaptiveWatchdogContext } from "./adaptiveWorkerWatchdog.js";
import type { RunnerUtilContext } from "./runnerUtil.js";
import type { PlannerSeed } from "./prompts/planner.js";
import { bumpAgentCounter } from "./runnerHelpers.js";
import { pheromoneHeatmap } from "../pheromoneHeatmap.js";
import type { LifecycleState } from "./lifecycleState.js";
import { brainEnabled } from "./prompts/brainIntegration.js";
import type { ProfileName } from "../../tools/ToolDispatcher.js";
import type { ExplorationCacheEntry } from "@ollama-swarm/shared/explorationCache";
import type { StallGateVerdict } from "@ollama-swarm/shared/swarmControl/types";

// BlackboardRunnerFields is now a generated interface (125 properties,
// 11 per-context subsets). Regenerate via:
//   npx tsx server/scripts/discover-runner-fields.ts > server/src/swarm/blackboard/runnerContextTypes.ts
// The CI check in ci.yml guards against drift (<100 unique props fails).
import type { BlackboardRunnerFields } from "./runnerContextTypes.js";

export function utilCtx(r: BlackboardRunnerFields): RunnerUtilContext {
  return {
    active: r.active,
    phase: r.phase,
    planningSubphase: r.planningSubphase,
    round: r.round,
    runStartedAt: r.runStartedAt,
    transcript: r.transcript,
    todoQueue: r.todoQueue,
    findings: r.findings,
    activeAborts: r.activeAborts,
    lifecycleState: r.lifecycleState,
    terminationReason: r.terminationReason,
    scheduleStateWrite: () => r.scheduleStateWrite(),
    appendSystem: (text: string, summary?: TranscriptEntrySummary) => r.appendSystem(text, summary),
    emit: (e: SwarmEvent) => r.opts.emit(e),
    getAmendments: r.opts.getAmendments,
    pendingPromptByAgent: r.pendingPromptByAgent,
    pendingToolTraceByAgent: r.pendingToolTraceByAgent,
  } as RunnerUtilContext;
}

export function lifecycleContext(r: BlackboardRunnerFields): LifecycleContext {
  return {
    isRunning: () => r.isRunning(),
    getLifecycleState: () => r.lifecycleState,
    setLifecycleState: (v: LifecycleState) => { r.lifecycleState = v; },
    getWasDrained: () => r._wasDrained,
    setWasDrained: (v: boolean) => { r._wasDrained = v; },
    getUserStopRequested: () => r._userStopRequested,
    setUserStopRequested: (v: boolean) => { r._userStopRequested = v; },
    getStartupCrashMessage: () => r._startupCrashMessage,
    setStartupCrashMessage: (v: string | undefined) => { r._startupCrashMessage = v; },
    getPaused: () => r.paused,
    setPaused: (v: boolean) => { r.paused = v; },
    getRound: () => r.round,
    setRound: (v: number) => { r.round = v; },
    getRunStartedAt: () => r.runStartedAt,
    setRunStartedAt: (v: number | undefined) => { r.runStartedAt = v; },
    getRunBootedAt: () => r.runBootedAt,
    setRunBootedAt: (v: number | undefined) => { r.runBootedAt = v; },
    getGitPorcelainAtRunStart: () => r.gitPorcelainAtRunStart,
    setGitPorcelainAtRunStart: (v: string) => { r.gitPorcelainAtRunStart = v; },
    getTokenBaselineForRun: () => r.tokenBaselineForRun,
    setTokenBaselineForRun: (v: number | undefined) => { r.tokenBaselineForRun = v; },
    getTickAccumulator: () => r.tickAccumulator,
    setTickAccumulator: (v: TickAccumulator | undefined) => { r.tickAccumulator = v; },
    getTerminationReason: () => r.terminationReason,
    setTerminationReason: (v: string | undefined) => { r.terminationReason = v; },
    getDrainStartedAt: () => r.drainStartedAt,
    setDrainStartedAt: (v: number | undefined) => { r.drainStartedAt = v; },
    getPauseProbeTimer: () => r.pauseProbeTimer,
    setPauseProbeTimer: (v: NodeJS.Timeout | undefined) => { r.pauseProbeTimer = v; },
    getDrainWatcherTimer: () => r.drainWatcherTimer,
    setDrainWatcherTimer: (v: NodeJS.Timeout | undefined) => { r.drainWatcherTimer = v; },
    getPauseStartedAt: () => r.pauseStartedAt,
    setPauseStartedAt: (v: number | undefined) => { r.pauseStartedAt = v; },
    getTotalPausedMs: () => r.totalPausedMs,
    setTotalPausedMs: (v: number) => { r.totalPausedMs = v; },
    getSubscriberPaused: () => r.subscriberPaused,
    setSubscriberPaused: (v: boolean) => { r.subscriberPaused = v; },
    getMemoryPaused: () => r.memoryPaused,
    setMemoryPaused: (v: boolean) => { r.memoryPaused = v; },
    getLastMemoryPressureLevel: () => r.lastMemoryPressureLevel,
    setLastMemoryPressureLevel: (v: "ok" | "throttle" | "pause") => { r.lastMemoryPressureLevel = v; },
    getActive: () => r.active,
    setActive: (v: RunConfig | undefined) => { r.active = v; },
    getContract: () => r.contract,
    setContract: (v: ExitContract | undefined) => { r.contract = v; },
    getPriorSnapshot: () => r.priorSnapshot,
    setPriorSnapshot: (v: BlackboardStateSnapshot | null | undefined) => { r.priorSnapshot = v; },
    getTranscript: () => r.transcript,
    setTranscript: (v: TranscriptEntry[]) => { r.transcript = v; },
    getTurnsPerAgent: () => r.turnsPerAgent,
    getAttemptsPerAgent: () => r.attemptsPerAgent,
    getCommitsPerAgent: () => r.commitsPerAgent,
    getLinesAddedPerAgent: () => r.linesAddedPerAgent,
    getLinesRemovedPerAgent: () => r.linesRemovedPerAgent,
    getRejectedAttemptsPerAgent: () => r.rejectedAttemptsPerAgent,
    getJsonRepairsPerAgent: () => r.jsonRepairsPerAgent,
    getPromptErrorsPerAgent: () => r.promptErrorsPerAgent,
    getPromptTokensPerAgent: () => r.promptTokensPerAgent,
    getResponseTokensPerAgent: () => r.responseTokensPerAgent,
    getRetriesPerAgent: () => r.retriesPerAgent,
    getLatenciesPerAgent: () => r.latenciesPerAgent,
    getErrorTracker: () => r.errorTracker,
    getFailoverState: () => r.failoverState,
    setFailoverState: (v: FailoverState) => { r.failoverState = v; },
    getLocalOllamaTags: () => r.localOllamaTags,
    setLocalOllamaTags: (v: string[]) => { r.localOllamaTags = v; },
    getStaleEventCount: () => r.staleEventCount,
    setStaleEventCount: (v: number) => { r.staleEventCount = v; },
    getHypothesisGroupAborts: () => r.hypothesisGroupAborts,
    getFileCommitCounts: () => r.fileCommitCounts,
    getHypothesisDeferralTimestamps: () => r.hypothesisDeferralTimestamps,
    getActiveAborts: () => r.activeAborts,
    getAuditor: () => r.auditor,
    setAuditor: (v: Agent | undefined) => { r.auditor = v; },
    getPlanner: () => r.planner,
    setPlanner: (v: Agent | undefined) => { r.planner = v; },
    getAgentRoster: () => r.agentRoster,
    setAgentRoster: (v: Array<{ id: string; index: number }>) => { r.agentRoster = v; },
    getWorkerRoles: () => r.workerRoles,
    getAuditInvocations: () => r.auditInvocations,
    setAuditInvocations: (v: number) => { r.auditInvocations = v; },
    getCompletionDetail: () => r.completionDetail,
    setCompletionDetail: (v: string | undefined) => { r.completionDetail = v; },
    getCurrentTier: () => r.currentTier,
    setCurrentTier: (v: number) => { r.currentTier = v; },
    getTiersCompleted: () => r.tiersCompleted,
    setTiersCompleted: (v: number) => { r.tiersCompleted = v; },
    getTierHistory: () => r.tierHistory,
    setTierHistory: (v: TierHistoryEntry[]) => { r.tierHistory = v; },
    getTierStartedAt: () => r.tierStartedAt,
    setTierStartedAt: (v: number | undefined) => { r.tierStartedAt = v; },
    getTierUpFailures: () => r.tierUpFailures,
    setTierUpFailures: (v: number) => { r.tierUpFailures = v; },
    get cloneStateForStatus() { return r.cloneStateForStatus; },
    set cloneStateForStatus(v: LifecycleContext["cloneStateForStatus"]) { r.cloneStateForStatus = v; },
    setPhase: (phase: SwarmPhase) => r.setPhase(phase),
    setPlanningSubphase: (
      subphase: import("@ollama-swarm/shared/planningSubphase").PlanningSubphase | undefined,
    ) => r.setPlanningSubphase(subphase),
    clearExplorationCache: () => r.clearExplorationCache(),
    syncExplorationCacheFromSeed: (seed: PlannerSeed) => r.syncExplorationCacheFromSeed(seed),
    getPhase: () => r.phase,
    getPlanningStartedAt: () => r.planningStartedAt,
    setPlanningStartedAt: (v: number | undefined) => { r.planningStartedAt = v; },
    getContractDerivationFailure: () => r.contractDerivationFailure,
    setContractDerivationFailure: (v: string | undefined) => { r.contractDerivationFailure = v; },
    getDrainEligibilityInput: (partial: { claimed: number; pendingCommit: number }) =>
      r.getDrainEligibilityInput(partial),
    appendSystem: (text: string, summary?: TranscriptEntrySummary) => r.appendSystem(text, summary),
    appendAgent: (agent: Agent, text: string) => r.appendAgent(agent, text),
    pendingToolTraceByAgent: r.pendingToolTraceByAgent,
    discoverLocalOllamaTags: () => r.discoverLocalOllamaTags(),
    clearStateSnapshotScheduler: () => r.stateSnapshotScheduler.clearTimer(),
    emit: (ev: SwarmEvent) => r.opts.emit(ev),
    excludeRunnerArtifacts: (destPath: string) => r.opts.repos.excludeRunnerArtifacts(destPath),
    captureGitBaseline: async (clonePath: string) => {
      try {
        const gs = await r.opts.repos.gitStatus(clonePath);
        r.gitPorcelainAtRunStart = gs.porcelain;
      } catch {
        r.gitPorcelainAtRunStart = "";
      }
    },
    buildSeed: (clonePath: string, cfg: RunConfig) => r.buildSeed(clonePath, cfg),
    spawnAgent: (opts: SpawnOpts) => r.opts.manager.spawnAgent(opts),
    getManager: () => r.opts.manager,
    emitAgentState: (s: AgentState) => r.emitAgentState(s),
    markPlannerStatus: (planner: Agent, status: "thinking" | "ready") => r.markPlannerStatus(planner, status),
    v2ObserverApply: (ev: SwarmEvent) => r.v2Observer.apply(ev),
    v2ObserverReset: () => r.v2Observer.reset(),
    flushBoardBroadcasterSnapshot: () => r.boardBroadcaster.flushSnapshot(),
    boardCounts: () => r.boardCounts(),
    getTodoQueueCounts: () => r.todoQueue.counts(),
    getBoardRestoredFromSnapshot: () => r.boardRestoredFromSnapshot,
    allCriteriaResolved: () => r.allCriteriaResolved(),
    allCriteriaMet: () => r.allCriteriaMet(),
    get maxAuditInvocations() { return r.maxAuditInvocations; },
    runAuditor: (planner: Agent, opts?: { allowWhenStopping?: boolean }) => r.runAuditor(planner, opts),
    writeRunSummary: (crashMessage: string | undefined) => r.writeRunSummary(crashMessage),
    writeBlackboardDeliverable: () => r.writeBlackboardDeliverable(),
    runAutoRollbacks: () => r.runAutoRollbacks(),
    runPlanner: (planner: Agent, seed: PlannerSeed, isFallbackAttempt?: boolean) => r.runPlanner(planner, seed, isFallbackAttempt),
    runFirstPassContractOrchestrator: (planner: Agent, workers: Agent[], seed: PlannerSeed) => r.runFirstPassContractOrchestrator(planner, workers, seed),
    tryResumeContract: (clonePath: string) => r.tryResumeContract(clonePath),
    runAuditedExecution: (planner: Agent, workers: Agent[]) => r.runAuditedExecution(planner, workers),
    recordError: (err: unknown, opts?: { causeHint?: ErrorCategory; statusCode?: number }) => r.recordError(err, opts),
    writeCrashSnapshot: (err: unknown) => r.writeCrashSnapshot(err),
    killAll: () => r.opts.manager.killAll(),
    flushStateWrite: () => r.flushStateWrite(),
    stopQueueReaper: () => r.stopQueueReaper(),
    stopCapWatchdog: () => r.stopCapWatchdog(),
    stopReplanWatcher: () => r.stopReplanWatcher(),
    startQueueReaper: () => r.startQueueReaper(),
    startCapWatchdog: () => r.startCapWatchdog(),
    startReplanWatcher: () => r.startReplanWatcher(),
    isOverWallClockCap: () => r.isOverWallClockCap(),
    startAdaptiveWorkerWatchdog: (opts: AdaptiveWatchdogOpts) => r.startAdaptiveWorkerWatchdog(opts),
    disposeBoardBroadcaster: () => r.boardBroadcaster.dispose(),
    clone: (opts: CloneOptions) => r.opts.repos.clone(opts),
    clearTodoQueue: () => r.todoQueue.clear(),
    clearFindings: () => r.findings.clear(),
    stop: () => r.stop(),
    buildReflectionContext: (planner: Agent, abortSignal: AbortSignal) => r.buildReflectionContext(planner, abortSignal),
    initRunControl: (runId: string) => r.initRunControl(runId),
    initBrainOverseer: (runId: string) => r.initBrainOverseer(runId),
    getBrainService: () => r.opts.getBrainService?.() ?? null,
    getInteractionTracker: () => r.interactionTracker,
    getExceptionCollector: () => r.exceptionCollector,
  } as unknown as LifecycleContext;
}

export function contractContext(r: BlackboardRunnerFields): ContractContext {
  return {
    getStopping: () => r.lifecycleState === "stopping",
    getActive: () => r.active,
    getContract: () => r.contract,
    getPriorSnapshot: () => r.priorSnapshot,
    getTodoQueue: () => r.todoQueue,
    getFindingsLog: () => r.findings,
    getTodoQueueCounts: () => r.todoQueue.counts(),
    getBoardRestoredFromSnapshot: () => r.boardRestoredFromSnapshot,
    setBoardRestoredFromSnapshot: (v: boolean) => { r.boardRestoredFromSnapshot = v; },
    getFindingsPost: () => r.findings.post.bind(r.findings),
    setContract: (c: ExitContract | undefined) => { r.contract = c; },
    setCurrentTier: (t: number) => { r.currentTier = t; },
    setTiersCompleted: (t: number) => { r.tiersCompleted = t; },
    setTierStartedAt: (t: number | undefined) => { r.tierStartedAt = t; },
    setTierHistory: (h: TierHistoryEntry[]) => { r.tierHistory = h; },
    appendSystem: (msg: string) => r.appendSystem(msg),
    appendAgent: (agent: Agent, text: string) => r.appendAgent(agent, text),
    findingsPost: (entry: { agentId: string; text: string; createdAt: number }) => r.findings.post(entry),
    getAuditor: () => r.auditor,
    emitAgentState: (s: AgentState) => r.emitAgentState(s),
    manager: r.opts.manager,
    getPlannerFallbackModel: () => r.active?.plannerFallbackModel,
    updateAgentModel: (agentId: string, model: string) => { r.opts.manager.updateAgentModel(agentId, model); },
    setContractDerivationFailure: (reason: string | undefined) => { r.contractDerivationFailure = reason; },
    promptPlannerSafely: (
      primaryAgent: Agent,
      promptText: string,
      agentName?: "swarm" | "swarm-read" | "swarm-builder",
      ollamaFormat?: "json" | Record<string, unknown>,
      activity?: { kind?: string; label?: string; maxToolTurns?: number },
    ) => r.promptPlannerSafely(primaryAgent, promptText, agentName ?? "swarm", ollamaFormat, activity),
    promptAgent: (agent: Agent, prompt: string, agentName: "swarm" | "swarm-read" | "swarm-builder" | "swarm-research", formatExpect: "json" | "free", ollamaFormat?: "json" | Record<string, unknown>, activity?: { kind?: string; label?: string }) => r.promptAgent(agent, prompt, agentName, formatExpect, ollamaFormat, activity),
    emit: (e: unknown) => r.opts.emit(e as SwarmEvent),
    scheduleStateWrite: () => r.scheduleStateWrite(),
    flushBoardBroadcasterSnapshot: () => r.boardBroadcaster.flushSnapshot(),
    v2ObserverApply: (event: SwarmEvent) => r.v2Observer.apply(event),
    repos: r.opts.repos,
    getTranscript: () => r.transcript,
    getPlanner: () => r.planner,
    directiveWithAmendments: () => r.directiveWithAmendments(),
    getAmendments: r.opts.getAmendments,
  } as unknown as ContractContext;
}

export function tierContext(r: BlackboardRunnerFields): TierContext {
  return {
    getContract: () => r.contract,
    getActive: () => r.active,
    getStopping: () => r.lifecycleState === "stopping",
    getCurrentTier: () => r.currentTier,
    getTiersCompleted: () => r.tiersCompleted,
    getTierHistory: () => r.tierHistory,
    getTierStartedAt: () => r.tierStartedAt,
    getTierUpFailures: () => r.tierUpFailures,
    getAuditInvocations: () => r.auditInvocations,
    getCompletionDetail: () => r.completionDetail,
    getConsecutiveStuckCycles: () => r.consecutiveStuckCycles,
    getZeroProgressStreak: () =>
      (r as { zeroProgressStreak?: number }).zeroProgressStreak ?? 0,
    setCurrentTier: (t: number) => { r.currentTier = t; },
    setTiersCompleted: (t: number) => { r.tiersCompleted = t; },
    setTierStartedAt: (t: number | undefined) => { r.tierStartedAt = t; },
    setTierHistory: (h: TierHistoryEntry[]) => { r.tierHistory = h; },
    setTierUpFailures: (t: number) => { r.tierUpFailures = t; },
    setCompletionDetail: (d: string | undefined) => { r.completionDetail = d; },
    setContract: (c: ExitContract | undefined) => { r.contract = c; },
    setConsecutiveStuckCycles: (n: number) => { r.consecutiveStuckCycles = n; },
    setZeroProgressStreak: (n: number) => {
      (r as { zeroProgressStreak?: number }).zeroProgressStreak = n;
    },
    appendSystem: (msg: string, summary?: import("../../types.js").TranscriptEntrySummary) =>
      r.appendSystem(msg, summary),
    appendAgent: (agent: Agent, text: string) => r.appendAgent(agent, text),
    getBrainService: () => r.opts.getBrainService?.() ?? null,
    promptPlannerSafely: (agent: Agent, promptText: string, agentName: "swarm" | "swarm-read" | "swarm-builder" | "swarm-research", ollamaFormat?: "json" | Record<string, unknown>) => r.promptPlannerSafely(agent, promptText, agentName, ollamaFormat),
    emit: (e: SwarmEvent) => r.opts.emit(e),
    scheduleStateWrite: () => r.scheduleStateWrite(),
    cloneContract: (c: ExitContract) => r.cloneContract(c),
    directiveWithAmendments: () => r.directiveWithAmendments(),
    getExplorationCache: () => r.getExplorationCache(),
    logDiag: r.opts.logDiag,
    boardListTodos: () => r.boardListTodos(),
    boardCounts: () => r.boardCounts(),
    readReadme: (clonePath: string) => r.opts.repos.readReadme(clonePath),
    listRepoFiles: (clonePath: string, opts: { maxFiles?: number }) => r.opts.repos.listRepoFiles(clonePath, opts),
    findPost: (entry: { agentId: string; text: string; createdAt: number }) => r.findings.post(entry),
    checkAndApplyCaps: () => r.checkAndApplyCaps(),
    runWorkers: (workers: Agent[]) => r.runWorkers(workers),
    runAuditor: (planner: Agent, opts?: { allowWhenStopping?: boolean }) => r.runAuditor(planner, opts),
    runPlannerFallbackForUnmetCriteria: (planner: Agent) => r.runPlannerFallbackForUnmetCriteria(planner),
    noteProviderStall: (msg: string) => r.noteProviderStall(msg),
    consumeProviderStall: () => r.consumeProviderStall(),
    evaluateStallGate: async (
      planner: Agent,
      providerStall?: string,
    ): Promise<StallGateVerdict | null> => {
      const active = r.active;
      const counts = r.boardCounts();
      return r.getSwarmControl().evaluateStallGate({
        board: counts,
        contract: r.contract,
        stuckCycles: r.consecutiveStuckCycles,
        providerStall,
        todos: r.boardListTodos(),
        coachAgent: planner,
        clonePath: active?.localPath,
        runId: active?.runId,
        manager: r.opts.manager,
        interactionTracker: r.interactionTracker,
        exceptionCollector: r.exceptionCollector,
        appendSystem: (msg: string) => r.appendSystem(msg),
        emit: (e: SwarmEvent) => r.opts.emit(e),
      });
    },
    v2ObserverApply: (event: SwarmEvent) => r.v2Observer.apply(event),
  } as unknown as TierContext;
}

export function plannerContext(r: BlackboardRunnerFields): PlannerContext {
  return {
    getContract: () => r.contract,
    getActive: () => r.active ?? undefined,
    isStopping: () => r.lifecycleState === "stopping",
    getPlannerFallbackModel: () => r.active?.plannerFallbackModel,
    updateAgentModel: (agentId: string, model: string) => { r.opts.manager.updateAgentModel(agentId, model); },
    emit: (e: SwarmEvent) => r.opts.emit(e),
    appendSystem: (msg: string) => r.appendSystem(msg),
    appendAgent: (agent: Agent, text: string) => r.appendAgent(agent, text),
    promptPlannerSafely: (agent: Agent, promptText: string, agentName: "swarm" | "swarm-read" | "swarm-builder" | "swarm-research", ollamaFormat?: "json" | Record<string, unknown>) => r.promptPlannerSafely(agent, promptText, agentName, ollamaFormat),
    wrappers: r.wrappers,
    findingsPost: (entry: { agentId: string; text: string; createdAt: number }) => r.findings.post(entry),
    getAuditor: () => r.auditor,
    emitAgentState: (s: AgentState) => r.emitAgentState(s),
    manager: r.opts.manager,
    v2ObserverApply: (event: SwarmEvent) => r.v2Observer.apply(event),
    hypothesisGroupAbortsSet: (groupId: string, controller: AbortController) => { r.hypothesisGroupAborts.set(groupId, controller); },
    noteProviderStall: (msg: string) => r.noteProviderStall(msg),
    buildSeed: (clonePath: string, cfg: RunConfig) => r.buildSeed(clonePath, cfg),
    boardCounts: () => r.boardCounts(),
  } as unknown as PlannerContext;
}

export function workerContext(r: BlackboardRunnerFields): WorkerContext {
  return {
    isStopping: () => r.lifecycleState === "stopping",
    isDraining: () => r.lifecycleState === "draining",
    getActiveAborts: () => r.activeAborts,
    isPaused: () => r.paused,
    isSubscriberPaused: () => r.subscriberPaused,
    isMemoryPaused: () => r.memoryPaused,
    checkAndApplyCaps: () => r.checkAndApplyCaps(),
    boardCounts: () => r.boardCounts(),
    getActive: () => r.active,
    getTranscript: () => r.transcript,
    getAmendments: r.opts.getAmendments,
    getReplanPending: () => r.replanPending,
    isReplanRunning: () => r.replanRunning,
    getWrappers: () => r.wrappers,
    getTodoQueue: () => r.todoQueue,
    getWorkerPool: () => r.workerPool,
    getWorkerRoles: () => r.workerRoles,
    getFileCommitCounts: () => r.fileCommitCounts,
    setFileCommitCounts: (v: Map<string, number>) => { r.fileCommitCounts = v; },
    getHypothesisGroupAborts: () => r.hypothesisGroupAborts,
    getHypothesisDeferralTimestamps: () => r.hypothesisDeferralTimestamps,
    setHypothesisDeferralTimestamps: (v: Map<string, number>) => { r.hypothesisDeferralTimestamps = v; },
    getAuditor: () => r.auditor,
    appendSystem: (msg: string) => r.appendSystem(msg),
    appendAgent: (agent: Agent, text: string) => r.appendAgent(agent, text),
    pendingToolTraceByAgent: r.pendingToolTraceByAgent,
    promptAgent: (
      agent: Agent,
      prompt: string,
      agentName: ProfileName,
      formatExpect: "json" | "free",
      ollamaFormat?: "json" | Record<string, unknown>,
      activity?: {
        kind?: string;
        label?: string;
        maxToolTurns?: number;
        mode?: "explore" | "emit";
        promptWallClockMs?: number;
      },
    ) => r.promptAgent(agent, prompt, agentName, formatExpect, ollamaFormat, activity),
    getRepoFiles: () => r.getRepoFiles(),
    emitAgentState: (s: AgentState) => r.emitAgentState(s),
    getManager: () => r.opts.manager,
    readExpectedFiles: (files: string[]) => r.readExpectedFiles(files),
    sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    markStatus: (agentId: string, status: AgentState["status"], meta?: Partial<AgentState>) => r.opts.manager.markStatus(agentId, status, meta),
    anyAgentThinking: () => r.opts.manager.anyAgentThinking(),
    logDiag: (entry: unknown) => { r.opts.logDiag?.(entry as Record<string, unknown>); },
    emit: (ev: SwarmEvent) => r.opts.emit(ev),
    maybeSettleHypothesisGroup: (todoId: string) => r.maybeSettleHypothesisGroup(todoId),
    bumpStaleEventCount: () => { r.staleEventCount++; },
    enqueueReplan: (todoId: string) => r.enqueueReplan(todoId),
    bumpCommitsPerAgent: (agentId: string) => bumpAgentCounter(r.commitsPerAgent, agentId),
    addLinesPerAgent: (agentId: string, added: number, removed: number) => {
      r.linesAddedPerAgent.set(agentId, (r.linesAddedPerAgent.get(agentId) ?? 0) + added);
      r.linesRemovedPerAgent.set(agentId, (r.linesRemovedPerAgent.get(agentId) ?? 0) + removed);
    },
    recordCriterionCommits: (todo: Todo, commitSha: string | undefined) => {
      if (commitSha) {
        const criteriaForTodo = todo.criteriaIds && todo.criteriaIds.length > 0
          ? todo.criteriaIds
          : todo.criterionId ? [todo.criterionId] : [];
        for (const criterionId of criteriaForTodo) {
          const list = r.commitsByCriterion.get(criterionId) ?? [];
          list.push(commitSha);
          r.commitsByCriterion.set(criterionId, list);
        }
      }
    },
    bumpStigmergyFileCounts: (expectedFiles: string[], commitSha: string | undefined) => {
      if (commitSha) {
        for (const f of expectedFiles) {
          r.fileCommitCounts.set(f, (r.fileCommitCounts.get(f) ?? 0) + 1);
        }
      }
    },
    gitStatus: (clonePath: string) => r.opts.repos.gitStatus(clonePath),
    commitAll: (clonePath: string, message: string) => r.opts.repos.commitAll(clonePath, message),
    bumpRejectedAttempts: (agentId: string) => bumpAgentCounter(r.rejectedAttemptsPerAgent, agentId),
    bumpJsonRepairs: (agentId: string) => bumpAgentCounter(r.jsonRepairsPerAgent, agentId),
    bumpPromptErrors: (agentId: string) => bumpAgentCounter(r.promptErrorsPerAgent, agentId),
    getSelfConsistencyK: () => Math.max(1, Math.min(5, r.active?.selfConsistencyK ?? 1)),
    getPheromoneHeatmap: () => pheromoneHeatmap,
    brainPromptFn: brainEnabled() ? r.brainPromptFn.bind(r) : undefined,
    updateAgentModel: (agentId: string, model: string) => { r.opts.manager.updateAgentModel(agentId, model); },
    getPlannerFallbackModel: () => r.active?.plannerFallbackModel,
    // Plan 4: brain system overseer — wire tracker/collector to worker context
    recordInteraction: (type: string, todoId: string, agentId: string, reason: string) => {
      const tracker = r.interactionTracker;
      if (type === "worker_skip") tracker.recordSkip(todoId, agentId, reason);
      else if (type === "replanner_skip" || type === "replanner_revise") tracker.recordReplannerDecision(todoId, type === "replanner_skip" ? "skip" : "revise", reason, agentId);
      else if (type === "auditor_override" || type === "auditor_accept") tracker.recordAuditorVerdict("", todoId, type === "auditor_accept" ? "met" : "unmet", reason, agentId);
      else if (type === "worker_retry_success" || type === "worker_retry_fail") tracker.recordWorkerRetry(todoId, agentId, type === "worker_retry_success", reason);
    },
    recordException: (type: string, agentId: string, todoId?: string, reason?: string) => {
      r.exceptionCollector?.record({ type: type as any, agentId, todoId, reason: reason ?? "" });
    },
    getSessionPlannerHint: () => r.getSwarmControl().getSessionPlannerHint(),
  } as unknown as WorkerContext;
}

export function promptContext(r: BlackboardRunnerFields): PromptContext {
  return {
    turnsPerAgent: r.turnsPerAgent,
    promptTokensPerAgent: r.promptTokensPerAgent,
    responseTokensPerAgent: r.responseTokensPerAgent,
    attemptsPerAgent: r.attemptsPerAgent,
    retriesPerAgent: r.retriesPerAgent,
    latenciesPerAgent: r.latenciesPerAgent,
    recentLatencySamples: r.recentLatencySamples,
    errorTracker: r.errorTracker,
    activeAborts: r.activeAborts,
    failoverState: r.failoverState,
    localOllamaTags: r.localOllamaTags,
    getActive: () => r.active,
    isStopping: () => r.lifecycleState === "stopping",
    isDraining: () => r.lifecycleState === "draining",
    setLifecycleState: (v: LifecycleState) => { r.lifecycleState = v; },
    getTerminationReason: () => r.terminationReason,
    setTerminationReason: (v: string | undefined) => { r.terminationReason = v; },
    manager: r.opts.manager,
    emit: r.opts.emit,
    logDiag: r.opts.logDiag,
    getOllamaBaseUrl: () => r.opts.ollamaBaseUrl,
    appendSystem: (msg: string, summary?: TranscriptEntrySummary) => r.appendSystem(msg, summary),
    emitAgentState: (s: AgentState) => r.emitAgentState(s),
    extractText: (res: unknown) => r.extractText(res),
    maxTrackedErrors: r.maxTrackedErrors,
    pendingPromptByAgent: r.pendingPromptByAgent,
    pendingToolTraceByAgent: r.pendingToolTraceByAgent,
    getSwarmControl: () => r.getSwarmControl(),
    getCoachAgent: () => r.planner ?? r.auditor ?? r.opts.manager.list()[0],
  } as unknown as PromptContext;
}

export function capContext(r: BlackboardRunnerFields): CapContext {
  return {
    getPaused: () => r.paused,
    setPaused: (v: boolean) => { r.paused = v; },
    getPauseStartedAt: () => r.pauseStartedAt,
    setPauseStartedAt: (v: number | undefined) => { r.pauseStartedAt = v; },
    getTotalPausedMs: () => r.totalPausedMs,
    setTotalPausedMs: (v: number) => { r.totalPausedMs = v; },
    getPauseProbeTimer: () => r.pauseProbeTimer,
    setPauseProbeTimer: (v: NodeJS.Timeout | undefined) => { r.pauseProbeTimer = v; },
    getPauseProbeAttempt: () => r.pauseProbeAttempt,
    setPauseProbeAttempt: (v: number) => { r.pauseProbeAttempt = v; },
    getCapWatchdog: () => r.capWatchdog,
    setCapWatchdog: (v: NodeJS.Timeout | undefined) => { r.capWatchdog = v; },
    getMemoryPaused: () => r.memoryPaused,
    setMemoryPaused: (v: boolean) => { r.memoryPaused = v; },
    getLastMemoryPressureLevel: () => r.lastMemoryPressureLevel,
    setLastMemoryPressureLevel: (v: "ok" | "throttle" | "pause") => { r.lastMemoryPressureLevel = v; },
    getSubscriberPaused: () => r.subscriberPaused,
    setSubscriberPaused: (v: boolean) => { r.subscriberPaused = v; },
    getLifecycleState: () => r.lifecycleState,
    setLifecycleState: (v: LifecycleState) => { r.lifecycleState = v; },
    getTickAccumulator: () => r.tickAccumulator,
    setTickAccumulator: (v: TickAccumulator | undefined) => { r.tickAccumulator = v; },
    getRunStartedAt: () => r.runStartedAt,
    getTokenBaselineForRun: () => r.tokenBaselineForRun,
    getTerminationReason: () => r.terminationReason,
    setTerminationReason: (v: string | undefined) => { r.terminationReason = v; },
    getActiveAborts: () => r.activeAborts,
    getActive: () => r.active,
    boardCounts: () => r.boardCounts(),
    getPlanner: () => r.planner,
    isStopping: () => r.lifecycleState === "stopping",
    appendSystem: (msg: string, summary?: TranscriptEntrySummary) => r.appendSystem(msg, summary),
    setPhase: (phase: SwarmPhase) => r.setPhase(phase),
    getBrainService: () => r.opts.getBrainService?.() ?? null,
    v2ObserverApply: (event: SwarmEvent) => r.v2Observer.apply(event),
    recordError: (err: unknown, opts?: { causeHint?: ErrorCategory; statusCode?: number }) => r.recordError(err, opts),
  } as unknown as CapContext;
}

export function replanContext(r: BlackboardRunnerFields): ReplanContext {
  return {
    getReplanPending: () => r.replanPending,
    getReplanRunning: () => r.replanRunning,
    setReplanRunning: (v: boolean) => { r.replanRunning = v; },
    getPlanner: () => r.planner,
    getAuditor: () => r.auditor,
    getActive: () => r.active,
    getContract: () => r.contract,
    getSessionPlannerHint: () => r.getSwarmControl().getSessionPlannerHint(),
    getTranscript: () => r.transcript,
    getAmendments: r.opts.getAmendments,
    getExplorationCache: () => r.getExplorationCache(),
    setExplorationCache: (cache: ExplorationCacheEntry[]) => r.setExplorationCache(cache),
    getRepoFiles: () => r.getRepoFiles(),
    isStopping: () => r.lifecycleState === "stopping",
    isDraining: () => r.lifecycleState === "draining",
    boardListTodos: () => r.boardListTodos(),
    boardGetTodo: (id: string) => r.boardGetTodo(id),
    readExpectedFiles: (files: string[]) => r.readExpectedFiles(files),
    wrappers: r.wrappers,
    appendSystem: (msg: string) => r.appendSystem(msg),
    appendAgent: (agent: Agent, text: string, options?: import("./runnerUtil.js").AppendAgentOptions) =>
      r.appendAgent(agent, text, options),
    promptPlannerSafely: (
      agent: Agent,
      prompt: string,
      name?: ProfileName,
      format?: "json" | Record<string, unknown>,
      activity?: {
        kind?: string;
        label?: string;
        maxToolTurns?: number;
        mode?: "explore" | "emit";
      },
    ) => r.promptPlannerSafely(agent, prompt, name, format, activity),
    checkAndApplyCaps: () => r.checkAndApplyCaps(),
    emit: (e: unknown) => r.opts.emit(e as SwarmEvent),
    brainPromptFn: brainEnabled() ? r.brainPromptFn.bind(r) : undefined,
    // Plan 4: brain system overseer — wire tracker/collector to replan context
    recordInteraction: (type: string, todoId: string, agentId: string, reason: string) => {
      const tracker = r.interactionTracker;
      if (type === "worker_skip") tracker.recordSkip(todoId, agentId, reason);
      else if (type === "replanner_skip" || type === "replanner_revise") tracker.recordReplannerDecision(todoId, type === "replanner_skip" ? "skip" : "revise", reason, agentId);
      else if (type === "auditor_override" || type === "auditor_accept") tracker.recordAuditorVerdict("", todoId, type === "auditor_accept" ? "met" : "unmet", reason, agentId);
      else if (type === "worker_retry_success" || type === "worker_retry_fail") tracker.recordWorkerRetry(todoId, agentId, type === "worker_retry_success", reason);
    },
    recordException: (type: string, agentId: string, todoId?: string, reason?: string) => {
      r.exceptionCollector?.record({ type: type as any, agentId, todoId, reason: reason ?? "" });
    },
  } as unknown as ReplanContext;
}

export function auditorContext(r: BlackboardRunnerFields): AuditorContext {
  // Create applyAndCommit wrapper for auditor-gated commits
  const applyHunksAndCommit = async (hunks: readonly unknown[], files: readonly string[], message: string, options?: { skipCommit?: boolean }) => {
    const { applyAndCommit } = await import("./WorkerPipeline.js");
    const { realFilesystemAdapter, realGitAdapter, realVerifyAdapter, isGitRepository } = await import("./v2Adapters.js");
    const clonePath = r.active?.localPath ?? "";
    const fs = realFilesystemAdapter(clonePath);
    const git = realGitAdapter(clonePath);
    const gitCommitOptional = !(await isGitRepository(clonePath));

    const verifyCommand = r.active?.verifyCommand?.trim();
    const forceVerify = r.active?.requireAuditorVerification || r.active?.auditorOnlyMutations;
    const verify = verifyCommand && verifyCommand.length > 0
      ? realVerifyAdapter(clonePath, verifyCommand)
      : (forceVerify ? { async run() { return { ok: true as const }; } } : undefined);

    const result = await applyAndCommit({
      todoId: "auditor-approved",
      workerId: "auditor",
      expectedFiles: files,
      hunks: hunks as import("./applyHunks.js").Hunk[],
      fs,
      git,
      verify,
      auditorApproved: true,
      skipCommit: options?.skipCommit,
      gitCommitOptional,
      runId: r.active?.runId,
    });
    return { 
      ok: result.ok, 
      reason: result.ok ? undefined : result.reason,
      verifyFailed: (result as { verifyFailed?: boolean }).verifyFailed,
      filesWritten: (result as { filesWritten?: string[] }).filesWritten 
    };
  };

  return {
    getContract: () => r.contract,
    getAuditInvocations: () => r.auditInvocations,
    incrementAuditInvocations: () => { r.auditInvocations++; },
    getMaxAuditInvocations: () => r.maxAuditInvocations,
    getAuditor: () => r.auditor,
    getStopping: () => r.lifecycleState === "stopping",
    boardListTodos: () => r.boardListTodos(),
    getFindingsList: () => r.findings.list(),
    readExpectedFiles: (paths: string[]) => r.readExpectedFiles(paths),
    getActive: () => r.active,
    cloneContract: (c: ExitContract) => r.cloneContract(c),
    emitContractUpdated: (contract: ExitContract) => { r.opts.emit({ type: "contract_updated", contract }); },
    appendSystem: (msg: string) => r.appendSystem(msg),
    appendAgent: (agent: Agent, text: string, options?: import("./runnerUtil.js").AppendAgentOptions) =>
      r.appendAgent(agent, text, options),
    emit: (e: unknown) => r.opts.emit(e as SwarmEvent),
    updateAgentModel: (agentId: string, model: string) => { r.opts.manager.updateAgentModel(agentId, model); },
    promptPlannerSafely: (agent: Agent, prompt: string, name: "swarm" | "swarm-read" | "swarm-builder", format?: "json" | Record<string, unknown>) => r.promptPlannerSafely(agent, prompt, name, format),
    wrappers: r.wrappers,
    allCriteriaResolvedSnapshot: () => r.allCriteriaResolvedSnapshot(),
    v2ObserverApply: (event: SwarmEvent) => r.v2Observer.apply(event),
    getWorkTranscript: () => r.transcript,
    getAmendments: r.opts.getAmendments,
    applyHunksAndCommit,
    brainPromptFn: brainEnabled() ? r.brainPromptFn.bind(r) : undefined,
  } as unknown as AuditorContext;
}

export function adaptiveWatchdogCtx(r: BlackboardRunnerFields): AdaptiveWatchdogContext {
  return {
    getAdaptiveWatchdog: () => r.adaptiveWatchdog,
    setAdaptiveWatchdog: (v: NodeJS.Timeout | undefined) => { r.adaptiveWatchdog = v; },
    getAdaptiveHysteresis: () => r.adaptiveHysteresis,
    setAdaptiveHysteresis: (v: { upPolls: number; downPolls: number }) => { r.adaptiveHysteresis = v; },
    getAdaptiveScaleInFlight: () => r.adaptiveScaleInFlight,
    setAdaptiveScaleInFlight: (v: boolean) => { r.adaptiveScaleInFlight = v; },
    getActive: () => r.active,
    getManager: () => r.opts.manager,
    getTodoQueue: () => r.todoQueue,
    isStopping: () => r.lifecycleState === "stopping",
    appendSystem: (msg: string) => r.appendSystem(msg),
    getBrainService: () => r.opts.getBrainService?.() ?? null,
  } as unknown as AdaptiveWatchdogContext;
}