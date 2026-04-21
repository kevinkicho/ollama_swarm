import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
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
import type { Todo } from "./types.js";
import {
  buildWorkerRepairPrompt,
  buildWorkerUserPrompt,
  parseWorkerResponse,
  WORKER_SYSTEM_PROMPT,
  type WorkerSeed,
} from "./prompts/worker.js";

// Blackboard preset: planner posts TODOs, workers drain them in a
// claim/execute loop. Workers produce full-file diffs as JSON. Phase 4 is a
// dry-run — no real file writes happen. Workers hash + prompt + parse diffs
// and then pass the CAS check trivially since nothing on disk changes.
//
// Lifecycle: cloning -> spawning -> seeding -> planning -> executing -> completed.
// Stop at any point aborts in-flight prompts, kills agents, frees ports.

const CLAIM_TTL_MS = 10 * 60_000;
const CLAIM_EXPIRY_INTERVAL_MS = 30_000;
const WORKER_POLL_MS = 2_000;
const WORKER_POLL_JITTER_MS = 500;
const WORKER_COOLDOWN_MS = 5_000;
// Safety valve so a broken board/prompt doesn't spin a worker forever. Real
// stop conditions (wall-clock, commit cap) land in Phase 7.
const MAX_WORKER_ITERATIONS = 50;
// No "idle silence" cap. OpenCode's SSE /event stream is observed to stay
// completely silent across session.prompt's entire duration for our setup, so
// there is no reliable activity signal to gate on. We rely solely on the
// absolute turn cap below — if a prompt hasn't returned in 20 minutes, abort.
const ABSOLUTE_MAX_MS = 20 * 60_000;

export class BlackboardRunner implements SwarmRunner {
  private transcript: TranscriptEntry[] = [];
  private phase: SwarmPhase = "idle";
  private round = 0;
  private stopping = false;
  private active?: RunConfig;
  private board: Board;
  private boardBroadcaster: BoardBroadcaster;
  // Every in-flight prompt registers its AbortController so stop() can abort
  // them all at once without needing to know about planner vs worker.
  private activeAborts = new Set<AbortController>();
  private expiryTimer?: NodeJS.Timeout;

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
    // Planner is always index 1. Workers take 2..N. If the user picks
    // agentCount=1 there are no workers — planner posts TODOs, nothing drains
    // them, and we transition straight to completed. Documented in README.
    const planner = await this.opts.manager.spawnAgent({
      cwd: destPath,
      index: 1,
      model: cfg.model,
    });
    this.appendSystem(`Planner agent ready on port ${planner.port}`);

    const workerCount = Math.max(0, cfg.agentCount - 1);
    const workers: Agent[] = [];
    if (workerCount > 0) {
      // Parallel spawn: each opencode serve takes a few seconds to boot,
      // sequential would compound that for every extra worker.
      const workerSpawns = Array.from({ length: workerCount }, (_, i) =>
        this.opts.manager.spawnAgent({ cwd: destPath, index: 2 + i, model: cfg.model }),
      );
      const spawned = await Promise.all(workerSpawns);
      workers.push(...spawned);
      for (const w of workers) this.appendSystem(`Worker agent ${w.id} ready on port ${w.port}`);
    } else {
      this.appendSystem("No workers spawned (agentCount=1). Planner will post TODOs, nothing will drain them.");
    }

    this.setPhase("seeding");
    const seed = await this.buildSeed(destPath, cfg);
    this.appendSystem(
      `Seed: ${seed.topLevel.length} top-level entries, README ${
        seed.readmeExcerpt ? `${seed.readmeExcerpt.length} chars` : "(missing)"
      }.`,
    );

