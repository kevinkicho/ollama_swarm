import { randomUUID } from "node:crypto";
import type { Agent } from "../services/AgentManager.js";
import type {
  AgentState,
  SwarmEvent,
  SwarmPhase,
  SwarmStatus,
  TranscriptEntry,
} from "./../types.js";
import type { RunConfig, RunnerOpts, SwarmRunner } from "./SwarmRunner.js";
import { promptWithRetry } from "./promptWithRetry.js";
import { AgentStatsCollector } from "./agentStatsCollector.js";
import { buildDiscussionSummary, writeRunSummary } from "./runSummary.js";
import { extractTextWithDiag } from "./extractText.js";
import { formatCloneMessage } from "./cloneMessage.js";

// Debate + judge.
// Agent 1 = PRO (argues FOR the proposition).
// Agent 2 = CON (argues AGAINST).
// Agent 3 = JUDGE (scores the debate on the final round).
//
// Per round, Pro speaks first, then Con. Both see the running transcript so
// they can rebut each other — that's the point, unlike Council's round-1
// isolation. On the final round, after Pro and Con's closing statements,
// the Judge reads the whole debate and issues a scored verdict.
//
// Proposition defaults to "This project is ready for production use."
// Users can override by injecting a message before starting the run — the
// runner picks up the most recent user-injected text as the proposition.
// Discussion-only, no file edits.
export class DebateJudgeRunner implements SwarmRunner {
  private transcript: TranscriptEntry[] = [];
  private phase: SwarmPhase = "idle";
  private round = 0;
  private stopping = false;
  private active?: RunConfig;
  // Unit 33: cross-preset metrics — see RoundRobinRunner for rationale.
  private stats = new AgentStatsCollector();
  private startedAt?: number;
  private summaryWritten = false;
  // User-supplied proposition override, captured by injectUser before start.
  // Only the most recent pre-start injection counts as the proposition;
  // mid-run injections are treated as regular transcript commentary.
  private proposition?: string;

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
    // If the run hasn't started yet (phase is idle), treat the most recent
    // user input as the proposition override. Once the run is underway,
    // injectUser just posts to the transcript as normal.
    if (this.phase === "idle" && text.trim().length > 0) {
      this.proposition = text.trim();
    }
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
    // Unit 32: cfg.proposition (set from the form's Advanced section)
    // takes precedence over an inject-before-start proposition. Lets
    // users specify the proposition at start time without the
    // inject-before-start workaround. The inject path still works when
    // cfg.proposition is absent — same as pre-Unit-32 behavior.
    if (cfg.proposition && cfg.proposition.trim().length > 0) {
      this.proposition = cfg.proposition.trim();
    }
    const propositionAtStart = this.proposition;
    this.transcript = [];
    this.stopping = false;
    this.round = 0;
    this.active = cfg;
    this.stats.reset();
    this.startedAt = undefined;
    this.summaryWritten = false;
    this.proposition = propositionAtStart; // re-set after transcript reset

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
    // This preset requires exactly 3 agents — the Zod schema + SetupForm
    // also enforce this, but check here so a direct-API caller gets a clear
    // error instead of a downstream "no judge" crash.
    if (ready.length !== 3) {
      throw new Error(
        `Debate + judge requires exactly 3 agents (got ${ready.length}). Agent 1 = Pro, Agent 2 = Con, Agent 3 = Judge.`,
      );
    }
    this.appendSystem(
      `3 agents ready on ports ${ready.map((a) => a.port).join(", ")}. Agent 1 = PRO, Agent 2 = CON, Agent 3 = JUDGE.`,
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
    const prop = this.proposition ?? DEFAULT_PROPOSITION;
    const seed = [
      `Project clone: ${clonePath}`,
      `Repo: ${cfg.repoUrl}`,
      `Top-level entries: ${tree.join(", ") || "(empty)"}`,
      "",
      `Proposition under debate: "${prop}"`,
      "Agent 1 (PRO) argues FOR the proposition.",
      "Agent 2 (CON) argues AGAINST.",
      "Agent 3 (JUDGE) stays silent until the final round, then reads the full debate and scores.",
    ].join("\n");
    this.appendSystem(seed);
  }

