import { config as appConfig } from "../config.js";
import { siblingModelFor } from "./blackboard/BlackboardRunnerConstants.js";

/**
 * Next model for council worker stage-3 retry. Prefers explicit SIBLING_MODELS
 * pairs, then the first entry in providerFailover (or env default) that differs
 * from the agent's current model. When the chain is empty and degradation is
 * enabled, falls back to SWARM_DEGRADATION_PREFERRED local models.
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
    if (candidate && candidate !== currentModel) return candidate;
  }

  // Preferred local/degraded models when explicit chain is empty or exhausted.
  // Use SWARM_DEGRADATION_PREFERRED even if DEGRADATION_FALLBACK flag is off —
  // empty chain + pure-think thrash (2964afe8) still needs a next hop when set.
  for (const candidate of appConfig.SWARM_DEGRADATION_PREFERRED) {
    if (candidate && candidate !== currentModel) return candidate;
  }

  // Last resort: cloud model → bare local id (deepseek-v4-flash:cloud → deepseek-v4-flash)
  if (/:cloud\s*$/i.test(currentModel)) {
    const local = currentModel.replace(/:cloud\s*$/i, "").trim();
    if (local && local !== currentModel) return local;
  }

  // Legacy flag still enables preferred list when only that path was configured.
  if (appConfig.SWARM_DEGRADATION_FALLBACK) {
    for (const candidate of appConfig.SWARM_DEGRADATION_PREFERRED) {
      if (candidate && candidate !== currentModel) return candidate;
    }
  }

  return undefined;
}

/** Short label for transcript lines (avoids dumping full error strings). */
export function summarizeWorkerFailureReason(raw: string): string {
  const msg = raw.trim();
  if (!msg) return "unknown failure";
  if (/empty provider response/i.test(msg)) return "empty provider response";
  if (/format\/provider|pure\s*<think>/i.test(msg)) return msg.slice(0, 160);
  if (/JSON parse failed/i.test(msg)) return msg.slice(0, 160);
  if (/build_misroute|build_precondition/i.test(msg)) return msg.slice(0, 160);
  if (/hunk file/i.test(msg) && /not in expectedFiles/i.test(msg)) return msg.slice(0, 160);
  if (/search/i.test(msg) && /not found/i.test(msg)) return msg.slice(0, 160);
  if (/aborted|user stop/i.test(msg)) return "prompt aborted";
  return msg.length > 160 ? `${msg.slice(0, 157)}…` : msg;
}