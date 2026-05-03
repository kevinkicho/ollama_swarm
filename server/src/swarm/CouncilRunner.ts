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
import { promptWithRetry } from "./promptWithRetry.js";
import { AgentStatsCollector } from "./agentStatsCollector.js";
import { buildSeedSummary } from "./runSummary.js";
import { discussionWriteSummary } from "./discussionWriteSummary.js";
import { runDiscussionCloseOut } from "./runFinallyHooks.js";
import { extractTextWithDiag, looksLikeJunk, trackPostRetryJunk } from "./extractText.js";
import { snapshotLifetimeTokens } from "../services/ollamaProxy.js";
import { checkBudgetGuards } from "./loopGuards.js";
import { OutputEmptyDeadLoopGuard } from "./deadLoopGuard.js";
import { retryEmptyResponse } from "./promptAndExtract.js";
import { formatCloneMessage } from "./cloneMessage.js";
import { staggerStart } from "./staggerStart.js";
// runEndReflection moved into runFinallyHooks (Phase D).
import { stripAgentText } from "../../../shared/src/stripAgentText.js";
import { getAgentAddendum } from "../../../shared/src/topology.js";
import { describeSdkError } from "./sdkError.js";
import { formatChatReceipt, userEntryVisibleTo } from "./chatReceipt.js";
import { writeDeliverable, runQualityPasses } from "./deliverable.js";
import { deriveRubric, type DerivedRubric } from "./rubricPrePass.js";
import {
  buildCouncilPositionsSection,
  getLastPositionForAgent,
} from "./councilPosition.js";
import {
  readDirective,
  buildDirectiveBlock,
  pickDeliverableTitle,
  pickAnswerSectionTitle,
  pickDeliverableSubtitle,
  maybeDirectiveSection,
} from "./directivePromptHelpers.js";
import { parseConvergenceSignal } from "./convergenceSignal.js";

// Council / parallel drafts + reconcile.
// Round 1: every agent drafts independently. Each agent's prompt contains
// only the seed + any human-injected messages — NO peer drafts. Drafts are
// fanned out in parallel and only land in the shared transcript after the
// whole round has settled, so within Round 1 no agent can see what any other
// agent wrote. That independence is the whole point: same-model agents
// produce surprisingly different answers when they can't anchor on each
// other's output first.
//
// Round 2..N: everyone sees everyone's drafts (and any prior revisions) and
// revises. The reconcile step is whatever the agents converge to across
// later rounds — no vote, no explicit judge. Discussion-only, no file edits.
export class CouncilRunner implements SwarmRunner {
  private transcript: TranscriptEntry[] = [];
  private phase: SwarmPhase = "idle";
  private round = 0;
  private stopping = false;
  private active?: RunConfig;
  // Unit 33: cross-preset metrics — see RoundRobinRunner for rationale.
  private stats = new AgentStatsCollector();
  private startedAt?: number;
  private summaryWritten = false;
  // Phase B (Task #99): set when the midpoint convergence check
  // returns "high"; promoted to stopReason="early-stop" by writeSummary.
  private earlyStopDetail?: string;
  // 2026-05-02 (quality lever #2): rubric derived at run-start via
  // deriveRubric. Stored so writeCouncilDeliverable can bake it into
  // the deliverable AND pass it to the critic pass.
  private derivedRubric: DerivedRubric | null = null;

