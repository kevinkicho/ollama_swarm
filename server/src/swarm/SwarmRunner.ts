import type { AgentManager } from "../services/AgentManager.js";
import type { RepoService } from "../services/RepoService.js";
import type { SwarmEvent, SwarmStatus, TranscriptEntrySummary } from "../types.js";
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
  // P7: optional brain service for post-run analysis + oversight.
  getBrainService?: () => import("./blackboard/brainOverseer/brainService.js").BrainService | null;
}

// Every preset implementation fulfills this contract so the top-level
// Orchestrator can dispatch to it without caring which pattern is running.
export interface SwarmRunner {
  /**
   * Run the preset to completion (or until stop/drain). Discussion
   * presets await their internal loop so callers (pipeline, orchestrator
   * settle) know when the run is truly finished — not merely seeded.
   */
  start(cfg: RunConfig): Promise<void>;
  stop(): Promise<void>;
  // Soft-stop: finish the current unit of work then close out.
  // Blackboard: finish claimed todos. Discussion: finish current round
  // then exit (drainRequested). When undefined, orchestrator hard-stops.
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
  /**
   * Resolve when the run has fully settled (loop finished / terminal phase).
   * Optional for legacy fakes; DiscussionRunnerBase + Blackboard implement it.
   * After await start(), this is typically already resolved.
   */
  waitUntilSettled?(): Promise<void>;
  // For Brain proactive suggestions during run
  appendSystemMessage?(text: string, summary?: TranscriptEntrySummary): void;
  /** Mid-run limit extension (rounds, wall-clock cap, token budget). */
  reconfig?(changes: import("./runReconfig.js").RunReconfigChanges): void;
}
