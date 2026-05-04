import { randomUUID } from "node:crypto";
import type { Agent } from "../services/AgentManager.js";
import { buildAgentsReadySummary } from "./agentsReadySummary.js";
import { startSseAwareTurnWatchdog } from "./sseAwareTurnWatchdog.js";
import type {
  AgentState,
  SwarmEvent,
  SwarmPhase,
  SwarmStatus,
  TranscriptEntry,
  TranscriptEntrySummary,
} from "../types.js";
import type { RunConfig, RunnerOpts, SwarmRunner } from "./SwarmRunner.js";
import { roleForAgent, type SwarmRole } from "./roles.js";
import { promptWithRetry } from "./promptWithRetry.js";
import { formatChatReceipt } from "./chatReceipt.js";
import { detectSemanticConvergence } from "./semanticConvergence.js";
import { detectConvergence as detectJaccardConvergence } from "./moaConsensus.js";
import { AgentStatsCollector } from "./agentStatsCollector.js";
import { buildSeedSummary } from "./runSummary.js";
import { discussionWriteSummary } from "./discussionWriteSummary.js";
import { runDiscussionCloseOut } from "./runFinallyHooks.js";
import { extractResponseBreakdown, extractTextWithDiag, looksLikeJunk, trackPostRetryJunk } from "./extractText.js";
import { snapshotLifetimeTokens } from "../services/ollamaProxy.js";
import { checkBudgetGuards } from "./loopGuards.js";
// runEndReflection moved into runFinallyHooks (Phase D).
import { retryEmptyResponse } from "./promptAndExtract.js";
import { formatCloneMessage } from "./cloneMessage.js";
import { stripAgentText } from "../../../shared/src/stripAgentText.js";
import { getAgentAddendum } from "../../../shared/src/topology.js";
import { describeSdkError } from "./sdkError.js";
import { writeDeliverableAndEmit } from "./deliverable.js";
import { maybeRunWrapUpApply } from "./wrapUpApplyPhase.js";
// T199 (2026-05-04): LLM-driven dynamic role catalog.
import { deriveDynamicRoleCatalog } from "./dynamicRoleCatalog.js";
import { buildRoleDiffDeliverableSections } from "./roleDiffDeliverable.js";
import {
  readDirective,
  buildDirectiveBlock,
  pickDeliverableTitle,
  pickDeliverableSubtitle,
  pickAnswerSectionTitle,
  maybeDirectiveSection,
} from "./directivePromptHelpers.js";
import {
  extractNextActions,
  formatNextActionsMarkdown,
} from "./qualityPasses.js";
import {
  parseConvergenceSignal,
  parseConvergenceSignalLoose,
} from "./convergenceSignal.js";

export interface RoundRobinOptions {
  // Unit 8: when set, every agent gets a per-index role prepended to its
  // prompt. The Orchestrator's "role-diff" preset instantiates this runner
  // with DEFAULT_ROLES; the plain "round-robin" preset leaves it undefined.
  roles?: readonly SwarmRole[];
}

// The current collaboration pattern: N identical agents take turns in a fixed
// order, each one seeing the full transcript before speaking. Discussion-only —
// agents may read files but don't edit them.
export class RoundRobinRunner implements SwarmRunner {
  private transcript: TranscriptEntry[] = [];
  private phase: SwarmPhase = "idle";
  private round = 0;
  private stopping = false;
  private active?: RunConfig;
  // T199 (2026-05-04): no longer readonly — when cfg.dynamicRoles is
  // set, the runner replaces this with an LLM-derived catalog before
  // the discussion loop starts. Default still set in the constructor
  // from options.roles for back-compat.
  private roles?: readonly SwarmRole[];
  // Unit 33: cross-preset metrics. Collector aggregates per-agent
  // counters (turns, attempts, retries, latencies) via the same
  // onTiming/onRetry hooks promptWithRetry already surfaces. startedAt
  // is stamped once the discussing loop begins so wall-clock excludes
  // clone + spawn (mirrors BlackboardRunner.runStartedAt scoping).
  private stats = new AgentStatsCollector();
  private startedAt?: number;
  private summaryWritten = false;
  // Phase B (Task #100): set when the role-diff midpoint synthesis
  // returns CONVERGENCE: high. Promoted to stopReason="early-stop"
  // by writeSummary. 2026-05-02: also set when plain round-robin's
  // structured-deliberation convergence check (improvement #3) detects
  // the discussion has settled.
  private earlyStopDetail?: string;
  // 2026-05-02 (round-robin improvement #1): cumulative turn counter
  // across all agents + rounds. Drives disposition rotation in
  // buildPrompt. Pre-incremented by runTurn before each prompt build.
  private turnsTaken = 0;

  constructor(private readonly opts: RunnerOpts, options?: RoundRobinOptions) {
    this.roles = options?.roles && options.roles.length > 0 ? options.roles : undefined;
  }

  status(): SwarmStatus {
    return {
      phase: this.phase,
      round: this.round,
      repoUrl: this.active?.repoUrl,
      localPath: this.active?.localPath,
      model: this.active?.model,
      agents: this.opts.manager.toStates(),
      transcript: [...this.transcript],
      // Task #39: per-agent partial-stream buffer for catch-up.
      streaming: this.opts.manager.getPartialStreams(),
    };
  }

  injectUser(
    text: string,
    opts?: { intent?: "suggest" | "steer" | "ask"; targetAgent?: string },
  ): void {
    const intent = opts?.intent ?? "steer";
    const entry: TranscriptEntry = {
      id: randomUUID(),
      role: "user",
      text,
      ts: Date.now(),
      intent,
      ...(opts?.targetAgent ? { targetAgent: opts.targetAgent } : {}),
    };
    this.transcript.push(entry);
    this.opts.emit({ type: "transcript_append", entry });
    this.appendSystem(formatChatReceipt(intent, opts?.targetAgent));
  }

  isRunning(): boolean {
    // Task #34: see BlackboardRunner.isRunning() — terminal phases
    // are not running.
    return (
      this.phase !== "idle" &&
      this.phase !== "stopped" &&
      this.phase !== "completed" &&
      this.phase !== "failed"
    );
  }

