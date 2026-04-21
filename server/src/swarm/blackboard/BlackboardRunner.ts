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
import { checkCaps } from "./caps.js";
import { buildCrashSnapshot } from "./crashSnapshot.js";
import { findBomPrefixed, findZeroedFiles } from "./diffValidation.js";
import { resolveSafe } from "./resolveSafe.js";
import { writeFileAtomic } from "./writeFileAtomic.js";
import {
  buildPlannerUserPrompt,
  buildRepairPrompt,
  parsePlannerResponse,
  PLANNER_SYSTEM_PROMPT,
  type PlannerSeed,
} from "./prompts/planner.js";
import {
  buildReplannerRepairPrompt,
  buildReplannerUserPrompt,
  parseReplannerResponse,
  REPLANNER_SYSTEM_PROMPT,
  type ReplannerSeed,
} from "./prompts/replanner.js";
import type { BoardEvent, Todo } from "./types.js";
import {
  buildWorkerRepairPrompt,
  buildWorkerUserPrompt,
  parseWorkerResponse,
  WORKER_SYSTEM_PROMPT,
  type WorkerSeed,
} from "./prompts/worker.js";

// Blackboard preset: planner posts TODOs, workers drain them in a
// claim/execute loop. Workers produce full-file diffs as JSON; the runner
// does an optimistic-CAS re-hash at commit time, writes each diff via
// tmp+rename, then records the commit on the board.
//
// Lifecycle: cloning -> spawning -> seeding -> planning -> executing -> completed.
// Stop at any point aborts in-flight prompts, kills agents, frees ports.