  constructor(private readonly opts: RunnerOpts) {}

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
    this.summaryWritten = false;
    this.earlyStopDetail = undefined;

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
    // Unit 48: hide runner artifacts from `git status` (see RoundRobinRunner).
    await this.opts.repos.excludeRunnerArtifacts(destPath);
    // E3 Phase 5: opencode.json no longer needed — no opencode subprocess.
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
        preset: "council",
        ready,
        requestedCount: cfg.agentCount,
        spawnElapsedMs: Date.now() - spawnStart,
        roleResolver: () => "Drafter",
      }),
    );
    this.stats.registerAgents(ready);

    this.setPhase("seeding");
    await this.seed(destPath, cfg);

    // 2026-05-02 (quality lever #2): derive a per-run rubric from the
    // user directive BEFORE the main loop. Lead agent (index 1) does
    // the derivation; result is stored for the deliverable + critic
    // pass at run-end. Best-effort — failure falls back to DEFAULT_RUBRIC
    // so the loop always proceeds.
    const lead = ready[0];
    if (lead && cfg.userDirective) {
      this.appendSystem(`Deriving success rubric from directive (lever #2)…`);
      this.derivedRubric = await deriveRubric({
        agent: lead,
        manager: this.opts.manager,
        directive: cfg.userDirective,
      });
      this.appendSystem(
        `Rubric derived: ${this.derivedRubric.criteria.length} criteria, shape "${this.derivedRubric.deliverableShape}".`,
      );
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
    // 2026-05-02 (council improvement #1): user directive surfaces
    // at the TOP of the seed when set. Council was already deriving
    // a rubric from cfg.userDirective at run-start (lever #2 of the
    // deliverables initiative) but the agents themselves were
    // directive-blind in their drafts. Now every drafter sees it.
    // 2026-05-03 (Phase A): directive block extracted to shared helper.
    const dirCtx = readDirective(cfg);
    const lines = [
      `Project clone: ${clonePath}`,
      `Repo: ${cfg.repoUrl}`,
      `Top-level entries: ${tree.join(", ") || "(empty)"}`,
      "",
      ...buildDirectiveBlock(dirCtx, {
        framingLines: [
          "Every drafter answers the directive above. Round 1 = independent drafts (peers hidden); Round 2+ = reveal and revise. Synthesis at the end consolidates into a single answer with a minority report when dissent persists.",
        ],
      }),
      "Use your file-read / grep / find tools to actually inspect this repo — start with README.md if present.",
    ];
    // Task #72: structured payload so the web renders the seed
    // announce as a grid (definition list + collapsible top-level
    // file list) instead of the wall-of-text comma-separated line.
    this.appendSystem(lines.join("\n"), buildSeedSummary(cfg.repoUrl, clonePath, tree));
  }

  private async loop(cfg: RunConfig): Promise<void> {
    let crashMessage: string | undefined;
    try {
      // Phase B (Task #99): single midpoint convergence check.
      // Mirrors #94's debate-judge midpoint pattern — one extra
      // synthesis call max, not per-round. Skip for tiny runs where
      // a midpoint check IS the loop end.
      const earlyCheckRound = cfg.rounds >= 4 ? Math.ceil(cfg.rounds / 2) : 0;
      // Task #146: dead-loop guard (mirrors #144).
      // 2026-05-03 (Phase B): dead-loop guard extracted to shared class.
      const deadLoopGuard = new OutputEmptyDeadLoopGuard({
        roleLabel: "drafters",
        unit: "round",
      });

      // Task #124: snapshot lifetime tokens at run start; budget
      // checks compare delta vs cfg.tokenBudget.
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

        // Snapshot the transcript at round start. Every agent in this round
        // builds its prompt from this same snapshot, guaranteeing that within
        // a round no agent sees another agent's output — even if one agent's
        // session.prompt returns before another's. For Round 1, the snapshot
        // contains only system + user entries (no agent output exists yet).
        const snapshot: readonly TranscriptEntry[] = [...this.transcript];
        const agents = this.opts.manager.list();

        // Unit 18b (2026-04-22): pre-batch parallel warmup REMOVED. v4
        // battle test showed it doubled timeout count (12 vs v3's 6) and
        // retry count (8 vs 4) — the parallel warmup batch hit the same
        // cloud cold-start ceiling as the real batch it was meant to
        // protect. Serial spawn-warmup stays in start(); council relies
        // on that alone now.

        // Fan out: runTurn appends to this.transcript as each agent returns,
        // so the UI sees drafts populate in real time while the prompts above
        // were all built from the pre-round snapshot.
        // Task #53: stagger the N parallel session.prompt calls by ~150ms
        // per agent so they don't all hit the cloud at the same ms.
        // Log analysis 2026-04-24 confirmed Pattern 3 — agent-2 consistently
        // loses the queue race when all agents fire simultaneously.
        const transcriptLenBefore = this.transcript.length;
        await staggerStart(agents, (agent) =>
          this.runTurn(agent, r, cfg.rounds, snapshot, cfg.userDirective),
        );
        // Task #146: dead-loop guard. After each council round, if EVERY
        // drafter's new entry is empty/junk, count consecutive bad rounds
        // and break at threshold. Same context-bloat root cause as #144.
        // 2026-05-03 (Phase B): logic extracted to OutputEmptyDeadLoopGuard.
        const newEntries = this.transcript
          .slice(transcriptLenBefore)
          .filter((e) => e.role === "agent");
        const dlHit = deadLoopGuard.recordIteration(newEntries);
        if (dlHit.tripped) {
          this.earlyStopDetail = dlHit.earlyStopDetail;
          this.appendSystem(
            `All council drafters produced empty/junk output for ${dlHit.consecutive} consecutive rounds — ending council early.`,
          );
          break;
        }

        // Phase B (Task #99): midpoint synthesis check. If the
        // synthesizer reports CONVERGENCE: high, the council has
        // settled — running more rounds just restates the same
        // consensus. The midpoint synthesis is the canonical
        // synthesis (we don't run it again at end), so skip the
        // post-loop pass.
        if (
          !this.stopping &&
          r === earlyCheckRound &&
          r < cfg.rounds
        ) {
          const convergence = await this.runSynthesisPass(cfg);
          if (convergence === "high") {
            this.earlyStopDetail =
              `council-converged-high after round ${r}/${cfg.rounds}`;
            this.appendSystem(
              `Council reached convergence:high at round ${r}/${cfg.rounds} — ending early.`,
            );
            break;
          }
        }
      }
      // Task #79 (2026-04-25): final consensus pass. After all rounds,
      // agent-1 takes every drafter's final position and produces a
      // single consolidated answer. Without this, council ends with N
      // parallel drafts and no clear "what did we decide" output —
      // users had to read every draft and synthesize themselves.
      // Task #99: skip if the midpoint check already broke us out
      // (in which case we already ran the synthesis above).
      if (!this.stopping && cfg.rounds > 0 && !this.earlyStopDetail) {
        await this.runSynthesisPass(cfg);
      }
      // 2026-05-02 (deliverables initiative + quality levers): structured
      // markdown artifact + rubric + critic + next-actions. Best-effort —
      // never blocks run-end if it fails.
      if (!this.stopping && cfg.runId) {
        await this.writeCouncilDeliverable(cfg);
      }
      if (!this.stopping) this.appendSystem("Council complete.");
    } catch (err) {
      crashMessage = err instanceof Error ? err.message : String(err);
      this.opts.emit({ type: "error", message: crashMessage });
    } finally {
      // 2026-05-03 (Phase D): finally close-out extracted to shared helper.
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
            `Council preset · ${cfg.agentCount} drafters · ran ${s.round}/${cfg.rounds} rounds${s.earlyStopDetail ? ` · early-stop: ${s.earlyStopDetail}` : ""}`,
        },
      });
    }
  }

  // Unit 33: shared summary writer pattern — see RoundRobinRunner.
  private async writeSummary(cfg: RunConfig, crashMessage?: string): Promise<void> {
    if (this.summaryWritten) return;
    this.summaryWritten = true;
    if (this.startedAt === undefined) return;
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

  // 2026-05-02 (deliverables initiative + quality levers #1-#3):
  // per-preset structured markdown artifact. Pulls the synthesis bubble
  // from the transcript (latest entry tagged council_synthesis) + the
  // per-round drafts and renders them as a portable report. Augmented
  // by runQualityPasses with a rubric (top), critic notes (bottom),
  // and extracted next-actions (bottom). Best-effort — failure posts
  // a system message but doesn't break run-end.
  private async writeCouncilDeliverable(cfg: RunConfig): Promise<void> {
    if (!cfg.runId) return;
    // 2026-05-03 (Phase A): directive helpers extracted to shared module.
    const dirCtx = readDirective(cfg);
    // Latest synthesis bubble (lead's consolidated answer).
    const synthesisEntry = [...this.transcript]
      .reverse()
      .find((e) => e.summary?.kind === "council_synthesis");
    const synthesisText = synthesisEntry?.text ?? "_(synthesis missing)_";
    // Round 1 = independent drafts (peer-hidden). Group by agentIndex.
    const round1Drafts = this.transcript.filter(
      (e) =>
        e.summary?.kind === "council_draft" &&
        e.summary.round === 1 &&
        e.role === "agent",
    );
    // Final round = revised drafts. Last round number we actually ran.
    const finalRound = this.round;
    const finalDrafts = this.transcript.filter(
      (e) =>
        e.summary?.kind === "council_draft" &&
        e.summary.round === finalRound &&
        e.role === "agent",
    );
    // 2026-05-02 (council improvement #4): per-agent latest position
    // section, extracted from `### MY POSITION` blocks. Surfaces each
    // agent's final answer side-by-side with the synthesis — counters
    // synthesis-collapse by giving the reader the raw distinct
    // positions, not just the consolidated view.
    const positionsSection = buildCouncilPositionsSection(
      this.transcript,
      cfg.agentCount,
    );
    const baseSections: Array<{ title: string; body: string }> = [];
    const directiveSection = maybeDirectiveSection(dirCtx);
    if (directiveSection) baseSections.push(directiveSection);
    baseSections.push(
      {
        title: pickAnswerSectionTitle(dirCtx, {
          withDirective: "Answer to directive",
          withoutDirective: "Final synthesis",
        }),
        body: synthesisText,
      },
      positionsSection,
      {
        title: `Round ${finalRound} — final drafts (full text)`,
        body:
          finalDrafts.length > 0
            ? finalDrafts
                .map((e) => `### Agent ${e.agentIndex ?? "?"}\n\n${e.text.trim()}`)
                .join("\n\n")
            : "_(no final-round drafts captured)_",
      },
      {
        title: "Round 1 — independent first drafts (peer-hidden)",
        body:
          round1Drafts.length > 0
            ? round1Drafts
                .map((e) => `### Agent ${e.agentIndex ?? "?"}\n\n${e.text.trim()}`)
                .join("\n\n")
            : "_(no round 1 drafts captured)_",
      },
    );
    // 2026-05-02 (quality levers #1-#3): augment with rubric +
    // critic notes + extracted next-actions. The lead agent (index 1)
    // doubles as critic so we don't burn a separate agent slot.
    const lead = this.opts.manager.list().find((a) => a.index === 1) ?? null;
    const sections = await runQualityPasses({
      baseSections,
      rubric: this.derivedRubric,
      criticAgent: lead,
      manager: this.opts.manager,
    });
    const subtitleBase = `${cfg.agentCount} drafter${cfg.agentCount === 1 ? "" : "s"} across ${finalRound}/${cfg.rounds} round${cfg.rounds === 1 ? "" : "s"}${this.earlyStopDetail ? " · early-stop" : ""}`;
    const result = writeDeliverable({
      preset: "council",
      runId: cfg.runId,
      clonePath: cfg.localPath,
      title: pickDeliverableTitle(dirCtx, {
        withDirective: "Council: directive answer",
        withoutDirective: "Council synthesis",
      }),
      subtitle: pickDeliverableSubtitle(dirCtx, subtitleBase),
      sections,
    });
    if (result.ok) {
      this.appendSystem(`Deliverable saved → ${result.filename}`, {
        kind: "deliverable",
        preset: "council",
        filename: result.filename,
        fullPath: result.fullPath,
        bytes: result.bytes,
        sectionTitles: sections.map((s) => s.title),
      });
    } else {
      this.appendSystem(`Failed to write deliverable (${result.reason})`);
    }
  }

  // Task #79: final consensus synthesis. Routes through agent-1 with
  // all council drafts in context and asks for a unified answer. Uses
  // the same promptWithRetry + extractText path as runTurn so timing
  // + retry stats land in the per-agent rollup. Treated as a normal
  // agent turn for stats purposes — the synthesis IS agent-1's last
  // contribution. Tagged with summary kind "council_synthesis" so
  // the modal can render it distinctively.
  private async runSynthesisPass(cfg: RunConfig): Promise<"high" | "medium" | "low" | null> {
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
    this.appendSystem(`Synthesizing council consensus (agent-${lead.index})…`);

    const prompt = buildCouncilSynthesisPrompt(cfg.rounds, this.transcript, cfg.userDirective);
    // 2026-04-27: SSE-aware watchdog (see startSseAwareTurnWatchdog).
    const controller = new AbortController();
    const watchdog = startSseAwareTurnWatchdog({
      manager: this.opts.manager,
      sessionId: lead.sessionId,
      controller,
      abortSession: async () => {},
    });
    try {
      const onTokens = ({ promptTokens, responseTokens }: { promptTokens: number; responseTokens: number }) => this.stats.recordTokens(lead.id, promptTokens, responseTokens);
      const res = await promptWithRetry(lead, prompt, {
        onTokens,
        signal: controller.signal,
        manager: this.opts.manager,
        agentName: "swarm-read",
        // Phase 5b of #243: per-agent addendum from the topology row.
        promptAddendum: getAgentAddendum(cfg.topology, lead.index),
        describeError: describeSdkError,
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
        runner: "council",
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
      // Task #108: defensive guard — if the post-retry text still
      // looks like junk, do NOT tag it as the canonical synthesis.
      // The transcript still keeps the entry (so the run history
      // shows what happened) but without the synthesis kind, the
      // UI won't render a single character as the "consensus".
      const isJunkSynthesis = looksLikeJunk(text) || extracted.isEmpty;
      const stripped = stripAgentText(text);
      const entry: TranscriptEntry = {
        id: randomUUID(),
        role: "agent",
        agentId: lead.id,
        agentIndex: lead.index,
        text: stripped.finalText || "(empty response)",
        ts: Date.now(),
        summary: isJunkSynthesis
          ? undefined
          : { kind: "council_synthesis", rounds: cfg.rounds },
        ...(stripped.thoughts.length > 0 ? { thoughts: stripped.thoughts } : {}),
        ...(stripped.toolCalls.length > 0 ? { toolCalls: stripped.toolCalls } : {}),
      };
      this.transcript.push(entry);
      this.opts.emit({ type: "transcript_append", entry });
      if (isJunkSynthesis) {
        this.appendSystem(
          `[${lead.id}] synthesis text is degenerate (${text.length} chars) — kept in transcript but NOT tagged as canonical synthesis.`,
        );
        return null;
      }
      // Phase B (Task #99): parse the convergence signal so the loop
      // can act on it.
      return parseConvergenceSignal(text);
    } catch (err) {
      // Synthesis failure is non-fatal — log and continue. The council
      // still produced N final drafts that the user can read.
      this.appendSystem(
        `[${lead.id}] synthesis failed (${err instanceof Error ? err.message : String(err)}); skipping consolidation.`,
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

  private async runTurn(
    agent: Agent,
    round: number,
    totalRounds: number,
    snapshot: readonly TranscriptEntry[],
    userDirective?: string,
  ): Promise<void> {
    this.opts.manager.markStatus(agent.id, "thinking");
    this.emitAgentState({
      id: agent.id,
      index: agent.index,
      port: agent.port,
      sessionId: agent.sessionId,
      status: "thinking",
      thinkingSince: Date.now(),
    });
    this.stats.countTurn(agent.id);

    // 2026-05-02 (chat lever #3): drop user entries @mentioned at OTHER
    // agents so this agent's prompt only sees broadcast + targeted-at-me.
    const visible = snapshot.filter((e) => userEntryVisibleTo(e, agent.id));
    const prompt = buildCouncilPrompt(agent.index, round, totalRounds, visible, userDirective);
    // 2026-04-27: replaced wall-clock 4-min cap with SSE-aware watchdog.
    // Pre-fix the cap killed prompts the model was actively producing
    // (cloud streaming has long-tail latency for big prompts but SSE
    // chunks keep arriving — wall clock saw "4 min" and killed regardless).
    // New behavior: only abort when SSE has been silent >90s OR total
    // wall-clock exceeds 30 min. See sseAwareTurnWatchdog for details.
    const controller = new AbortController();
    const watchdog = startSseAwareTurnWatchdog({
      manager: this.opts.manager,
      sessionId: agent.sessionId,
      controller,
      abortSession: async () => {},
    });

    try {
      // Unit 16: shared retry wrapper.
      const res = await promptWithRetry(agent, prompt, {
        signal: controller.signal,
        manager: this.opts.manager,
        // Unit 20: read-only tools for discussion presets.
        agentName: "swarm-read",
        // Phase 5b of #243: per-agent addendum from the topology row.
        promptAddendum: getAgentAddendum(this.active?.topology, agent.index),
        describeError: describeSdkError,
        onTokens: ({ promptTokens, responseTokens }) => this.stats.recordTokens(agent.id, promptTokens, responseTokens),
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
          });
          // Improvement #4: per-agent first-prompt cold-start logging.
          // No-op after the first call per agent.
          this.opts.manager.recordPromptComplete(agent.id, { attempt, elapsedMs, success });
          // Unit 40: live latency sample over WS for the UI sparkline.
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
        runner: "council",
        agentId: agent.id,
        agentIndex: agent.index,
        logDiag: this.opts.logDiag,
      };
      const extracted = extractTextWithDiag(res, diagCtx);
      let text = extracted.text;
      // Task #54: one-shot retry when the response came back with no
      // text part (model-silence pattern, observed on nemotron under
      // parallel fanout). Best-effort — if the retry also empties or
      // throws, we keep the original "(empty response)" placeholder.
      // Pattern 8 (2026-04-24): also retry on junk-short single-token
      // outputs ("4", a hex SHA, a passwd-like string) — same nemotron
      // failure mode, the response is non-empty but useless.
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
      // #230: strip <think> + XML tool-call markers before saving
      // (matches BlackboardRunner.appendAgent treatment).
      const stripped = stripAgentText(text);
      const entry: TranscriptEntry = {
        id: randomUUID(),
        role: "agent",
        agentId: agent.id,
        agentIndex: agent.index,
        text: stripped.finalText || "(empty response)",
        ts: Date.now(),
        // Phase 2b: tag with round + phase so the DraftMatrix can
        // bucket without fragile index math. Round 1 = independent
        // drafts (peer-hidden in the prompt); Round 2+ = reveal &
        // revise (peers visible).
        summary: {
          kind: "council_draft",
          round,
          phase: round === 1 ? "draft" : "reveal",
        },
        ...(stripped.thoughts.length > 0 ? { thoughts: stripped.thoughts } : {}),
        ...(stripped.toolCalls.length > 0 ? { toolCalls: stripped.toolCalls } : {}),
      };
      this.transcript.push(entry);
      this.opts.emit({ type: "transcript_append", entry });
      this.opts.emit({ type: "agent_streaming_end", agentId: agent.id });
      this.opts.manager.markStatus(agent.id, "ready", { lastMessageAt: entry.ts });
      this.emitAgentState({
        id: agent.id,
        index: agent.index,
        port: agent.port,
        sessionId: agent.sessionId,
        status: "ready",
        lastMessageAt: entry.ts,
      });
    } catch (err) {
      const msg = watchdog.getAbortReason() ?? describeSdkError(err);
      this.appendSystem(`[${agent.id}] error: ${msg}`);
      this.opts.emit({ type: "agent_streaming_end", agentId: agent.id });
      this.opts.manager.markStatus(agent.id, "failed", { error: msg });
      this.emitAgentState({
        id: agent.id,
        index: agent.index,
        port: agent.port,
        sessionId: agent.sessionId,
        status: "failed",
        error: msg,
      });
    } finally {
      watchdog.cancel();
    }
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

// Task #79: synthesis prompt. Uses ALL transcript entries (system +
// agent) so the lead can see the seed + every draft. Frames the
// output expectation explicitly: one consolidated answer, what
// converged, what's still contested, one concrete next action.
// Phase B (Task #99): scan a synthesis response for the
// "CONVERGENCE: high|medium|low" line.
// 2026-05-03 (Phase A): the parser implementation moved to the shared
// `convergenceSignal.ts` module (also used by RoundRobinRunner). This
// re-export preserves the legacy public name for any external caller.
export { parseConvergenceSignal as parseCouncilConvergence } from "./convergenceSignal.js";

export function buildCouncilSynthesisPrompt(
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

  // 2026-05-02 (council improvement #1 + #3): directive-aware synthesis
  // with a required Minority report section. The minority report is the
  // counter to "synthesis collapse" — when 5 drafts get squeezed into
  // 1 consensus answer, the dissenting view (often the right one) is
  // lost. Forcing the synthesis to NAME the strongest dissent + who
  // held it preserves it; "_consensus reached_" is a valid value when
  // there genuinely was no dissent.
  // 2026-05-03 (Phase A): directive block extracted to shared helper.
  const dirCtx = readDirective({ userDirective });
  const directiveBlock = buildDirectiveBlock(dirCtx, {
    labelSuffix: "(the question this council was answering)",
  });

  const structure = dirCtx.hasDirective
    ? [
        "STRUCTURE your response as:",
        "1. **Answer to directive** — direct response to the user's question. State what the council concluded, not how it deliberated.",
        "2. **Consensus** — what every agent (including you) converged on while resolving the directive. State as a direct claim.",
        "3. **Disagreements** — where agents still hold different positions on the directive. Name the agents and their stances.",
        "4. **Minority report** — when at least one agent's `### MY POSITION` diverges from the consensus, name them and state their strongest argument **verbatim** from their last position. If the council genuinely converged with no dissent, write `_consensus reached — no minority position_`. Do NOT invent dissent for show.",
        "5. **Next action** — ONE concrete next step toward the directive. Cite files / decisions / experiments. If no action is needed, say so.",
        "",
      ]
    : [
        "STRUCTURE your response as:",
        "1. **Consensus** — what every agent (including you) converged on. State it as a direct claim, not a meta-observation.",
        "2. **Disagreements** — where agents still hold different positions. Name the agents and their stances.",
        "3. **Minority report** — when at least one agent's `### MY POSITION` diverges from the consensus, name them and state their strongest argument **verbatim** from their last position. If the council genuinely converged with no dissent, write `_consensus reached — no minority position_`. Do NOT invent dissent for show.",
        "4. **Next action** — ONE concrete next step the swarm or user should take, given the council's findings. If no action is needed, say so.",
        "",
      ];

  return [
    `You are Agent 1, the council's synthesis lead. The council just finished ${totalRounds} round${totalRounds === 1 ? "" : "s"} of independent drafts + reveal/revise.`,
    "Your job NOW is to produce a SINGLE consolidated answer that integrates every agent's final position.",
    "",
    ...directiveBlock,
    ...structure,
    "Keep it under ~500 words. Be specific. Cite file paths or peer claims when relevant. Do not just summarize the drafts — synthesize them.",
    "",
    // Phase B (Task #99): convergence signal on the FINAL line. Lets
    // the runner end mid-loop when the council has clearly settled.
    // Be conservative — only mark "high" when consensus genuinely
    // dominates and any remaining disagreements are minor. Marking
    // converged=high prematurely cuts off useful debate.
    "On the FINAL line of your response (no markdown, nothing after it), output exactly one of:",
    "  CONVERGENCE: high   — agents largely agree; further rounds would only restate the consensus.",
    "  CONVERGENCE: medium — partial consensus with real open questions still in play.",
    "  CONVERGENCE: low    — significant unresolved disagreement; more rounds would help.",
    "",
    "=== FULL COUNCIL TRANSCRIPT ===",
    transcriptText,
    "=== END TRANSCRIPT ===",
    "",
    "Produce your synthesis now.",
  ].join("\n");
}

// Exported so CouncilRunner.test.ts can lock down the independence invariant
// without spinning up real agents.
export function buildCouncilPrompt(
  agentIndex: number,
  round: number,
  totalRounds: number,
  snapshot: readonly TranscriptEntry[],
  userDirective?: string,
): string {
  // Round 1 is the draft round: strip peer-agent entries so an agent writing
  // its first-pass answer cannot anchor on what anyone else has said. Round
  // 2..N is the revision round: show everything, including prior drafts.
  const visible =
    round === 1 ? snapshot.filter((e) => e.role !== "agent") : snapshot;

  const transcriptText = visible
    .map((e) => {
      if (e.role === "system") return `[SYSTEM] ${e.text}`;
      if (e.role === "user") return `[HUMAN] ${e.text}`;
      return `[Agent ${e.agentIndex}] ${e.text}`;
    })
    .join("\n\n");

  const header = `You are Agent ${agentIndex} in a council of AI engineers reviewing a cloned GitHub project.`;
  const roundIntent =
    round === 1
      ? "This is ROUND 1 — your independent first draft. You cannot see the other agents' drafts; that is deliberate. Answer without anchoring on anyone else."
      : `This is ROUND ${round} of ${totalRounds} — revision. The other agents' prior drafts are in the transcript below. Revise your own position: keep what still holds, change what a peer's draft convinced you of, explicitly disagree where you think they're wrong. Do not just agree.`;

  const transcriptLabel =
    round === 1
      ? "=== SEED + ANY HUMAN INPUT (peer drafts hidden this round) ==="
      : "=== COUNCIL TRANSCRIPT SO FAR ===";

  // 2026-05-02 (council improvement #1): user directive injected into
  // every drafter's prompt. Without this, agents draft answers to "what
  // is this project" while the rubric (derived from the directive) is
  // only used by the deliverable critic — load-bearing miss.
  // 2026-05-03 (Phase A): directive block extracted to shared helper.
  const dirCtx = readDirective({ userDirective });
  const directiveBlock = buildDirectiveBlock(dirCtx, {
    labelSuffix: "(the question this council is answering)",
  });
  // Local boolean for the existing flow control further down (KEEP / Goals branches).
  const directive = dirCtx.directive;

  // 2026-05-02 (council improvement #2): position pre-registration to
  // counter Round-3 conformity drift. Each turn ends with a
  // `### MY POSITION` block — one short statement of the agent's
  // current best answer. Round 2+ is given its OWN prior position back
  // and required to explicitly own KEEP / CHANGE with a one-line WHY.
  // Anchors the agent against unconscious drift toward the loudest
  // voice — they have to actively renounce their prior position to
  // converge, not just quietly stop defending it.
  const priorPosition =
    round > 1 ? getLastPositionForAgent(snapshot, agentIndex) : null;
  const priorPositionBlock =
    round > 1
      ? [
          "=== YOUR PRIOR POSITION (from last round) ===",
          priorPosition ?? "_(you did not produce a `### MY POSITION` block last round — start fresh this round)_",
          "=== END PRIOR POSITION ===",
          "",
        ]
      : [];

  const positionContract =
    round === 1
      ? [
          "**POSITION CONTRACT (every turn):** End your response with:",
          "    ### MY POSITION",
          "    <one short sentence — ≤300 chars — your direct answer to the directive (or to 'what should this project do' when no directive). This is your anchor against drift in later rounds.>",
          "",
        ]
      : [
          "**POSITION CONTRACT (every turn):** End your response with:",
          "    ### MY POSITION",
          "    KEEP: <restate your prior position verbatim>   — OR —   CHANGE: <new one-sentence position>",
          "    WHY: <one line — what specifically convinced you to keep or change. Cite the agent + their argument when CHANGE.>",
          "",
          "Drift without an explicit CHANGE is the failure mode this contract exists to prevent. If you find yourself softening your prior position without naming who convinced you and how, KEEP it.",
          "",
        ];

  const goals = directive.length > 0
    ? [
        "Goals of this council:",
        "1. Read the repo just enough to ground your answer to the directive in real code (not filename guesses).",
        "2. Round 1: produce YOUR independent answer to the directive. Don't anchor on peers — you cannot see them.",
        "3. Round 2+: revise vs. prior round. Keep what still holds, change what a peer's draft genuinely convinced you of, explicitly disagree where you think they're wrong.",
        "",
      ]
    : [
        "Goals of this discussion:",
        "1. Figure out what this project is and who it is for.",
        "2. Identify what is working and what is missing.",
        "3. Propose one concrete next action the swarm should take.",
        "",
      ];

  return [
    header,
    roundIntent,
    "Your working directory IS the project clone — use file-read, grep, and find-files tools to inspect it.",
    "Round 1: skim README.md and the top-level tree before opining. Later rounds: re-read files when a peer's claim needs checking.",
    "Keep responses under ~250 words. Be specific. Cite file paths (e.g. `src/foo.ts:42`) when you reference code.",
    "",
    ...directiveBlock,
    ...priorPositionBlock,
    ...positionContract,
    ...goals,
    transcriptLabel,
    transcriptText || "(empty — you are writing the first entry)",
    "=== END TRANSCRIPT ===",
    "",
    `Now respond as Agent ${agentIndex}. End with your \`### MY POSITION\` block.`,
  ].join("\n");
}

