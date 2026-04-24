import { randomUUID } from "node:crypto";
import type { AgentManager } from "./AgentManager.js";
import type { RepoService } from "./RepoService.js";
import type { SwarmEvent, SwarmStatus } from "../types.js";
import type { PresetId, RunConfig, RunnerOpts, SwarmRunner } from "../swarm/SwarmRunner.js";
import { RoundRobinRunner } from "../swarm/RoundRobinRunner.js";
import { BlackboardRunner } from "../swarm/blackboard/BlackboardRunner.js";
import { CouncilRunner } from "../swarm/CouncilRunner.js";
import { OrchestratorWorkerRunner } from "../swarm/OrchestratorWorkerRunner.js";
import { DebateJudgeRunner } from "../swarm/DebateJudgeRunner.js";
import { MapReduceRunner } from "../swarm/MapReduceRunner.js";
import { StigmergyRunner } from "../swarm/StigmergyRunner.js";
import { DEFAULT_ROLES } from "../swarm/roles.js";

export interface OrchestratorOpts extends RunnerOpts {
  manager: AgentManager;
  repos: RepoService;
  emit: (e: SwarmEvent) => void;
}

// Re-exported so callers (routes/swarm.ts, index.ts) don't have to reach into
// the swarm/ namespace to pass a RunConfig.
export type { RunConfig };

// Thin preset dispatcher. Holds one `SwarmRunner` per run and delegates the
// public surface to it. The state of a run lives on the runner itself.
export class Orchestrator {
  private runner: SwarmRunner | null = null;
  // Unit 62: stash the runId minted at run-start so the page-refresh
  // catch-up snapshot can include it. The runner doesn't own this
  // identifier (it's an orchestrator-level handle), so we merge it in
  // here rather than threading it through the runner contract.
  private runId?: string;

  constructor(private readonly opts: OrchestratorOpts) {}

  status(): SwarmStatus {
    if (this.runner) {
      const runnerStatus = this.runner.status();
      // Unit 62: stitch the orchestrator-level runId into the snapshot.
      // Leave runnerStatus.runId untouched if the runner already set one
      // (defensive — currently no runner does, but keeps the merge safe).
      return { ...runnerStatus, runId: runnerStatus.runId ?? this.runId };
    }
    return {
      phase: "idle",
      round: 0,
      agents: this.opts.manager.toStates(),
      transcript: [],
    };
  }

  isRunning(): boolean {
    return this.runner?.isRunning() ?? false;
  }

  injectUser(text: string): void {
    this.runner?.injectUser(text);
  }

