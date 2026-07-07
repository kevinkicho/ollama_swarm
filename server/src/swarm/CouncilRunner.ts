import { randomUUID } from "node:crypto";
import type { Agent } from "../services/AgentManager.js";

import type {
  TranscriptEntry,
  SwarmEvent,
} from "../types.js";
import type { RunConfig, RunnerOpts } from "./SwarmRunner.js";
import { DiscussionRunnerBase } from "./DiscussionRunnerBase.js";
import { promptWithFailoverAuto } from "./promptWithFailoverAuto.js";

import { buildSeedSummary, formatPortReleaseLine } from "./runSummary.js";
import { extractProviderText, parseJsonArrayFromResponse, createTimeoutController } from "./councilUtils.js";
import { extractTextWithDiag, looksLikeJunk, trackPostRetryJunk } from "./extractText.js";
import { retryEmptyResponse } from "./promptAndExtract.js";

import { staggerStart } from "./staggerStart.js";
import { stripAgentText } from "@ollama-swarm/shared/stripAgentText";
import { describeSdkError } from "./sdkError.js";
import { userEntryVisibleTo } from "./chatReceipt.js";
import {
  readDirective,
  buildDirectiveBlock,
} from "./directivePromptHelpers.js";
import {
  buildCouncilSynthesisPrompt,
  buildCouncilPrompt,
  buildStandupPrompt,
} from "./councilPromptHelpers.js";
import {
  extractActionableTodos,
} from "./councilDecisions.js";
import { writeCouncilDeliverable } from "./councilDeliverable.js";
import { runSynthesisPass } from "./councilSynthesis.js";
import { runCouncilWorkers } from "./councilWorkerRunner.js";
import { runCouncilLlmAudit } from "./councilAuditor.js";
import { maybeRunWrapUpApply } from "./wrapUpApplyPhase.js";
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
import { readExpectedFiles } from "./sharedFileUtils.js";
import { reconcileCriteriaFromSkips } from "./councilSkipReconcile.js";
import { buildCouncilTodoPost } from "./councilTodoClassify.js";


export class CouncilRunner extends DiscussionRunnerBase {
  protected getPresetName(): string { return "Council"; }

  private state!: CouncilAdapterState;
  private repoFiles: string[] = [];
  private codeContextExcerpts: ReadonlyArray<{ path: string; excerpt: string }> = [];
  private executionFailures: string[] = [];
  private previousUnmetIds: Set<string> = new Set();
  private stuckCycleCount = 0;
  private consecutiveEmptyCycles = 0;
  private tierPromotionRetries = 0;
  private maxTiers = Infinity;
  private capWatchdog: ReturnType<typeof setInterval> | undefined;
  private drainResolve: (() => void) | undefined;
  private drainRequested = false;
  private stopAbortController: AbortController | undefined;
  private stopInFlight: Promise<void> | null = null;
  private loopPromise: Promise<void> | null = null;

  constructor(opts: RunnerOpts) {
    super(opts);
  }

