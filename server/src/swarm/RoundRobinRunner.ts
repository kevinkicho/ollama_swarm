import { createOutcomeEmitter, type OutcomeScoredEvent } from "./outcomeTypes.js";
import type { Agent } from "../services/AgentManager.js";

import type {
  SwarmEvent,
  SwarmPhase,
  SwarmStatus,
  TranscriptEntry,
  TranscriptEntrySummary,
} from "../types.js";
import type { RunConfig, RunnerOpts } from "./SwarmRunner.js";
import { DiscussionRunnerBase } from "./DiscussionRunnerBase.js";

import { roleForAgent, type SwarmRole } from "./roles.js";
import { formatChatReceipt } from "./chatReceipt.js";

import { runDiscussionCloseOut } from "./runFinallyHooks.js";
import { buildRoundRobinSeedMessage } from "./roundRobinSeed.js";
import { snapshotLifetimeTokens } from "../services/ollamaProxy.js";
import { checkBudgetGuards } from "./loopGuards.js";
// runEndReflection moved into runFinallyHooks (Phase D).

import { writeDeliverableAndEmit } from "./deliverable.js";
import { maybeRunWrapUpApply } from "./wrapUpApplyPhase.js";
import { maybeRunPostRoundCritique } from "./postRoundCritique.js";
// T199 (2026-05-04): LLM-driven dynamic role catalog.
import { deriveDynamicRoleCatalog } from "./dynamicRoleCatalog.js";
import { buildRoleDiffDeliverableSections } from "./roleDiffDeliverable.js";
import {
  readDirective,
  pickDeliverableTitle,
  pickDeliverableSubtitle,
} from "./directivePromptHelpers.js";

import {
  pickNextDisposition,
  buildRoundRobinDeliverableSections,
  buildRoundRobinTurnPrompt,
} from "./roundRobinPromptHelpers.js";
import {
  MultiWriterState,
  DEFAULT_CONFLICT_POLICIES,
} from "./multiWriterState.js";
import {
  type RoundRobinSynthesisHost,
  checkStructuredConvergence as checkStructuredConvergenceExtracted,
  runStructuredSynthesisPass as runStructuredSynthesisPassExtracted,
  runRoleDiffSynthesisPass as runRoleDiffSynthesisPassExtracted,
} from "./roundRobinSynthesis.js";

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
  protected getPresetName(): string { return "Round-robin"; }

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
    const { text, summary } = buildRoundRobinSeedMessage({ clonePath, cfg, tree });
    this.appendSystem(text, summary);
  }

  private async loop(cfg: RunConfig): Promise<void> {
    await this.runDiscussionLoop(cfg, "Round-robin", async (cfg) => {
      const earlyCheckRound = this.roles && cfg.rounds >= 4 ? Math.ceil(cfg.rounds / 2) : 0;
      const tokenBaseline = snapshotLifetimeTokens();

      for (let r = 1; r <= cfg.rounds; r++) {
        if (!this.checkRoundBudget(cfg, "round", r, tokenBaseline)) break;

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
    }, {
      pickReflectionAgent: (m) => m.list().find((a) => a.index === 1) ?? null,
      buildReflectionContext: (s) =>
        `${cfg.preset} preset · ${cfg.agentCount} agents · ran ${s.round}/${cfg.rounds} rounds${s.earlyStopDetail ? ` · early-stop: ${s.earlyStopDetail}` : ""}`,
      transcript: this.transcript as any,
      emitOutcome: createOutcomeEmitter((e) => this.opts.emit(e)),
      wallClockMs: this.startedAt ? Date.now() - this.startedAt : 0,
    });
  }

  // Unit 33: shared summary writer. Called once from the loop's finally
  // regardless of termination cause (completed / user-stop / crash).
  // summaryWritten guards against a double-write if stop() races the
  // natural completion path.
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

  private synthesisHost(): RoundRobinSynthesisHost {
    return {
      manager: this.opts.manager,
      transcript: this.transcript,
      ollamaBaseUrl: this.opts.ollamaBaseUrl,
      getStopping: () => this.stopping,
      getRoles: () => this.roles,
      getTopology: () => this.active?.topology,
      getProviderFailover: () => this.active?.providerFailover,
      getRunId: () => this.active?.runId,
      logDiag: this.opts.logDiag,
      stats: this.stats,
      appendSystem: (t) => this.appendSystem(t),
      emit: (e) => this.opts.emit(e),
      emitAgentState: (s) => this.emitAgentState(s),
    };
  }

  // 2026-05-02 (round-robin improvement #3): semantic convergence check.
  // Implementation extracted to roundRobinSynthesis.ts.
  private async checkStructuredConvergence(): Promise<boolean> {
    return checkStructuredConvergenceExtracted(this.synthesisHost());
  }

  // 2026-05-02 (round-robin improvement #4): final synthesis pass for
  // the no-roles structured-deliberation case. Extracted to roundRobinSynthesis.ts.
  private async runStructuredSynthesisPass(
    cfg: RunConfig,
  ): Promise<"high" | "medium" | "low" | null> {
    return runStructuredSynthesisPassExtracted(this.synthesisHost(), cfg);
  }

  // Role-diff synthesis. Tagged "role_diff_synthesis". Extracted to roundRobinSynthesis.ts.
  private async runRoleDiffSynthesisPass(
    cfg: RunConfig,
  ): Promise<"high" | "medium" | "low" | null> {
    return runRoleDiffSynthesisPassExtracted(this.synthesisHost(), cfg);
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
