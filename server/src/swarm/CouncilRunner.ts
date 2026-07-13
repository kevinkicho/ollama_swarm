import { randomUUID } from "node:crypto";
import type { Agent } from "../services/AgentManager.js";

import type {
  TranscriptEntry,
  SwarmEvent,
} from "../types.js";
import { summarizeAgentResponse } from "./blackboard/transcriptSummary.js";
import type { RunConfig, RunnerOpts } from "./SwarmRunner.js";
import { DiscussionRunnerBase } from "./DiscussionRunnerBase.js";
import { promptWithFailoverAuto } from "./promptWithFailoverAuto.js";


import { extractProviderText, parseJsonArrayFromResponse, createTimeoutController } from "./councilUtils.js";
import { extractTextWithDiag, looksLikeJunk, trackPostRetryJunk } from "./extractText.js";
import { retryEmptyResponse } from "./promptAndExtract.js";

import { stripAgentText } from "@ollama-swarm/shared/stripAgentText";
import { takePendingToolTrace } from "./toolCallTranscript.js";
import { describeSdkError } from "./sdkError.js";
import { resolveCouncilToolProfile } from "./toolProfiles.js";
import { userEntryVisibleTo } from "./chatReceipt.js";
import {
  readDirective,
  buildDirectiveBlock,
} from "./directivePromptHelpers.js";
import {
  buildCouncilSynthesisPrompt,
  buildCouncilPrompt,
  buildStandupPrompt,
  buildStandupSynthesisPrompt,
} from "./councilPromptHelpers.js";
import {
  loadCouncilProgressLedger,
  type CouncilProgressLedger,
} from "./councilProgressLedger.js";
import { TodoQueue } from "./blackboard/TodoQueue.js";
import { FindingsLog } from "./blackboard/FindingsLog.js";
import type { ExitContract, ExitCriterion } from "./blackboard/types.js";
import {
  buildCouncilAdapterState,
  runContractDerivation,
  runTierPromotion,
  type CouncilAdapterState,
} from "./councilAdapter.js";
import { gatherCodeContext } from "./gatherCodeContext.js";
import { SwarmControlCenter } from "./control/SwarmControlCenter.js";
import type { StallGateVerdict } from "@ollama-swarm/shared/swarmControl/types";
import { emitCouncilTodoPosted } from "./councilTodoWire.js";
import type { PostTodoInput } from "./blackboard/TodoQueue.js";
import {
  loadPendingExecutionTodos,
  persistCouncilPendingTodos,
  seedPendingTodosToQueue,
} from "./councilExecutionResume.js";
import {
  synthesizeStandup as synthesizeStandupImpl,
  runStandupTurn as runStandupTurnImpl,
  type CouncilStandupHost,
} from "./councilStandup.js";
import {
  runCouncilAuditCycle,
  type CouncilAuditHost,
} from "./councilAuditCycle.js";
import { buildCouncilSeedMessage } from "./councilSeed.js";
import { drainCouncilTodos } from "./councilDrainTodos.js";
import {
  enterImmediateShutdown as enterImmediateShutdownExtracted,
  councilStop as councilStopExtracted,
  councilDrain as councilDrainExtracted,
  awaitLoopThenCloseOut as awaitLoopThenCloseOutExtracted,
  closeOutStopped as closeOutStoppedExtracted,
  ensureTerminalCloseOut as ensureTerminalCloseOutExtracted,
  type CouncilStopHost,
} from "./councilStop.js";
import {
  appendCouncilTerminalMessage as appendCouncilTerminalMessageExtracted,
  syncProgressContext as syncProgressContextExtracted,
  prependCouncilControlHints as prependCouncilControlHintsExtracted,
  evaluateCouncilStallGate as evaluateCouncilStallGateExtracted,
  persistProgressLedger as persistProgressLedgerExtracted,
  cycleTranscriptSlice as cycleTranscriptSliceExtracted,
  recordTodoSettled as recordTodoSettledExtracted,
  finalizeCycleProgress as finalizeCycleProgressExtracted,
  type CouncilProgressHost,
} from "./councilProgress.js";
import { runCouncilCycle } from "./councilRunCycle.js";

