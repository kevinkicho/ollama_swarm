import { randomUUID } from "node:crypto";
import type { Agent } from "../../services/AgentManager.js";
import type {
  AgentState,
  SwarmEvent,
  SwarmPhase,
  SwarmStatus,
  TranscriptEntry,
} from "../../types.js";
import type { RunConfig, RunnerOpts, SwarmRunner } from "../SwarmRunner.js";
import { Board } from "./Board.js";
import { createBoardBroadcaster, type BoardBroadcaster } from "./boardBroadcaster.js";
import {
  buildPlannerUserPrompt,
  buildRepairPrompt,
  parsePlannerResponse,
  PLANNER_SYSTEM_PROMPT,
  type PlannerSeed,
} from "./prompts/planner.js";

// Blackboard preset, Phase 3: planner-only. One agent reads the repo tour and
// posts TODOs to the board. No workers, no file edits — that's Phase 4+.
//
// Lifecycle: cloning -> spawning -> seeding -> planning -> completed.
// Stop at any point aborts the in-flight prompt and kills the planner agent.
export class BlackboardRunner implements SwarmRunner {
  private transcript: TranscriptEntry[] = [];
  private phase: SwarmPhase = "idle";
  private round = 0;
  private stopping = false;
  private active?: RunConfig;
  private board: Board;
  private boardBroadcaster: BoardBroadcaster;
  private plannerAbort?: AbortController;

  constructor(private readonly opts: RunnerOpts) {
    this.boardBroadcaster = createBoardBroadcaster(this.opts.emit);
    this.board = new Board({ emit: this.boardBroadcaster.emit });
    this.boardBroadcaster.bindBoard(this.board);
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

    this.setPhase("cloning");
    const { destPath } = await this.opts.repos.clone({
      url: cfg.repoUrl,
      destPath: cfg.localPath,
    });
    await this.opts.repos.writeOpencodeConfig(destPath, cfg.model);
    this.appendSystem(`Cloned ${cfg.repoUrl} -> ${destPath}`);

    this.setPhase("spawning");
    // Phase 3: one planner agent. Workers are Phase 4. cfg.agentCount is
    // recorded on the active config for future phases but currently unused.
    const planner = await this.opts.manager.spawnAgent({
      cwd: destPath,
      index: 1,
      model: cfg.model,
    });
    this.appendSystem(`Planner agent ready on port ${planner.port}`);

    this.setPhase("seeding");
    const seed = await this.buildSeed(destPath, cfg);
    this.appendSystem(
      `Seed: ${seed.topLevel.length} top-level entries, README ${
        seed.readmeExcerpt ? `${seed.readmeExcerpt.length} chars` : "(missing)"
      }.`,
    );

    this.setPhase("planning");
    // Fire the planner loop in the background so the HTTP POST that triggered
    // start() can return immediately. The UI watches progress over /ws.
    void this.planAndFinalize(planner, seed);
  }

  private async planAndFinalize(agent: Agent, seed: PlannerSeed): Promise<void> {
    try {
      await this.runPlanner(agent, seed);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.opts.emit({ type: "error", message: `planner failed: ${msg}` });
      this.appendSystem(`Planner failed: ${msg}`);
    }
    // Ensure the final snapshot lands even if the debounce timer hasn't fired.
    this.boardBroadcaster.flushSnapshot();
    if (!this.stopping) this.setPhase("completed");
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.setPhase("stopping");
    this.plannerAbort?.abort(new Error("user stop"));
    await this.opts.manager.killAll();
    this.boardBroadcaster.dispose();
    this.setPhase("stopped");
  }

  private async buildSeed(clonePath: string, cfg: RunConfig): Promise<PlannerSeed> {
    const topLevel = (await this.opts.repos.listTopLevel(clonePath)).slice(0, 200);
    const readmeExcerpt = await this.opts.repos.readReadme(clonePath);
    return {
      repoUrl: cfg.repoUrl,
      clonePath,
      topLevel,
      readmeExcerpt,
    };
  }

