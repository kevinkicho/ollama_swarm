import { randomUUID } from "node:crypto";
import type { Agent } from "../services/AgentManager.js";

import { startSseAwareTurnWatchdog } from "./sseAwareTurnWatchdog.js";
import type {
  AgentState,
  SwarmEvent,
  SwarmPhase,
  SwarmStatus,
  TranscriptEntry,
  TranscriptEntrySummary,
} from "../types.js";
import type { RunConfig, RunnerOpts } from "./SwarmRunner.js";
import { DiscussionRunnerBase } from "./DiscussionRunnerBase.js";
import { roleForAgent, type SwarmRole } from "./roles.js";
import { promptWithRetry } from "./promptWithRetry.js";
import { promptWithFailoverAuto } from "./promptWithFailoverAuto.js";
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

import { stripAgentText } from "../../../shared/src/stripAgentText.js";
import { getAgentAddendum } from "../../../shared/src/topology.js";
import { describeSdkError } from "./sdkError.js";
import { writeDeliverableAndEmit } from "./deliverable.js";
import { maybeRunWrapUpApply } from "./wrapUpApplyPhase.js";
import { maybeRunPostRoundCritique } from "./postRoundCritique.js";
// T199 (2026-05-04): LLM-driven dynamic role catalog.
import { deriveDynamicRoleCatalog } from "./dynamicRoleCatalog.js";
import { buildRoleDiffDeliverableSections } from "./roleDiffDeliverable.js";
import {
  readDirective,
  buildDirectiveBlock,
  pickDeliverableTitle,
  pickDeliverableSubtitle,
} from "./directivePromptHelpers.js";

import {
  parseConvergenceSignal,
  parseConvergenceSignalLoose,
} from "./convergenceSignal.js";
import {
  pickNextDisposition,
  buildStructuredSynthesisPrompt,
  buildRoleDiffSynthesisPrompt,
  buildRoundRobinDeliverableSections,
  buildRoundRobinTurnPrompt,
} from "./roundRobinPromptHelpers.js";
import {
  MultiWriterState,
  DEFAULT_CONFLICT_POLICIES,
} from "./multiWriterState.js";

export interface RoundRobinOptions {
  // Unit 8: when set, every agent gets a per-index role prepended to its
  // prompt. The Orchestrator's "role-diff" preset instantiates this runner
  // with DEFAULT_ROLES; the plain "round-robin" preset leaves it undefined.
  roles?: readonly SwarmRole[];
}

// The current collaboration pattern: N identical agents take turns in a fixed
// order, each one seeing the full transcript before speaking. Discussion-only —
// agents may read files but don't edit them.
export class RoundRobinRunner extends DiscussionRunnerBase {
  // T199 (2026-05-04): no longer readonly — when cfg.dynamicRoles is
  // set, the runner replaces this with an LLM-derived catalog before
  // the discussion loop starts. Default still set in the constructor
  // from options.roles for back-compat.
  private roles?: readonly SwarmRole[];
  // Phase 2 (writeMode: multi): collects hunk proposals during rounds
  private multiWriter?: MultiWriterState;
  // Unit 33: cross-preset metrics. Collector aggregates per-agent
  // counters (turns, attempts, retries, latencies) via the same
  // onTiming/onRetry hooks promptWithRetry already surfaces. startedAt
  // is stamped once the discussing loop begins so wall-clock excludes
  // clone + spawn (mirrors BlackboardRunner.runStartedAt scoping).
  private stats = new AgentStatsCollector();
  // 2026-05-02 (round-robin improvement #1): cumulative turn counter
  // across all agents + rounds. Drives disposition rotation in
  // buildPrompt. Pre-incremented by runTurn before each prompt build.
  private turnsTaken = 0;

  constructor(opts: RunnerOpts, options?: RoundRobinOptions) {
    super(opts);
    this.roles = options?.roles && options.roles.length > 0 ? options.roles : undefined;
  }

