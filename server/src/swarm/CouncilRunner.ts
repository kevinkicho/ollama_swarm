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

import { buildSeedSummary, formatPortReleaseLine } from "./runSummary.js";
import { extractProviderText, parseJsonArrayFromResponse, createTimeoutController } from "./councilUtils.js";
import { extractTextWithDiag, looksLikeJunk, trackPostRetryJunk } from "./extractText.js";
import { retryEmptyResponse } from "./promptAndExtract.js";

import { burstSpacingForModels, staggerStart } from "./staggerStart.js";
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
  buildProgressContextBlock,
  harvestStandupFindingsFromEntries,
  loadCouncilProgressLedger,
  saveCouncilProgressLedger,
  wrapProgressContextForPrompt,
  appendLedgerObservation,
  type CouncilProgressLedger,
} from "./councilProgressLedger.js";
import { standupFallbackTodosFromEntries } from "./councilStandupFallback.js";
import {
  extractActionableTodos,
} from "./councilDecisions.js";
import { writeCouncilDeliverable } from "./councilDeliverable.js";
import { runSynthesisPass } from "./councilSynthesis.js";
import { runCouncilWorkers } from "./councilWorkerRunner.js";
import { runCouncilLlmAudit } from "./councilAuditor.js";
import { maybeRunWrapUpApply } from "./wrapUpApplyPhase.js";
import { TodoQueue } from "./blackboard/TodoQueue.js";
import { v2QueueCountsToWireCounts } from "./blackboard/boardWireCompat.js";
import { FindingsLog } from "./blackboard/FindingsLog.js";
import type { ExitContract, ExitCriterion } from "./blackboard/types.js";
import {
  buildCouncilAdapterState,
  runContractDerivation,
  runTierPromotion,
  type CouncilAdapterState,
} from "./councilAdapter.js";
import { gatherCodeContext } from "./gatherCodeContext.js";
import { readExpectedFiles } from "./sharedFileUtils.js";
import { reconcileCriteriaFromSkips } from "./councilSkipReconcile.js";
import {
  buildUnmetFailSignature,
  extractRecentProviderStallFromLedger,
  hasCommitProgressOnUnmet,
  unmetFailsAreTransientOnly,
  reconcileCriteriaFromLedger,
} from "./councilLedgerReconcile.js";
import { SwarmControlCenter } from "./control/SwarmControlCenter.js";
import type { StallGateVerdict } from "@ollama-swarm/shared/swarmControl/types";
import { postCouncilTodoBatch } from "./councilTodoPlan.js";
import { emitCouncilTodoPosted } from "./councilTodoWire.js";
import type { PostTodoInput } from "./blackboard/TodoQueue.js";
import {
  councilRunIdShort,
  loadPendingExecutionTodos,
  persistCouncilPendingTodos,
  seedPendingTodosToQueue,
} from "./councilExecutionResume.js";



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
  private capWatchdog: ReturnType<typeof setInterval> | undefined;
  private drainResolve: (() => void) | undefined;
  private drainRequested = false;

  /** True when the run is draining or hard-stopping — skip audit / new cycle work. */
  private closingRequested(): boolean {
    return this.stopping || this.drainRequested;
  }
  private stopAbortController: AbortController | undefined;
  private stopInFlight: Promise<void> | null = null;
  private loopPromise: Promise<void> | null = null;
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
    this.loopPromise = this.loop(cfg)
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.opts.emit({ type: "error", message: msg });
      })
      .finally(() => this.ensureTerminalCloseOut());
  }

  /** Idempotent backstop when loop exits without a summary (crash, throw, or race with stop). */
  private async ensureTerminalCloseOut(): Promise<void> {
    if (this.summaryWritten) return;
    if (this.phase === "stopped" || this.phase === "completed") return;
    if (this.stopInFlight) {
      await this.stopInFlight.catch(() => {});
      return;
    }
    this.stopInFlight = this.closeOutStopped({ immediate: true });
    await this.stopInFlight.catch(() => {});
  }

  /**
   * Cut off transcript + streaming immediately on user stop. Close-out may still
   * wait for in-flight workers before writing summary / killAll.
   */
  private enterImmediateShutdown(): void {
    this.transcriptFrozen = true;
    this.stopping = true;
    if (this.state) this.state.stopping = true;
    this.opts.manager.beginRunShutdown();
    try {
      this.stopAbortController?.abort(new Error("user stop"));
    } catch {
      // best-effort
    }
  }

  /**
   * Hard stop: enter closing immediately, write summary, kill agents.
   * (Soft drain is `drain()`.)
   */
  async stop(): Promise<void> {
    if (this.stopInFlight) return this.stopInFlight;
    this.enterImmediateShutdown();
    this.stopInFlight = this.awaitLoopThenCloseOut({ immediate: true });
    return this.stopInFlight;
  }

  /**
   * Soft stop: workers finish their current todo, then escalate to hard stop.
   * Backstopped at 3 min (matches UI copy).
   */
  async drain(): Promise<void> {
    if (this.stopInFlight) return this.stopInFlight;
    if (this.phase === "stopped" || this.phase === "completed") return;

    const q = this.state?.todoQueue?.counts();
    const inFlight = (q?.inProgress ?? 0) + (q?.pending ?? 0);
    if (inFlight === 0 && this.phase !== "executing") {
      this.appendSystem(
        "Drain not applicable (no in-flight execution todos — use Stop for immediate exit). Stopping immediately.",
      );
      return this.stop();
    }

    this.drainRequested = true;
    this.setPhase("draining");

    const DRAIN_TIMEOUT = 180_000;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.appendSystem("[drain] Timeout waiting for workers — forcing stop.");
        resolve();
      }, DRAIN_TIMEOUT);
      const origResolve = this.drainResolve;
      this.drainResolve = () => {
        clearTimeout(timer);
        resolve();
        origResolve?.();
      };
    });

    this.stopInFlight = this.awaitLoopThenCloseOut({ immediate: true });
    return this.stopInFlight;
  }

  /** Wait for the autonomous loop to observe drain/stop, then write summary last. */
  private async awaitLoopThenCloseOut(opts: { immediate: boolean }): Promise<void> {
    // Hard stop during execution: wait for worker pool to exit before writing
    // summary / killAll. The old 15s loop race let close-out run while
    // runCouncilWorkers was still awaiting in-flight provider HTTP.
    if (opts.immediate && this.workerDrainPromise) {
      await Promise.race([
        this.workerDrainPromise.catch(() => {}),
        new Promise<void>((r) => setTimeout(r, 45_000)),
      ]);
    }
    if (this.loopPromise) {
      const loopCapMs = opts.immediate ? 10_000 : 120_000;
      await Promise.race([
        this.loopPromise.catch(() => {}),
        new Promise<void>((r) => setTimeout(r, loopCapMs)),
      ]);
    }
    await this.closeOutStopped(opts);
  }

  private async closeOutStopped(opts: { immediate: boolean }): Promise<void> {
    if (this.summaryWritten && (this.phase === "stopped" || this.phase === "completed")) return;

    if (opts.immediate) {
      this.enterImmediateShutdown();
    } else {
      this.stopping = true;
      if (this.state) this.state.stopping = true;
    }
    this.setPhase("stopping");
    this.stopCapWatchdog();

    const unblockDrain = this.drainResolve;
    this.drainResolve = undefined;
    unblockDrain?.();

    const cfg = this.active;
    if (cfg?.runId && this.state?.todoQueue) {
      const n = this.state.todoQueue.counts().pending + this.state.todoQueue.counts().inProgress;
      if (n > 0) {
        const clonePath = cfg.localPath ?? "";
        if (clonePath) {
          persistCouncilPendingTodos(clonePath, cfg.runId, this.state.todoQueue.list());
          this.appendSystem(
            `[resume] Saved ${n} pending execution todo(s) for run ${councilRunIdShort(cfg.runId)}.`,
          );
        }
      }
    }
    if (cfg) {
      await this.writeSummary(cfg);
    }

    this.transcriptFrozen = true;
    const killResult = await this.opts.manager.killAll();
    super.appendSystem(formatPortReleaseLine(killResult));
    this.setPhase("stopped");
  }

  private startCapWatchdog(cfg: RunConfig): void {
    const CHECK_INTERVAL = 10_000;
    this.capWatchdog = setInterval(() => {
      const capMs = this.active?.wallClockCapMs ?? cfg.wallClockCapMs;
      if (!capMs || capMs <= 0 || this.startedAt == null) return;
      const deadline = this.startedAt + capMs;
      if (Date.now() >= deadline) {
        this.appendSystem(`[cap] Wall-clock cap reached (${Math.round(capMs / 60_000)} min) — stopping.`);
        this.stop();
      }
    }, CHECK_INTERVAL);
    this.capWatchdog.unref();
  }

  protected override onReconfig(changes: import("./runReconfig.js").RunReconfigChanges): void {
    if (changes.wallClockCapMs && this.active) {
      this.stopCapWatchdog();
      if (this.active.wallClockCapMs && this.active.wallClockCapMs > 0) {
        this.startCapWatchdog(this.active);
      }
    }
  }

  private stopCapWatchdog(): void {
    if (this.capWatchdog) {
      clearInterval(this.capWatchdog);
      this.capWatchdog = undefined;
    }
  }

  private async seed(clonePath: string, cfg: RunConfig): Promise<void> {
    const tree = (await this.opts.repos.listTopLevel(clonePath)).slice(0, 200);
    const dirCtx = readDirective(cfg);

    const readmeExcerpt = await this.opts.repos.readReadme(clonePath);

    const lines: string[] = [
      `Project clone: ${clonePath}`,
      `Repo: ${cfg.repoUrl}`,
      `Top-level entries: ${tree.join(", ") || "(empty)"}`,
      "",
      ...buildDirectiveBlock(dirCtx, {
        framingLines: [
          "Every drafter answers the directive above. Round 1 = independent drafts (peers hidden); Round 2+ = reveal and revise. Synthesis at the end consolidates into a single plan.",
        ],
        authoritative: true,
      }),
    ];

    if (readmeExcerpt) {
      lines.push("", `README excerpt:\n${readmeExcerpt.slice(0, 3000)}`);
    }

    if (this.repoFiles.length > 0) {
      lines.push(
        "",
        `Project files (${this.repoFiles.length} total):`,
        ...this.repoFiles.slice(0, 100),
      );
      if (this.repoFiles.length > 100) {
        lines.push(`... and ${this.repoFiles.length - 100} more`);
      }
    }

    if (this.codeContextExcerpts.length > 0) {
      lines.push("", "Key file excerpts:");
      for (const { path, excerpt } of this.codeContextExcerpts) {
        lines.push(`--- ${path} ---`, excerpt, "---");
      }
    }

    lines.push(
      "",
      "Use your read / grep / find tools to actually inspect this repo — start with README.md if present.",
    );

    this.appendSystem(lines.join("\n"), buildSeedSummary(cfg.repoUrl, clonePath, tree));
  }

  private async loop(cfg: RunConfig): Promise<void> {
    const isAutonomous = cfg.rounds === 0;
    let cycle = 0;

    await this.runDiscussionLoop(cfg, "Council", async (cfg) => {
      while (!this.stopping) {
        cycle++;
        this.state.stopping = this.stopping;
        const result = await this.runCycle(cfg, cycle, isAutonomous);

        if (result === "stop") break;
        if (result === "retry") {
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        if (this.executionOnlyResume) {
          this.appendSystem("[resume] Execution-only resume complete — finishing run.");
          break;
        }
        if (!isAutonomous || this.closingRequested()) break;
        this.earlyStopDetail = undefined;
        await new Promise((r) => setTimeout(r, 2000));
      }
      this.appendCouncilTerminalMessage();
    }, {
      shouldSetCompleted: () => !this.earlyStopDetail,
    });
  }

  /** Terminal line written before summary so transcript and stopDetail stay aligned. */
  private appendCouncilTerminalMessage(): void {
    if (this.closingRequested()) return;
    if (this.earlyStopDetail) {
      this.appendSystem(`[audit] Council stopped: ${this.earlyStopDetail}`);
      return;
    }
    this.appendSystem("Council complete.");
  }

  private syncProgressContext(): void {
    const block = buildProgressContextBlock(this.progressLedger);
    const wrapped = wrapProgressContextForPrompt(block);
    this.state.progressContext = wrapped || undefined;
  }

  private prependCouncilControlHints(): void {
    const sessionHint = this.swarmControl.consumeSessionPlannerHint();
    if (!sessionHint) return;
    const tag = `[Swarm control — session]\n${sessionHint}\n[End swarm control]\n\n`;
    this.state.progressContext = tag + (this.state.progressContext ?? "");
  }

  private async evaluateCouncilStallGate(
    planner: Agent,
    providerStall?: string,
  ): Promise<StallGateVerdict | null> {
    const wire = v2QueueCountsToWireCounts(this.state.todoQueue.counts());
    return this.swarmControl.evaluateStallGate({
      board: {
        open: wire.open + wire.claimed,
        stale: wire.stale,
        skipped: wire.skipped,
        committed: wire.committed,
        total: wire.total,
      },
      contract: this.state.contract,
      stuckCycles: this.stuckCycleCount,
      providerStall,
      todos: this.state.todoQueue.list() as unknown as import("./blackboard/types.js").Todo[],
      coachAgent: planner,
      clonePath: this.active?.localPath,
      runId: this.active?.runId,
      appendSystem: (msg) => this.appendSystem(msg),
      emit: (e) => this.opts.emit(e),
    });
  }

  private persistProgressLedger(): void {
    const clonePath = this.active?.localPath;
    const runId = this.active?.runId;
    if (!clonePath || !runId) return;
    saveCouncilProgressLedger(clonePath, this.progressLedger);
  }

  private cycleTranscriptSlice(): TranscriptEntry[] {
    return this.transcript.slice(this.cycleTranscriptStart);
  }

  private recordTodoSettled(
    cycle: number,
    info: {
      description: string;
      expectedFiles: readonly string[];
      outcome: "completed" | "skipped" | "failed";
      detail?: string;
    },
  ): void {
    const files = [...info.expectedFiles];
    if (info.outcome === "completed") {
      appendLedgerObservation(this.progressLedger, {
        kind: "commit",
        text: info.description.slice(0, 400),
        cycle,
        files: files.length ? files : undefined,
      });
      for (const f of files) {
        if (!this.state.committedFiles.includes(f)) this.state.committedFiles.push(f);
      }
      return;
    }
    if (info.outcome === "skipped") {
      appendLedgerObservation(this.progressLedger, {
        kind: "skip",
        text: info.detail ? `${info.description.slice(0, 200)} — ${info.detail.slice(0, 180)}` : info.description.slice(0, 400),
        cycle,
        files: files.length ? files : undefined,
      });
      return;
    }
    appendLedgerObservation(this.progressLedger, {
      kind: "fail",
      text: info.detail
        ? `${info.description.slice(0, 160)} — ${info.detail.slice(0, 200)}`
        : info.description.slice(0, 400),
      cycle,
      files: files.length ? files : undefined,
    });
  }

  private finalizeCycleProgress(cycle: number): void {
    this.progressLedger.lastCycle = cycle;
    this.syncProgressContext();
    this.persistProgressLedger();
  }

  private async runCycle(cfg: RunConfig, cycle: number, isAutonomous: boolean): Promise<"done" | "retry" | "stop"> {
    this.cycleTranscriptStart = this.transcript.length;
    this.progressLedger.lastCycle = cycle;
    this.syncProgressContext();
    this.prependCouncilControlHints();

    const hasPendingTodos = this.state.todoQueue.counts().pending > 0;

    if (hasPendingTodos) {
      const pending = this.state.todoQueue.counts().pending;
      this.appendSystem(
        `═══ Council cycle ${cycle} — draining ${pending} pending todo(s) ═══`,
        { kind: "council_cycle", cycle, executionOnly: true, pendingTodos: pending },
      );
    } else {
      this.appendSystem(`═══ Council cycle ${cycle} ═══`, {
        kind: "council_cycle",
        cycle,
        executionOnly: false,
      });

      if (cycle === 1) {
        // ── CYCLE 1: Full discussion (3 rounds) ──
        this.setPhase("discussing");
        this.appendSystem(`Analysis — 3 round(s)`, {
          kind: "council_stage",
          cycle,
          stage: "discussion",
          detail: "3 rounds",
        });

        for (let r = 1; r <= 3; r++) {
          if (this.stopping) break;
          const snapshot: readonly TranscriptEntry[] = [...this.transcript];
          const agents = this.opts.manager.list();
          await staggerStart(
            agents,
            (agent) => this.runTurn(agent, r, 3, snapshot, cfg.userDirective),
            burstSpacingForModels(agents),
          );
        }

        // Final synthesis
        if (!this.stopping) {
          await runSynthesisPass(
            cfg,
            this.transcript,
            this.stopping,
            this.stats,
            this.runDiscussionAgent.bind(this),
            {
              manager: this.opts.manager as any,
              emit: this.opts.emit as any,
              getSwarmControl: () => this.swarmControl,
              getCoachAgent: () => this.opts.manager.list().find((a) => a.index === 1),
              appendSystem: ((msg: string) => {
                if (msg.startsWith("Synthesizing council consensus")) {
                  this.appendSystem(msg, {
                    kind: "council_stage",
                    cycle,
                    stage: "synthesis",
                    detail: `agent-1`,
                  });
                } else {
                  this.appendSystem(msg);
                }
              }) as any,
              logDiag: (this.opts.logDiag ?? (() => {})) as any,
            },
            this.state.committedFiles,
            this.state.currentTier,
            this.repoFiles,
            this.codeContextExcerpts,
          );

          const lead = this.opts.manager.list().find((a) => a.index === 1);
          if (lead) {
            const synthesisTodos = await extractActionableTodos(
              lead,
              cfg,
              this.transcript,
              this.opts.repos,
              (msg) => this.appendSystem(msg),
              this.opts.manager as any,
              this.state.contract,
              this.state.progressContext,
            );
            const enqueued = postCouncilTodoBatch(
              (input) => this.postCouncilTodo(input),
              synthesisTodos.map((t) => ({
                description: t.description,
                expectedFiles: t.expectedFiles,
                createdBy: "council-synthesis",
              })),
              (msg) => this.appendSystem(msg),
            );
            if (enqueued > 0) {
              this.appendSystem(
                `[synthesis] Enqueued ${enqueued} actionable todo(s).`,
                {
                  kind: "council_stage",
                  cycle,
                  stage: "execution",
                  detail: `${enqueued} synthesis todo(s)`,
                },
              );
        const clonePath = cfg.localPath ?? "";
        if (cfg.runId && clonePath) {
          persistCouncilPendingTodos(clonePath, cfg.runId, this.state.todoQueue.list());
        }
            }
          }
        }

        // Write deliverable
        if (!this.stopping && cfg.runId) {
          await writeCouncilDeliverable(
            cfg,
            this.transcript,
            null,
            this.round,
            this.earlyStopDetail,
            undefined,
            {
              manager: this.opts.manager as any,
              repos: this.opts.repos as any,
              emit: this.opts.emit as any,
              appendSystem: this.appendSystem.bind(this) as any,
            },
          );
          const wrapLead = this.opts.manager.list().find((a) => a.index === 1);
          if (wrapLead) {
            await maybeRunWrapUpApply({
              cfg,
              presetName: "council",
              agent: wrapLead,
              manager: this.opts.manager,
              repos: this.opts.repos,
              emit: this.opts.emit,
              appendSystem: (text) => this.appendSystem(text),
              relevantFiles: [],
            });
          }
        }
      } else {
        // ── CYCLE 2+: Fast standup (1 round) ──
        this.setPhase("discussing");
        const unmetCount = this.state.contract?.criteria.filter(c => c.status !== "met").length ?? 0;
        this.appendSystem(
          `[Standup] Planning next batch — ${this.state.contract?.criteria.length ?? 0} criteria, ${unmetCount} unmet.`,
          {
            kind: "council_stage",
            cycle,
            stage: "standup",
            detail: `${unmetCount} unmet criteria`,
          },
        );

        if (this.executionFailures.length > 0) {
          this.appendSystem(`[Standup] Previous failures:\n${this.executionFailures.map(f => `  ${f}`).join("\n")}`);
        }

        const snapshot: readonly TranscriptEntry[] = [...this.transcript];
        const standupAgents = this.opts.manager.list();
        await staggerStart(
          standupAgents,
          (agent) => this.runStandupTurn(agent, snapshot, cfg.userDirective),
          burstSpacingForModels(standupAgents),
        );

        harvestStandupFindingsFromEntries(
          this.progressLedger,
          cycle,
          this.cycleTranscriptSlice(),
        );

        await this.synthesizeStandup(cfg, cycle);
      }
    }

    // ── DRAIN LOOP: execute all pending todos ──
    this.executionFailures = [];
    if (!this.stopping) {
      await this.drainTodos(cfg, cycle);
    }

    if (this.closingRequested()) {
      this.finalizeCycleProgress(cycle);
      return "stop";
    }

    if (this.state.contract) {
      const skippedTodos = this.state.todoQueue
        .list()
        .filter((t) => t.status === "skipped");
      const { criteria: reconciled, promotedIds } = reconcileCriteriaFromSkips(
        this.state.contract.criteria,
        skippedTodos,
        this.repoFiles,
      );
      if (promotedIds.length > 0) {
        this.state.contract = { ...this.state.contract, criteria: reconciled };
        this.appendSystem(
          `[execution] Promoted ${promotedIds.length} criterion(s) to met from worker skips: ${promotedIds.join(", ")}.`,
        );
      }
    }

    // ── AUDIT: check criteria ──
    if (!this.closingRequested() && this.state.contract) {
      const auditResult = await this.runAudit(cfg, cycle);
      this.finalizeCycleProgress(cycle);
      if (auditResult === "stop") return "stop";
      if (auditResult === "retry") return "retry";
      return "done";
    }

    this.finalizeCycleProgress(cycle);
    return "done";
  }

  private async drainTodos(cfg: RunConfig, cycle: number): Promise<void> {
    const agents = this.opts.manager.list();
    const executionAgents = agents.filter((a) => a.index > 1);
    if (executionAgents.length === 0) return;

    const pending = this.state.todoQueue.counts().pending;
    if (pending > 0) {
      this.appendSystem(`[execution] Starting ${pending} todo(s)…`, {
        kind: "council_stage",
        cycle,
        stage: "execution",
        detail: `${pending} todo${pending === 1 ? "" : "s"}`,
      });
    }

    this.setPhase("executing");

    const REAPER_INTERVAL = 30_000;
    // Council doc+web todos routinely exceed 10 min; 15 min reduces false reaps.
    const IN_PROGRESS_TTL = 15 * 60_000;
    const reaper = setInterval(() => {
      const reaped = this.state.todoQueue.reapStaleInProgress(Date.now(), IN_PROGRESS_TTL);
      for (const id of reaped) {
        this.appendSystem(`[reaper] Timed out todo ${id} — was in-progress for >10min.`);
      }
    }, REAPER_INTERVAL);
    reaper.unref();

    const drainWork = (async () => {
      const coachAgent = this.opts.manager.list().find((a) => a.index === 1);
      const { completed, failed, skipped } = await runCouncilWorkers(
        this.state,
        executionAgents,
        {
          appendSystem: (msg) => this.appendSystem(msg),
          recordFailure: (todoId, description, error) => {
            this.executionFailures.push(`${description}: ${error.slice(0, 200)}`);
          },
          onTodoSettled: (info) => this.recordTodoSettled(cycle, info),
          stopping: () => this.stopping,
          draining: () => this.drainRequested,
          promptSignal: this.stopAbortController?.signal,
          getSwarmControl: () => this.swarmControl,
          getCoachAgent: () => coachAgent,
          emit: (e) => this.opts.emit(e as SwarmEvent),
        },
      );

      this.appendSystem(
        `[execution] Complete: ${completed} done, ${failed} failed, ${skipped} skipped.`,
        {
          kind: "council_stage",
          cycle,
          stage: "execution",
          detail: `${completed} done, ${failed} failed, ${skipped} skipped`,
        },
      );
      this.drainResolve?.();
    })();

    this.workerDrainPromise = drainWork.finally(() => {
      this.workerDrainPromise = null;
    });

    try {
      await this.workerDrainPromise;
    } finally {
      clearInterval(reaper);
    }
  }

  private async runAudit(cfg: RunConfig, cycle: number): Promise<"done" | "retry" | "stop"> {
    if (!this.state.contract) return "done";
    if (this.closingRequested()) return "stop";
    const isAutonomous = cfg.rounds === 0;

    this.setPhase("auditing");

    const tagAudit = (msg: string) => {
      if (msg.startsWith("[audit] LLM audit:")) {
        this.appendSystem(msg, {
          kind: "council_stage",
          cycle,
          stage: "audit",
          detail: msg.replace(/^\[audit\]\s*/, ""),
        });
      } else {
        this.appendSystem(msg);
      }
    };

    const skipEvidence = this.state.todoQueue
      .list()
      .filter((t) => t.status === "skipped" && t.reason)
      .map((t) => ({
        criterionId: t.criterionId,
        criteriaIds: t.criteriaIds,
        reason: t.reason,
        expectedFiles: t.expectedFiles,
      }));

    const criteriaBeforeAudit = this.state.contract.criteria;
    const { criteria: ledgerReconciled, promotedIds: ledgerPromoted } = reconcileCriteriaFromLedger(
      this.progressLedger,
      criteriaBeforeAudit,
      this.state.committedFiles,
    );
    if (ledgerPromoted.length > 0) {
      this.state.contract = { ...this.state.contract, criteria: ledgerReconciled };
      this.appendSystem(
        `[execution] Promoted ${ledgerPromoted.length} criterion(s) to met from ledger commits: ${ledgerPromoted.join(", ")}.`,
      );
    }

    const { updatedCriteria, newTodos } = await runCouncilLlmAudit(
      cfg,
      this.state.contract,
      this.state.committedFiles,
      {
        manager: this.opts.manager as any,
        appendSystem: tagAudit,
        stopping: () => this.closingRequested(),
        abortSignal: this.stopAbortController?.signal,
        ledger: this.progressLedger,
        getSwarmControl: () => this.swarmControl,
        getCoachAgent: () => this.opts.manager.list().find((a) => a.index === 1),
        emit: (e) => this.opts.emit(e as SwarmEvent),
      },
      skipEvidence,
    );

    if (this.closingRequested()) return "stop";

    this.state.contract = { ...this.state.contract, criteria: updatedCriteria };
    const metCount = updatedCriteria.filter(c => c.status === "met").length;
    const unmetCount = updatedCriteria.filter(c => c.status === "unmet").length;
    const currentUnmetIds = new Set(updatedCriteria.filter(c => c.status === "unmet").map(c => c.id));

    const beforeById = new Map(criteriaBeforeAudit.map((c) => [c.id, c]));
    const metFlips = updatedCriteria.filter(
      (c) =>
        c.status === "met" &&
        beforeById.get(c.id)?.status === "unmet" &&
        !ledgerPromoted.includes(c.id),
    ).length;

    // Convergence detection — same unmet IDs, same fail signature, no commits on those files
    const sameUnmet = [...currentUnmetIds].filter(id => this.previousUnmetIds.has(id)).length;
    const failSignature = buildUnmetFailSignature(
      this.progressLedger,
      currentUnmetIds,
      updatedCriteria,
      cycle,
    );
    const commitOnUnmet = hasCommitProgressOnUnmet(
      this.progressLedger,
      currentUnmetIds,
      updatedCriteria,
      cycle,
    );
    const sameFailurePattern =
      failSignature.length > 0 && failSignature === this.previousStuckFailSignature;

    this.previousUnmetIds = currentUnmetIds;
    this.previousStuckFailSignature = failSignature;

    if (unmetCount > 0 && sameUnmet === currentUnmetIds.size) {
      const noLedgerProgress = sameFailurePattern && !commitOnUnmet && metFlips === 0;
      if (noLedgerProgress) {
        const transientOnly = unmetFailsAreTransientOnly(
          this.progressLedger,
          currentUnmetIds,
          updatedCriteria,
          cycle,
        );
        if (transientOnly && isAutonomous) {
          this.stuckCycleCount = 0;
          this.previousStuckFailSignature = "";
          this.appendSystem(
            "[audit] Provider quota/transport stall — backing off 2m without counting as stuck (autonomous).",
          );
          await new Promise((r) => setTimeout(r, 120_000));
          return "retry";
        }
        const providerStall = extractRecentProviderStallFromLedger(this.progressLedger, cycle);
        const planner = this.opts.manager.list().find((a) => a.index === 1);
        if (planner) {
          const gate = await this.evaluateCouncilStallGate(planner, providerStall);
          if (gate?.action === "backoff" && isAutonomous) {
            this.stuckCycleCount = 0;
            this.previousStuckFailSignature = "";
            const waitMs = gate.backoffMs ?? 120_000;
            this.appendSystem(`[control] Backing off ${Math.round(waitMs / 1000)}s — ${gate.rationale}`);
            await new Promise((r) => setTimeout(r, waitMs));
            return "retry";
          }
          if (gate?.action === "retry" && isAutonomous) {
            this.stuckCycleCount = 0;
            this.previousStuckFailSignature = "";
            this.appendSystem(`[control] Retrying after stall gate — ${gate.rationale}`);
            return "retry";
          }
          if (gate?.action === "stop") {
            this.earlyStopDetail = `audit-stuck: ${gate.rationale}`;
            this.appendSystem(`[control] Stopping — ${gate.rationale}`);
            this.setPhase("stopped");
            return "stop";
          }
        }
        this.stuckCycleCount++;
        this.appendSystem(`[audit] Same ${sameUnmet} criteria unmet for ${this.stuckCycleCount} cycle(s).`);
        if (this.stuckCycleCount >= 3) {
          this.earlyStopDetail = `audit-stuck: same ${sameUnmet} criteria unmet for ${this.stuckCycleCount} cycles`;
          this.appendSystem(`[audit] Stuck for ${this.stuckCycleCount} cycles — stopping.`);
          this.setPhase("stopped");
          const getBrain = this.opts.getBrainService;
          if (getBrain) {
            const brain = getBrain();
            if (brain && brain.injectSuggestion) {
              const rid = this.active?.runId || "current-run";
              brain.injectSuggestion(rid, {
                title: `Council stuck after ${this.stuckCycleCount} cycles`,
                text: "Suggestion: consider amending directive or trying a different preset (e.g. pipeline for chaining).",
                category: "recommendation",
              });
            }
          }
          return "stop";
        }
      } else {
        this.stuckCycleCount = 0;
      }
    } else {
      this.stuckCycleCount = 0;
      this.previousStuckFailSignature = "";
    }

    if (unmetCount === 0) {
      // All criteria met — try tier promotion
      this.stuckCycleCount = 0;
      this.previousUnmetIds = new Set();
      this.consecutiveEmptyCycles = 0;

      const planner = this.opts.manager.list().find((a) => a.index === 1);
      if (planner && this.state.currentTier < this.maxTiers) {
        this.appendSystem(`[ambition] All criteria met — attempting tier ${this.state.currentTier + 1} promotion.`);
        const promoted = await runTierPromotion(this.state, planner, this.maxTiers);
        if (promoted) {
          this.tierPromotionRetries = 0;
          return "done";
        }
        // Tier promotion failed — retry with bounded attempts.
        this.tierPromotionRetries++;
        if (this.tierPromotionRetries >= 3) {
          this.earlyStopDetail = `ambition-failed: tier promotion failed ${this.tierPromotionRetries} times`;
          this.appendSystem(`[ambition] Tier promotion failed ${this.tierPromotionRetries} times — stopping.`);
          this.setPhase("stopped");
          return "stop";
        }
        this.appendSystem(`[ambition] Tier promotion returned no criteria — retrying (${this.tierPromotionRetries}/3).`);
        return "retry";
      }
      this.appendSystem(`[ambition] All criteria met, no more tiers — stopping.`);
      return "stop";
    }

    const auditEnqueued = postCouncilTodoBatch(
      (input) => this.postCouncilTodo(input),
      newTodos.map((t) => ({
        description: t.description,
        expectedFiles: t.expectedFiles,
        createdBy: "auditor",
        ...(t.criterionId ? { criterionId: t.criterionId } : {}),
      })),
      (msg) => this.appendSystem(msg),
    );
    this.appendSystem(`[audit] Created ${auditEnqueued} todo(s) for unmet criteria.`);

    // Planner fallback
    if (newTodos.length === 0) {
      this.consecutiveEmptyCycles++;
      if (this.consecutiveEmptyCycles >= 2) {
        this.appendSystem(`[audit] No new todos for ${this.consecutiveEmptyCycles} cycles — trying planner fallback.`);
        const lead = this.opts.manager.list().find((a) => a.index === 1);
        if (lead) {
          // Instead of extracting from synthesis, explicitly ask the planner
          // to decompose unmet criteria into concrete todos.
          const unmetCriteria = this.state.contract?.criteria.filter(c => c.status === "unmet") ?? [];
          if (unmetCriteria.length > 0) {
            const prompt = `You are the planner. The auditor found ${unmetCriteria.length} unmet criteria:

${unmetCriteria.map(c => `- ${c.description} (files: ${c.expectedFiles.join(", ") || "none"})`).join("\n")}

Your task: For EACH unmet criterion, produce 1-2 concrete, actionable todos that would satisfy it.
Each todo must have a specific description and list the files it would modify.

Output a JSON array:
[{"description": "specific change", "expectedFiles": ["path/to/file.ts"]}]

Max 8 todos. Every file path MUST appear in the PROJECT FILES list.`;

            try {
              const { controller, cleanup } = createTimeoutController();
              try {
                const raw = await promptWithFailoverAuto(lead, prompt, {
                  manager: this.opts.manager,
                  agentName: resolveCouncilToolProfile(cfg),
                  webToolsConfig: cfg,
                  signal: controller.signal,
                }, cfg.providerFailover);
                const text = extractProviderText(raw);
                if (text) {
                  const todos = parseJsonArrayFromResponse(text, (t: Record<string, unknown>, i: number) => ({
                    description: String(t.description ?? `Task ${i + 1}`),
                    expectedFiles: Array.isArray(t.expectedFiles) ? t.expectedFiles.map(String) : [],
                  }));
                  const fallbackEnqueued = postCouncilTodoBatch(
                    (input) => this.postCouncilTodo(input),
                    todos.map((t) => ({
                      description: t.description,
                      expectedFiles: t.expectedFiles,
                      createdBy: "planner-fallback",
                    })),
                    (msg) => this.appendSystem(msg),
                  );
                  this.appendSystem(`[planner] Fallback created ${fallbackEnqueued} todo(s).`);
                  if (fallbackEnqueued > 0) {
                    cleanup();
                    return "retry";
                  }
                }
              } finally {
                cleanup();
              }
            } catch { /* ignore */ }
          }
          this.appendSystem(`[planner] Fallback produced nothing — stopping.`);
          return "stop";
        }
      }
    } else {
      this.consecutiveEmptyCycles = 0;
    }

    return "retry";
  }

  private async synthesizeStandup(cfg: RunConfig, cycle: number): Promise<void> {
    const agents = this.opts.manager.list();
    const lead = agents.find((a) => a.index === 1);
    if (!lead) return;

    const standupEntries = this.cycleTranscriptSlice().filter(
      (e) =>
        e.role === "agent" &&
        e.summary?.kind === "council_draft" &&
        (e.summary as { phase?: string }).phase === "standup",
    );
    const proposals = standupEntries
      .map((e) => `[Agent ${e.agentIndex}]:\n${e.text}`)
      .join("\n\n---\n\n");

    if (!proposals) return;

    const prompt = buildStandupSynthesisPrompt(proposals, this.state.progressContext);

    const controller = new AbortController();
    let standupEnqueued = 0;
    this.opts.manager.markStatus(lead.id, "thinking", {
      activityKind: "council",
      activityLabel: "standup synthesis",
    });
    try {
      const raw = await promptWithFailoverAuto(lead, prompt, {
        manager: this.opts.manager,
        agentName: resolveCouncilToolProfile(cfg),
        webToolsConfig: cfg,
        signal: controller.signal,
        activity: { kind: "council", label: "standup synthesis" },
      }, cfg.providerFailover);
      const text = extractProviderText(raw);
      if (text) {
        const todos = parseJsonArrayFromResponse(text, (item: any) => ({
          description: String(item.description ?? ""),
          expectedFiles: Array.isArray(item.expectedFiles) ? item.expectedFiles.map(String) : [],
        }));
        const standupDrafts = todos
          .filter((todo) => todo.description)
          .map((todo) => ({
            description: todo.description,
            expectedFiles: todo.expectedFiles,
            createdBy: "council",
          }));
        standupEnqueued = postCouncilTodoBatch(
          (input) => this.postCouncilTodo(input),
          standupDrafts,
          (msg) => this.appendSystem(msg),
        );
      }
    } catch (err) {
      this.appendSystem(`[council] Standup synthesis failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.opts.manager.markStatus(lead.id, "ready");
    }

    if (standupEnqueued === 0) {
      const fallback = standupFallbackTodosFromEntries(standupEntries);
      if (fallback.length > 0) {
        standupEnqueued = postCouncilTodoBatch(
          (input) => this.postCouncilTodo(input),
          fallback,
          (msg) => this.appendSystem(msg),
        );
        appendLedgerObservation(this.progressLedger, {
          kind: "synthesis",
          text: `Agent-1 merge produced no todos; enqueued ${standupEnqueued} from standup agent drafts.`,
          cycle,
        });
        this.appendSystem(
          `[Standup] Merge empty — enqueued ${standupEnqueued} todo(s) from agent standup drafts.`,
        );
      } else {
        appendLedgerObservation(this.progressLedger, {
          kind: "synthesis",
          text: "Standup merge produced no todos and no parseable standup drafts.",
          cycle,
        });
        this.appendSystem(`[Standup] Synthesized 0 proposals into unified plan.`);
      }
    } else {
      appendLedgerObservation(this.progressLedger, {
        kind: "synthesis",
        text: `Synthesized ${standupEnqueued} proposal(s) into unified plan.`,
        cycle,
      });
      this.appendSystem(`[Standup] Synthesized ${standupEnqueued} proposals into unified plan.`);
    }
  }

  private async runStandupTurn(
    agent: Agent,
    snapshot: readonly TranscriptEntry[],
    userDirective?: string,
  ): Promise<void> {
    const prompt = buildStandupPrompt(
      agent.index,
      {
        missionStatement: this.state.contract?.missionStatement ?? "",
        criteria: this.state.contract?.criteria ?? [],
      },
      this.state.committedFiles,
      userDirective,
      this.active?.localPath,
      this.repoFiles,
      agent.model,
      this.state.progressContext,
    );
    await this.runDiscussionAgent(agent, prompt, {
      runnerName: "council",
      agentName: resolveCouncilToolProfile(this.active),
      activity: { kind: "council", label: "standup" },
      stats: this.stats,
      enrichSummary: {
        kind: "council_draft",
        round: 1,
        phase: "standup" as "draft",
      },
    });
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