  async start(cfg: RunConfig): Promise<void> {
    if (this.isRunning()) throw new Error("A swarm is already running. Stop it first.");
    this.transcript = [];
    this.stopping = false;
    this.round = 0;
    this.active = cfg;
    this.stats.reset();
    this.startedAt = undefined;
    this.earlyStopDetail = undefined;
    this.summaryWritten = false;

    this.setPhase("cloning");
    const cloneResult = await this.opts.repos.clone({ url: cfg.repoUrl, destPath: cfg.localPath });
    const { destPath } = cloneResult;
    // Unit 47: tell the UI whether this is a fresh clone or a resume.
    this.opts.emit({
      type: "clone_state",
      alreadyPresent: cloneResult.alreadyPresent,
      clonePath: destPath,
      priorCommits: cloneResult.priorCommits,
      priorChangedFiles: cloneResult.priorChangedFiles,
      priorUntrackedFiles: cloneResult.priorUntrackedFiles,
    });
    // Unit 48: hide runner-written artifacts from `git status` via the
    // clone's local .git/info/exclude (NOT the user's .gitignore).
    await this.opts.repos.excludeRunnerArtifacts(destPath);
    // E3 Phase 5: opencode.json no longer needed.
    this.appendSystem(formatCloneMessage(cfg.repoUrl, destPath, cloneResult));

    this.setPhase("spawning");
    const spawnStart = Date.now();
    const spawnTasks: Promise<Agent>[] = [];
    for (let i = 1; i <= cfg.agentCount; i++) {
      spawnTasks.push(this.opts.manager.spawnAgentNoOpencode({ cwd: destPath, index: i, model: cfg.model }));
    }
    const results = await Promise.allSettled(spawnTasks);
    const ready = results
      .filter((r): r is PromiseFulfilledResult<Agent> => r.status === "fulfilled")
      .map((r) => r.value);
    if (ready.length === 0) throw new Error("No agents started successfully");
    this.appendSystem(
      `${ready.length}/${cfg.agentCount} agents ready on ports ${ready.map((a) => a.port).join(", ")}`,
      buildAgentsReadySummary({
        manager: this.opts.manager,
        preset: "round-robin",
        ready,
        requestedCount: cfg.agentCount,
        spawnElapsedMs: Date.now() - spawnStart,
        roleResolver: () => "Discussant",
      }),
    );
    // Unit 33: register the spawned roster so buildPerAgentStats still
    // produces rows after AgentManager.killAll() clears its own roster.
    this.stats.registerAgents(ready);

    this.setPhase("seeding");
    await this.seed(destPath, cfg);

    // T199 (2026-05-04): LLM-driven dynamic role catalog. When opt-in
    // for role-diff with a directive, fire one planner pass to derive
    // a directive-tailored role catalog. Replaces this.roles before
    // the discussion loop. Falls back silently to the keyword/static
    // catalog from selectRoleCatalog on any failure (parse, agent
    // error, etc.). Adds ~5-15s to run-start latency when active.
    if (
      this.roles &&
      cfg.dynamicRoles &&
      (cfg.userDirective ?? "").trim().length > 0
    ) {
      try {
        const planner = this.opts.manager.list().find((a) => a.index === 1);
        if (planner) {
          this.appendSystem(
            `[T199 dynamic role catalog] Asking agent-1 to derive directive-tailored roles…`,
          );
          const topLevel = await this.opts.repos.listTopLevel(destPath);
          const readme = (await this.opts.repos.readReadme(destPath)) ?? undefined;
          const dynamic = await deriveDynamicRoleCatalog({
            agent: planner,
            manager: this.opts.manager,
            directive: cfg.userDirective!.trim(),
            topLevel: topLevel.slice(0, 40),
            readmeExcerpt: readme,
          });
          if (dynamic && dynamic.length >= 3) {
            const oldNames = this.roles.map((r) => r.name).join(", ");
            const newNames = dynamic.map((r) => r.name).join(", ");
            this.roles = dynamic;
            this.appendSystem(
              `[T199 dynamic role catalog] Refined roles: was [${oldNames}] → now [${newNames}].`,
            );
          } else {
            this.appendSystem(
              `[T199 dynamic role catalog] Derivation returned fewer than 3 valid roles — keeping static catalog.`,
            );
          }
        }
      } catch (err) {
        this.appendSystem(
          `[T199 dynamic role catalog] Derivation failed (${err instanceof Error ? err.message : String(err)}) — keeping static catalog.`,
        );
      }
    }

    this.setPhase("discussing");
    this.startedAt = Date.now();
    void this.loop(cfg);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.setPhase("stopping");
    await this.opts.manager.killAll();
    this.setPhase("stopped");
  }

  private async seed(clonePath: string, cfg: RunConfig): Promise<void> {
    const tree = (await this.opts.repos.listTopLevel(clonePath)).slice(0, 200);
    // 2026-05-02 (improvement #5): user directive is now honored. When
    // present, surfaced at the TOP of the seed so every agent sees it
    // before any tool call. Round-robin moves out of "analysis-only"
    // status — the deliberation now drives toward a stated objective,
    // not just open-ended commentary on the repo.
    // 2026-05-03 (Phase A): directive block extracted to shared helper.
    const dirCtx = readDirective(cfg);
    const lines = [
      `Project clone: ${clonePath}`,
      `Repo: ${cfg.repoUrl}`,
      `Top-level entries: ${tree.join(", ") || "(empty)"}`,
      "",
      ...buildDirectiveBlock(dirCtx, {
        framingLines: [
          "The deliberation should converge on a concrete plan / answer for the directive above. Treat it as the question every disposition is helping resolve.",
        ],
      }),
      "Use your file-read / grep / find tools to actually inspect this repo — start with README.md if present.",
    ];
    this.appendSystem(lines.join("\n"), buildSeedSummary(cfg.repoUrl, clonePath, tree));
  }

