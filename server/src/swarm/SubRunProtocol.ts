// Direction 2 Phase 1: sub-run protocol.
//
// Defines the contract between a parent runner and a child runner.
// The parent (e.g., BlackboardRunner delegating a todo to a council)
// creates a SubRunRequest, the Orchestrator creates a child runner via
// its existing buildRunner, and returns a SubRunHandle with await/cancel.
//
// Key design choices:
// - Sub-runs use the same SwarmRunner interface as top-level runs
// - Events are scoped: sub-run events are tagged with parentRunId + subRunId
// - Sub-runs inherit a fraction of the parent's cost budget
// - Sub-run timeout is capped at 60% of the parent's remaining wall-clock
// - Only 1 level of nesting (no sub-swarm-of-sub-swarm)

import type { SwarmRunner } from "./SwarmRunner.js";
import type { PresetId } from "./SwarmRunner.js";

export interface SubRunRequest {
  parentRunId: string;
  subRunId: string;
  preset: PresetId;
  directive: string;
  context: string;
  agentCount: number;
  rounds: number;
  model?: string;
  timeoutMs: number;
}

export interface SubRunResult {
  subRunId: string;
  status: "completed" | "stopped" | "failed" | "timed_out";
  deliverable: string;
  transcript: Array<{ role: string; text: string }>;
  costUsd: number;
  tokenUsage: { prompt: number; completion: number };
}

export interface SubRunHandle {
  subRunId: string;
  runner: SwarmRunner;
  result: Promise<SubRunResult>;
  cancel(): void;
}

export interface RunnerFactory {
  (preset: PresetId, cfg: Record<string, unknown>): Promise<SwarmRunner>;
}

export function validateSubRunRequest(req: SubRunRequest): string | null {
  if (!req.parentRunId) return "parentRunId is required";
  if (!req.subRunId) return "subRunId is required";
  if (!req.preset) return "preset is required";
  if (req.agentCount < 1 || req.agentCount > 8) return "agentCount must be 1-8";
  if (req.rounds < 1 || req.rounds > 20) return "rounds must be 1-20";
  if (req.timeoutMs < 10000) return "timeoutMs must be at least 10 seconds";
  return null;
}

export function buildSubRunDirective(req: SubRunRequest, parentDeliverable?: string): string {
  const parts: string[] = [req.directive];
  if (req.context) {
    parts.push("", "=== Context from parent run ===", req.context);
  }
  if (parentDeliverable) {
    parts.push("", "=== Deliverable so far ===", parentDeliverable.slice(0, 4000));
  }
  return parts.join("\n");
}

export const MAX_CONCURRENT_SUBRUNS = 2;
export const SUBRUN_BUDGET_FRACTION = 0.2;
export const SUBRUN_TIMEOUT_FRACTION = 0.6;