/**
 * Ambition tier cap for council (mirrors blackboard tierRunner.resolvedMaxTiers).
 * rounds===0 / continuous → unbounded; ambitionTiers=0 disables ratchet;
 * ambitionTiers>0 caps climb; otherwise keep open-ended (council default).
 */
export function resolveCouncilMaxTiers(cfg: Pick<RunConfig, "rounds" | "ambitionTiers">): number {
  if (cfg.rounds === 0 || cfg.rounds >= 1_000_000) return Infinity;
  const perRun = cfg.ambitionTiers;
  if (perRun !== undefined) {
    // 0 = explicitly disable further tiers (stay on tier 1 after settlement).
    if (perRun <= 0) return 1;
    return Math.max(1, perRun);
  }
  // Council historically ratchets without a cap when rounds is finite and
  // ambitionTiers is unset — preserve that so multi-cycle ambition still works.
  return Infinity;
}

export class CouncilRunner extends DiscussionRunnerBase {
  protected getPresetName(): string { return "Council"; }

  private state!: CouncilAdapterState;
  private repoFiles: string[] = [];
  private codeContextExcerpts: ReadonlyArray<{ path: string; excerpt: string }> = [];
  private executionFailures: string[] = [];
  private previousUnmetIds: Set<string> = new Set();
  private previousStuckFailSignature = "";
  private stuckCycleCount = 0;
  private consecutiveEmptyCycles = 0;
  private tierPromotionRetries = 0;
  private maxTiers = Infinity;

  private drainResolve: (() => void) | undefined;
  // drainRequested: inherited protected from DiscussionRunnerBase

  /** True when the run is draining or hard-stopping — skip audit / new cycle work. */
  private closingRequested(): boolean {
    return this.stopping || this.drainRequested;
  }
  private stopAbortController: AbortController | undefined;
  private stopInFlight: Promise<void> | null = null;
  // loopPromise inherited from DiscussionRunnerBase (waitUntilSettled / drain)
  /** Set while drainTodos / runCouncilWorkers is in flight — stop waits for this. */
  private workerDrainPromise: Promise<void> | null = null;
  /** After close-out begins, drop straggler worker transcript lines. */
  private transcriptFrozen = false;
  /** When set, exit after the first execution-drain cycle (resume path). */
  private executionOnlyResume = false;
  private progressLedger!: CouncilProgressLedger;
  private cycleTranscriptStart = 0;
  private swarmControl = new SwarmControlCenter();

  /** Post a todo and sync the wire event the drain button reads. */
  private postCouncilTodo(input: PostTodoInput): string {
    const id = this.state.todoQueue.post(input);
    emitCouncilTodoPosted((e) => this.opts.emit(e as SwarmEvent), this.state.todoQueue, id);
    return id;
  }

  constructor(opts: RunnerOpts) {
    super(opts);
  }

  protected override getSwarmControl(): SwarmControlCenter {
    return this.swarmControl;
  }

  protected override getCoachAgent(_agent: Agent): Agent | undefined {
    return this.opts.manager.list().find((a) => a.index === 1);
  }

  appendSystem(text: string, summary?: import("../types.js").TranscriptEntrySummary): void {
    if (this.transcriptFrozen) return;
    super.appendSystem(text, summary);
  }

  /** Persist worker / drafter JSON to the server transcript (survives refresh). */
  private appendCouncilAgent(agent: Agent, text: string): void {
    if (this.transcriptFrozen) return;
    const { finalText, thoughts, toolCalls } = stripAgentText(text);
    const summary = summarizeAgentResponse(finalText);
    const toolTrace = takePendingToolTrace(this.pendingToolTraceByAgent, agent.id);
    const entry: TranscriptEntry = {
      id: randomUUID(),
      role: "agent",
      agentId: agent.id,
      agentIndex: agent.index,
      text: finalText || "(empty response)",
      ts: Date.now(),
      ...(summary ? { summary } : {}),
      ...(thoughts.length > 0 ? { thoughts } : {}),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      ...(toolTrace ? { toolTrace } : {}),
    };
    this.transcript.push(entry);
    this.opts.emit({ type: "transcript_append", entry });
  }