  private async loop(cfg: RunConfig): Promise<void> {
    let crashMessage: string | undefined;
    try {
      // Phase B (Task #100): role-diff midpoint convergence check.
      // Only fires when the runner is in role-diff mode (this.roles
      // defined). Same midpoint pattern as council #99 — one extra
      // agent-1 call max, not per-round.
      const earlyCheckRound =
        this.roles && cfg.rounds >= 4 ? Math.ceil(cfg.rounds / 2) : 0;

      // 2026-05-03 (Phase B): budget + quota guards extracted to shared helper.
      const tokenBaseline = snapshotLifetimeTokens();

      for (let r = 1; r <= cfg.rounds; r++) {
        if (this.stopping) break;
        const guard = checkBudgetGuards({
          tokenBaseline,
          tokenBudget: cfg.tokenBudget,
          round: r,
          totalRounds: cfg.rounds,
          unit: "round",
        });
        if (guard.halt) {
          this.earlyStopDetail = guard.earlyStopDetail;
          this.appendSystem(guard.message ?? "");
          break;
        }
        this.round = r;
        this.opts.emit({ type: "swarm_state", phase: "discussing", round: r });

        const agents = this.opts.manager.list();
        for (const agent of agents) {
          if (this.stopping) break;
          await this.runTurn(agent, r, cfg.rounds);
        }

        // Phase B (Task #100): midpoint synthesis check for role-diff.
        // If convergence:high, the synthesis IS the canonical output
        // (we skip the post-loop pass, same as #99 council).
        if (
          this.roles &&
          !this.stopping &&
          r === earlyCheckRound &&
          r < cfg.rounds
        ) {
          const convergence = await this.runRoleDiffSynthesisPass(cfg);
          if (convergence === "high") {
            this.earlyStopDetail =
              `role-diff-converged-high after round ${r}/${cfg.rounds}`;
            this.appendSystem(
              `Role-diff reached convergence:high at round ${r}/${cfg.rounds} — ending early.`,
            );
            break;
          }
        }
        // 2026-05-02 (round-robin improvement #3): semantic convergence
        // check for the no-roles structured-deliberation case. After
        // round 2+, if the LAST agent's turn this round is >0.85
        // cosine-similar to the same agent's turn LAST round, the
        // discussion has settled — stop early. Falls back to Jaccard
        // when embedding model unavailable. Saves the wasted "everyone
        // agreed already" tail.
        if (
          !this.roles &&
          !this.stopping &&
          r >= 2 &&
          r < cfg.rounds
        ) {
          const converged = await this.checkStructuredConvergence();
          if (converged) {
            this.earlyStopDetail = `structured-deliberation-converged after round ${r}/${cfg.rounds}`;
            this.appendSystem(
              `[improvement #3] Structured deliberation converged at round ${r}/${cfg.rounds} — last agent's turn echoes their prior round. Ending early.`,
            );
            break;
          }
        }
      }

      // Phase B (Task #100): final synthesis pass (role-diff only).
      // Closes the gap noted in the tour summary — role-diff was the
      // only read-only preset without a synthesis tag. Skip if the
      // midpoint already broke us out (we already wrote one).
      if (this.roles && !this.stopping && cfg.rounds > 0 && !this.earlyStopDetail) {
        await this.runRoleDiffSynthesisPass(cfg);
      }
      // 2026-05-02 (round-robin improvement #4): final synthesis pass
      // for the no-roles structured-deliberation case. Lead distills
      // Consensus / Disagreements / Recommended next step. Skip when
      // role-diff already ran or convergence cap broke us out.
      if (!this.roles && !this.stopping && cfg.rounds > 0 && !this.earlyStopDetail) {
        await this.runStructuredSynthesisPass(cfg);
      }

      // 2026-05-04 (T1.1 universal deliverable): plain round-robin gets
      // a portable deliverable.md too. Role-diff has its own block
      // below; this fires for the no-roles structured-deliberation
      // case (post-runStructuredSynthesisPass). Best-effort — failure
      // posts a system message but doesn't block the rest of the
      // close-out. Mirrors the role-diff block 25 lines down.
      if (!this.roles && !this.stopping && cfg.runId) {
        try {
          const sections = buildRoundRobinDeliverableSections({
            cfg,
            transcript: this.transcript,
            actualRounds: this.round,
          });
          const dirCtx = readDirective(cfg);
          const subtitleBase = `${cfg.agentCount} agent${cfg.agentCount === 1 ? "" : "s"} across ${this.round}/${cfg.rounds} round${cfg.rounds === 1 ? "" : "s"} (rotating dispositions)${this.earlyStopDetail ? " · early-stop" : ""}`;
          writeDeliverableAndEmit(
            {
              preset: "round-robin",
              runId: cfg.runId,
              clonePath: cfg.localPath,
              title: pickDeliverableTitle(dirCtx, {
                withDirective: "Round-robin: directive answer",
                withoutDirective: "Round-robin deliberation",
              }),
              subtitle: pickDeliverableSubtitle(dirCtx, subtitleBase),
              sections,
            },
            { transcript: this.transcript, emit: this.opts.emit },
          );
          // T2.2 (2026-05-04): opt-in wrap-up apply phase for plain
          // round-robin. Lead (agent-1) doubles as implementer.
          const lead = this.opts.manager.list().find((a) => a.index === 1);
          if (lead) {
            await maybeRunWrapUpApply({
              cfg,
              presetName: "round-robin",
              agent: lead,
              manager: this.opts.manager,
              repos: this.opts.repos,
              emit: this.opts.emit,
              appendSystem: (text) => this.appendSystem(text),
            });
          }
        } catch (err) {
          this.appendSystem(
            `[T1.1] Round-robin deliverable write failed (${err instanceof Error ? err.message : String(err)}); transcript still has the synthesis bubble.`,
          );
        }
      }

      // 2026-05-02 (role-diff improvement #4): portable deliverable for
      // role-diff. Pulls each role's latest `### MY DELIVERABLE` block
      // + the synthesis text into a PR-shaped markdown file. Fires for
      // every role-diff run that wasn't user-stopped or crashed,
      // including early-stop convergence runs (the synthesis already
      // wrote — we just compose around it). Best-effort; failure
      // doesn't block the rest of the close-out.
      if (this.roles && !this.stopping && cfg.runId) {
        try {
          const sections = buildRoleDiffDeliverableSections({
            userDirective: cfg.userDirective,
            roles: this.roles,
            agentCount: cfg.agentCount,
            transcript: this.transcript,
          });
          // 2026-05-03 (Phase A): directive helpers extracted to shared module.
          const dirCtx = readDirective(cfg);
          const subtitleBase = dirCtx.hasDirective
            ? `${cfg.agentCount} specialists across ${this.round}/${cfg.rounds} rounds`
            : `${cfg.agentCount} reviewers across ${this.round}/${cfg.rounds} rounds — open repo analysis`;
          writeDeliverableAndEmit(
            {
              preset: "role-diff",
              runId: cfg.runId,
              clonePath: cfg.localPath,
              title: pickDeliverableTitle(dirCtx, {
                withDirective: "Role-diff specialist deliverable",
                withoutDirective: "Role-diff repo audit",
              }),
              subtitle: pickDeliverableSubtitle(dirCtx, subtitleBase),
              sections,
            },
            { transcript: this.transcript, emit: this.opts.emit },
          );
          // T2.2 (2026-05-04): opt-in wrap-up apply phase for role-diff.
          // Synthesis lead (agent-1) doubles as implementer.
          const lead = this.opts.manager.list().find((a) => a.index === 1);
          if (lead) {
            await maybeRunWrapUpApply({
              cfg,
              presetName: "role-diff",
              agent: lead,
              manager: this.opts.manager,
              repos: this.opts.repos,
              emit: this.opts.emit,
              appendSystem: (text) => this.appendSystem(text),
            });
          }
        } catch (err) {
          this.appendSystem(
            `[role-diff #4] Deliverable write failed (${err instanceof Error ? err.message : String(err)}); transcript still has the synthesis bubble.`,
          );
        }
      }

      if (!this.stopping) this.appendSystem("Discussion complete.");
    } catch (err) {
      crashMessage = err instanceof Error ? err.message : String(err);
      this.opts.emit({ type: "error", message: crashMessage });
    } finally {
      // 2026-05-03 (Phase D): finally close-out extracted to shared helper.
      // RoundRobin's role-diff path's deliverable was already written
      // earlier in the try-block (gated on this.roles + runId), so the
      // helper here just handles reflection + summary + killAll + setPhase.
      await runDiscussionCloseOut({
        cfg,
        crashMessage,
        stopping: this.stopping,
        earlyStopDetail: this.earlyStopDetail,
        round: this.round,
        currentPhase: this.phase,
        manager: this.opts.manager,
        appendSystem: (text) => this.appendSystem(text),
        setPhase: (p) => this.setPhase(p),
        writeSummary: () => this.writeSummary(cfg, crashMessage),
        hooks: {
          pickReflectionAgent: (m) => m.list().find((a) => a.index === 1) ?? null,
          buildReflectionContext: (s) =>
            `${cfg.preset} preset · ${cfg.agentCount} agents · ran ${s.round}/${cfg.rounds} rounds${s.earlyStopDetail ? ` · early-stop: ${s.earlyStopDetail}` : ""}`,
        },
      });
    }
  }

  // Unit 33: shared summary writer. Called once from the loop's finally
  // regardless of termination cause (completed / user-stop / crash).
  // summaryWritten guards against a double-write if stop() races the
  // natural completion path.
  private async writeSummary(cfg: RunConfig, crashMessage?: string): Promise<void> {
    if (this.summaryWritten) return;
    this.summaryWritten = true;
    if (this.startedAt === undefined) return; // never reached discussing
    // 2026-05-03 (Phase C): writeSummary body extracted to shared helper.
    await discussionWriteSummary({
      cfg,
      crashMessage,
      stopping: this.stopping,
      startedAt: this.startedAt,
      earlyStopDetail: this.earlyStopDetail,
      agentCount: cfg.agentCount,
      agents: this.stats.buildPerAgentStats(),
      transcript: this.transcript,
      topology: cfg.topology,
      repos: this.opts.repos,
      appendSystem: (text, summary) => this.appendSystem(text, summary),
    });
  }

