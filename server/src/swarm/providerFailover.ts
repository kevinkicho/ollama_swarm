// R1 (2026-05-04): provider-failover decision helper.
//
// When the active provider hits a wall (quota / auth), the caller can
// fail over to the next model in a configured chain instead of dying.
// This module is the pure decision function — caller supplies the
// current model + the classified error + the chain + the set of models
// already exhausted, gets back an action.
//
// We deliberately treat "swap" as one-shot per call; the caller
// re-invokes us if the next model also fails. That keeps the state
// (alreadyTried) outside the helper and lets the caller decide how to
// persist it (per-run vs. per-agent vs. cross-run).

import type { ClassifiedError } from "./errorTaxonomy.js";

export type FailoverAction = "retry-same" | "swap" | "give-up";

export interface FailoverDecision {
  action: FailoverAction;
  /** Set when action === "swap". The model id to switch to. */
  nextModel?: string;
  /** Human-readable rationale for the transcript / diagnostics. */
  reason: string;
}

export interface FailoverInput {
  /** The model string that just failed. */
  currentModel: string;
  /** The classified failure. */
  classified: ClassifiedError;
  /** Ordered failover chain (e.g. ["claude-haiku-4-5", "glm-5.1:cloud"]).
   *  May or may not include currentModel — we filter it out. */
  failoverChain: readonly string[];
  /** Models we've already tried this run (current + any prior swaps). */
  alreadyTried: ReadonlySet<string>;
}

/** Pure decision function. No I/O. */
export function decideFailover(input: FailoverInput): FailoverDecision {
  const { currentModel, classified, failoverChain, alreadyTried } = input;
  // Never-retryable terminal categories — bail straight to give-up
  // without consuming a chain slot. The caller should surface these
  // to the user (cap, runner-bug, user-stop) rather than retrying.
  if (
    classified.category === "cap" ||
    classified.category === "user-stop" ||
    classified.category === "runner-bug"
  ) {
    return {
      action: "give-up",
      reason: `terminal category ${classified.category} — failover skipped`,
    };
  }
  // Quota + auth = the current provider physically can't serve us;
  // retrying it is hopeless. Swap if a fresh model is available.
  // disk + oom = local-machine failure, swap won't help; give up.
  if (classified.category === "disk" || classified.category === "oom") {
    return {
      action: "give-up",
      reason: `local-machine failure (${classified.category}) — swap won't help`,
    };
  }
  if (classified.category === "quota" || classified.category === "auth") {
    const next = pickNextUntried(currentModel, failoverChain, alreadyTried);
    if (next) {
      return {
        action: "swap",
        nextModel: next,
        reason: `${classified.category} on ${currentModel} → swap to ${next}`,
      };
    }
    return {
      action: "give-up",
      reason: `${classified.category} on ${currentModel} but failover chain exhausted`,
    };
  }
  // Transient-but-retryable categories (network / timeout / model-output):
  // first retry the same model; only swap once retries are exhausted by
  // the caller (which signals by passing currentModel into alreadyTried).
  if (classified.retryable) {
    return {
      action: "retry-same",
      reason: `${classified.category} is transient on ${currentModel} — retry`,
    };
  }
  // Catch-all (git, unknown): treat like a soft failure. Try a swap if
  // the chain has anything; otherwise give up.
  const next = pickNextUntried(currentModel, failoverChain, alreadyTried);
  if (next) {
    return {
      action: "swap",
      nextModel: next,
      reason: `non-retryable ${classified.category} — try ${next}`,
    };
  }
  return {
    action: "give-up",
    reason: `non-retryable ${classified.category} and no fallback available`,
  };
}

/** First entry in `chain` that isn't `currentModel` and isn't in
 *  `alreadyTried`. Returns null if everything is exhausted. */
function pickNextUntried(
  currentModel: string,
  chain: readonly string[],
  alreadyTried: ReadonlySet<string>,
): string | null {
  for (const candidate of chain) {
    if (candidate === currentModel) continue;
    if (alreadyTried.has(candidate)) continue;
    return candidate;
  }
  return null;
}
