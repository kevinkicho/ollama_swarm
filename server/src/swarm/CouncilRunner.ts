import { randomUUID } from "node:crypto";
import type { Agent } from "../services/AgentManager.js";
import type {
  AgentState,
  SwarmEvent,
  SwarmPhase,
  SwarmStatus,
  TranscriptEntry,
} from "../types.js";
import type { RunConfig, RunnerOpts, SwarmRunner } from "./SwarmRunner.js";
import { promptWithRetry } from "./promptWithRetry.js";
import { AgentStatsCollector } from "./agentStatsCollector.js";
import { buildDiscussionSummary, formatPortReleaseLine, formatRunFinishedBanner, writeRunSummary } from "./runSummary.js";
import { extractTextWithDiag, looksLikeJunk } from "./extractText.js";
import { retryEmptyResponse } from "./promptAndExtract.js";
import { formatCloneMessage } from "./cloneMessage.js";
import { staggerStart } from "./staggerStart.js";

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

  injectUser(text: string): void {
    const entry: TranscriptEntry = {
      id: randomUUID(),
      role: "user",
      text,
      ts: Date.now(),
    };
    this.transcript.push(entry);
    this.opts.emit({ type: "transcript_append", entry });
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
    await this.opts.repos.writeOpencodeConfig(destPath, cfg.model);
    this.appendSystem(formatCloneMessage(cfg.repoUrl, destPath, cloneResult));

    this.setPhase("spawning");
    const spawnTasks: Promise<Agent>[] = [];
    for (let i = 1; i <= cfg.agentCount; i++) {
      spawnTasks.push(this.opts.manager.spawnAgent({ cwd: destPath, index: i, model: cfg.model }));
    }
    const results = await Promise.allSettled(spawnTasks);
    const ready = results
      .filter((r): r is PromiseFulfilledResult<Agent> => r.status === "fulfilled")
      .map((r) => r.value);
    if (ready.length === 0) throw new Error("No agents started successfully");
    this.appendSystem(
      `${ready.length}/${cfg.agentCount} agents ready on ports ${ready.map((a) => a.port).join(", ")}`,
    );
    this.stats.registerAgents(ready);

    this.setPhase("seeding");
    await this.seed(destPath, cfg);

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
    const seed = [
      `Project clone: ${clonePath}`,
      `Repo: ${cfg.repoUrl}`,
      `Top-level entries: ${tree.join(", ") || "(empty)"}`,
      "",
      "Use your file-read / grep / find tools to actually inspect this repo — start with README.md if present.",
    ].join("\n");
    this.appendSystem(seed);
  }

  private async loop(cfg: RunConfig): Promise<void> {
    let crashMessage: string | undefined;
    try {
      for (let r = 1; r <= cfg.rounds; r++) {
        if (this.stopping) break;
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
        await staggerStart(agents, (agent) =>
          this.runTurn(agent, r, cfg.rounds, snapshot),
        );
      }
      if (!this.stopping) this.appendSystem("Council complete.");
    } catch (err) {
      crashMessage = err instanceof Error ? err.message : String(err);
      this.opts.emit({ type: "error", message: crashMessage });
    } finally {
      await this.writeSummary(cfg, crashMessage);
      // Unit 55: auto-killAll on natural completion (see RoundRobinRunner).
      // Task #68: surface the kill result in the transcript so the user
      // sees explicit confirmation that all agent ports were released.
      if (!this.stopping) {
        const killResult = await this.opts.manager.killAll();
        this.appendSystem(formatPortReleaseLine(killResult));
        this.setPhase("completed");
      }
    }
  }

  // Unit 33: shared summary writer pattern — see RoundRobinRunner.
  private async writeSummary(cfg: RunConfig, crashMessage?: string): Promise<void> {
    if (this.summaryWritten) return;
    this.summaryWritten = true;
    if (this.startedAt === undefined) return;
    let gitStatus = { porcelain: "", changedFiles: 0 };
    try {
      gitStatus = await this.opts.repos.gitStatus(cfg.localPath);
    } catch {
      // best-effort
    }
    const summary = buildDiscussionSummary({
      config: {
        repoUrl: cfg.repoUrl,
        localPath: cfg.localPath,
        preset: cfg.preset,
        model: cfg.model,
        runId: cfg.runId,
      },
      agentCount: cfg.agentCount,
      rounds: cfg.rounds,
      startedAt: this.startedAt,
      endedAt: Date.now(),
      crashMessage,
      stopping: this.stopping,
      filesChanged: gitStatus.changedFiles,
      finalGitStatus: gitStatus.porcelain,
      agents: this.stats.buildPerAgentStats(),
      // Task #65: persist transcript so the history modal can replay.
      transcript: this.transcript,
    });
    try {
      await writeRunSummary(cfg.localPath, summary);
      // Task #68: rich end-of-run banner with per-agent rollup. Posted
      // BEFORE the terse file-write line so the most informative
      // content is the last thing the user reads.
      this.appendSystem(formatRunFinishedBanner(summary));
      this.appendSystem(
        `Wrote run summary (stopReason=${summary.stopReason}, wallClockMs=${summary.wallClockMs}, files=${summary.filesChanged}).`,
      );
    } catch (writeErr) {
      const msg = writeErr instanceof Error ? writeErr.message : String(writeErr);
      this.appendSystem(`Failed to write run summary (${msg})`);
    }
  }

  private async runTurn(
    agent: Agent,
    round: number,
    totalRounds: number,
    snapshot: readonly TranscriptEntry[],
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

    const prompt = buildCouncilPrompt(agent.index, round, totalRounds, snapshot);
    // Same absolute-turn cap rationale as RoundRobinRunner: no reliable idle
    // signal from OpenCode's SSE, so we rely solely on the 20-minute ceiling.
    // Pattern 11 (2026-04-24): lowered from 20m → 4m. nemotron-3-super:cloud
    // has a long-tail of 4-7 min slow first-prompts (~12% of attempts);
    // beyond ~4 min, the agent is almost certainly hung rather than slow.
    // Aborting here unblocks the round so the rest of the swarm can finish.
    const ABSOLUTE_MAX_MS = 4 * 60_000;
    const turnStart = Date.now();
    this.opts.manager.touchActivity(agent.sessionId, turnStart);

    const controller = new AbortController();
    let abortedReason: string | null = null;
    const watchdog = setInterval(() => {
      if (Date.now() - turnStart > ABSOLUTE_MAX_MS) {
        abortedReason = `absolute turn cap hit (${ABSOLUTE_MAX_MS / 1000}s)`;
        controller.abort(new Error(abortedReason));
        void agent.client.session.abort({ path: { id: agent.sessionId } }).catch(() => {});
      }
    }, 10_000);

    try {
      // Unit 16: shared retry wrapper.
      const res = await promptWithRetry(agent, prompt, {
        signal: controller.signal,
        // Unit 20: read-only tools for discussion presets.
        agentName: "swarm-read",
        describeError: describeSdkError,
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
      const entry: TranscriptEntry = {
        id: randomUUID(),
        role: "agent",
        agentId: agent.id,
        agentIndex: agent.index,
        text,
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
      const msg = abortedReason ?? describeSdkError(err);
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
      clearInterval(watchdog);
    }
  }

  private appendSystem(text: string): void {
    const entry: TranscriptEntry = { id: randomUUID(), role: "system", text, ts: Date.now() };
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

// Exported so CouncilRunner.test.ts can lock down the independence invariant
// without spinning up real agents.
export function buildCouncilPrompt(
  agentIndex: number,
  round: number,
  totalRounds: number,
  snapshot: readonly TranscriptEntry[],
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

  return [
    header,
    roundIntent,
    "Your working directory IS the project clone — use file-read, grep, and find-files tools to inspect it.",
    "Round 1: skim README.md and the top-level tree before opining. Later rounds: re-read files when a peer's claim needs checking.",
    "Keep responses under ~250 words. Be specific. Cite file paths (e.g. `src/foo.ts:42`) when you reference code.",
    "",
    "Goals of this discussion:",
    "1. Figure out what this project is and who it is for.",
    "2. Identify what is working and what is missing.",
    "3. Propose one concrete next action the swarm should take.",
    "",
    transcriptLabel,
    transcriptText || "(empty — you are writing the first entry)",
    "=== END TRANSCRIPT ===",
    "",
    `Now respond as Agent ${agentIndex}.`,
  ].join("\n");
}

function describeSdkError(err: unknown): string {
  if (err instanceof Error) {
    const parts: string[] = [err.message];
    let cause: unknown = (err as { cause?: unknown }).cause;
    let depth = 0;
    while (cause && depth < 4) {
      if (cause instanceof Error) {
        const code = (cause as { code?: string }).code;
        parts.push(code ? `${cause.message} [${code}]` : cause.message);
        cause = (cause as { cause?: unknown }).cause;
      } else {
        parts.push(String(cause));
        cause = undefined;
      }
      depth++;
    }
    return parts.join(" <- ");
  }
  if (err && typeof err === "object") {
    const o = err as { name?: string; message?: string };
    const head = o.name ? `${o.name}: ` : "";
    if (o.message) return head + o.message;
    try {
      return head + JSON.stringify(o).slice(0, 500);
    } catch {
      return head + String(err);
    }
  }
  return String(err);
}
