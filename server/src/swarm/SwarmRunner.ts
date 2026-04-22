import type { AgentManager } from "../services/AgentManager.js";
import type { RepoService } from "../services/RepoService.js";
import type { SwarmEvent, SwarmStatus } from "../types.js";

export type PresetId =
  | "round-robin"
  | "blackboard"
  | "role-diff"
  | "council"
  | "orchestrator-worker"
  | "debate-judge"
  | "map-reduce"
  | "stigmergy";

export interface RunConfig {
  repoUrl: string;
  localPath: string;
  agentCount: number;
  rounds: number;
  model: string;
  preset: PresetId;
}

export interface RunnerOpts {
  manager: AgentManager;
  repos: RepoService;
  emit: (e: SwarmEvent) => void;
}

// Every preset implementation fulfills this contract so the top-level
// Orchestrator can dispatch to it without caring which pattern is running.
export interface SwarmRunner {
  start(cfg: RunConfig): Promise<void>;
  stop(): Promise<void>;
  status(): SwarmStatus;
  injectUser(text: string): void;
  isRunning(): boolean;
}