  private async runTurn(agent: Agent, round: number, totalRounds: number): Promise<void> {
    this.turnsTaken += 1; // 2026-05-02 (improvement #1): drive disposition rotation
    this.opts.manager.markStatus(agent.id, "thinking");
    this.emitAgentState({ id: agent.id, index: agent.index, port: agent.port, sessionId: agent.sessionId, status: "thinking", thinkingSince: Date.now() });
    // Unit 33: one turn = one call to runTurn (retries inside
    // promptWithRetry don't bump this; onTiming counts those separately).
    this.stats.countTurn(agent.id);

    const prompt = this.buildPrompt(agent, round, totalRounds);
    // T193 (2026-05-04): per-disposition model routing. When
    // cfg.dispositionModels[<disposition>] is set, override the
    // agent's spawn-time model for THIS turn. Skipped when role-diff
    // is active (roles ARE the specialization). Skipped on first
    // call (turnsTaken not yet incremented past 0).
    let modelOverride: string | undefined;
    if (!this.roles && this.active?.dispositionModels) {
      const turnNumber = this.turnsTaken;
      const disp = pickNextDisposition(this.transcript, turnNumber);
      const key = disp.name.toLowerCase().replace(/[ -]/g, "-") as
        | "critic"
        | "synthesizer"
        | "gap-finder"
        | "builder";
      const mapped = this.active.dispositionModels[key];
      if (mapped && mapped.trim().length > 0) {
        modelOverride = mapped.trim();
      }
    }
    // 2026-04-27: SSE-aware watchdog. Replaces the wall-clock 4-min cap
    // that killed prompts the model was actively producing. The old
    // comment claimed "OpenCode's SSE stays completely silent" — that
    // was true before the #170 SSE auth fix; SSE chunks now flow
    // reliably and AgentManager.getLastActivity tracks them. See
    // sseAwareTurnWatchdog.
    const controller = new AbortController();
    const watchdog = startSseAwareTurnWatchdog({
      manager: this.opts.manager,
      sessionId: agent.sessionId,
      controller,
      abortSession: async () => {},
    });

    try {
      // Unit 16: shared retry wrapper. Same retry semantics as
      // BlackboardRunner — UND_ERR_HEADERS_TIMEOUT and friends get up
      // to 3 attempts with [4s, 16s] backoff before giving up.
      // T194 (2026-05-04): per-role tool grants. When the active
      // role declares a profile (Tester=swarm-builder for bash;
      // Security=swarm-builder for dep queries), use it; else
      // default to "swarm-read". Skipped for plain round-robin
      // (no role) which uses swarm-read unconditionally.
      const role = this.roles ? roleForAgent(agent.index, this.roles) : null;
      const roleProfile: "swarm-read" | "swarm-builder" | "swarm" =
        role?.profile ?? "swarm-read";
      const res = await promptWithRetry(agent, prompt, {
        signal: controller.signal,
        manager: this.opts.manager,
        onTokens: ({ promptTokens, responseTokens }) => this.stats.recordTokens(agent.id, promptTokens, responseTokens),
        // T194: per-role profile (defaults to swarm-read).
        agentName: roleProfile,
        // Phase 5b of #243: per-agent addendum from the topology row.
        promptAddendum: getAgentAddendum(this.active?.topology, agent.index),
        describeError: (e) => describeSdkError(e),
        // T193 (2026-05-04): per-disposition model override.
        ...(modelOverride ? { modelOverride } : {}),
        onTiming: ({ attempt, elapsedMs, success }) => {
          this.stats.onTiming(agent.id, success, elapsedMs);
          this.opts.logDiag?.({
            type: "_prompt_timing",
            preset: this.active?.preset,
            agentId: agent.id,
            agentIndex: agent.index,
            attempt,
            elapsedMs,
            success,
            // Task #104: prompt-size to correlate with elapsedMs.
            promptChars: prompt.length,
            round,
          });
          // Improvement #4: per-agent first-prompt cold-start logging.
          this.opts.manager.recordPromptComplete(agent.id, { attempt, elapsedMs, success });
          // Unit 40: live-stream latency samples over WS so the UI can
          // render a sparkline tooltip on the thinking ticker.
          this.opts.emit({
            type: "agent_latency_sample",
            agentId: agent.id,
            agentIndex: agent.index,
            attempt,
            elapsedMs,
            success,
            ts: Date.now(),
          });
        },
        onRetry: ({ attempt, max, reasonShort, delayMs }) => {
          this.stats.onRetry(agent.id);
          this.appendSystem(
            `[${agent.id}] transport error (${reasonShort}) — retry ${attempt}/${max} in ${Math.round(delayMs / 1000)}s`,
          );
          this.opts.manager.markStatus(agent.id, "retrying", {
            retryAttempt: attempt,
            retryMax: max,
            retryReason: reasonShort,
          });
          this.emitAgentState({
            id: agent.id,
            index: agent.index,
            port: agent.port,
            sessionId: agent.sessionId,
            status: "retrying",
            retryAttempt: attempt,
            retryMax: max,
            retryReason: reasonShort,
          });
        },
      });

      const diagCtx = {
        runner: "round-robin",
        agentId: agent.id,
        agentIndex: agent.index,
        logDiag: this.opts.logDiag,
      };
      const extracted = extractTextWithDiag(res, diagCtx);
      let text = extracted.text;
      // Task #117: response-side breakdown for latency RCA. Logged
      // per-turn so analysis can correlate (agentIndex, round) with
      // the same-key _prompt_timing record. Captures FIRST attempt's
      // breakdown — retries are visible separately via the timing log.
      const breakdown = extractResponseBreakdown(res);
      this.opts.logDiag?.({
        type: "_response_breakdown",
        preset: this.active?.preset,
        agentId: agent.id,
        agentIndex: agent.index,
        round,
        ...breakdown,
      });
      // Task #54: retry on model silence (see CouncilRunner for detail).
      // Pattern 8: retry on junk-short single-token output too.
      if ((extracted.isEmpty || looksLikeJunk(text)) && !this.stopping) {
        const retryText = await retryEmptyResponse(agent, prompt, "swarm-read", diagCtx);
        if (retryText !== null) text = retryText;
      }
      // Task #115: track Pattern 8 stuck-loop, warn on threshold.
      trackPostRetryJunk(text, {
        agentId: agent.id,
        recordJunkPostRetry: (id, j) => this.stats.recordJunkPostRetry(id, j),
        appendSystem: (msg) => this.appendSystem(msg),
      });
      // #230: strip <think> + XML pseudo-tool-call markers first.
      const stripped = stripAgentText(text);
      const entry: TranscriptEntry = {
        id: randomUUID(),
        role: "agent",
        agentId: agent.id,
        agentIndex: agent.index,
        text: stripped.finalText || "(empty response)",
        ts: Date.now(),
        ...(stripped.thoughts.length > 0 ? { thoughts: stripped.thoughts } : {}),
        ...(stripped.toolCalls.length > 0 ? { toolCalls: stripped.toolCalls } : {}),
      };
      this.transcript.push(entry);
      this.opts.emit({ type: "transcript_append", entry });
      this.opts.emit({ type: "agent_streaming_end", agentId: agent.id });
      this.opts.manager.markStatus(agent.id, "ready", { lastMessageAt: entry.ts });
      this.emitAgentState({ id: agent.id, index: agent.index, port: agent.port, sessionId: agent.sessionId, status: "ready", lastMessageAt: entry.ts });
    } catch (err) {
      const msg = watchdog.getAbortReason() ?? describeSdkError(err);
      this.appendSystem(`[${agent.id}] error: ${msg}`);
      this.opts.emit({ type: "agent_streaming_end", agentId: agent.id });
      this.opts.manager.markStatus(agent.id, "failed", { error: msg });
      this.emitAgentState({ id: agent.id, index: agent.index, port: agent.port, sessionId: agent.sessionId, status: "failed", error: msg });
    } finally {
      watchdog.cancel();
    }
  }

  // Phase B (Task #100): role-diff synthesis pass. Mirrors the
  // council #79 pattern — agent-1 takes every role's findings and
  // produces a cross-role consolidation. Same prompt also asks for
  // a CONVERGENCE: high|medium|low signal (parsed for the early-stop
  // 2026-05-02 (round-robin improvement #3): semantic convergence
  // check. Compares the LAST agent's turn this round to the SAME
  // agent's turn last round. When >0.85 cosine similar (or 0.7 Jaccard
  // when embedding unavailable), the discussion has settled. Pure
  // server-side check — no LLM call required (just an embed call when
  // semantic path fires). Best-effort: returns false on any failure
  // so the loop continues.
  private async checkStructuredConvergence(): Promise<boolean> {
    const agents = this.opts.manager.list();
    if (agents.length === 0) return false;
    // The last agent's turn this round vs last round.
    const agentEntries = this.transcript.filter(
      (e) => e.role === "agent" && e.agentIndex === agents[agents.length - 1].index,
    );
    if (agentEntries.length < 2) return false;
    const current = agentEntries[agentEntries.length - 1].text;
    const prior = agentEntries[agentEntries.length - 2].text;
    if (!current || !prior) return false;
    const ollamaBaseUrl = this.opts.ollamaBaseUrl;
    if (ollamaBaseUrl) {
      const semantic = await detectSemanticConvergence({
        prior,
        current,
        ollamaBaseUrl,
        threshold: 0.85,
      });
      if (semantic !== null) {
        this.appendSystem(
          `[improvement #3] Convergence check: embedding cosine=${semantic.similarity.toFixed(3)} (threshold ${semantic.threshold.toFixed(3)})`,
        );
        return semantic.converged;
      }
    }
    // Fallback: Jaccard when embedding model unavailable
    const verdict = detectJaccardConvergence(prior, current, 0.7);
    this.appendSystem(
      `[improvement #3] Convergence check (Jaccard fallback): jaccard=${verdict.similarity.toFixed(3)} (threshold ${verdict.threshold})`,
    );
    return verdict.converged;
  }

