import type { Agent, KillAllResult } from "../../services/AgentManager.js";
import type { RunConfig } from "../SwarmRunner.js";
import type { PlannerSeed } from "./prompts/planner.js";
import type { ExitContract } from "./types.js";
import type { SwarmPhase, TranscriptEntry, TranscriptEntrySummary } from "../../types.js";
import type { BlackboardStateSnapshot } from "./stateSnapshot.js";
import type { ClassifiedError, ErrorCategory } from "../errorTaxonomy.js";
import type { FailoverState } from "../promptWithFailover.js";
import type { TickAccumulator } from "./caps.js";
import type { TierHistoryEntry } from "./tierRunner.js";
import { config as appConfig } from "../../config.js";
import { formatCloneMessage } from "../cloneMessage.js";
import { formatPortReleaseLine } from "../runSummary.js";
import { readBlackboardStateSnapshot } from "./stateSnapshot.js";
import { assignWorkerRole } from "./workerRoles.js";
import { shouldRunFinalAudit } from "./finalAudit.js";
import { snapshotLifetimeTokens } from "../../services/ollamaProxy.js";
import { createTickAccumulator, WALL_CLOCK_CAP_MS } from "./caps.js";
import { runGoalGenerationPrePass } from "./goalGenerationPrePass.js";
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
  getPaused(): boolean;
  setPaused(v: boolean): void;

  // --- simple value fields ---
  getRound(): number;
  setRound(v: number): void;
  getRunStartedAt(): number | undefined;
  setRunStartedAt(v: number | undefined): void;
  getRunBootedAt(): number | undefined;
  setRunBootedAt(v: number | undefined): void;
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
  getConsecutiveLoopDetections(): number;
  setConsecutiveLoopDetections(v: number): void;
  getLastLoopWarningAtTurn(): number;
  setLastLoopWarningAtTurn(v: number): void;

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
  appendSystem(text: string, summary?: TranscriptEntrySummary): void;
  discoverLocalOllamaTags(): Promise<void>;
  clearStateSnapshotScheduler(): void;
  emit(ev: { type: string; [key: string]: unknown }): void;
  excludeRunnerArtifacts(destPath: string): Promise<void>;
  buildSeed(clonePath: string, cfg: RunConfig): Promise<PlannerSeed>;
  spawnAgentNoOpencode(opts: { cwd: string; index: number; model: string }): Promise<Agent>;
  markPlannerStatus(planner: Agent, status: "thinking" | "ready"): void;
  v2ObserverApply(ev: Record<string, unknown>): void;
  v2ObserverReset(): void;
  flushBoardBroadcasterSnapshot(): void;
  boardCounts(): { open: number; claimed: number; stale: number; committed: number; skipped: number; total: number };
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
}

// ---------------------------------------------------------------------------
// start()
// ---------------------------------------------------------------------------

