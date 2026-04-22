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

  constructor(private readonly opts: OrchestratorOpts) {}

  status(): SwarmStatus {
    if (this.runner) return this.runner.status();
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
    const runner = this.buildRunner(cfg.preset);
    // Assign up-front so status()/isRunning() reflect the in-progress run for
    // new WS clients and the POST /status endpoint while start() is still awaiting.
    this.runner = runner;
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
      if (this.runner === runner) this.runner = null;
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
    }
  }

  private buildRunner(preset: PresetId): SwarmRunner {
    switch (preset) {
      case "round-robin":
        return new RoundRobinRunner(this.opts);
      case "role-diff":
        // Same runner as round-robin, plus the seven-role catalog prepended
        // to each agent's prompt so identical weights produce distinct priors.
        return new RoundRobinRunner(this.opts, { roles: DEFAULT_ROLES });
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
