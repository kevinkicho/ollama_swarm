/**
 * Shared types for council worker execution (runner / attempt / retry chain).
 * Extracted so modules can import without circular deps through councilWorkerRunner.
 */

import type { Agent } from "../services/AgentManager.js";
import type { SwarmControlCenter } from "./control/SwarmControlCenter.js";
import type { SwarmEvent } from "../types.js";

export type TodoSettledOutcome = "completed" | "skipped" | "failed";

export interface WorkerRunnerContext {
  appendSystem: (msg: string) => void;
  recordFailure?: (todoId: string, description: string, error: string) => void;
  onTodoSettled?: (info: {
    todoId: string;
    description: string;
    expectedFiles: readonly string[];
    outcome: TodoSettledOutcome;
    detail?: string;
  }) => void;
  /** Like onTodoSettled but includes the worker agent id (for cycle settlement). */
  onTodoSettledByAgent?: (
    agentId: string,
    info: {
      todoId: string;
      description: string;
      expectedFiles: readonly string[];
      outcome: TodoSettledOutcome;
      detail?: string;
    },
  ) => void;
  stopping: () => boolean;
  /** Soft drain: finish the in-flight todo, then exit without dequeuing more. */
  draining?: () => boolean;
  /** Aborted on hard stop so hung prompts fail fast. */
  promptSignal?: AbortSignal;
  /** Register per-worker AbortController so reaper can abort stuck todos. */
  registerTodoAbort?: (workerId: string, ctrl: AbortController) => void;
  unregisterTodoAbort?: (workerId: string) => void;
  getSwarmControl?: () => SwarmControlCenter;
  getCoachAgent?: () => Agent | undefined;
  emit?: (e: SwarmEvent) => void;
  /** Hotspot basename → fail streak (settlement book); soft dequeue deprioritize. */
  getFileFailStreak?: () => ReadonlyMap<string, number> | undefined;
}

export type TodoExecuteResult =
  | { outcome: "completed" }
  | { outcome: "skipped"; reason: string }
  | { outcome: "failed"; error: string };

export type WorkerRetryResult = { outcome: "retry"; reason: string; lastResponse?: string };
export type WorkerAttemptResult = TodoExecuteResult | WorkerRetryResult;

export function isWorkerRetry(r: WorkerAttemptResult): r is WorkerRetryResult {
  return r.outcome === "retry";
}