const CLAIM_TTL_MS = 10 * 60_000;
const CLAIM_EXPIRY_INTERVAL_MS = 30_000;
const WORKER_POLL_MS = 2_000;
const WORKER_POLL_JITTER_MS = 500;
const WORKER_COOLDOWN_MS = 5_000;
// Phase 6: after this many replans, stop trying and mark the todo skipped.
// Keeps a pathological todo from burning planner turns indefinitely.
const MAX_REPLAN_ATTEMPTS = 3;
// Fallback sweep in case the event path missed a stale (e.g. replanOne threw).
const REPLAN_FALLBACK_TICK_MS = 20_000;
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
  // Phase 6: replan orchestration. Planner is captured during executing and
  // reused to replan stale todos — see docs/known-limitations.md.
  private planner?: Agent;
  private replanPending = new Set<string>();
  private replanRunning = false;
  private replanTickTimer?: NodeJS.Timeout;
  // Phase 7: hard-cap state. runStartedAt is stamped when executing begins so
  // the wall-clock cap is scoped to the worker loop (planning time doesn't
  // count). terminationReason is set by the cap-enforcement helper so the
  // finally block can tell "user pressed stop" (phase → stopped) apart from
  // "cap tripped and asked us to stop" (phase → completed, with a transcript
  // note explaining which cap).
  private runStartedAt?: number;
  private terminationReason?: string;

  constructor(private readonly opts: RunnerOpts) {
    this.boardBroadcaster = createBoardBroadcaster(this.opts.emit);
    this.board = new Board({
      emit: (ev) => {
        this.boardBroadcaster.emit(ev);
        this.onBoardEvent(ev);
      },
    });
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
    this.runStartedAt = undefined;
    this.terminationReason = undefined;
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
        // Stamp the wall-clock origin just before caps start being checked.
        // Planning time (seeding, initial planner prompt, repair) does NOT
        // count toward the cap — the cap is a worker-loop guard, not a total
        // run guard.
        this.runStartedAt = Date.now();
        this.setPhase("executing");
        this.startClaimExpiry();
        this.planner = planner;
        this.startReplanWatcher();
        await this.runWorkers(workers);
      }
    } catch (err) {
      errored = true;
      const msg = err instanceof Error ? err.message : String(err);
      this.opts.emit({ type: "error", message: `blackboard run failed: ${msg}` });
      this.appendSystem(`Run failed: ${msg}`);
      // Best-effort post-mortem. Awaited so the write lands before the
      // finally block flips phase to "failed" — a WS consumer watching for
      // the failed transition should be able to trust the artifact is
      // already on disk.
      await this.writeCrashSnapshot(err);
    } finally {
      this.stopClaimExpiry();
      this.stopReplanWatcher();
    }
    // Ensure the final snapshot lands even if the debounce timer hasn't fired.
    this.boardBroadcaster.flushSnapshot();
    // User-initiated stop: stop() sets phase to "stopping" → "stopped" itself,
    // so we bail. Cap-initiated stop also sets this.stopping, but we detect
    // that via terminationReason and fall through to setPhase("completed")
    // so the UI reflects the run actually finishing at the cap boundary.
    if (this.stopping && !this.terminationReason) return;
    this.setPhase(errored ? "failed" : "completed");
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.setPhase("stopping");
    this.stopClaimExpiry();
    this.stopReplanWatcher();
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
    while (!this.stopping) {
      // Jittered poll so N workers don't hit the board in lockstep.
      const jitter = Math.floor(Math.random() * WORKER_POLL_JITTER_MS);
      await this.sleep(WORKER_POLL_MS + jitter);
      if (this.stopping) return;

      // Phase 7: cap guard. Check BEFORE considering new work so we don't
      // burn another prompt right after a cap would have tripped. Sets
      // stopping=true under the hood, so the next loop iteration (if any)
      // exits cleanly; we also return early here for promptness.
      if (this.checkAndApplyCaps()) return;

      const counts = this.board.counts();
      // Nothing left to do: no open, nothing claimed, no stales, AND no
      // in-flight replan work. Stales can resurrect to open via replan, and
      // a slow replan can finish AFTER the last worker loop — so we must
      // also wait for replanPending to drain and replanRunning to clear,
      // otherwise a revised todo would be posted to an already-terminated
      // swarm and stuck at open forever.
      if (
        counts.open === 0 &&
        counts.claimed === 0 &&
        counts.stale === 0 &&
        this.replanPending.size === 0 &&
        !this.replanRunning
      ) {
        return;
      }
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

    // Phase 5: re-hash the claimed files; if any drifted since claim time,
    // mark the todo stale and bail without writing. Otherwise write each diff
    // via tmp+rename, then record the commit on the board.
    let currentHashes: Record<string, string>;
    try {
      currentHashes = await this.hashExpectedFiles(todo.expectedFiles);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.board.markStale(todo.id, `re-hash failure: ${msg}`);
      return "stale";
    }

    const mismatched: string[] = [];
    for (const [p, claimed] of Object.entries(hashes)) {
      if ((currentHashes[p] ?? "") !== claimed) mismatched.push(p);
    }
    if (mismatched.length > 0) {
      this.board.markStale(todo.id, `CAS mismatch before write: ${mismatched.join(", ")}`);
      return "stale";
    }

    // Block a worker from zeroing out a previously non-empty file. We use the
    // pre-prompt contents as "old" — CAS above already proved no one touched
    // these files since, so contents is current.
    const zeroed = findZeroedFiles(parsed.diffs, contents);
    if (zeroed.length > 0) {
      this.board.markStale(
        todo.id,
        `worker would zero non-empty file(s): ${zeroed.join(", ")}`,
      );
      return "stale";
    }

    // Reject leading UTF-8 BOMs. Writing one through silently breaks tooling
    // (git treats the file as unchanged, node parsers throw, linters lie).
    const bomFiles = findBomPrefixed(parsed.diffs);
    if (bomFiles.length > 0) {
      this.board.markStale(
        todo.id,
        `worker output has leading UTF-8 BOM in: ${bomFiles.join(", ")}`,
      );
      return "stale";
    }

    // CAS passed locally. Write atomically; on any write error we leave the
    // claim in place — TTL expiry will convert it to stale and Phase 6 replan
    // will observe whatever state the partial write left on disk.
    try {
      for (const diff of parsed.diffs) {
        await this.writeDiff(diff.file, diff.newText);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.appendSystem(`[${agent.id}] write failed mid-commit: ${msg}`);
      this.opts.emit({
        type: "error",
        message: `Write failed after CAS pass for todo ${todo.id}: ${msg}`,
      });
      this.board.markStale(todo.id, `write failed: ${msg}`);
      return "stale";
    }

    // Record on the board. Trivially passes CAS since nothing touched the
    // files between our re-hash above and these writes (same event-loop tick).
    const commit = this.board.commitTodo({
      todoId: todo.id,
      agentId: agent.id,
      currentHashes,
      committedAt: Date.now(),
    });
    if (!commit.ok) {
      // Unexpected: we just verified the hashes. Surface as an error and
      // mark stale so the run can continue.
      this.appendSystem(`[${agent.id}] unexpected commit refusal: ${commit.reason}`);
      this.board.markStale(todo.id, `commit refused after write: ${commit.reason}`);
      return "stale";
    }

    const summary = parsed.diffs.map((d) => `${d.file} (${d.newText.length} chars)`).join(", ");
    this.appendSystem(`[${agent.id}] committed: ${summary}`);
    return "committed";
  }

  // ---------------------------------------------------------------------
  // Phase 6 — replan orchestration
  //
  // Hook into Board events so every todo_stale enqueues the todo for replan.
  // processReplanQueue serializes through the planner agent (single session),
  // bumps replanCount via board.replan, or skips via board.skip. A fallback
  // tick sweeps the board for any stale the event path missed (e.g. if
  // replanOne itself threw mid-prompt).
  // ---------------------------------------------------------------------

  private onBoardEvent(ev: BoardEvent): void {
    if (ev.type !== "todo_stale") return;
    this.enqueueReplan(ev.todoId);
  }

  private enqueueReplan(todoId: string): void {
    if (this.replanPending.has(todoId)) return;
    this.replanPending.add(todoId);
    void this.processReplanQueue();
  }

  private async processReplanQueue(): Promise<void> {
    // One-at-a-time: the planner is a single agent with one session, so
    // parallel replans would interleave prompts on the same session.
    if (this.replanRunning) return;
    if (!this.planner) return;
    this.replanRunning = true;
    try {
      while (!this.stopping && this.replanPending.size > 0 && this.planner) {
        const todoId = this.replanPending.values().next().value as string;
        this.replanPending.delete(todoId);
        try {
          await this.replanOne(todoId);
        } catch (err) {
          // If replanOne crashes mid-prompt, don't kill the whole queue — but
          // also don't leave the todo hanging. The fallback tick would re-
          // enqueue a still-stale todo forever, which then prevents workers
          // from ever exiting (see shutdown-race fix). Mark it skipped so it
          // leaves in-flight state cleanly.
          const msg = err instanceof Error ? err.message : String(err);
          this.appendSystem(`Replan handler crashed on todo ${todoId}: ${msg}`);
          try {
            this.board.skip(todoId, `replanner crashed: ${msg}`);
          } catch {
            // skip can throw if the todo moved state meanwhile — ignore.
          }
        }
      }
    } finally {
      this.replanRunning = false;
    }
  }

  private async replanOne(todoId: string): Promise<void> {
    const planner = this.planner;
    if (!planner) return;
    const todo = this.board.listTodos().find((t) => t.id === todoId);
    if (!todo) return;
    // Dedup: the same todo could be enqueued twice. Only act if still stale.
    if (todo.status !== "stale") return;

    if (todo.replanCount >= MAX_REPLAN_ATTEMPTS) {
      this.board.skip(
        todoId,
        `auto-skipped: replan attempts exhausted (${todo.replanCount})`,
      );
      this.appendSystem(
        `Replan exhausted for todo ${todoId} after ${todo.replanCount} attempt(s). Skipped.`,
      );
      return;
    }

    let contents: Record<string, string | null>;
    try {
      contents = await this.readExpectedFiles(todo.expectedFiles);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.board.skip(todoId, `replanner unable to read files: ${msg}`);
      return;
    }

    const seed: ReplannerSeed = {
      todoId: todo.id,
      originalDescription: todo.description,
      originalExpectedFiles: todo.expectedFiles,
      staleReason: todo.staleReason ?? "(unknown)",
      fileContents: contents,
      replanCount: todo.replanCount,
    };

    let response: string;
    try {
      response = await this.promptAgent(
        planner,
        `${REPLANNER_SYSTEM_PROMPT}\n\n${buildReplannerUserPrompt(seed)}`,
      );
    } catch (err) {
      if (this.stopping) return;
      const msg = err instanceof Error ? err.message : String(err);
      this.board.skip(todoId, `replanner prompt failed: ${msg}`);
      return;
    }
    if (this.stopping) return;
    this.appendAgent(planner, response);

    let parsed = parseReplannerResponse(response);
    if (!parsed.ok) {
      this.appendSystem(
        `Replanner JSON invalid for ${todoId} (${parsed.reason}); issuing repair prompt.`,
      );
      let repair: string;
      try {
        repair = await this.promptAgent(
          planner,
          `${REPLANNER_SYSTEM_PROMPT}\n\n${buildReplannerRepairPrompt(response, parsed.reason)}`,
        );
      } catch (err) {
        if (this.stopping) return;
        const msg = err instanceof Error ? err.message : String(err);
        this.board.skip(todoId, `replanner repair prompt failed: ${msg}`);
        return;
      }
      if (this.stopping) return;
      this.appendAgent(planner, repair);
      parsed = parseReplannerResponse(repair);
      if (!parsed.ok) {
        this.board.skip(
          todoId,
          `replanner produced invalid JSON after repair: ${parsed.reason}`,
        );
        return;
      }
    }

    if (parsed.action === "skip") {
      this.board.skip(todoId, `replanner decided to skip: ${parsed.reason}`);
      this.appendSystem(`Replanner skipped todo ${todoId}: ${parsed.reason}`);
      return;
    }

    const r = this.board.replan(todoId, {
      description: parsed.description,
      expectedFiles: parsed.expectedFiles,
    });
    if (!r.ok) {
      // Board refused (e.g. status changed between our read and the call).
      // Log it and move on — the fallback tick will pick up any leftover.
      this.appendSystem(`Replan refused for todo ${todoId}: ${r.reason}`);
      return;
    }
    this.appendSystem(
      `Replanned todo ${todoId} (attempt ${r.todo.replanCount}): "${truncate(r.todo.description)}"`,
    );
  }

  private startReplanWatcher(): void {
    if (this.replanTickTimer) return;
    this.replanTickTimer = setInterval(() => {
      if (this.stopping) return;
      for (const todo of this.board.listTodos()) {
        if (todo.status === "stale" && todo.replanCount < MAX_REPLAN_ATTEMPTS) {
          this.enqueueReplan(todo.id);
        }
      }
      // Also sweep exhausted stales into skipped right away — otherwise
      // workers would keep looping (counts.stale>0) waiting for them.
      for (const todo of this.board.listTodos()) {
        if (todo.status === "stale" && todo.replanCount >= MAX_REPLAN_ATTEMPTS) {
          this.board.skip(
            todo.id,
            `auto-skipped: replan attempts exhausted (${todo.replanCount})`,
          );
        }
      }
    }, REPLAN_FALLBACK_TICK_MS);
    this.replanTickTimer.unref?.();
  }

  private stopReplanWatcher(): void {
    if (this.replanTickTimer) clearInterval(this.replanTickTimer);
    this.replanTickTimer = undefined;
    this.replanPending.clear();
    this.planner = undefined;
  }

  // ---------------------------------------------------------------------
  // Phase 7 — hard caps
  //
  // Called from each worker loop iteration. If any cap trips, sets
  // terminationReason, flips stopping=true so all workers exit their
  // `while (!this.stopping)` guard, and aborts in-flight prompts so a
  // worker mid-prompt doesn't sit for the full ABSOLUTE_MAX_MS watchdog.
  //
  // Idempotent: if terminationReason is already set (a peer worker beat us
  // to it) we just return true without double-logging or double-aborting.
  // Also returns true unconditionally once stopping is set — any non-cap
  // path that flipped stopping (user stop, shutdown race) wants workers
  // to exit too, so short-circuit here keeps the call site simple.
  // ---------------------------------------------------------------------

  private checkAndApplyCaps(): boolean {
    if (this.stopping) return true;
    if (this.runStartedAt === undefined) return false;
    const reason = checkCaps({
      startedAt: this.runStartedAt,
      now: Date.now(),
      committed: this.board.counts().committed,
      totalTodos: this.board.listTodos().length,
    });
    if (!reason) return false;
    this.terminationReason = reason;
    this.appendSystem(`Stopping: ${reason}`);
    this.stopping = true;
    for (const ctrl of this.activeAborts) {
      try {
        ctrl.abort(new Error(`cap: ${reason}`));
      } catch {
        // best-effort; AbortController.abort throws on already-aborted in
        // some runtimes.
      }
    }
    return true;
  }

  // Phase 7 Step B: write a post-mortem blob at the clone root so a crashed
  // run leaves behind enough state to diagnose what happened. Writes via
  // writeFileAtomic so a crash *during* the snapshot write doesn't leave a
  // half-written JSON. Swallows its own errors — if we can't write the
  // snapshot, we log the failure to the transcript (which still broadcasts
  // over WS) and move on. Losing the snapshot is better than turning a
  // normal run failure into a recursive crash.
  private async writeCrashSnapshot(err: unknown): Promise<void> {
    const clone = this.active?.localPath;
    if (!clone) {
      this.appendSystem("Could not write crash snapshot: no clone path set.");
      return;
    }
    const snapshot = buildCrashSnapshot({
      error: err,
      phase: this.phase,
      runStartedAt: this.runStartedAt,
      crashedAt: Date.now(),
      config: this.active,
      board: this.board.snapshot(),
      transcript: this.transcript,
    });
    const outPath = path.join(clone, "board-final.json");
    try {
      await writeFileAtomic(outPath, JSON.stringify(snapshot, null, 2));
      this.appendSystem(`Wrote crash snapshot to ${outPath}`);
    } catch (writeErr) {
      const msg = writeErr instanceof Error ? writeErr.message : String(writeErr);
      this.appendSystem(`Failed to write crash snapshot (${msg})`);
    }
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
    const abs = await this.resolveSafe(relPath);
    try {
      const buf = await fs.readFile(abs);
      return createHash("sha256").update(buf).digest("hex");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw err;
    }
  }

  private async writeDiff(relPath: string, contents: string): Promise<void> {
    await writeFileAtomic(await this.resolveSafe(relPath), contents);
  }

  private async readExpectedFiles(files: string[]): Promise<Record<string, string | null>> {
    const out: Record<string, string | null> = {};
    for (const f of files) {
      const abs = await this.resolveSafe(f);
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

  private async resolveSafe(relPath: string): Promise<string> {
    const clone = this.active?.localPath;
    if (!clone) throw new Error("no active clone path");
    return resolveSafe(clone, relPath);
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
