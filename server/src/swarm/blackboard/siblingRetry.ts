import type { Agent } from "../../services/AgentManager.js";
import { siblingModelFor } from "./BlackboardRunnerConstants.js";

export interface SiblingRetryOpts {
  agent: Agent;
  modelAtEntry: string;
  /** Captured before any prompts — NOT agent.model (may have been mutated by
   *  provider-level failover already). */
  logPrefix: string;
  updateAgentModel: (agentId: string, model: string) => void;
  emit: (ev: Record<string, unknown>) => void;
  getFallbackModel: () => string | undefined;
  reason: string;
  /** If true, never retry (prevents infinite swap loops). */
  isFallbackAttempt?: boolean;
}

/**
 * Attempt a sibling-model retry. Swaps agent.model, emits model_shift,
 * runs the provided function, and restores the original model in a finally
 * block regardless of outcome.
 *
 * Returns true if a sibling was found AND the function was called.
 * The caller checks the result of the retry (stored in the out parameter)
 * to decide whether to give up or proceed.
 */
export async function withSiblingRetry(
  opts: SiblingRetryOpts,
  fn: () => Promise<void>,
): Promise<boolean> {
  if (opts.isFallbackAttempt) return false;

  const currentModel = opts.agent.model;
  const fallback = opts.getFallbackModel() ?? siblingModelFor(currentModel);
  if (!fallback || fallback === currentModel) return false;

  opts.updateAgentModel(opts.agent.id, fallback);
  opts.emit({
    type: "model_shift",
    agentId: opts.agent.id,
    agentIndex: opts.agent.index,
    fromModel: opts.modelAtEntry,
    toModel: fallback,
    reason: opts.reason,
  });
  opts.agent.model = fallback;

  try {
    await fn();
    return true;
  } finally {
    opts.agent.model = opts.modelAtEntry;
    opts.updateAgentModel(opts.agent.id, opts.modelAtEntry);
    opts.emit({
      type: "model_shift",
      agentId: opts.agent.id,
      agentIndex: opts.agent.index,
      fromModel: fallback,
      toModel: opts.modelAtEntry,
      reason: "sibling-retry reverted",
    });
  }
}