export async function start(ctx: LifecycleContext, cfg: RunConfig): Promise<void> {
  if (ctx.isRunning()) throw new Error("A swarm is already running. Stop it first.");
  ctx.setTranscript([]);
  ctx.setLifecycleState("running");
  ctx.setRound(0);
  ctx.setRunStartedAt(undefined);
  ctx.setTokenBaselineForRun(undefined);
  ctx.setTickAccumulator(undefined);
  // Task #165: clear pause state from any prior run.
  ctx.setPaused(false);
  ctx.setPauseStartedAt(undefined);
  ctx.setTotalPausedMs(0);
  if (ctx.getPauseProbeTimer()) {
    clearTimeout(ctx.getPauseProbeTimer()!);
    ctx.setPauseProbeTimer(undefined);
  }
  // Task #167: clear drain state from any prior run.
  ctx.setDrainStartedAt(undefined);
  if (ctx.getDrainWatcherTimer()) {
    clearInterval(ctx.getDrainWatcherTimer()!);
    ctx.setDrainWatcherTimer(undefined);
  }
  // Task #168: clear the drain-marker so this fresh run defaults
  // to "stop = hard user-stop" classification unless drain() fires.
  ctx.setWasDrained(false);
  ctx.setTerminationReason(undefined);
  // 2026-05-04 (W7/W13/W14/W15 wiring): clear per-run trackers.
  ctx.getErrorTracker().length = 0;
  ctx.setFailoverState({ modelHealth: new Map() });
  ctx.setLocalOllamaTags([]);
  // 2026-05-04 (W16/W17/W18 wiring): clear pause/loop counters.
  ctx.setSubscriberPaused(false);
  ctx.setMemoryPaused(false);
  ctx.setLastMemoryPressureLevel("ok");
  ctx.setConsecutiveLoopDetections(0);
  ctx.setLastLoopWarningAtTurn(-1);
  // 2026-05-04 (W14 wiring): when SWARM_DEGRADATION_FALLBACK is on,
  // discover local Ollama tags once at run-start so R3's
  // pickLocalFallback has candidates. Best-effort: discovery
  // failure just disables R3 silently. The fetch is bounded at
  // 3 s so a slow Ollama doesn't block run startup.
  if (appConfig.SWARM_DEGRADATION_FALLBACK) {
    ctx.discoverLocalOllamaTags().catch((err) => {
      ctx.appendSystem(`⚠ lifecycle discoverLocalOllamaTags: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
  // Unit 31: clear any lingering state-write timer from a prior run.
  // stateWriteInFlight may still be true momentarily if a run was torn
  // down mid-write. The new scheduler starts fresh on next run.
  ctx.clearStateSnapshotScheduler();
  ctx.setRunBootedAt(Date.now());
  // Task #171: persist a "Run started" entry as the FIRST transcript
  // line so it survives a page-refresh catch-up. The WS run_started
  // event already fires for live observers; this gives refreshing
  // observers (and review-mode readers) the same anchor at the top
  // of the transcript. Includes runId8 + preset + model summary so
  // it's self-explanatory without needing the surrounding UI chrome.
  {
    // Task #171 + 2026-04-26 fix: emit the "▸▸RUN-START▸▸" sentinel
    // format so the web RunStartDivider component renders the rich
    // horizontal-rule block (matching the divider shown when starting
    // a new run mid-session). Previously we emitted a plain "▶ Run
    // started" prose string which rendered as a generic system bubble
    // — visually inconsistent with the in-session run-start divider.
    const plannerModel = cfg.plannerModel ?? cfg.model;
    const workerModel = cfg.workerModel ?? cfg.model;
    const dividerText = [
      "▸▸RUN-START▸▸",
      `runId=${cfg.runId ?? ""}`,
      `preset=${cfg.preset ?? ""}`,
      `plannerModel=${plannerModel}`,
      `workerModel=${workerModel}`,
      `agentCount=${cfg.agentCount ?? ""}`,
      `repoUrl=${cfg.repoUrl ?? ""}`,
    ].join("|");
    ctx.appendSystem(dividerText);
  }
  ctx.setStaleEventCount(0);
  ctx.getTurnsPerAgent().clear();
  ctx.getAttemptsPerAgent().clear();
  ctx.getCommitsPerAgent().clear();
  ctx.getLinesAddedPerAgent().clear();
  ctx.getLinesRemovedPerAgent().clear();
  ctx.getRejectedAttemptsPerAgent().clear();
  ctx.getJsonRepairsPerAgent().clear();
  ctx.getPromptErrorsPerAgent().clear();
  ctx.getPromptTokensPerAgent().clear();
  ctx.getResponseTokensPerAgent().clear();
  ctx.getRetriesPerAgent().clear();
  ctx.getLatenciesPerAgent().clear();
  ctx.setAgentRoster([]);
  ctx.setContract(undefined);
  ctx.setAuditInvocations(0);
  ctx.setCompletionDetail(undefined);
  // Unit 34: reset tier state on every start.
  ctx.setCurrentTier(0);
  ctx.setTiersCompleted(0);
  ctx.setTierHistory([]);
  ctx.setTierStartedAt(undefined);
  ctx.setTierUpFailures(0);
  ctx.setActive(cfg);
  // V2 Step 3b: reset the parallel V2 reducer + fire start.
  ctx.v2ObserverReset();
  ctx.v2ObserverApply({ type: "start", ts: ctx.getRunBootedAt()! });
  // Reset the V2 todo-queue mirror so the run starts clean.
  ctx.clearTodoQueue();
  ctx.clearFindings();
  // T-Item-3 (2026-05-04): clear any stale per-group AbortControllers
  // from a prior run so a new run starts clean.
  ctx.getHypothesisGroupAborts().clear();
  // T-Item-StigBb (2026-05-04): clear stigmergy commit counts for the
  // new run.
  ctx.getFileCommitCounts().clear();
  // T-Item-HypTimeout (2026-05-04): clear deferral timestamps.
  ctx.getHypothesisDeferralTimestamps().clear();

  ctx.setPhase("cloning");
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
  // Unit 42: per-agent model overrides. Each falls back to cfg.model
  // when absent, so existing single-model runs are byte-identical.
  const plannerModel = cfg.plannerModel ?? cfg.model;
  const workerModel = cfg.workerModel ?? cfg.model;
  // Unit 58: auditor model. Falls back to plannerModel (same role
  // family — reasoning over criteria + file state) then to model.
  // Only meaningful when cfg.dedicatedAuditor is true; harmless to
  // compute either way.
  const auditorModel = cfg.auditorModel ?? plannerModel;
  // Unit 48: hide runner-written artifacts (opencode.json,
  // blackboard-state.json, summary.json, summary-*.json) from
  // `git status` via the clone's local .git/info/exclude — NOT the
  // user's .gitignore. See RepoService.excludeRunnerArtifacts.
  await ctx.excludeRunnerArtifacts(destPath);
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
  // E3 Phase 5: opencode subprocess is gone. spawnAgentNoOpencode is
  // the only spawn path. The auxiliary direct-prompt helpers
  // (auditorSeedBuilder, goalGenerationPrePass, reflectionPasses,
  // runEndReflection, promptAndExtract) all migrated to chatOnce in
  // earlier cleanup commits.
  const planner = await ctx.spawnAgentNoOpencode({
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
    const workerSpawns = Array.from({ length: workerCount }, (_, i) =>
      ctx.spawnAgentNoOpencode({ cwd: destPath, index: 2 + i, model: workerModel }),
    );
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
    ctx.setAuditor(await ctx.spawnAgentNoOpencode({
      cwd: destPath,
      index: auditorIndex,
      model: auditorModel,
    }));
    ctx.appendSystem(
      `Auditor agent ${ctx.getAuditor()!.id} ready (model=${auditorModel}). Audit calls will route here in parallel with workers.`,
    );
  } else {
    ctx.setAuditor(undefined);
  }

  // Freeze the roster for the summary artifact — killAll() will later
  // empty AgentManager's own map.
  ctx.setAgentRoster([planner, ...workers, ...(ctx.getAuditor() ? [ctx.getAuditor()!] : [])]
    .map((a) => ({ id: a.id, index: a.index })));

  ctx.setPhase("seeding");
  const seed = await ctx.buildSeed(destPath, cfg);
  ctx.appendSystem(
    `Seed: ${seed.topLevel.length} top-level entries, README ${
      seed.readmeExcerpt ? `${seed.readmeExcerpt.length} chars` : "(missing)"
    }.`,
  );

  // Task #127: goal-generation pre-pass. When no userDirective is
  // set AND autoGenerateGoals isn't explicitly disabled, ask the
  // planner to propose 3-5 ambitious-but-feasible improvements;
  // the top one becomes the directive for this run. Lifts the
  // swarm from "do something" to "do something that matters."
  const shouldGenerateGoals =
    (!seed.userDirective || seed.userDirective.length === 0) &&
    cfg.autoGenerateGoals !== false;
  if (shouldGenerateGoals) {
    const generated = await runGoalGenerationPrePass(
      planner,
      seed,
      (text) => ctx.appendSystem(text),
      // Issue C-min: status callback so the UI shows the planner as
      // thinking during the pre-pass (was showing "ready" because
      // this code path bypassed promptAgent's markStatus).
      { onStatusChange: (status) => ctx.markPlannerStatus(planner, status) },
    );
    if (generated && generated.length > 0) {
      seed.userDirective = generated;
      ctx.appendSystem(
        `Goal-generation pre-pass: directive set to "${generated.length > 200 ? generated.slice(0, 200) + "…" : generated}"`,
      );
    } else {
      ctx.appendSystem(
        `Goal-generation pre-pass: no usable directive returned — falling back to planner-from-scratch.`,
      );
    }
  }

  // V2 Step 3b.2: agents are ready — fire spawned event so the V2
  // reducer can advance from "spawning" to "planning".
  ctx.v2ObserverApply({
    type: "spawned",
    ts: Date.now(),
    agentCount: ctx.getAgentRoster().length,
  });
  ctx.setPhase("planning");
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
      await ctx.runFirstPassContractOrchestrator(planner, workers, seed);
    }
    if (lifecycleIsStopping(ctx.getLifecycleState())) return;
    await ctx.runPlanner(planner, seed);
    if (lifecycleIsStopping(ctx.getLifecycleState())) return;
    const counts = ctx.boardCounts();
    if (workers.length > 0 && counts.open > 0) {
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
    if (!errored) {
      try {
        await ctx.writeBlackboardDeliverable();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.appendSystem(`Deliverable write failed (best-effort): ${msg}`);
      }
    }
    // Phase 9: always try to write a summary, regardless of how we got
    // here (completed / stopped / failed / cap). Awaited so the file and
    // the broadcast event land before the terminal phase transition, so
    // a UI consumer reacting to `completed|stopped|failed` can trust the
    // summary is already available.
    await ctx.writeRunSummary(crashMessage);
  }
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

// ---------------------------------------------------------------------------
// drain()
// ---------------------------------------------------------------------------

export async function drain(ctx: LifecycleContext): Promise<void> {
  if (lifecycleIsStopping(ctx.getLifecycleState()) || lifecycleIsDraining(ctx.getLifecycleState())) return;
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
  ctx.appendSystem(
    `Drain & Stop requested. Workers will finish their current claim (${ctx.boardCounts().claimed} in-flight); no new claims. ` +
      `Backstop ${DRAIN_DEADLINE_MS / 60_000} min before forced hard stop. ` +
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

// ---------------------------------------------------------------------------
// checkDrainComplete()
// ---------------------------------------------------------------------------

export async function checkDrainComplete(ctx: LifecycleContext): Promise<void> {
  if (lifecycleIsStopping(ctx.getLifecycleState()) || !lifecycleIsDraining(ctx.getLifecycleState())) {
    if (ctx.getDrainWatcherTimer()) {
      clearInterval(ctx.getDrainWatcherTimer()!);
      ctx.setDrainWatcherTimer(undefined);
    }
    return;
  }
  const counts = ctx.boardCounts();
  const elapsed = Date.now() - (ctx.getDrainStartedAt() ?? Date.now());
  const overDeadline = elapsed >= DRAIN_DEADLINE_MS;
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

// ---------------------------------------------------------------------------
// stop()
// ---------------------------------------------------------------------------

export async function stop(ctx: LifecycleContext): Promise<void> {
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
}