  // 2026-05-02 (round-robin improvement #4): final synthesis pass for
  // the no-roles structured-deliberation case. Mirrors the role-diff
  // version but uses buildStructuredSynthesisPrompt + tags as
  // role_diff_synthesis (existing summary kind — UI rendering applies
  // identically; could add a dedicated kind in a follow-up).
  private async runStructuredSynthesisPass(
    cfg: RunConfig,
  ): Promise<"high" | "medium" | "low" | null> {
    const agents = this.opts.manager.list();
    const lead = agents.find((a) => a.index === 1);
    if (!lead) return null;
    if (this.stopping) return null;
    this.opts.manager.markStatus(lead.id, "thinking");
    this.emitAgentState({
      id: lead.id,
      index: lead.index,
      port: lead.port,
      sessionId: lead.sessionId,
      status: "thinking",
      thinkingSince: Date.now(),
    });
    this.stats.countTurn(lead.id);
    this.appendSystem(`[improvement #4] Synthesizing structured deliberation (agent-${lead.index})…`);
    const prompt = buildStructuredSynthesisPrompt(cfg.rounds, this.transcript, cfg.userDirective);
    const controller = new AbortController();
    const watchdog = startSseAwareTurnWatchdog({
      manager: this.opts.manager,
      sessionId: lead.sessionId,
      controller,
      abortSession: async () => {},
    });
    try {
      const res = (await promptWithRetry(lead, prompt, {
        signal: controller.signal,
        manager: this.opts.manager,
        onTokens: ({ promptTokens, responseTokens }) => this.stats.recordTokens(lead.id, promptTokens, responseTokens),
        agentName: "swarm-read",
        promptAddendum: getAgentAddendum(this.active?.topology, lead.index),
        describeError: (e) => describeSdkError(e),
      })) as { data: { parts: Array<{ type: "text"; text: string }> } };
      const text = (res?.data?.parts?.find((p) => p.type === "text")?.text ?? "").trim();
      if (text.length === 0) {
        this.appendSystem(`[improvement #4] Synthesis returned empty response; skipping.`);
        return null;
      }
      const stripped = stripAgentText(text);
      const entry: TranscriptEntry = {
        id: randomUUID(),
        role: "agent",
        agentId: lead.id,
        agentIndex: lead.index,
        text: stripped.finalText || "(empty response)",
        ts: Date.now(),
        // Tag with the existing role_diff_synthesis kind so the UI
        // renders distinctively. role_diff_synthesis was the natural
        // home; the disposition rotation is the structured-deliberation
        // analog of role-diff's specialized roles. Could add a
        // dedicated kind later.
        summary: { kind: "role_diff_synthesis", rounds: cfg.rounds, roles: 0 },
        ...(stripped.thoughts.length > 0 ? { thoughts: stripped.thoughts } : {}),
        ...(stripped.toolCalls.length > 0 ? { toolCalls: stripped.toolCalls } : {}),
      };
      this.transcript.push(entry);
      this.opts.emit({ type: "transcript_append", entry });
      // 2026-05-03 (Phase A): convergence parser unified to shared module.
      // The synthesis-pass path historically used a looser scanner (anywhere
      // in text, not just trailing lines) so we keep that behavior here via
      // parseConvergenceSignalLoose. The role-diff path below uses the strict
      // trailing-3-lines parser via parseConvergenceSignal.
      return parseConvergenceSignalLoose(text);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.appendSystem(`[improvement #4] Synthesis prompt failed (${msg})`);
      return null;
    } finally {
      watchdog.cancel();
      this.opts.manager.markStatus(lead.id, "ready");
      this.emitAgentState({
        id: lead.id,
        index: lead.index,
        port: lead.port,
        sessionId: lead.sessionId,
        status: "ready",
      });
    }
  }

  // detector). Tagged "role_diff_synthesis" so the modal can render
  // it distinctively.
  private async runRoleDiffSynthesisPass(
    cfg: RunConfig,
  ): Promise<"high" | "medium" | "low" | null> {
    if (!this.roles) return null;
    const agents = this.opts.manager.list();
    const lead = agents.find((a) => a.index === 1);
    if (!lead) return null;
    this.opts.manager.markStatus(lead.id, "thinking");
    this.emitAgentState({
      id: lead.id,
      index: lead.index,
      port: lead.port,
      sessionId: lead.sessionId,
      status: "thinking",
      thinkingSince: Date.now(),
    });
    this.stats.countTurn(lead.id);
    this.appendSystem(`Synthesizing role-diff findings (agent-${lead.index})…`);

    const prompt = buildRoleDiffSynthesisPrompt(this.roles, this.transcript);
    // 2026-04-27: SSE-aware watchdog (see startSseAwareTurnWatchdog).
    const controller = new AbortController();
    const watchdog = startSseAwareTurnWatchdog({
      manager: this.opts.manager,
      sessionId: lead.sessionId,
      controller,
      abortSession: async () => {},
    });
    try {
      const res = await promptWithRetry(lead, prompt, {
        signal: controller.signal,
        manager: this.opts.manager,
        onTokens: ({ promptTokens, responseTokens }) => this.stats.recordTokens(lead.id, promptTokens, responseTokens),
        agentName: "swarm-read",
        // Phase 5b of #243: per-agent addendum from the topology row.
        promptAddendum: getAgentAddendum(this.active?.topology, lead.index),
        describeError: (e) => describeSdkError(e),
        onTiming: ({ attempt, elapsedMs, success }) => {
          this.stats.onTiming(lead.id, success, elapsedMs);
          this.opts.manager.recordPromptComplete(lead.id, { attempt, elapsedMs, success });
          this.opts.emit({
            type: "agent_latency_sample",
            agentId: lead.id,
            agentIndex: lead.index,
            attempt,
            elapsedMs,
            success,
            ts: Date.now(),
          });
        },
        onRetry: ({ attempt, max, reasonShort, delayMs }) => {
          this.stats.onRetry(lead.id);
          this.appendSystem(
            `[${lead.id}] transport error (${reasonShort}) — retry ${attempt}/${max} in ${Math.round(delayMs / 1000)}s`,
          );
        },
      });
      const diagCtx = {
        runner: "role-diff",
        agentId: lead.id,
        agentIndex: lead.index,
        logDiag: this.opts.logDiag,
      };
      const extracted = extractTextWithDiag(res, diagCtx);
      let text = extracted.text;
      if ((extracted.isEmpty || looksLikeJunk(text)) && !this.stopping) {
        const retryText = await retryEmptyResponse(lead, prompt, "swarm-read", diagCtx);
        if (retryText !== null) text = retryText;
      }
      // Task #115: track Pattern 8 stuck-loop, warn on threshold.
      trackPostRetryJunk(text, {
        agentId: lead.id,
        recordJunkPostRetry: (id, j) => this.stats.recordJunkPostRetry(id, j),
        appendSystem: (msg) => this.appendSystem(msg),
      });
      // Task #108: defensive guard — see CouncilRunner.runSynthesisPass.
      const isJunkSynthesis = looksLikeJunk(text) || extracted.isEmpty;
      // #230: strip <think> + XML pseudo-tool-call markers first.
      const strippedSyn = stripAgentText(text);
      const entry: TranscriptEntry = {
        id: randomUUID(),
        role: "agent",
        agentId: lead.id,
        agentIndex: lead.index,
        text: strippedSyn.finalText || "(empty response)",
        ts: Date.now(),
        summary: isJunkSynthesis
          ? undefined
          : { kind: "role_diff_synthesis", rounds: cfg.rounds, roles: this.roles.length },
        ...(strippedSyn.thoughts.length > 0 ? { thoughts: strippedSyn.thoughts } : {}),
        ...(strippedSyn.toolCalls.length > 0 ? { toolCalls: strippedSyn.toolCalls } : {}),
      };
      this.transcript.push(entry);
      this.opts.emit({ type: "transcript_append", entry });
      if (isJunkSynthesis) {
        this.appendSystem(
          `[${lead.id}] role-diff synthesis text is degenerate (${text.length} chars) — kept in transcript but NOT tagged as canonical synthesis.`,
        );
        return null;
      }
      return parseConvergenceSignal(text);
    } catch (err) {
      this.appendSystem(
        `[${lead.id}] role-diff synthesis failed (${err instanceof Error ? err.message : String(err)}); skipping consolidation.`,
      );
      return null;
    } finally {
      watchdog.cancel();
      this.opts.manager.markStatus(lead.id, "ready");
      this.emitAgentState({
        id: lead.id,
        index: lead.index,
        port: lead.port,
        sessionId: lead.sessionId,
        status: "ready",
        lastMessageAt: Date.now(),
      });
    }
  }