  async start(cfg: RunConfig): Promise<void> {
    if (this.isRunning()) throw new Error("A swarm is already running. Stop it first.");
    this.resetState(cfg);
    this.transcriptFrozen = false;

    const { destPath, ready: spawnedLlm } = await this.initCloneAndSpawn(cfg, {
      preset: "council",
      roleResolver: () => "Drafter",
    });
    try {
      const gs = await this.opts.repos.gitStatus(destPath);
      this.gitPorcelainAtRunStart = gs.porcelain;
    } catch {
      this.gitPorcelainAtRunStart = "";
    }
    this.stats.registerAgents(this.opts.manager.list());

    this.state = buildCouncilAdapterState(
      cfg,
      destPath,
      this.opts.manager as any,
      this.opts.repos as any,
      (msg) => this.appendSystem(msg),
      (agent, text) => this.appendCouncilAgent(agent, text),
      (e) => this.opts.emit(e as SwarmEvent),
      (entry) => this.opts.logDiag?.(entry as any),
      this.pendingToolTraceByAgent,
      () => this.opts.getAmendments?.() ?? [],
    );

    // Gather project context
    this.repoFiles = await this.opts.repos.listRepoFiles(destPath, { maxFiles: 500 });
    this.codeContextExcerpts = await gatherCodeContext(destPath, cfg.userDirective, this.repoFiles);

    this.setPhase("seeding");
    await this.seed(destPath, cfg);

    this.executionOnlyResume = false;
    const resumeFrom = cfg.resumeExecutionFromRunId?.trim();
    if (resumeFrom) {
      const pending = loadPendingExecutionTodos(destPath, resumeFrom);
      if (pending.length > 0) {
        const n = seedPendingTodosToQueue(pending, (input) => this.postCouncilTodo(input));
        this.executionOnlyResume = true;
        this.appendSystem(
          `[resume] Loaded ${n} pending execution todo(s) from run ${resumeFrom} — skipping contract derivation.`,
        );
      } else {
        this.appendSystem(
          `[resume] No pending-execution-todos.json for run ${resumeFrom} — proceeding with normal council flow.`,
        );
      }
    }

    // Derive initial contract (skip when resuming execution-only todos)
    const planner = spawnedLlm.find((a) => a.index === 1);
    const workers = spawnedLlm.filter((a) => a.index > 1);
    const executionResume = resumeFrom && this.state.todoQueue.counts().pending > 0;
    if (planner && cfg.userDirective && !executionResume) {
      this.appendSystem(`Deriving tier ${this.state.currentTier} contract from directive…`);
      await runContractDerivation(this.state, planner, workers, () => this.transcript);
    }

    this.setPhase("discussing");
    this.startedAt = Date.now();
    this.state.runStartedAt = this.startedAt;

    this.swarmControl.reset();
    void this.swarmControl.loadPriorPatterns(destPath);

    if (cfg.runId) {
      this.progressLedger = loadCouncilProgressLedger(destPath, cfg.runId);
      this.syncProgressContext();
    } else {
      this.progressLedger = {
        schemaVersion: 1,
        runId: "local",
        updatedAt: Date.now(),
        lastCycle: 0,
        observations: [],
      };
    }

    // Start wall-clock cap watchdog if configured
    if (cfg.wallClockCapMs && cfg.wallClockCapMs > 0) {
      this.startCapWatchdog(cfg);
    }

    this.stopAbortController = new AbortController();
    this.stopInFlight = null;
    this.drainRequested = false;
    // Await the loop so start() settles when the council is truly done
    // (pipeline / orchestrator natural-complete depend on this).
    this.loopPromise = this.loop(cfg)
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.opts.emit({ type: "error", message: msg });
      })
      .finally(() => this.ensureTerminalCloseOut());
    await this.loopPromise;
  }

  /** Idempotent backstop when loop exits without a summary (crash, throw, or race with stop). */
  private stopHost(): CouncilStopHost {
    return {
      getSummaryWritten: () => this.summaryWritten,
      getPhase: () => this.phase,
      setPhase: (p) => this.setPhase(p),
      getStopInFlight: () => this.stopInFlight,
      setStopInFlight: (p) => {
        this.stopInFlight = p;
      },
      setTranscriptFrozen: (v) => {
        this.transcriptFrozen = v;
      },
      setStopping: (v) => {
        this.stopping = v;
      },
      getStopping: () => this.stopping,
      setStateStopping: (v) => {
        if (this.state) this.state.stopping = v;
      },
      hasState: () => !!this.state,
      manager: this.opts.manager,
      getStopAbortController: () => this.stopAbortController,
      getDrainRequested: () => this.drainRequested,
      setDrainRequested: (v) => {
        this.drainRequested = v;
      },
      appendSystem: (t) => this.appendSystem(t),
      getTodoCounts: () => this.state?.todoQueue?.counts(),
      anyAgentThinking: () => this.opts.manager.anyAgentThinking(),
      getDrainResolve: () => this.drainResolve,
      setDrainResolve: (fn) => {
        this.drainResolve = fn;
      },
      getWorkerDrainPromise: () => this.workerDrainPromise,
      getLoopPromise: () => this.loopPromise,
      getActive: () => this.active,
      getTodoQueue: () => this.state?.todoQueue,
      writeSummary: (cfg) => this.writeSummary(cfg),
      superAppendSystem: (t) => super.appendSystem(t),
      stopCapWatchdog: () => this.stopCapWatchdog(),
    };
  }

  private async ensureTerminalCloseOut(): Promise<void> {
    await ensureTerminalCloseOutExtracted(this.stopHost());
  }

  private enterImmediateShutdown(): void {
    enterImmediateShutdownExtracted(this.stopHost());
  }

  async stop(): Promise<void> {
    return councilStopExtracted(this.stopHost());
  }

  async drain(): Promise<void> {
    return councilDrainExtracted(this.stopHost());
  }

  private async awaitLoopThenCloseOut(opts: { immediate: boolean }): Promise<void> {
    return awaitLoopThenCloseOutExtracted(this.stopHost(), opts);
  }

  private async closeOutStopped(opts: { immediate: boolean }): Promise<void> {
    return closeOutStoppedExtracted(this.stopHost(), opts);
  }

  private startCapWatchdog(cfg: RunConfig): void {
    // Delegate to shared sleep-safe discussion wall-clock (tick accumulator).
    this.startDiscussionWallClockIfConfigured(cfg);
  }

  protected override onReconfig(changes: import("./runReconfig.js").RunReconfigChanges): void {
    if (changes.wallClockCapMs && this.active) {
      this.stopDiscussionWallClock();
      if (this.active.wallClockCapMs && this.active.wallClockCapMs > 0) {
        this.startDiscussionWallClockIfConfigured(this.active);
      }
    }
  }

  private stopCapWatchdog(): void {
    this.stopDiscussionWallClock();
  }

  private async seed(clonePath: string, cfg: RunConfig): Promise<void> {
    const { text, summary } = await buildCouncilSeedMessage({
      clonePath,
      cfg,
      repos: this.opts.repos,
      repoFiles: this.repoFiles,
      codeContextExcerpts: this.codeContextExcerpts,
    });
    this.appendSystem(text, summary);
  }

  private async loop(cfg: RunConfig): Promise<void> {
    // rounds===0: open-ended ambition ratchet (user Stop / hard stop ends it).
    // rounds>=1e6: continuous-mode rewrite of "unbounded" from startRoute.
    const isAutonomous = cfg.rounds === 0 || cfg.rounds >= 1_000_000;
    // Resolve ambition cap once per run (matches blackboard tierRunner).
    this.maxTiers = resolveCouncilMaxTiers(cfg);
    let cycle = 0;

    await this.runDiscussionLoop(cfg, "Council", async (cfg) => {
      if (isAutonomous) {
        const wallMin =
          cfg.wallClockCapMs && cfg.wallClockCapMs > 0
            ? Math.round(cfg.wallClockCapMs / 60_000)
            : null;
        const tok =
          cfg.tokenBudget && cfg.tokenBudget > 0
            ? cfg.tokenBudget.toLocaleString()
            : null;
        this.appendSystem(
          `[council] Autonomous mode (rounds=${cfg.rounds === 0 ? 0 : "continuous"}) — continues until Stop or a hard stop`
          + (wallMin != null ? ` · wall-clock cap ${wallMin}m` : "")
          + (tok != null ? ` · token budget ${tok}` : "")
          + (wallMin == null && tok == null
            ? " · WARNING: no resource cap configured"
            : "")
          + ".",
        );
      } else if (this.maxTiers > 1 && Number.isFinite(this.maxTiers)) {
        this.appendSystem(
          `[council] Ambition ratchet enabled (max ${this.maxTiers} tier(s)); cycle budget rounds=${cfg.rounds}.`,
        );
      }
      while (!this.closingRequested()) {
        cycle++;
        this.state.stopping = this.closingRequested();
        const result = await this.runCycle(cfg, cycle, isAutonomous);

        if (result === "stop") break;
        if (result === "retry") {
          // Ambition tier-up, unmet criteria with new todos, stall backoff, etc.
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        // result === "done"
        if (this.executionOnlyResume) {
          this.appendSystem("[resume] Execution-only resume complete — finishing run.");
          break;
        }
        if (this.closingRequested()) break;
        if (isAutonomous) {
          // Open-ended: never treat a soft "done" as terminal — keep cycling
          // so ambition / stretch work can keep progressing.
          this.earlyStopDetail = undefined;
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
        // Finite rounds: soft "done" ends the run. Tier promotion and unmet
        // work return "retry" above, so this path is for true settlement.
        break;
      }
      this.appendCouncilTerminalMessage();
    }, {
      shouldSetCompleted: () => !this.earlyStopDetail,
    });
  }

  private progressHost(): CouncilProgressHost {
    return {
      progressLedger: this.progressLedger,
      state: this.state,
      transcript: this.transcript,
      cycleTranscriptStart: this.cycleTranscriptStart,
      stuckCycleCount: this.stuckCycleCount,
      swarmControl: this.swarmControl,
      getActiveLocalPath: () => this.active?.localPath,
      getActiveRunId: () => this.active?.runId,
      appendSystem: (t) => this.appendSystem(t),
      emit: (e) => this.opts.emit(e),
      closingRequested: () => this.closingRequested(),
      getEarlyStopDetail: () => this.earlyStopDetail,
    };
  }

  private appendCouncilTerminalMessage(): void {
    appendCouncilTerminalMessageExtracted(this.progressHost());
  }

  private syncProgressContext(): void {
    syncProgressContextExtracted(this.progressHost());
  }

  private prependCouncilControlHints(): void {
    prependCouncilControlHintsExtracted(this.progressHost());
  }

  private async evaluateCouncilStallGate(
    planner: Agent,
    providerStall?: string,
  ): Promise<StallGateVerdict | null> {
    return evaluateCouncilStallGateExtracted(this.progressHost(), planner, providerStall);
  }

  private persistProgressLedger(): void {
    persistProgressLedgerExtracted(this.progressHost());
  }

  private cycleTranscriptSlice(): TranscriptEntry[] {
    return cycleTranscriptSliceExtracted(this.progressHost());
  }

  private recordTodoSettled(
    cycle: number,
    info: {
      description: string;
      expectedFiles?: readonly string[] | null;
      outcome: "completed" | "skipped" | "failed";
      detail?: string;
    },
  ): void {
    recordTodoSettledExtracted(this.progressHost(), cycle, info);
  }

  private finalizeCycleProgress(cycle: number): void {
    finalizeCycleProgressExtracted(this.progressHost(), cycle);
  }

  private async runCycle(cfg: RunConfig, cycle: number, isAutonomous: boolean): Promise<"done" | "retry" | "stop"> {
    return runCouncilCycle(
      {
        state: this.state,
        transcript: this.transcript,
        progressLedger: this.progressLedger,
        repoFiles: this.repoFiles,
        codeContextExcerpts: this.codeContextExcerpts,
        executionFailures: this.executionFailures,
        round: this.round,
        earlyStopDetail: this.earlyStopDetail,
        setEarlyStopDetail: (d) => { this.earlyStopDetail = d; },
        getRunId: () => this.active?.runId,
        getStartedAt: () => this.startedAt,
        getTokenBaseline: () => this.tokenBaselineForStatus,
        getBrainService: () => this.opts.getBrainService?.() ?? null,
        swarmControl: this.swarmControl,
        manager: this.opts.manager,
        repos: this.opts.repos,
        emit: (e) => this.opts.emit(e),
        logDiag: this.opts.logDiag,
        stats: this.stats,
        setCycleTranscriptStart: (n) => {
          this.cycleTranscriptStart = n;
        },
        getCycleTranscriptStart: () => this.cycleTranscriptStart,
        setExecutionFailures: (f) => {
          this.executionFailures = f;
        },
        getExecutionFailures: () => this.executionFailures,
        syncProgressContext: () => this.syncProgressContext(),
        prependCouncilControlHints: () => this.prependCouncilControlHints(),
        appendSystem: (t, s) => this.appendSystem(t, s as any),
        setPhase: (p) => this.setPhase(p),
        closingRequested: () => this.closingRequested(),
        getStopping: () => this.stopping,
        runTurn: (a, r, tr, snap, d) => this.runTurn(a, r, tr, snap, d),
        runStandupTurn: (a, snap, d) => this.runStandupTurn(a, snap, d),
        runDiscussionAgent: (a, p, o) => this.runDiscussionAgent(a, p, o as any),
        postCouncilTodo: (input) => this.postCouncilTodo(input),
        synthesizeStandup: (c, cy) => this.synthesizeStandup(c, cy),
        cycleTranscriptSlice: () => this.cycleTranscriptSlice(),
        drainTodos: (c, cy) => this.drainTodos(c, cy),
        finalizeCycleProgress: (cy) => this.finalizeCycleProgress(cy),
        runAudit: (c, cy) => this.runAudit(c, cy),
      },
      cfg,
      cycle,
      isAutonomous,
    );
  }

  private async drainTodos(cfg: RunConfig, cycle: number): Promise<void> {
    await drainCouncilTodos(
      {
        state: this.state,
        manager: this.opts.manager,
        appendSystem: (msg, summary) => this.appendSystem(msg, summary as any),
        setPhase: (phase) => this.setPhase(phase as any),
        executionFailures: this.executionFailures,
        recordTodoSettled: (c, info) => this.recordTodoSettled(c, info as any),
        isStopping: () => this.stopping,
        isDraining: () => this.drainRequested,
        promptSignal: () => this.stopAbortController?.signal,
        swarmControl: this.swarmControl,
        emit: (e) => this.opts.emit(e),
        setWorkerDrainPromise: (p) => {
          this.workerDrainPromise = p;
        },
        resolveDrain: () => this.drainResolve?.(),
      },
      cfg,
      cycle,
    );
  }

  private auditHost(): CouncilAuditHost {
    return {
      state: this.state,
      progressLedger: this.progressLedger,
      manager: this.opts.manager,
      emit: (e) => this.opts.emit(e),
      swarmControl: this.swarmControl,
      stopAbortSignal: () => this.stopAbortController?.signal,
      closingRequested: () => this.closingRequested(),
      setPhase: (phase) => this.setPhase(phase as any),
      appendSystem: (msg, summary) => this.appendSystem(msg, summary as any),
      postCouncilTodo: (input) => this.postCouncilTodo(input),
      evaluateCouncilStallGate: (planner, stall) =>
        this.evaluateCouncilStallGate(planner, stall ?? undefined),
      getBrainService: this.opts.getBrainService
        ? () => this.opts.getBrainService?.() as any
        : undefined,
      getActiveRunId: () => this.active?.runId,
      maxTiers: this.maxTiers,
      getStuckCycleCount: () => this.stuckCycleCount,
      setStuckCycleCount: (n) => {
        this.stuckCycleCount = n;
      },
      getPreviousUnmetIds: () => this.previousUnmetIds,
      setPreviousUnmetIds: (s) => {
        this.previousUnmetIds = s;
      },
      getPreviousStuckFailSignature: () => this.previousStuckFailSignature,
      setPreviousStuckFailSignature: (s) => {
        this.previousStuckFailSignature = s;
      },
      getConsecutiveEmptyCycles: () => this.consecutiveEmptyCycles,
      setConsecutiveEmptyCycles: (n) => {
        this.consecutiveEmptyCycles = n;
      },
      getTierPromotionRetries: () => this.tierPromotionRetries,
      setTierPromotionRetries: (n) => {
        this.tierPromotionRetries = n;
      },
      setEarlyStopDetail: (s) => {
        this.earlyStopDetail = s;
      },
      logDiag: this.opts.logDiag
        ? (entry) => this.opts.logDiag?.(entry as Record<string, unknown>)
        : undefined,
    };
  }

  private async runAudit(cfg: RunConfig, cycle: number): Promise<"done" | "retry" | "stop"> {
    return runCouncilAuditCycle(this.auditHost(), cfg, cycle);
  }

  private standupHost(): CouncilStandupHost {
    return {
      manager: this.opts.manager,
      state: this.state,
      progressLedger: this.progressLedger,
      active: this.active,
      repoFiles: this.repoFiles,
      appendSystem: (msg, summary) => this.appendSystem(msg, summary),
      postCouncilTodo: (input) => this.postCouncilTodo(input),
      cycleTranscriptSlice: () => this.cycleTranscriptSlice(),
      runDiscussionAgent: (agent, prompt, opts) =>
        this.runDiscussionAgent(agent, prompt, opts as any),
      stats: this.stats,
    };
  }

  private async synthesizeStandup(cfg: RunConfig, cycle: number): Promise<void> {
    await synthesizeStandupImpl(this.standupHost(), cfg, cycle);
  }

  private async runStandupTurn(
    agent: Agent,
    snapshot: readonly TranscriptEntry[],
    userDirective?: string,
  ): Promise<void> {
    await runStandupTurnImpl(this.standupHost(), agent, snapshot, userDirective);
  }

  private async runTurn(
    agent: Agent,
    round: number,
    totalRounds: number,
    snapshot: readonly TranscriptEntry[],
    userDirective?: string,
  ): Promise<void> {
    const visible = snapshot.filter((e) => userEntryVisibleTo(e, agent.id));
    const prompt = buildCouncilPrompt(
      agent.index,
      round,
      totalRounds,
      visible,
      userDirective,
      this.active?.localPath,
      this.repoFiles,
      this.codeContextExcerpts,
      agent.model,
    );
    await this.runDiscussionAgent(agent, prompt, {
      runnerName: "council",
      agentName: resolveCouncilToolProfile(this.active),
      stats: this.stats,
      activity: {
        kind: "discussion",
        label: round === 1 ? `draft r${round}` : `reveal r${round}`,
        mode: "explore",
      },
      enrichSummary: {
        kind: "council_draft",
        round,
        phase: round === 1 ? "draft" : "reveal",
      },
    });
  }
}

export { parseConvergenceSignal as parseCouncilConvergence } from "./convergenceSignal.js";
export { buildCouncilPrompt, buildCouncilSynthesisPrompt } from "./councilPromptHelpers.js";
