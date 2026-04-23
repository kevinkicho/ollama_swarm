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
  // Unit 19: optional diagnostic-log channel for non-WS records (per-call
  // timing, raw SDK events, warmup outcomes). Defaults to a no-op so
  // existing tests don't have to construct one. Lands in the same
  // logs/current.jsonl that the WS event logger writes.
  logDiag?: (record: unknown) => void;
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