  async start(cfg: RunConfig): Promise<void> {
    if (this.isRunning()) throw new Error("A swarm is already running. Stop it first.");
    this.resetState(cfg);

    const { destPath, ready } = await this.initCloneAndSpawn(cfg, {
      preset: "council",
      roleResolver: () => "Drafter",
    });
    this.stats.registerAgents(ready);

    this.state = buildCouncilAdapterState(
      cfg,
      destPath,
      this.opts.manager as any,
      this.opts.repos as any,
      (msg) => this.appendSystem(msg),
      (agent, text) => { const entry: TranscriptEntry = { id: randomUUID(), role: "agent", agentId: agent.id, agentIndex: agent.index, text, ts: Date.now() }; this.transcript.push(entry); this.opts.emit({ type: "transcript_append", entry } as any); },
      (e) => this.opts.emit(e as SwarmEvent),
      (entry) => this.opts.logDiag?.(entry as any),
    );

    // Gather project context
    this.repoFiles = await this.opts.repos.listRepoFiles(destPath, { maxFiles: 500 });
    this.codeContextExcerpts = await gatherCodeContext(destPath, cfg.userDirective, this.repoFiles);

    this.setPhase("seeding");
    await this.seed(destPath, cfg);

    // Derive initial contract
    const planner = ready[0];
    const workers = ready.slice(1);
    if (planner && cfg.userDirective) {
      this.appendSystem(`Deriving tier ${this.state.currentTier} contract from directive…`);
      await runContractDerivation(this.state, planner, workers);
    }

    this.setPhase("discussing");
    this.startedAt = Date.now();
    this.state.runStartedAt = this.startedAt;

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
   * Hard stop: enter closing immediately, write summary, kill agents.
   * (Soft drain is `drain()`.)
   */
  async stop(): Promise<void> {
    if (this.stopInFlight) return this.stopInFlight;
    this.stopInFlight = this.closeOutStopped({ immediate: true });
    return this.stopInFlight;
  }

  /**
   * Soft stop: workers finish their current todo, then escalate to hard stop.
   * Backstopped at 3 min (matches UI copy).
   */
  async drain(): Promise<void> {
    if (this.stopInFlight) return this.stopInFlight;
    if (this.phase === "stopped" || this.phase === "completed") return;

    this.drainRequested = true;
    this.setPhase("draining");

    const DRAIN_TIMEOUT = 180_000;
    await Promise.race([
      new Promise<void>((resolve) => {
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
      }),
      this.loopPromise ?? Promise.resolve(),
    ]);

    this.stopInFlight = this.closeOutStopped({ immediate: true });
    return this.stopInFlight;
  }

  private async closeOutStopped(opts: { immediate: boolean }): Promise<void> {
    if (this.summaryWritten && (this.phase === "stopped" || this.phase === "completed")) return;

    this.stopping = true;
    if (this.state) this.state.stopping = true;
    this.setPhase("stopping");
    this.stopCapWatchdog();

    const unblockDrain = this.drainResolve;
    this.drainResolve = undefined;
    unblockDrain?.();

    if (opts.immediate) {
      try {
        this.stopAbortController?.abort(new Error("user stop"));
      } catch {
        // best-effort
      }
    }

    const cfg = this.active;
    if (cfg) {
      await this.writeSummary(cfg);
    }

    const killResult = await this.opts.manager.killAll();
    this.appendSystem(formatPortReleaseLine(killResult));
    this.setPhase("stopped");
  }

  private startCapWatchdog(cfg: RunConfig): void {
    const deadline = this.startedAt! + cfg.wallClockCapMs!;
    const CHECK_INTERVAL = 10_000;
    this.capWatchdog = setInterval(() => {
      if (Date.now() >= deadline) {
        this.appendSystem(`[cap] Wall-clock cap reached (${Math.round(cfg.wallClockCapMs! / 60_000)} min) — stopping.`);
        this.stop();
      }
    }, CHECK_INTERVAL);
    this.capWatchdog.unref();
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
        if (!isAutonomous || this.stopping) break;
        this.earlyStopDetail = undefined;
        await new Promise((r) => setTimeout(r, 2000));
      }
    });

    if (!this.stopping) this.appendSystem("Council complete.");
  }

  private async runCycle(cfg: RunConfig, cycle: number, isAutonomous: boolean): Promise<"done" | "retry" | "stop"> {
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
          await staggerStart(this.opts.manager.list(), (agent) =>
            this.runTurn(agent, r, 3, snapshot, cfg.userDirective),
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
            );
            for (const t of synthesisTodos) {
              this.state.todoQueue.post(
                buildCouncilTodoPost({
                  description: t.description,
                  expectedFiles: t.expectedFiles,
                  createdBy: "council-synthesis",
                }),
              );
            }
            if (synthesisTodos.length > 0) {
              this.appendSystem(
                `[synthesis] Enqueued ${synthesisTodos.length} actionable todo(s).`,
                {
                  kind: "council_stage",
                  cycle,
                  stage: "execution",
                  detail: `${synthesisTodos.length} synthesis todo(s)`,
                },
              );
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
          await maybeRunWrapUpApply({
            cfg,
            presetName: "council",
            agent: this.opts.manager.list()[0],
            manager: this.opts.manager,
            repos: this.opts.repos,
            emit: this.opts.emit,
            appendSystem: (text) => this.appendSystem(text),
            relevantFiles: [],
          });
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
        await staggerStart(this.opts.manager.list(), (agent) =>
          this.runStandupTurn(agent, snapshot, cfg.userDirective),
        );

        await this.synthesizeStandup(cfg);
      }
    }

    // ── DRAIN LOOP: execute all pending todos ──
    this.executionFailures = [];
    if (!this.stopping) {
      await this.drainTodos(cfg, cycle);
    }

    if (!this.stopping && this.state.contract) {
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
    if (!this.stopping && this.state.contract) {
      const auditResult = await this.runAudit(cfg, cycle);
      if (auditResult === "stop") return "stop";
      if (auditResult === "retry") return "retry";
      return "done";
    }

    return "done";
  }

  private async drainTodos(cfg: RunConfig, cycle: number): Promise<void> {
    const agents = this.opts.manager.list();
    const executionAgents = agents.filter((a) => a.index !== 1);
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

    const REAPER_INTERVAL = 30_000;
    const IN_PROGRESS_TTL = 10 * 60_000;
    const reaper = setInterval(() => {
      const reaped = this.state.todoQueue.reapStaleInProgress(Date.now(), IN_PROGRESS_TTL);
      for (const id of reaped) {
        this.appendSystem(`[reaper] Timed out todo ${id} — was in-progress for >10min.`);
      }
    }, REAPER_INTERVAL);
    reaper.unref();

    try {
      // Set up drain resolver so stop() can signal us
      const drainPromise = new Promise<void>((resolve) => {
        this.drainResolve = resolve;
      });

      const { completed, failed, skipped } = await runCouncilWorkers(
        this.state,
        executionAgents,
        {
          appendSystem: (msg) => this.appendSystem(msg),
          recordFailure: (todoId, description, error) => {
            this.executionFailures.push(`${description}: ${error.slice(0, 200)}`);
          },
          stopping: () => this.stopping,
          draining: () => this.drainRequested,
          promptSignal: this.stopAbortController?.signal,
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
      // Signal drain complete
      this.drainResolve?.();
    } finally {
      clearInterval(reaper);
    }
  }

  private async runAudit(cfg: RunConfig, cycle: number): Promise<"done" | "retry" | "stop"> {
    if (!this.state.contract) return "done";

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

    const { updatedCriteria, newTodos } = await runCouncilLlmAudit(
      cfg,
      this.state.contract,
      this.state.committedFiles,
      {
        manager: this.opts.manager as any,
        appendSystem: tagAudit,
        stopping: () => this.stopping,
      },
      skipEvidence,
    );

    this.state.contract = { ...this.state.contract, criteria: updatedCriteria };
    const metCount = updatedCriteria.filter(c => c.status === "met").length;
    const unmetCount = updatedCriteria.filter(c => c.status === "unmet").length;
    const currentUnmetIds = new Set(updatedCriteria.filter(c => c.status === "unmet").map(c => c.id));

    // Convergence detection
    const sameUnmet = [...currentUnmetIds].filter(id => this.previousUnmetIds.has(id)).length;
    this.previousUnmetIds = currentUnmetIds;
    if (unmetCount > 0 && sameUnmet === currentUnmetIds.size) {
      this.stuckCycleCount++;
      this.appendSystem(`[audit] Same ${sameUnmet} criteria unmet for ${this.stuckCycleCount} cycle(s).`);
      if (this.stuckCycleCount >= 3) {
        this.appendSystem(`[audit] Stuck for ${this.stuckCycleCount} cycles — stopping.`);
        // Council-specific proactive path: trigger brain suggestion (clean opts access)
        const getBrain = this.opts.getBrainService;
        if (getBrain) {
          const brain = getBrain();
          if (brain && brain.injectSuggestion) {
            const rid = this.active?.runId || 'current-run';
            brain.injectSuggestion(rid, {
              title: `Council stuck after ${this.stuckCycleCount} cycles`,
              text: 'Suggestion: consider amending directive or trying a different preset (e.g. pipeline for chaining).',
              category: 'recommendation',
            });
          }
        }
        return "stop";
      }
    } else {
      this.stuckCycleCount = 0;
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
          this.appendSystem(`[ambition] Tier promotion failed ${this.tierPromotionRetries} times — stopping.`);
          return "stop";
        }
        this.appendSystem(`[ambition] Tier promotion returned no criteria — retrying (${this.tierPromotionRetries}/3).`);
        return "retry";
      }
      this.appendSystem(`[ambition] All criteria met, no more tiers — stopping.`);
      return "stop";
    }

    // Create todos for unmet criteria
    for (const t of newTodos) {
      this.state.todoQueue.post(
        buildCouncilTodoPost({
          description: t.description,
          expectedFiles: t.expectedFiles,
          createdBy: "auditor",
          ...(t.criterionId ? { criterionId: t.criterionId } : {}),
        }),
      );
    }
    this.appendSystem(`[audit] Created ${newTodos.length} todo(s) for unmet criteria.`);

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
                  agentName: "swarm-read",
                  signal: controller.signal,
                }, cfg.providerFailover);
                const text = extractProviderText(raw);
                if (text) {
                  const todos = parseJsonArrayFromResponse(text, (t: Record<string, unknown>, i: number) => ({
                    description: String(t.description ?? `Task ${i + 1}`),
                    expectedFiles: Array.isArray(t.expectedFiles) ? t.expectedFiles.map(String) : [],
                  }));
                  for (const t of todos) {
                    this.state.todoQueue.post(
                      buildCouncilTodoPost({
                        description: t.description,
                        expectedFiles: t.expectedFiles,
                        createdBy: "planner-fallback",
                      }),
                    );
                  }
                  this.appendSystem(`[planner] Fallback created ${todos.length} todo(s).`);
                  if (todos.length > 0) {
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

  private async synthesizeStandup(cfg: RunConfig): Promise<void> {
    const agents = this.opts.manager.list();
    const lead = agents.find((a) => a.index === 1);
    if (!lead) return;

    const proposals = this.transcript
      .filter((e) => e.role === "agent" && e.summary?.kind === "council_draft" && (e.summary as any).phase === "standup")
      .map((e) => `[Agent ${e.agentIndex}]:\n${e.text}`)
      .join("\n\n---\n\n");

    if (!proposals) return;

    const prompt = `You are Agent 1, synthesizing standup proposals into a unified plan.

Standup proposals from all agents:
${proposals}

Your task: Merge these proposals into a single, coherent plan. Focus on what's actionable.
Output a JSON array of concrete todos:
[{"description": "specific file change", "expectedFiles": ["path/to/file.ts"]}]

Max 6 items. Each todo must target specific files. Return ONLY the JSON array.`;

    const controller = new AbortController();
    try {
      const raw = await promptWithFailoverAuto(lead, prompt, {
        manager: this.opts.manager,
        agentName: "swarm-read",
        signal: controller.signal,
      }, cfg.providerFailover);
      const text = extractProviderText(raw);
      if (text) {
        const todos = parseJsonArrayFromResponse(text, (item: any) => ({
          description: String(item.description ?? ""),
          expectedFiles: Array.isArray(item.expectedFiles) ? item.expectedFiles.map(String) : [],
        }));
        for (const todo of todos) {
          if (todo.description) {
            this.state.todoQueue.post(
              buildCouncilTodoPost({
                description: todo.description,
                expectedFiles: todo.expectedFiles,
                createdBy: "council",
              }),
            );
          }
        }
        this.appendSystem(`[Standup] Synthesized ${todos.length} proposals into unified plan.`);
      }
    } catch (err) {
      this.appendSystem(`[council] Standup synthesis failed: ${err instanceof Error ? err.message : String(err)}`);
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
    );
    await this.runDiscussionAgent(agent, prompt, {
      runnerName: "council",
      agentName: "swarm-read",
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
      agentName: "swarm-read",
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
