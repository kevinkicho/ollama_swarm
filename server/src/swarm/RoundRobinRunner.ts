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
import { roleForAgent, type SwarmRole } from "./roles.js";
import { promptWithRetry } from "./promptWithRetry.js";
import { AgentStatsCollector } from "./agentStatsCollector.js";
import { buildDiscussionSummary, writeRunSummary } from "./runSummary.js";

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
  private readonly roles?: readonly SwarmRole[];
  // Unit 33: cross-preset metrics. Collector aggregates per-agent
  // counters (turns, attempts, retries, latencies) via the same
  // onTiming/onRetry hooks promptWithRetry already surfaces. startedAt
  // is stamped once the discussing loop begins so wall-clock excludes
  // clone + spawn (mirrors BlackboardRunner.runStartedAt scoping).
  private stats = new AgentStatsCollector();
  private startedAt?: number;
  private summaryWritten = false;

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
    return this.phase !== "idle" && this.phase !== "stopped";
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
    const { destPath } = await this.opts.repos.clone({ url: cfg.repoUrl, destPath: cfg.localPath });
    await this.opts.repos.writeOpencodeConfig(destPath, cfg.model);
    this.appendSystem(`Cloned ${cfg.repoUrl} -> ${destPath}`);

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
    this.appendSystem(`${ready.length}/${cfg.agentCount} agents ready on ports ${ready.map((a) => a.port).join(", ")}`);
    // Unit 33: register the spawned roster so buildPerAgentStats still
    // produces rows after AgentManager.killAll() clears its own roster.
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

        const agents = this.opts.manager.list();
        for (const agent of agents) {
          if (this.stopping) break;
          await this.runTurn(agent, r, cfg.rounds);
        }
      }
      if (!this.stopping) this.appendSystem("Discussion complete.");
    } catch (err) {
      crashMessage = err instanceof Error ? err.message : String(err);
      this.opts.emit({ type: "error", message: crashMessage });
    } finally {
      // Unit 33: write summary.json at termination so any preset run
      // can be compared via scripts/compare-runs.mjs. Write BEFORE the
      // terminal setPhase so a UI observer reacting to "completed" can
      // trust the file is already on disk.
      await this.writeSummary(cfg, crashMessage);
      if (!this.stopping) this.setPhase("completed");
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
    let gitStatus = { porcelain: "", changedFiles: 0 };
    try {
      gitStatus = await this.opts.repos.gitStatus(cfg.localPath);
    } catch {
      // gitStatus already swallows; extra belt.
    }
    const summary = buildDiscussionSummary({
      config: {
        repoUrl: cfg.repoUrl,
        localPath: cfg.localPath,
        preset: cfg.preset,
        model: cfg.model,
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

  private async runTurn(agent: Agent, round: number, totalRounds: number): Promise<void> {
    this.opts.manager.markStatus(agent.id, "thinking");
    this.emitAgentState({ id: agent.id, index: agent.index, port: agent.port, sessionId: agent.sessionId, status: "thinking", thinkingSince: Date.now() });
    // Unit 33: one turn = one call to runTurn (retries inside
    // promptWithRetry don't bump this; onTiming counts those separately).
    this.stats.countTurn(agent.id);

    const prompt = this.buildPrompt(agent, round, totalRounds);
    // No "idle silence" cap. OpenCode's SSE /event stream is observed to stay
    // completely silent across session.prompt's entire duration for our setup, so
    // there is no reliable activity signal to gate on. We rely solely on the
    // absolute turn cap below — if a prompt hasn't returned in 20 minutes, abort.
    const ABSOLUTE_MAX_MS = 20 * 60_000;
    const turnStart = Date.now();
    this.opts.manager.touchActivity(agent.sessionId, turnStart);

    const controller = new AbortController();
    let abortedReason: string | null = null;
    const watchdog = setInterval(() => {
      if (Date.now() - turnStart > ABSOLUTE_MAX_MS) {
        abortedReason = `absolute turn cap hit (${ABSOLUTE_MAX_MS / 1000}s)`;
        controller.abort(new Error(abortedReason));
        // Tell opencode to stop working on this session too — otherwise the
        // backend keeps burning compute on a result we're about to discard.
        void agent.client.session.abort({ path: { id: agent.sessionId } }).catch(() => {});
      }
    }, 10_000);

    try {
      // Unit 16: shared retry wrapper. Same retry semantics as
      // BlackboardRunner — UND_ERR_HEADERS_TIMEOUT and friends get up
      // to 3 attempts with [4s, 16s] backoff before giving up.
      const res = await promptWithRetry(agent, prompt, {
        signal: controller.signal,
        // Unit 20: read-only tools (file-read / grep / glob / list).
        // Discussion-only presets — never edits.
        agentName: "swarm-read",
        describeError: (e) => this.describeSdkError(e),
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

      const text = this.extractText(res) ?? "(empty response)";
      const entry: TranscriptEntry = {
        id: randomUUID(),
        role: "agent",
        agentId: agent.id,
        agentIndex: agent.index,
        text,
        ts: Date.now(),
      };
      this.transcript.push(entry);
      this.opts.emit({ type: "transcript_append", entry });
      this.opts.emit({ type: "agent_streaming_end", agentId: agent.id });
      this.opts.manager.markStatus(agent.id, "ready", { lastMessageAt: entry.ts });
      this.emitAgentState({ id: agent.id, index: agent.index, port: agent.port, sessionId: agent.sessionId, status: "ready", lastMessageAt: entry.ts });
    } catch (err) {
      const msg = abortedReason ?? this.describeSdkError(err);
      this.appendSystem(`[${agent.id}] error: ${msg}`);
      this.opts.emit({ type: "agent_streaming_end", agentId: agent.id });
      this.opts.manager.markStatus(agent.id, "failed", { error: msg });
      this.emitAgentState({ id: agent.id, index: agent.index, port: agent.port, sessionId: agent.sessionId, status: "failed", error: msg });
    } finally {
      clearInterval(watchdog);
    }
  }

  private buildPrompt(agent: Agent, round: number, totalRounds: number): string {
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
      : `You are Agent ${agent.index} in a swarm of collaborating AI engineers reviewing a cloned GitHub project.`;
    const roleGuidance = role ? [`As the ${role.name}: ${role.guidance}`, ""] : [];

    return [
      header,
      `This is discussion round ${round} of ${totalRounds}.`,
      ...roleGuidance,
      "Your working directory IS the project clone — use file-read, grep, and find-files tools to inspect it.",
      "Round 1: skim README.md and the top-level tree before opining. Later rounds: only re-read files when a peer's claim needs checking.",
      "Keep responses under ~250 words. Be specific. Cite file paths (e.g. `src/foo.ts:42`) when you reference code.",
      "You may @mention another agent (e.g. @Agent2) to address them directly.",
      "",
      "Goals of this discussion:",
      "1. Figure out what this project is and who it is for.",
      "2. Identify what is working and what is missing.",
      "3. Propose one concrete next action the swarm should take.",
      "",
      "=== SHARED TRANSCRIPT ===",
      transcriptText || "(empty — you are first to speak)",
      "=== END TRANSCRIPT ===",
      "",
      role
        ? `Now respond as Agent ${agent.index} (${role.name}), through the lens of your role.`
        : `Now respond as Agent ${agent.index}.`,
    ].join("\n");
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
    this.opts.emit({ type: "agent_state", agent: s });
  }

  private describeSdkError(err: unknown): string {
    if (err instanceof Error) {
      // "fetch failed" is the generic undici wrapper — the useful detail lives on
      // err.cause (ECONNRESET, ETIMEDOUT, socket hang up, etc.). Chase the chain.
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
      const o = err as { name?: string; message?: string; data?: unknown };
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

  private extractText(res: unknown): string | undefined {
    const any = res as {
      data?: {
        parts?: Array<{ type?: string; text?: string }>;
        info?: { parts?: Array<{ type?: string; text?: string }> };
        text?: string;
      };
    };
    const parts = any?.data?.parts ?? any?.data?.info?.parts;
    if (Array.isArray(parts)) {
      const texts = parts.filter((p) => p?.type === "text" && typeof p.text === "string").map((p) => p.text as string);
      if (texts.length) return texts.join("\n");
    }
    return any?.data?.text;
  }
}
