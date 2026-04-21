import type { AgentManager } from "./AgentManager.js";
import type { RepoService } from "./RepoService.js";
import type { SwarmEvent, SwarmStatus } from "../types.js";
import type { PresetId, RunConfig, RunnerOpts, SwarmRunner } from "../swarm/SwarmRunner.js";
import { RoundRobinRunner } from "../swarm/RoundRobinRunner.js";

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
    this.runner = this.buildRunner(cfg.preset);
    await this.runner.start(cfg);
  }

  async stop(): Promise<void> {
    if (!this.runner) return;
    await this.runner.stop();
  }

  private buildRunner(preset: PresetId): SwarmRunner {
    switch (preset) {
      case "round-robin":
        return new RoundRobinRunner(this.opts);
      case "blackboard":
        throw new Error("blackboard preset is not implemented yet (phase 0 scaffold)");
      default: {
        // Exhaustiveness check — if a new preset is added to PresetId, TS errors here.
        const _exhaustive: never = preset;
        throw new Error(`unknown preset: ${String(_exhaustive)}`);
      }
    }
  }
}
