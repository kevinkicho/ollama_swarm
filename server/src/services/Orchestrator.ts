import { randomUUID } from "node:crypto";
import type { AgentManager, Agent } from "./AgentManager.js";
import type { RepoService } from "./RepoService.js";
import type {
  AgentState,
  SwarmEvent,
  SwarmPhase,
  SwarmStatus,
  TranscriptEntry,
} from "../types.js";

export interface OrchestratorOpts {
  manager: AgentManager;
  repos: RepoService;
  emit: (e: SwarmEvent) => void;
}

export interface RunConfig {
  repoUrl: string;
  localPath: string;
  agentCount: number;
  rounds: number;
  model: string;
}

export class Orchestrator {
  private transcript: TranscriptEntry[] = [];
  private phase: SwarmPhase = "idle";
  private round = 0;
  private stopping = false;
  private active?: RunConfig;

  constructor(private readonly opts: OrchestratorOpts) {}

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

    this.setPhase("seeding");
    await this.seed(destPath, cfg);

    this.setPhase("discussing");
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
      const msg = err instanceof Error ? err.message : String(err);
      this.opts.emit({ type: "error", message: msg });
    } finally {
      if (!this.stopping) this.setPhase("completed");
    }
  }

  private async runTurn(agent: Agent, round: number, totalRounds: number): Promise<void> {
    this.opts.manager.markStatus(agent.id, "thinking");
    this.emitAgentState({ id: agent.id, index: agent.index, port: agent.port, sessionId: agent.sessionId, status: "thinking" });

    const prompt = this.buildPrompt(agent, round, totalRounds);
    // Instead of a wall-clock cap, watch the session's event activity. As long
    // as we see SSE events for this session (streaming tokens, tool calls,
    // message updates), we keep waiting. Only bail if the session has been
    // completely silent for IDLE_CAP_MS — that means it's genuinely stuck.
    const IDLE_CAP_MS = 120_000;
    const ABSOLUTE_MAX_MS = 20 * 60_000;
    const turnStart = Date.now();
    this.opts.manager.touchActivity(agent.sessionId, turnStart);

    const controller = new AbortController();
    let abortedReason: string | null = null;
    const watchdog = setInterval(() => {
      const now = Date.now();
      const last = this.opts.manager.getLastActivity(agent.sessionId) ?? turnStart;
      if (now - last > IDLE_CAP_MS) {
        abortedReason = `silent for ${Math.round((now - last) / 1000)}s`;
      } else if (now - turnStart > ABSOLUTE_MAX_MS) {
        abortedReason = `absolute turn cap hit (${ABSOLUTE_MAX_MS / 1000}s)`;
      }
      if (abortedReason) {
        controller.abort(new Error(abortedReason));
        // Tell opencode to stop working on this session too — otherwise the
        // backend keeps burning compute on a result we're about to discard.
        void agent.client.session.abort({ path: { id: agent.sessionId } }).catch(() => {});
      }
    }, 5_000);

    try {
      const res = await agent.client.session.prompt({
        path: { id: agent.sessionId },
        body: {
          model: { providerID: "ollama", modelID: agent.model },
          parts: [{ type: "text", text: prompt }],
        },
        signal: controller.signal,
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
        return `[Agent ${e.agentIndex}] ${e.text}`;
      })
      .join("\n\n");

    return [
      `You are Agent ${agent.index} in a swarm of collaborating AI engineers reviewing a cloned GitHub project.`,
      `This is discussion round ${round} of ${totalRounds}.`,
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
      `Now respond as Agent ${agent.index}.`,
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