  private buildPrompt(agent: Agent, round: number, totalRounds: number): string {
    // 2026-05-02 (round-robin improvement #1): rotating dispositions
    // when NO roles configured. Lifts plain round-robin out of "neutral
    // baseline" by assigning each turn a deliberate LENS — critic /
    // synthesizer / gap-finder / builder. Forces value-add per turn:
    // no two consecutive turns can be the same character. Skipped when
    // role-diff is active (roles ARE the specialization).
    const turnNumber = this.turnsTaken; // pre-increment in caller
    // T185 (2026-05-04): voted-next disposition. Reads votes from the
    // last 4 agent turns; falls back to mechanical rotation when
    // votes are absent or tied. First turn (no prior votes) always
    // mechanical.
    const disposition = !this.roles
      ? pickNextDisposition(this.transcript, turnNumber)
      : null;
    const transcriptText = this.transcript
      .map((e) => {
        if (e.role === "system") return `[SYSTEM] ${e.text}`;
        if (e.role === "user") return `[HUMAN] ${e.text}`;
        const label = this.roles
          ? `Agent ${e.agentIndex} (${roleForAgent(e.agentIndex ?? 1, this.roles).name})`
          : `Agent ${e.agentIndex}`;
        return `[${label}] ${e.text}`;
      })
      .join("\n\n");

    const role = this.roles ? roleForAgent(agent.index, this.roles) : null;
    const header = role
      ? `You are Agent ${agent.index} in a swarm of collaborating AI engineers reviewing a cloned GitHub project. Your role is "${role.name}".`
      : disposition
        ? `You are Agent ${agent.index} in a structured deliberation. This turn, you take the **${disposition.name}** disposition.`
        : `You are Agent ${agent.index} in a swarm of collaborating AI engineers reviewing a cloned GitHub project.`;
    const roleGuidance = role ? [`As the ${role.name}: ${role.guidance}`, ""] : [];
    // 2026-05-02 (improvement #5): user directive injected into every
    // turn. Placed BEFORE the disposition block so each disposition
    // is explicitly applied to the directive (Critic critiques peers'
    // take on it, Builder proposes a next step toward it, etc.).
    // 2026-05-03 (Phase A): directive helpers extracted to shared module.
    const dirCtx = readDirective({ userDirective: this.active?.userDirective });
    const directiveBlock = buildDirectiveBlock(dirCtx, {
      labelSuffix: "(the question this deliberation must resolve)",
    });
    const directive = dirCtx.directive;
    // 2026-05-02 (improvement #1 + #2): disposition framing + active-
    // disagreement backbone. Both omitted when role-diff is active
    // (roles ARE the specialization).
    const dispositionBlock = disposition
      ? [
          `**${disposition.name.toUpperCase()} disposition this turn:** ${disposition.framing}`,
          "",
          "**ACTIVE-DISAGREEMENT RULE (every turn):** You MUST do at least ONE of: (a) challenge a specific prior point with reasoning, (b) add a NEW dimension peers haven't named, or (c) call out a real tradeoff being glossed. Never just agree or restate. If you have nothing to push on, say so explicitly + name what's still unclear.",
          "",
          // T185 (2026-05-04): voted-next disposition. End your turn
          // with a one-line vote on what disposition is needed NEXT.
          // Runner aggregates votes from the last N turns to pick the
          // next disposition; majority wins, tie/none → mechanical
          // rotation falls back. Lets the discussion adapt to what
          // it actually needs (more Critic when claims pile up; more
          // Gap-finder when nobody's surfacing what's missing).
          "**NEXT-DISPOSITION VOTE (every turn):** End your response with a one-line vote on what should come NEXT. Format:",
          "    NEXT-DISPOSITION VOTE: critic|synthesizer|gap-finder|builder — <one-line why>",
          "Vote based on what the discussion needs, not what's mechanically next. If everyone keeps voting the same lens, the runner will keep firing it until the need shifts.",
          "",
        ]
      : [];

    // 2026-05-02 (role-diff improvement #3): per-role concrete-deliverable
    // contract. Every role MUST end its turn with a `### MY DELIVERABLE`
    // block — not commentary, but the role's piece of the actual answer.
    // Implementer lists file changes; Tester lists assertions; etc.
    // The deliverable artifact (#4) extracts these blocks per-role to
    // assemble a portable PR-shaped doc. Without this contract role-diff
    // produces 7 commentaries; with it, 7 specialists each own one piece
    // of one answer.
    const deliverableBlock = role
      ? [
          "**MY DELIVERABLE CONTRACT (every turn, role-diff):** End your prose with a `### MY DELIVERABLE` heading followed by your role's concrete contribution.",
          role.deliverableHint
            ? `For your role (${role.name}): ${role.deliverableHint}`
            : `For your role (${role.name}): a concrete contribution toward the directive — not commentary on it.`,
          "Even if your role's piece doesn't change this round, write what your CURRENT best answer is — peers and the synthesis lead read this block, not your prose.",
          "",
          // T186 (2026-05-04): cross-role peer review (R2+ only — R1
          // has no peer turns yet). Before writing your own output,
          // pick ONE peer role's last deliverable and react to it
          // (build / push back / refine). Surfaces blind spots within
          // the run instead of waiting for synthesis to catch them.
          ...(round >= 2
            ? [
                "**CROSS-ROLE PEER REVIEW (R2+):** BEFORE your `### MY DELIVERABLE` block, write:",
                "    ### PEER REVIEW",
                "    Reviewing: <Role X's deliverable from round R-1>",
                "    Reaction: <BUILD ON: <one line>> | <PUSH BACK: <one line + grounding>> | <NEEDS WORK: <what's missing>>",
                "Pick a peer whose stance you can engage substantively — not your own role. Be specific; ground reactions in file paths or peer's claims when possible.",
                "",
              ]
            : []),
        ]
      : [];

    return [
      header,
      `This is discussion round ${round} of ${totalRounds}. (Total turns so far: ${turnNumber}.)`,
      ...roleGuidance,
      ...directiveBlock,
      ...dispositionBlock,
      ...deliverableBlock,
      "Your working directory IS the project clone — use file-read, grep, and find-files tools to inspect it.",
      // Task #118: hard tool-use requirement. Run daf5c92e showed
      // role-diff agents NEVER invoked file-read tools (0 tool calls
      // across 8 turns) — they were guessing from filenames in the
      // seed snapshot. Without file grounding, role-diff degenerates
      // to filename-trivia. The "REQUIRED" framing mirrors the OW
      // lead-grounding rule (#83) that fixed the same problem there.
      "REQUIRED — BEFORE writing your prose response:",
      "  1. Use the `read` tool on AT LEAST ONE file from the repo. Pick a file relevant to your role (e.g. Architect → README.md or main entry point; Tester → a test file; Security → auth/config; Performance → hot-path code).",
      "  2. If a peer in the transcript cited a specific file path you haven't seen, read THAT file before agreeing or pushing back.",
      "  3. If your prior turn made a claim about file contents, re-verify with a tool call before defending or revising the claim.",
      "Failing to make at least one tool call means your turn is uninformed and will be flagged as such by reviewers.",
      "",
      "Round 1: skim README.md and the top-level tree before opining. Later rounds: read the specific files needed to verify peer claims.",
      "Keep responses under ~250 words. Be specific. Cite file paths (e.g. `src/foo.ts:42`) when you reference code.",
      "You may @mention another agent (e.g. @Agent2) to address them directly.",
      "",
      ...(directive.length > 0
        ? role
          ? [
              "Goals of this deliberation:",
              "1. Read the repo just enough to ground your role's deliverable in real code (not filename guesses).",
              `2. Through your role (${role.name}), produce YOUR specialist piece of the directive's answer. Other roles handle the other pieces — focus on yours.`,
              "3. By the final round the team should have converged on a coherent answer to the directive built from each role's deliverable, with the synthesis lead consolidating.",
              "",
            ]
          : [
              "Goals of this deliberation:",
              "1. Read the repo just enough to ground your take on the directive in real code (not filename guesses).",
              "2. Through your assigned disposition, advance the team's answer to the directive — challenge a peer's framing of it, surface what they're missing about it, or propose a concrete step toward it.",
              "3. By the final round the team should have converged on: a clear plan for the directive, what's risky about it, and what the next concrete step is.",
              "",
            ]
        : [
            "Goals of this discussion:",
            "1. Figure out what this project is and who it is for.",
            "2. Identify what is working and what is missing.",
            "3. Propose one concrete next action the swarm should take.",
            "",
          ]),
      "=== SHARED TRANSCRIPT ===",
      transcriptText || "(empty — you are first to speak)",
      "=== END TRANSCRIPT ===",
      "",
      role
        ? `Now respond as Agent ${agent.index} (${role.name}), through the lens of your role. Tool-call first, then prose, then your \`### MY DELIVERABLE\` block.`
        : `Now respond as Agent ${agent.index}. Tool-call first, then prose.`,
    ].join("\n");
  }