  async start(cfg: RunConfig): Promise<void> {
    if (this.isRunning()) throw new Error("A swarm is already running. Stop it first.");
    // Improvement #5 (post task #34): if a previous run is in a terminal
    // phase, isRunning() returns false but the runner reference is still
    // pinned (only stop() clears it — natural completion does not). Drop
    // it here so the new run gets a clean slot and the next status() call
    // doesn't surface stale state from the old runner. This is the
    // single-call equivalent of the explicit /stop the sequencer used to
    // need between every preset.
    if (this.runner) {
      try {
        await this.stop();
      } catch {
        // best-effort — if cleanup of the prior runner errors, surface it
        // via the next status() rather than blocking the new start.
      }
    }
    const runner = this.buildRunner(cfg.preset, cfg);
    // Assign up-front so status()/isRunning() reflect the in-progress run for
    // new WS clients and the POST /status endpoint while start() is still awaiting.
    this.runner = runner;
    // Unit 52a + 52c + 52d: anchor for the UI's runtime ticker,
    // identity strip, and identifiers row. Single source of truth
    // across all 7 runners. Fires BEFORE runner.start so a slow clone
    // or spawn counts toward user-visible runtime. Carries:
    // - runId: Unit 52d — app-level handle, distinct from opencode
    //   session ids. Useful for cross-referencing logs and future
    //   persistent run history.
    // - resolved config so the UI renders without a REST round-trip.
    const runId = randomUUID();
    this.runId = runId;
    this.opts.emit({
      type: "run_started",
      runId,
      startedAt: Date.now(),
      preset: cfg.preset,
      // Per-agent overrides (Unit 42) fall back to cfg.model when absent.
      plannerModel: cfg.plannerModel ?? cfg.model,
      workerModel: cfg.workerModel ?? cfg.model,
      repoUrl: cfg.repoUrl,
      clonePath: cfg.localPath,
      agentCount: cfg.agentCount,
      rounds: cfg.rounds,
    });
    try {
      await runner.start(cfg);
    } catch (err) {
      // Runner's start threw partway through (e.g. clone failed, spawn timed out).
      // Clean up anything it managed to create and drop the reference — otherwise
      // the dispatcher stays pinned to a stuck runner and the next start call
      // false-positives as "already running".
      try {
        await runner.stop();
      } catch {
        // ignore cleanup errors; the original failure is what we want to surface
      }
      if (this.runner === runner) {
        this.runner = null;
        // Unit 62: keep runId paired with runner — drop it on failed start.
        this.runId = undefined;
      }
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (!this.runner) return;
    const runner = this.runner;
    try {
      await runner.stop();
    } finally {
      // Once a run is fully stopped, drop the reference so the next start gets
      // a fresh slate rather than inheriting the previous runner's terminal phase.
      this.runner = null;
      // Unit 62: clear the runId too so a status() after stop reports an
      // idle slate instead of a stale handle from the previous run.
      this.runId = undefined;
    }
  }

  private buildRunner(preset: PresetId, cfg: RunConfig): SwarmRunner {
    switch (preset) {
      case "round-robin":
        return new RoundRobinRunner(this.opts);
      case "role-diff": {
        // Unit 32: optional user-supplied roles take precedence over the
        // default catalog. The route validates shape (name + guidance,
        // bounded counts) so we just need to pick which list to pass.
        // An empty `roles` array is treated as "user wants defaults",
        // same as omitting the field entirely — saves callers a UI bug
        // where clearing all roles would otherwise crash the runner
        // (roleForAgent throws on an empty array).
        const roles =
          cfg.roles && cfg.roles.length > 0 ? cfg.roles : DEFAULT_ROLES;
        return new RoundRobinRunner(this.opts, { roles });
      }
      case "blackboard":
        return new BlackboardRunner(this.opts);
      case "council":
        // Parallel drafts + reconcile. Round 1 hides peer drafts from each
        // agent's prompt; Round 2+ reveals them. Discussion-only.
        return new CouncilRunner(this.opts);
      case "orchestrator-worker":
        // Agent 1 = lead (plans + synthesizes), 2..N = workers (parallel,
        // isolated subtasks). `rounds` = plan→execute→synthesize cycles.
        return new OrchestratorWorkerRunner(this.opts);
      case "debate-judge":
        // Fixed 3 agents: Agent 1 = PRO, Agent 2 = CON, Agent 3 = JUDGE.
        // Per round Pro+Con exchange; Judge scores on the final round.
        return new DebateJudgeRunner(this.opts);
      case "map-reduce":
        // Agent 1 = reducer, 2..N = mappers. Mappers each get a round-robin
        // slice of top-level repo entries and inspect them in isolation;
        // reducer synthesizes all mapper reports per cycle.
        return new MapReduceRunner(this.opts);
      case "stigmergy":
        // Self-organizing repo exploration. No planner, no roles — agents
        // pick their own next file based on a shared annotation table
        // (pheromone trail) that the runner maintains in memory.
        return new StigmergyRunner(this.opts);
      default: {
        // Exhaustiveness check — if a new preset is added to PresetId, TS errors here.
        const _exhaustive: never = preset;
        throw new Error(`unknown preset: ${String(_exhaustive)}`);
      }
    }
  }
}
