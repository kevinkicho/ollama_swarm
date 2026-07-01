import type { AgentManager } from "../services/AgentManager.js";
import type { RepoService } from "../services/RepoService.js";
import type { SwarmEvent, SwarmStatus } from "../types.js";
import type { SwarmRole } from "./roles.js";

export type PresetId =
  | "round-robin"
  | "blackboard"
  | "role-diff"
  | "council"
  | "orchestrator-worker"
  | "orchestrator-worker-deep"
  | "debate-judge"
  | "map-reduce"
  | "stigmergy"
  | "baseline"
  | "moa"
  | "pipeline";


// Re-exported from RunConfig.ts for backward compatibility
import type { RunConfig } from "./RunConfig.js";
export type { RunConfig };


export interface RunnerOpts {
  manager: AgentManager;
  repos: RepoService;
  emit: (e: SwarmEvent) => void;
  // Unit 19: optional diagnostic-log channel for non-WS records (per-call
  // timing, raw SDK events, warmup outcomes). Defaults to a no-op so
  // existing tests don't have to construct one. Lands in the same
  // logs/current.jsonl that the WS event logger writes.
  logDiag?: (record: unknown) => void;
  // V2 Step 1: Ollama base URL (without /v1 suffix). Threaded from the
  // Orchestrator so the runner can pass it to OllamaClient when
  // USE_OLLAMA_DIRECT=1 is set. Optional — falls through to a default
  // if the runner doesn't need it (non-blackboard presets unchanged).
  ollamaBaseUrl?: string;
  // #299: read live user-submitted directive amendments for the
  // active run. The orchestrator pre-binds the active runId so the
  // runner doesn't need to track it. Returns [] when no amendments
  // / no active run. Runners use this to weave HITL nudges into
  // their next prompt's context. Optional so older test rigs /
  // minimal harnesses can skip wiring it; default = no amendments.
  getAmendments?: () => Array<{ ts: number; text: string }>;
}

// Every preset implementation fulfills this contract so the top-level
// Orchestrator can dispatch to it without caring which pattern is running.
export interface SwarmRunner {
  start(cfg: RunConfig): Promise<void>;
  stop(): Promise<void>;
  // Task #167: soft-stop. Optional — when undefined, the orchestrator
  // falls back to stop(). Blackboard implements it: workers finish
  // their currently-claimed todo, no new claims permitted, then
  // escalate to hard stop. Discussion presets have nothing analogous
  // (their parallel-round structure can't be cleanly drained
  // mid-round) so they leave it undefined and get hard-stop.
  drain?(): Promise<void>;
  status(): SwarmStatus;
  // 2026-05-02: opts param threads /api/swarm/say's intent + targetAgent
  // tags. Optional + back-compat — runners that haven't been updated
  // ignore opts and treat every injection as the default broadcast steer.
  injectUser(
    text: string,
    opts?: { intent?: "suggest" | "steer" | "ask"; targetAgent?: string },
  ): void;
  isRunning(): boolean;
}