  private async loop(cfg: RunConfig): Promise<void> {
    let crashMessage: string | undefined;
    try {
      const agents = this.opts.manager.list();
      const pro = agents.find((a) => a.index === 1);
      const con = agents.find((a) => a.index === 2);
      const judge = agents.find((a) => a.index === 3);
      if (!pro || !con || !judge) throw new Error("Pro/Con/Judge must all spawn (agents 1, 2, 3)");
      const prop = this.proposition ?? DEFAULT_PROPOSITION;

      for (let r = 1; r <= cfg.rounds; r++) {
        if (this.stopping) break;
        this.round = r;
        this.opts.emit({ type: "swarm_state", phase: "discussing", round: r });

        const isFinalRound = r === cfg.rounds;
        // PRO turn
        await this.runDebaterTurn(pro, "pro", r, cfg.rounds, prop, isFinalRound);
        if (this.stopping) break;
        // CON turn
        await this.runDebaterTurn(con, "con", r, cfg.rounds, prop, isFinalRound);
        if (this.stopping) break;
        // JUDGE turn (only on the final round)
        if (isFinalRound) {
          await this.runJudgeTurn(judge, prop, r);
        }
      }
      if (!this.stopping) this.appendSystem("Debate concluded.");
    } catch (err) {
      crashMessage = err instanceof Error ? err.message : String(err);
      this.opts.emit({ type: "error", message: crashMessage });
    } finally {
      await this.writeSummary(cfg, crashMessage);
      // Unit 55: auto-killAll on natural completion (see RoundRobinRunner).
      if (!this.stopping) {
        await this.opts.manager.killAll();
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
    });
    try {
      await writeRunSummary(cfg.localPath, summary);
      this.appendSystem(
        `Wrote run summary (stopReason=${summary.stopReason}, wallClockMs=${summary.wallClockMs}, files=${summary.filesChanged}).`,
      );
    } catch (writeErr) {
      const msg = writeErr instanceof Error ? writeErr.message : String(writeErr);
      this.appendSystem(`Failed to write run summary (${msg})`);
    }
  }

  private async runDebaterTurn(
    agent: Agent,
    side: "pro" | "con",
    round: number,
    totalRounds: number,
    proposition: string,
    isFinalRound: boolean,
  ): Promise<void> {
    const prompt = buildDebaterPrompt({
      side,
      round,
      totalRounds,
      proposition,
      isFinalRound,
      transcript: [...this.transcript],
    });
    // Phase 2c: tag so VerdictPanel can group PRO/CON pairs by round.
    await this.runAgent(agent, prompt, { role: side, round });
  }

  private async runJudgeTurn(
    judge: Agent,
    proposition: string,
    round: number,
  ): Promise<void> {
    const prompt = buildJudgePrompt({ proposition, transcript: [...this.transcript] });
    await this.runAgent(judge, prompt, { role: "judge", round });
  }

