import { config as appConfig } from "../config.js";
import { siblingModelFor } from "./blackboard/BlackboardRunnerConstants.js";

/**
 * Next model for council worker stage-3 retry. Prefers explicit SIBLING_MODELS
 * pairs, then the first entry in providerFailover (or env default) that differs
 * from the agent's current model.
 */
export function councilWorkerFallbackModel(
  currentModel: string,
  perRunChain?: readonly string[],
): string | undefined {
  const sibling = siblingModelFor(currentModel);
  if (sibling && sibling !== currentModel) return sibling;

  const chain =
    perRunChain && perRunChain.length > 0
      ? perRunChain
      : appConfig.SWARM_PROVIDER_FAILOVER;

  for (const candidate of chain) {
    if (candidate !== currentModel) return candidate;
  }
  return undefined;
}

/** Short label for transcript lines (avoids dumping full error strings). */
export function summarizeWorkerFailureReason(raw: string): string {
  const msg = raw.trim();
  if (!msg) return "unknown failure";
  if (/empty provider response/i.test(msg)) return "empty provider response";
  if (/JSON parse failed/i.test(msg)) return msg.slice(0, 160);
  if (/hunk file/i.test(msg) && /not in expectedFiles/i.test(msg)) return msg.slice(0, 160);
  if (/search/i.test(msg) && /not found/i.test(msg)) return msg.slice(0, 160);
  if (/aborted|user stop/i.test(msg)) return "prompt aborted";
  return msg.length > 160 ? `${msg.slice(0, 157)}…` : msg;
}