    this.setPhase("planning");
    // Background so the HTTP POST that triggered start() returns immediately.
    // The UI watches progress over /ws.
    void this.planAndExecute(planner, workers, seed);
  }

  private async planAndExecute(
    planner: Agent,
    workers: Agent[],
    seed: PlannerSeed,
  ): Promise<void> {
    let errored = false;
    try {
      await this.runPlanner(planner, seed);
      if (this.stopping) return;
      if (workers.length > 0 && this.board.counts().open > 0) {
        this.setPhase("executing");
        this.startClaimExpiry();
        await this.runWorkers(workers);
      }
    } catch (err) {
      errored = true;
      const msg = err instanceof Error ? err.message : String(err);
      this.opts.emit({ type: "error", message: `blackboard run failed: ${msg}` });
      this.appendSystem(`Run failed: ${msg}`);
    } finally {
      this.stopClaimExpiry();
    }
    // Ensure the final snapshot lands even if the debounce timer hasn't fired.
    this.boardBroadcaster.flushSnapshot();
    if (this.stopping) return;
    this.setPhase(errored ? "failed" : "completed");
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.setPhase("stopping");
    this.stopClaimExpiry();
    for (const ctrl of this.activeAborts) {
      try {
        ctrl.abort(new Error("user stop"));
      } catch {
        // ignore — best-effort
      }
    }
    this.activeAborts.clear();
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

  // ---------------------------------------------------------------------
  // Planner
  // ---------------------------------------------------------------------

  private async runPlanner(agent: Agent, seed: PlannerSeed): Promise<void> {
    const firstResponse = await this.promptAgent(
      agent,
      `${PLANNER_SYSTEM_PROMPT}\n\n${buildPlannerUserPrompt(seed)}`,
    );
    if (this.stopping) return;
    this.appendAgent(agent, firstResponse);

    let parsed = parsePlannerResponse(firstResponse);
    if (!parsed.ok) {
      this.appendSystem(`Planner response did not parse (${parsed.reason}). Issuing repair prompt.`);
      const repairResponse = await this.promptAgent(
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

  // ---------------------------------------------------------------------
  // Workers (Phase 4: dry-run — no file writes)
  // ---------------------------------------------------------------------

  private async runWorkers(workers: Agent[]): Promise<void> {
    await Promise.all(workers.map((w) => this.runWorker(w)));
  }

  private async runWorker(agent: Agent): Promise<void> {
    let iterations = 0;
    while (!this.stopping && iterations < MAX_WORKER_ITERATIONS) {
      iterations++;
      // Jittered poll so N workers don't hit the board in lockstep.
      const jitter = Math.floor(Math.random() * WORKER_POLL_JITTER_MS);
      await this.sleep(WORKER_POLL_MS + jitter);
      if (this.stopping) return;

      const counts = this.board.counts();
      // Nothing left for this worker to do and no one else holding a claim
      // that could release back to open (Phase 4 stales are terminal).
      if (counts.open === 0 && counts.claimed === 0) return;
      if (counts.open === 0) continue;

      const todo = this.board.findOpenTodo();
      if (!todo) continue;

      const outcome = await this.executeWorkerTodo(agent, todo);
      if (outcome === "committed") {
        // Cooldown so one worker doesn't monopolize the board. Random jitter
        // helps desync workers that all finished around the same time.
        await this.sleep(WORKER_COOLDOWN_MS + Math.floor(Math.random() * 500));
      }
    }
    if (iterations >= MAX_WORKER_ITERATIONS) {
      this.appendSystem(`[${agent.id}] hit max-iteration safety valve (${MAX_WORKER_ITERATIONS})`);
    }
  }

  private async executeWorkerTodo(
    agent: Agent,
    todo: Todo,
  ): Promise<"committed" | "stale" | "lost-race" | "aborted"> {
    // Hash files BEFORE claiming so the claim records the CAS baseline. If we
    // lose the race with another worker, we throw away the hashes but the
    // operation was read-only so no harm done.
    let hashes: Record<string, string>;
    try {
      hashes = await this.hashExpectedFiles(todo.expectedFiles);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Can't even hash the paths — usually means path escape or a bad
      // planner output. Mark stale so Phase 6 replan can see it.
      this.appendSystem(`[${agent.id}] cannot hash todo "${truncate(todo.description)}": ${msg}`);
      this.board.markStale(todo.id, `hash failure: ${msg}`);
      return "stale";
    }

    const now = Date.now();
    const claim = this.board.claimTodo({
      todoId: todo.id,
      agentId: agent.id,
      fileHashes: hashes,
      claimedAt: now,
      expiresAt: now + CLAIM_TTL_MS,
    });
    if (!claim.ok) {
      // Another worker got it or it went stale/committed between find and claim.
      // Back off briefly to desync from whoever won.
      return "lost-race";
    }

    // Read current contents to feed the prompt. Use the same resolve-safe
    // check so we never leak anything outside the clone via a symlink.
    let contents: Record<string, string | null>;
    try {
      contents = await this.readExpectedFiles(todo.expectedFiles);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.board.markStale(todo.id, `read failure: ${msg}`);
      return "stale";
    }

    const seed: WorkerSeed = {
      todoId: todo.id,
      description: todo.description,
      expectedFiles: todo.expectedFiles,
      fileContents: contents,
    };

    let response: string;
    try {
      response = await this.promptAgent(agent, `${WORKER_SYSTEM_PROMPT}\n\n${buildWorkerUserPrompt(seed)}`);
    } catch (err) {
      if (this.stopping) return "aborted";
      const msg = err instanceof Error ? err.message : String(err);
      this.board.markStale(todo.id, `worker prompt failed: ${msg}`);
      return "stale";
    }
    if (this.stopping) return "aborted";
    this.appendAgent(agent, response);

    let parsed = parseWorkerResponse(response, todo.expectedFiles);
    if (!parsed.ok) {
      this.appendSystem(`[${agent.id}] worker JSON invalid (${parsed.reason}); issuing repair prompt.`);
      let repair: string;
      try {
        repair = await this.promptAgent(
          agent,
          `${WORKER_SYSTEM_PROMPT}\n\n${buildWorkerRepairPrompt(response, parsed.reason)}`,
        );
      } catch (err) {
        if (this.stopping) return "aborted";
        const msg = err instanceof Error ? err.message : String(err);
        this.board.markStale(todo.id, `worker repair prompt failed: ${msg}`);
        return "stale";
      }
      if (this.stopping) return "aborted";
      this.appendAgent(agent, repair);
      parsed = parseWorkerResponse(repair, todo.expectedFiles);
      if (!parsed.ok) {
        this.board.markStale(todo.id, `worker produced invalid JSON after repair: ${parsed.reason}`);
        return "stale";
      }
    }

    if (parsed.skip) {
      this.appendSystem(`[${agent.id}] worker declined todo: ${parsed.skip}`);
      // Mark stale (not skipped) so Phase 6 replan can decide whether to
      // re-prompt or formally skip it. Skipped is a human/planner decision.
      this.board.markStale(todo.id, `worker declined: ${parsed.skip}`);
      return "stale";
    }

    if (parsed.diffs.length === 0) {
      this.board.markStale(todo.id, "worker returned empty diffs with no skip reason");
      return "stale";
    }

    // Phase 4 dry-run: log what would be written and trivially pass CAS.
    // Hashes haven't moved (no one writes), so commitTodo accepts them.
    // Phase 5 replaces this block with a real re-hash + write loop.
    const summary = parsed.diffs.map((d) => `${d.file} (${d.newText.length} chars)`).join(", ");
    this.appendSystem(`[${agent.id}] would commit: ${summary}`);

    const commit = this.board.commitTodo({
      todoId: todo.id,
      agentId: agent.id,
      currentHashes: hashes,
      committedAt: Date.now(),
    });
    if (!commit.ok) {
      this.appendSystem(`[${agent.id}] unexpected dry-run commit refusal: ${commit.reason}`);
      this.board.markStale(todo.id, `commit refused: ${commit.reason}`);
      return "stale";
    }
    return "committed";
  }

  // ---------------------------------------------------------------------
  // File I/O helpers
  // ---------------------------------------------------------------------

  private async hashExpectedFiles(files: string[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const f of files) out[f] = await this.hashFile(f);
    return out;
  }

  private async hashFile(relPath: string): Promise<string> {
    const abs = this.resolveSafe(relPath);
    try {
      const buf = await fs.readFile(abs);
      return createHash("sha256").update(buf).digest("hex");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw err;
    }
  }

  private async readExpectedFiles(files: string[]): Promise<Record<string, string | null>> {
    const out: Record<string, string | null> = {};
    for (const f of files) {
      const abs = this.resolveSafe(f);
      try {
        out[f] = await fs.readFile(abs, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          out[f] = null;
        } else {
          throw err;
        }
      }
    }
    return out;
  }

  // Reject paths that escape the clone or point inside .git. This runs even
  // in Phase 4 dry-run because bad paths break hashing/reading.
  private resolveSafe(relPath: string): string {
    const clone = this.active?.localPath;
    if (!clone) throw new Error("no active clone path");
    if (path.isAbsolute(relPath)) throw new Error(`absolute path not allowed: ${relPath}`);
    const abs = path.resolve(clone, relPath);
    const rel = path.relative(clone, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`path escapes clone: ${relPath}`);
    }
    // normalize to forward-slash so Windows and POSIX both hit the same check
    const parts = rel.split(/[\\/]/);
    if (parts.includes(".git")) throw new Error(`path inside .git: ${relPath}`);
    return abs;
  }

  // ---------------------------------------------------------------------
  // Expiry watchdog
  // ---------------------------------------------------------------------

  private startClaimExpiry(): void {
    if (this.expiryTimer) return;
    this.expiryTimer = setInterval(() => {
      const expired = this.board.expireClaims(Date.now());
      if (expired.length > 0) {
        this.appendSystem(`Expired ${expired.length} stale claim(s) past TTL`);
      }
    }, CLAIM_EXPIRY_INTERVAL_MS);
    this.expiryTimer.unref?.();
  }

  private stopClaimExpiry(): void {
    if (this.expiryTimer) clearInterval(this.expiryTimer);
    this.expiryTimer = undefined;
  }

  // ---------------------------------------------------------------------
  // Prompting
  // ---------------------------------------------------------------------

  // Absolute-cap-only watchdog. No idle-silence detection because OpenCode
  // doesn't forward usable activity events for our ollama provider setup.
  private async promptAgent(agent: Agent, prompt: string): Promise<string> {
    this.opts.manager.markStatus(agent.id, "thinking");
    this.emitAgentState({
      id: agent.id,
      index: agent.index,
      port: agent.port,
      sessionId: agent.sessionId,
      status: "thinking",
    });

    const turnStart = Date.now();
    this.opts.manager.touchActivity(agent.sessionId, turnStart);

    const controller = new AbortController();
    this.activeAborts.add(controller);
    let abortedReason: string | null = null;

    const watchdog = setInterval(() => {
      if (Date.now() - turnStart > ABSOLUTE_MAX_MS) {
        abortedReason = `absolute turn cap hit (${ABSOLUTE_MAX_MS / 1000}s)`;
        controller.abort(new Error(abortedReason));
        void agent.client.session.abort({ path: { id: agent.sessionId } }).catch(() => {});
      }
    }, 10_000);
    watchdog.unref?.();

    try {
      const res = await agent.client.session.prompt({
        path: { id: agent.sessionId },
        body: {
          agent: "swarm",
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
      this.activeAborts.delete(controller);
    }
  }

  // ---------------------------------------------------------------------
  // Misc helpers
  // ---------------------------------------------------------------------

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
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

function truncate(s: string, max = 80): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}