  private async runPlanner(agent: Agent, seed: PlannerSeed): Promise<void> {
    const firstResponse = await this.promptPlanner(
      agent,
      `${PLANNER_SYSTEM_PROMPT}\n\n${buildPlannerUserPrompt(seed)}`,
    );
    if (this.stopping) return;
    this.appendAgent(agent, firstResponse);

    let parsed = parsePlannerResponse(firstResponse);
    if (!parsed.ok) {
      this.appendSystem(`Planner response did not parse (${parsed.reason}). Issuing repair prompt.`);
      const repairResponse = await this.promptPlanner(
        agent,
        `${PLANNER_SYSTEM_PROMPT}\n\n${buildRepairPrompt(firstResponse, parsed.reason)}`,
      );
      if (this.stopping) return;
      this.appendAgent(agent, repairResponse);
      parsed = parsePlannerResponse(repairResponse);
      if (!parsed.ok) {
        this.appendSystem(`Planner still invalid after repair (${parsed.reason}). Giving up this run.`);
        this.board.postFinding({
          agentId: agent.id,
          text: `Planner failed to produce valid JSON after one repair attempt. Last error: ${parsed.reason}`,
          createdAt: Date.now(),
        });
        return;
      }
    }

    if (parsed.dropped.length > 0) {
      this.appendSystem(
        `Dropped ${parsed.dropped.length} invalid todo(s): ${parsed.dropped
          .map((d) => d.reason)
          .join(" | ")}`,
      );
    }

    if (parsed.todos.length === 0) {
      this.appendSystem("Planner produced 0 valid todos.");
      this.board.postFinding({
        agentId: agent.id,
        text:
          parsed.dropped.length > 0
            ? `Planner returned only invalid todos (${parsed.dropped.length} dropped).`
            : "Planner returned an empty todo list — nothing actionable in the repo.",
        createdAt: Date.now(),
      });
      return;
    }

    const now = Date.now();
    for (const t of parsed.todos) {
      this.board.postTodo({
        description: t.description,
        expectedFiles: t.expectedFiles,
        createdBy: agent.id,
        createdAt: now,
      });
    }
    this.appendSystem(`Posted ${parsed.todos.length} todo(s) to the board.`);
  }

  // Same idle-watchdog pattern as RoundRobinRunner: wait as long as the session
  // is making progress (any SSE event counts), bail only on true silence.
  private async promptPlanner(agent: Agent, prompt: string): Promise<string> {
    this.opts.manager.markStatus(agent.id, "thinking");
    this.emitAgentState({
      id: agent.id,
      index: agent.index,
      port: agent.port,
      sessionId: agent.sessionId,
      status: "thinking",
    });

    const IDLE_CAP_MS = 120_000;
    const ABSOLUTE_MAX_MS = 20 * 60_000;
    const turnStart = Date.now();
    this.opts.manager.touchActivity(agent.sessionId, turnStart);

    const controller = new AbortController();
    this.plannerAbort = controller;
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
      const text = this.extractText(res) ?? "";
      this.opts.emit({ type: "agent_streaming_end", agentId: agent.id });
      this.opts.manager.markStatus(agent.id, "ready", { lastMessageAt: Date.now() });
      this.emitAgentState({
        id: agent.id,
        index: agent.index,
        port: agent.port,
        sessionId: agent.sessionId,
        status: "ready",
        lastMessageAt: Date.now(),
      });
      return text;
    } catch (err) {
      const msg = abortedReason ?? this.describeSdkError(err);
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
      throw new Error(msg);
    } finally {
      clearInterval(watchdog);
      if (this.plannerAbort === controller) this.plannerAbort = undefined;
    }
  }

  private appendSystem(text: string): void {
    const entry: TranscriptEntry = { id: randomUUID(), role: "system", text, ts: Date.now() };
    this.transcript.push(entry);
    this.opts.emit({ type: "transcript_append", entry });
  }

  private appendAgent(agent: Agent, text: string): void {
    const entry: TranscriptEntry = {
      id: randomUUID(),
      role: "agent",
      agentId: agent.id,
      agentIndex: agent.index,
      text: text || "(empty response)",
      ts: Date.now(),
    };
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
      const texts = parts
        .filter((p) => p?.type === "text" && typeof p.text === "string")
        .map((p) => p.text as string);
      if (texts.length) return texts.join("\n");
    }
    return any?.data?.text;
  }
}