  private appendSystem(text: string, summary?: TranscriptEntrySummary): void {
    const entry: TranscriptEntry = { id: randomUUID(), role: "system", text, ts: Date.now(), summary };
    this.transcript.push(entry);
    this.opts.emit({ type: "transcript_append", entry });
  }

  private setPhase(phase: SwarmPhase): void {
    this.phase = phase;
    this.opts.emit({ type: "swarm_state", phase, round: this.round });
  }

  private emitAgentState(s: AgentState): void {
    // thinkingSince REST-snapshot fix: route through the manager so
    // the agentStates mirror gets updated in lockstep with the WS
    // broadcast. See AgentManager.recordAgentState.
    this.opts.manager.recordAgentState(s);
  }


}

// Phase B (Task #100): role-diff synthesis prompt. Same shape as
// the council synthesis (#79) — labeled cross-role table, not a
// re-summary of each agent's draft. The CONVERGENCE: line at the
// end is the early-stop signal (same parser pattern as council #99).
// 2026-05-02 (round-robin improvement #1): rotating dispositions for
// the structured deliberation framework. When NO roles are configured,
// each turn cycles through these four lenses — every turn deliberately
// adds a distinct kind of value, no two consecutive turns can be the
// same character.
//
// Calibrated to a small fixed set: 4 dispositions covers the most
// useful axes of deliberation (push back / consolidate / surface gaps /
// move forward). More dispositions would dilute; fewer wouldn't cycle
// before agents repeat themselves.
export interface RoundRobinDisposition {
  name: string;
  framing: string;
}

export const DISPOSITIONS: readonly RoundRobinDisposition[] = [
  {
    name: "Critic",
    framing:
      "Find weaknesses in what's been said. Cite the specific claim you're challenging + your reason. Don't be contrary for its own sake — name the gap or unfounded assumption.",
  },
  {
    name: "Synthesizer",
    framing:
      "Distill what peers AGREED on (consensus) and what they DISAGREED on (open tradeoffs). Cite who said what. Surface 1-2 sentences that capture the current state of the discussion.",
  },
  {
    name: "Gap-finder",
    framing:
      "Name what HASN'T been addressed yet. What did the directive ask for that no peer has touched? What perspective (security, performance, ergonomics, cost) is missing? Cite specifics, not generalities.",
  },
  {
    name: "Builder",
    framing:
      "Propose ONE concrete next action the team should take. Name files to touch, decisions to make, or experiments to run. Be specific enough that a peer could execute on it. Build on what's been said; don't restart.",
  },
];

/** Pure helper — get the disposition for a 1-indexed turn number.
 *  Cycles through DISPOSITIONS in order. Pure — exported for tests. */
export function getDispositionForTurn(turnNumber: number): RoundRobinDisposition {
  const idx = ((turnNumber - 1) % DISPOSITIONS.length + DISPOSITIONS.length) % DISPOSITIONS.length;
  return DISPOSITIONS[idx];
}

// T185 (2026-05-04): voted-next disposition. Each agent ends their
// turn with `NEXT-DISPOSITION VOTE: <name> — <reason>`. Runner
// aggregates the last few votes to pick the next disposition; falls
// back to mechanical rotation when votes are absent or tied.

/** Parse a NEXT-DISPOSITION VOTE line out of an agent's text. Returns
 *  null when no recognizable vote is present. Tolerant to whitespace,
 *  case, and the trailing reason. */
export function extractDispositionVote(text: string | undefined): string | null {
  if (!text) return null;
  // Match "NEXT-DISPOSITION VOTE: <name>" with the name being one of
  // the disposition names (case-insensitive). Allow "next disposition vote"
  // too (model may drop the hyphen).
  const m = text.match(
    /NEXT[- ]DISPOSITION\s+VOTE\s*:\s*(critic|synthesizer|gap-?finder|builder)\b/i,
  );
  if (!m) return null;
  // Normalize gap-finder vs gapfinder.
  const raw = m[1]!.toLowerCase().replace(/-?finder/, "-finder");
  return raw;
}

/** Pick the next disposition based on votes from the last `lookback`
 *  agent turns. Returns the disposition that won the most votes;
 *  falls back to the mechanical rotation when no votes / tied votes /
 *  unrecognized vote names. Pure — exported for tests. */
export function pickNextDisposition(
  transcript: readonly TranscriptEntry[],
  fallbackTurnNumber: number,
  lookback: number = 4,
): RoundRobinDisposition {
  const recentAgentTurns = transcript
    .filter((e) => e.role === "agent")
    .slice(-lookback);
  const tally: Record<string, number> = {};
  for (const e of recentAgentTurns) {
    const vote = extractDispositionVote(e.text);
    if (!vote) continue;
    // Match against DISPOSITIONS catalog (lowercased name).
    const matchIdx = DISPOSITIONS.findIndex(
      (d) => d.name.toLowerCase().replace(/[ -]/g, "-") === vote,
    );
    if (matchIdx === -1) continue;
    const name = DISPOSITIONS[matchIdx]!.name;
    tally[name] = (tally[name] ?? 0) + 1;
  }
  // Pick the highest-vote disposition. Ties + no-votes → mechanical fallback.
  const entries = Object.entries(tally);
  if (entries.length === 0) return getDispositionForTurn(fallbackTurnNumber);
  entries.sort((a, b) => b[1] - a[1]);
  // Tied between top-2? Fall back to rotation rather than picking arbitrarily.
  if (entries.length >= 2 && entries[0]![1] === entries[1]![1]) {
    return getDispositionForTurn(fallbackTurnNumber);
  }
  const winner = DISPOSITIONS.find((d) => d.name === entries[0]![0]);
  return winner ?? getDispositionForTurn(fallbackTurnNumber);
}

// 2026-05-02 (round-robin improvement #4): structured-deliberation
// final synthesis. Mirrors buildRoleDiffSynthesisPrompt but for the
// no-roles structured-deliberation case. Lead distills the whole
// transcript into Consensus / Disagreements / Recommended next step.
export function buildStructuredSynthesisPrompt(
  totalRounds: number,
  transcript: readonly TranscriptEntry[],
  userDirective?: string,
): string {
  const transcriptText = transcript
    .map((e) => {
      if (e.role === "system") return `[SYSTEM] ${e.text}`;
      if (e.role === "user") return `[HUMAN] ${e.text}`;
      return `[Agent ${e.agentIndex}] ${e.text}`;
    })
    .join("\n\n");
  // 2026-05-02 (improvement #5): directive-aware synthesis. When a
  // directive is set the synthesis MUST answer it directly — adds a
  // dedicated "Answer to directive" section and reframes
  // "Recommended next step" as the next action toward the directive.
  // 2026-05-03 (Phase A): directive helpers extracted to shared module.
  const dirCtx = readDirective({ userDirective });
  const directiveBlock = buildDirectiveBlock(dirCtx, {
    labelSuffix: "(the question the team was deliberating)",
  });
  const structure = dirCtx.hasDirective
    ? [
        "STRUCTURE your response as:",
        "1. **Answer to directive** — direct response to the user's question / request. State what the team concluded, not how it deliberated.",
        "2. **Consensus** — what every agent agreed on while resolving the directive.",
        "3. **Disagreements** — where agents still hold different positions on the directive. Name the agents and their stances.",
        "4. **Cross-round flips** — positions that CHANGED between rounds (signal of weak ground; likely needs more evidence). Name the agent + the prior position + the new position. If no notable flips, say so explicitly.",
        "5. **Recommended next step** — ONE concrete next action toward the directive. Cite files / decisions / experiments. Build on the Builder-disposition turns.",
        "6. **Open questions** — anything the Gap-finder turns surfaced about the directive that the team didn't resolve.",
      ]
    : [
        "STRUCTURE your response as:",
        "1. **Consensus** — what every agent (including you) converged on. State as a direct claim, not a meta-observation.",
        "2. **Disagreements** — where agents still hold different positions. Name the agents and their stances.",
        "3. **Cross-round flips** — positions that CHANGED between rounds (signal of weak ground; likely needs more evidence). Name the agent + prior position + new position. If no notable flips, say so explicitly.",
        "4. **Recommended next step** — ONE concrete next action. Cite files / decisions / experiments. Build on the Builder-disposition turns from the discussion.",
        "5. **Open questions** — anything the Gap-finder turns surfaced that the team didn't resolve.",
      ];
  return [
    `You are Agent 1, the deliberation synthesis lead. The team just finished ${totalRounds} round${totalRounds === 1 ? "" : "s"} of structured deliberation across rotating dispositions (Critic / Synthesizer / Gap-finder / Builder).`,
    "Your job NOW is to produce a SINGLE consolidated answer that integrates the whole discussion.",
    "",
    ...directiveBlock,
    ...structure,
    "",
    "Keep under ~500 words. Be specific. Cite file paths when relevant.",
    "",
    "On the FINAL line of your response (no markdown, nothing after it), output exactly one of:",
    "  CONVERGENCE: high   — agents largely agree; further rounds would only restate consensus.",
    "  CONVERGENCE: medium — partial consensus with real open questions still in play.",
    "  CONVERGENCE: low    — significant unresolved disagreement; more rounds would help.",
    "",
    "=== FULL TRANSCRIPT ===",
    transcriptText,
    "=== END TRANSCRIPT ===",
    "",
    "Produce your synthesis now.",
  ].join("\n");
}

