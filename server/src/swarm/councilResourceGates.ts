// Fail-closed resource gates for council cycles (wall-clock + token budget).
// Checked at cycle boundaries so autonomous rounds=0 cannot ignore caps.

import { snapshotLifetimeTokens } from "../services/ollamaProxy.js";

export type CouncilResourceGateHit = {
  stop: true;
  detail: string;
  kind: "wall-clock" | "tokens";
};

export type CouncilResourceGateOk = { stop: false };

export type CouncilResourceGateResult = CouncilResourceGateHit | CouncilResourceGateOk;

/**
 * Pure check: has the run exhausted wall-clock or token budget?
 * Uses wall-clock from startedAt (coarse); sleep-safe tick watchdog remains the
 * primary timer for mid-cycle sleep, but cycle boundaries need an explicit stop.
 */
export function checkCouncilResourceCaps(opts: {
  wallClockCapMs?: number;
  startedAt?: number;
  tokenBudget?: number;
  tokenBaseline?: number;
  now?: number;
  /** Test override for lifetime tokens (defaults to process snapshot). */
  lifetimeTokens?: number;
}): CouncilResourceGateResult {
  const now = opts.now ?? Date.now();
  if (
    opts.wallClockCapMs != null
    && opts.wallClockCapMs > 0
    && opts.startedAt != null
  ) {
    const elapsed = now - opts.startedAt;
    if (elapsed >= opts.wallClockCapMs) {
      return {
        stop: true,
        kind: "wall-clock",
        detail: `cap:wall-clock (${Math.round(opts.wallClockCapMs / 60_000)} min)`,
      };
    }
  }
  if (
    opts.tokenBudget != null
    && opts.tokenBudget > 0
    && opts.tokenBaseline != null
  ) {
    const lifetime = opts.lifetimeTokens ?? snapshotLifetimeTokens();
    const spent = Math.max(0, lifetime - opts.tokenBaseline);
    if (spent >= opts.tokenBudget) {
      return {
        stop: true,
        kind: "tokens",
        detail: `cap:tokens (${opts.tokenBudget.toLocaleString()} budget, ${spent.toLocaleString()} used)`,
      };
    }
  }
  return { stop: false };
}