  async start(cfg: RunConfig): Promise<void> {
    if (this.isRunning()) throw new Error("A swarm is already running. Stop it first.");
    this.resetState(cfg);
    this.stats.reset();
    this.turnsTaken = 0;

    const { destPath, ready } = await this.initCloneAndSpawn(cfg, {
      preset: "round-robin",
      roleResolver: () => "Discussant",
    });
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

    // Phase 2 (writeMode: multi): initialize multi-writer state
    if (cfg.writeMode === "multi") {
      const destPath = this.active?.localPath;
      if (destPath) {
        this.multiWriter = new MultiWriterState({
          writeMode: cfg.writeMode,
          conflictPolicy: cfg.conflictPolicy ?? DEFAULT_CONFLICT_POLICIES["round-robin"],
          clonePath: destPath,
        });
        this.appendSystem(
          `Multi-writer mode enabled — agents will propose hunks during rounds, reconciled via ${cfg.conflictPolicy ?? "vote"} policy.`,
        );
      }
    }

    this.setPhase("discussing");
    this.startedAt = Date.now();
    void this.loop(cfg);
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

        if (cfg.postRoundCritique) {
          try {
            await maybeRunPostRoundCritique({
              agents: this.opts.manager.list(),
              round: this.round,
              totalRounds: cfg.rounds,
              transcript: this.transcript,
              userDirective: cfg.userDirective,
              enabled: cfg.postRoundCritique ?? false,
              runDiscussionAgent: (agent, prompt, opts) => this.runDiscussionAgent(agent, prompt, opts),
              stats: this.stats,
              appendSystem: (text, summary) => this.appendSystem(text, summary),
              presetName: "round-robin",
              stopping: this.stopping,
            });
          } catch (err) {
            this.appendSystem(`[postRoundCritique error] ${err instanceof Error ? err.message : String(err)}`);
          }
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
            // Phase 1 (writeMode: single): build discussion context
            const synthesisEntries = this.transcript.filter(
              (e) => e.role === "agent" && e.agentIndex === 1
            );
            const synthesisEntry = synthesisEntries.length > 0 
              ? synthesisEntries[synthesisEntries.length - 1] 
              : undefined;
            const discussionContext = synthesisEntry ? [
              `Round-robin synthesis (${cfg.agentCount} agents, ${this.round}/${cfg.rounds} rounds, rotating dispositions):`,
              synthesisEntry.text.slice(0, 2000),
            ].join("\n") : undefined;

            const relevantFiles: string[] = [];
            const filePattern = /(?:src\/|tests\/|lib\/|dist\/)[a-zA-Z0-9_./-]+\.(ts|js|tsx|jsx|py|rs|go)/g;
            for (const e of this.transcript.filter((e) => e.role === "agent").slice(-10)) {
              const matches = e.text.match(filePattern) || [];
              for (const m of matches) {
                if (!relevantFiles.includes(m)) relevantFiles.push(m);
              }
            }

            await maybeRunWrapUpApply({
              cfg,
              presetName: "round-robin",
              agent: lead,
              manager: this.opts.manager,
              repos: this.opts.repos,
              emit: this.opts.emit,
              appendSystem: (text) => this.appendSystem(text),
              discussionContext,
              relevantFiles: relevantFiles.slice(0, 20),
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
            // Phase 1 (writeMode: single): build discussion context for role-diff
            const synthesisEntry = this.transcript.find(
              (e) => e.role === "agent" && e.agentIndex === 1
            );
            const roleContext = this.roles
              ? this.roles.map((r) => `${r.name}: ${r.guidance}`).join("\n")
              : "";
            const discussionContext = synthesisEntry ? [
              `Role-diff synthesis (${cfg.agentCount} specialists, ${this.round}/${cfg.rounds} rounds):`,
              synthesisEntry.text.slice(0, 2000),
              "",
              "Specialist roles:",
              roleContext,
            ].join("\n") : undefined;

            const relevantFiles: string[] = [];
            const filePattern = /(?:src\/|tests\/|lib\/|dist\/)[a-zA-Z0-9_./-]+\.(ts|js|tsx|jsx|py|rs|go)/g;
            for (const e of this.transcript.filter((e) => e.role === "agent").slice(-10)) {
              const matches = e.text.match(filePattern) || [];
              for (const m of matches) {
                if (!relevantFiles.includes(m)) relevantFiles.push(m);
              }
            }

            await maybeRunWrapUpApply({
              cfg,
              presetName: "role-diff",
              agent: lead,
              manager: this.opts.manager,
              repos: this.opts.repos,
              emit: this.opts.emit,
              appendSystem: (text) => this.appendSystem(text),
              discussionContext,
              relevantFiles: relevantFiles.slice(0, 20),
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
        transcript: this.transcript,
        emitOutcome: (outcome: any) => this.opts.emit({ type: "outcome_scored" as const, runId: outcome.runId, score: outcome.score, verdict: outcome.verdict, dimensions: outcome.dimensions }),
        wallClockMs: this.startedAt ? Date.now() - this.startedAt : 0,
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
    this.turnsTaken += 1;
    const prompt = buildRoundRobinTurnPrompt({
      turnsTaken: this.turnsTaken,
      transcript: this.transcript,
      roles: this.roles,
      userDirective: this.active?.userDirective,
      agentIndex: agent.index,
      totalRounds,
      round,
      topology: this.active?.topology,
    });
    // T193: per-disposition model routing.
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
    await this.runDiscussionAgent(agent, prompt, {
      runnerName: "round-robin",
      stats: this.stats,
      agentName: "swarm-read",
      ...(modelOverride ? { modelOverride } : {}),
      onEntryPushed: (_entry, strippedText) => {
        if (this.multiWriter?.isActive()) {
          const result = this.multiWriter.addProposal(agent, strippedText);
          if (!result.skipped && result.hunks.length > 0) {
            this.appendSystem(
              `[${agent.id}] proposed ${result.hunks.length} hunk(s) — collected for reconciliation.`,
            );
          }
        }
      },
    });
  }

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
      const res = (await promptWithFailoverAuto(lead, prompt, {
        signal: controller.signal,
        manager: this.opts.manager,
        onTokens: ({ promptTokens, responseTokens }) => this.stats.recordTokens(lead.id, promptTokens, responseTokens),
        agentName: "swarm-read",
        promptAddendum: getAgentAddendum(this.active?.topology, lead.index),
        describeError: (e) => describeSdkError(e),
      }, this.active?.providerFailover)) as { data: { parts: Array<{ type: "text"; text: string }> } };
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
      const res = await promptWithFailoverAuto(lead, prompt, {
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
      }, this.active?.providerFailover);
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
    return buildRoundRobinTurnPrompt({
      turnsTaken: this.turnsTaken,
      transcript: this.transcript,
      roles: this.roles,
      userDirective: this.active?.userDirective,
      agentIndex: agent.index,
      totalRounds,
      round,
      topology: this.active?.topology,
    });
  }

}