export function buildRoleDiffSynthesisPrompt(
  roles: readonly SwarmRole[],
  transcript: readonly TranscriptEntry[],
): string {
  const transcriptText = transcript
    .map((e) => {
      if (e.role === "system") return `[SYSTEM] ${e.text}`;
      if (e.role === "user") return `[HUMAN] ${e.text}`;
      const role =
        e.agentIndex !== undefined ? roleForAgent(e.agentIndex, roles) : null;
      const label = role
        ? `Agent ${e.agentIndex} (${role.name})`
        : `Agent ${e.agentIndex}`;
      return `[${label}] ${e.text}`;
    })
    .join("\n\n");
  const roleNames = roles.map((r) => r.name).join(", ");

  return [
    `You are Agent 1, the role-diff synthesis lead. The swarm just finished N rounds of discussion with agents wearing different roles: ${roleNames}.`,
    "Your job NOW is to produce a SINGLE consolidated cross-role view that integrates every role's findings.",
    "",
    "STRUCTURE your response as:",
    "1. **Cross-role agreement** — what every role independently flagged. State as direct claims, cite which role surfaced each (e.g. \"Architect + Tester both noted the absence of integration tests in src/api/\").",
    "2. **Role-specific findings** — one short bullet per role naming its single most important standalone observation that the others didn't make.",
    // T186 (2026-05-04): role-pair conflicts. Pre-T186 the synthesis
    // surfaced general "disagreements" but never explicitly RESOLVED
    // them. Now: name the specific role-pair, state both sides, then
    // PICK A SIDE with reasoning (or explicitly say "this is a real
    // ongoing tradeoff the user must decide"). Every conflict left
    // unresolved is a deferred decision.
    "3. **Role-pair conflicts (RESOLVE, don't just list)** — for each pair of roles pulling in opposite directions, render as:",
    "    `<Role A> vs <Role B>: <one-line claim from A> ↔ <one-line counter from B>`",
    "    `Resolution: <which side wins for this directive AND why> — OR — \"Real tradeoff: user decides\" with context for that decision.`",
    "    Common pairs to watch: Performance ↔ Security (caching vs staleness); Architect ↔ Implementer (clean shape vs ship-now); Tester ↔ Performance (coverage vs hot-path overhead). If no pairs conflicted, write `_no role-pair conflicts surfaced this run_`.",
    "4. **Next action** — ONE concrete next step grounded in the cross-role view AND the conflict resolutions above.",
    "",
    "Keep it under ~400 words. Cite file paths from the discussion. Do NOT just restate each role's draft — synthesize across them.",
    "",
    // Phase B (Task #100): convergence signal — same line shape as
    // CouncilRunner so any UI/parser pattern transfers.
    "On the FINAL line of your response (no markdown, nothing after it), output exactly one of:",
    "  CONVERGENCE: high   — roles largely agree; further rounds would only restate the cross-role view.",
    "  CONVERGENCE: medium — partial cross-role agreement with real open tensions still in play.",
    "  CONVERGENCE: low    — roles still pulling in different directions; more rounds would help.",
    "",
    "=== FULL ROLE-DIFF TRANSCRIPT ===",
    transcriptText,
    "=== END TRANSCRIPT ===",
    "",
    "Produce your synthesis now.",
  ].join("\n");
}

// Phase B (Task #100): scan a synthesis response for the
// "CONVERGENCE: high|medium|low" line. Mirrors parseCouncilConvergence
// in CouncilRunner.ts.
// 2026-05-03 (Phase A): both parsers consolidated into the shared
// `convergenceSignal.ts` module. This re-export preserves the legacy
// public name for external callers.
export { parseConvergenceSignal as parseRoleDiffConvergence } from "./convergenceSignal.js";

// 2026-05-04 (T1.1 universal deliverable): build deliverable sections
// for plain round-robin (no roles). Mirrors CouncilRunner's section
// shape: directive (if set), final synthesis, last-round per-agent
// turns. Quality augmentation (rubric/critic) is skipped — round-robin
// doesn't carry a derivedRubric — but next-actions extraction is
// always free (pure parser) so it still runs.
export function buildRoundRobinDeliverableSections(input: {
  cfg: { userDirective?: string; agentCount: number; rounds: number };
  transcript: readonly TranscriptEntry[];
  actualRounds: number;
}): Array<{ title: string; body: string }> {
  const dirCtx = readDirective(input.cfg);
  const sections: Array<{ title: string; body: string }> = [];

  // Directive section first when set, so the deliverable opens with
  // the question being answered.
  const directiveSection = maybeDirectiveSection(dirCtx);
  if (directiveSection) sections.push(directiveSection);

  // Final synthesis — written by runStructuredSynthesisPass right
  // before this helper runs. Tagged with summary.kind="role_diff_synthesis"
  // (the structured-deliberation case reuses that envelope).
  const synthesisEntry = [...input.transcript]
    .reverse()
    .find(
      (e) =>
        e.role === "agent" &&
        e.summary?.kind === "role_diff_synthesis" &&
        e.summary.roles === 0,
    );
  const synthesisText = synthesisEntry?.text.trim() ?? "";
  sections.push({
    title: pickAnswerSectionTitle(dirCtx, {
      withDirective: "Answer to directive",
      withoutDirective: "Final synthesis",
    }),
    body:
      synthesisText.length > 0
        ? synthesisText
        : "_(synthesis pass returned empty; transcript may have partial discussion)_",
  });

  // Per-agent last-round turns so the reader sees the disposition
  // rotation that produced the synthesis. Filter to the final round
  // only — full transcript would dwarf the synthesis.
  const finalRoundTurns: Array<{ agentIndex?: number; text: string }> = [];
  // The transcript has agent entries tagged by round via summary.kind=
  // "agent_turn"; without that, fall back to the last cfg.agentCount
  // agent entries (one per agent in the final round under round-robin).
  const agentEntries = input.transcript.filter((e) => e.role === "agent");
  const tail = agentEntries.slice(-input.cfg.agentCount);
  for (const e of tail) {
    finalRoundTurns.push({ agentIndex: e.agentIndex, text: e.text.trim() });
  }
  sections.push({
    title: `Round ${input.actualRounds} — final-round turns (rotating dispositions)`,
    body:
      finalRoundTurns.length > 0
        ? finalRoundTurns
            .map((t) => `### Agent ${t.agentIndex ?? "?"}\n\n${t.text}`)
            .join("\n\n")
        : "_(no final-round turns captured)_",
  });

  // Always-free next-actions extraction (pure parser) so the
  // deliverable lands with concrete recommendations the user can chase.
  const baseText = sections
    .map((s) => `## ${s.title}\n\n${s.body}`)
    .join("\n\n");
  const actions = extractNextActions(baseText);
  sections.push({
    title: "Next actions",
    body: formatNextActionsMarkdown(actions),
  });

  return sections;
}