  // Phase 2c: transcript tag so the VerdictPanel can identify each
  // turn's role + round without guessing by agent-index order.
  private async runAgent(
    agent: Agent,
    prompt: string,
    debateTag?: { role: "pro" | "con" | "judge"; round: number },
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

    const ABSOLUTE_MAX_MS = 20 * 60_000;
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
      const text = extractTextWithDiag(res, {
        runner: "debate-judge",
        agentId: agent.id,
        agentIndex: agent.index,
        logDiag: this.opts.logDiag,
      });
      const entry: TranscriptEntry = {
        id: randomUUID(),
        role: "agent",
        agentId: agent.id,
        agentIndex: agent.index,
        text,
        ts: Date.now(),
        // Phase 2c: VerdictPanel groups entries by round + role.
        summary: debateTag
          ? { kind: "debate_turn", round: debateTag.round, role: debateTag.role }
          : undefined,
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

export const DEFAULT_PROPOSITION = "This project is ready for production use.";

interface BuildDebaterPromptArgs {
  side: "pro" | "con";
  round: number;
  totalRounds: number;
  proposition: string;
  isFinalRound: boolean;
  transcript: readonly TranscriptEntry[];
}

export function buildDebaterPrompt(args: BuildDebaterPromptArgs): string {
  const { side, round, totalRounds, proposition, isFinalRound, transcript } = args;
  const role = side === "pro" ? "PRO (arguing FOR)" : "CON (arguing AGAINST)";
  const stance = side === "pro" ? "FOR" : "AGAINST";
  const agentIndex = side === "pro" ? 1 : 2;

  const transcriptText = transcript
    .map((e) => {
      if (e.role === "system") return `[SYSTEM] ${e.text}`;
      if (e.role === "user") return `[HUMAN] ${e.text}`;
      const label =
        e.agentIndex === 1 ? "PRO" : e.agentIndex === 2 ? "CON" : `Agent ${e.agentIndex}`;
      return `[${label}] ${e.text}`;
    })
    .join("\n\n");

  const roundBrief = isFinalRound
    ? "This is the FINAL round — make your closing statement. Summarize your strongest points, directly address your opponent's strongest points, and make clear WHY the judge should decide in your favor."
    : `This is round ${round} of ${totalRounds}. Make your strongest case this round. Rebut your opponent's prior argument specifically (quote or paraphrase a line they made) rather than talking past them.`;

  return [
    `You are Agent ${agentIndex}, the ${role} debater in a structured debate.`,
    `Proposition: "${proposition}"`,
    `Your job: argue ${stance} the proposition.`,
    roundBrief,
    "",
    "Your working directory IS the project clone — you may use file-read, grep, and find-files tools to gather evidence for your position.",
    "Keep responses under ~300 words. Cite file paths (e.g. `src/foo.ts:42`) where relevant — concrete evidence beats abstract argument.",
    "Do NOT flip sides. Do NOT concede the proposition — your role is adversarial. If the evidence genuinely contradicts your side, find a narrower framing that's still defensible.",
    "",
    "=== DEBATE TRANSCRIPT SO FAR ===",
    transcriptText || "(empty — you open the debate)",
    "=== END TRANSCRIPT ===",
    "",
    `Now respond as Agent ${agentIndex} (${role}).`,
  ].join("\n");
}

interface BuildJudgePromptArgs {
  proposition: string;
  transcript: readonly TranscriptEntry[];
}

export function buildJudgePrompt(args: BuildJudgePromptArgs): string {
  const { proposition, transcript } = args;
  const transcriptText = transcript
    .map((e) => {
      if (e.role === "system") return `[SYSTEM] ${e.text}`;
      if (e.role === "user") return `[HUMAN] ${e.text}`;
      const label =
        e.agentIndex === 1 ? "PRO" : e.agentIndex === 2 ? "CON" : `Agent ${e.agentIndex}`;
      return `[${label}] ${e.text}`;
    })
    .join("\n\n");

  return [
    "You are Agent 3, the JUDGE of a structured debate.",
    `Proposition: "${proposition}"`,
    "",
    "Your job: score the debate on the MERITS of the arguments presented, not on your prior opinion of the proposition. Score independently — a weaker argument for the 'correct' side should lose to a stronger argument for the 'wrong' side.",
    "",
    "Produce a verdict in this shape (prose, not JSON):",
    "1. One-paragraph summary of each side's strongest argument (PRO, then CON).",
    "2. Your assessment of where each side was weakest.",
    "3. Verdict: PRO WINS, CON WINS, or TIE — with a one-sentence rationale citing which specific argument tipped the balance.",
    "4. Confidence: LOW / MEDIUM / HIGH — how clean the win was.",
    "",
    "Do NOT restate the proposition or the ground rules. Go straight into your summary.",
    "Cite debaters as 'PRO' / 'CON' (not Agent 1 / Agent 2) for readability.",
    "",
    "=== FULL DEBATE TRANSCRIPT ===",
    transcriptText,
    "=== END TRANSCRIPT ===",
    "",
    "Now deliver your verdict.",
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
