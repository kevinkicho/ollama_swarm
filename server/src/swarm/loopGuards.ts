// 2026-05-03 (Phase B of shared-layer refactor): top-of-loop budget +
// quota guard. Pre-extraction state (the audit's Pattern 2a):
//   - 7 runners had byte-identical 12-line `tokenBudgetExceeded` +
//     `shouldHaltOnQuota` blocks at the top of their main loop
//   - Only the noun "round" / "cycle" varied
//   - MoaRunner lacked these guards entirely (latent bug)
//
// This module is the single source of truth. Each runner replaces
// its 12-line block with one helper call:
//
//     const guard = checkBudgetGuards({ tokenBaseline, ... });
//     if (guard.halt) {
//       this.earlyStopDetail = guard.earlyStopDetail;
//       this.appendSystem(guard.message);
//       break;
//     }
//
// Adding the guards to MoA in Phase B closes the latent gap noted in
// the audit — MoA was the only preset with no token-budget protection.

import {
  shouldHaltOnQuota,
  tokenBudgetExceeded,
  tokenTracker,
  type snapshotLifetimeTokens as _snapshotLifetimeTokens,
} from "../services/ollamaProxy.js";

/** The shape returned by `snapshotLifetimeTokens()`. Today it's a
 *  number; aliased here so the helper signature reads correctly and
 *  survives any future change to the snapshot shape. */
type LifetimeTokensSnapshot = ReturnType<typeof _snapshotLifetimeTokens>;

export type LoopUnit = "round" | "cycle";

export interface BudgetGuardCheckOpts {
  /** Snapshot from `snapshotLifetimeTokens()` taken once at run start. */
  tokenBaseline: LifetimeTokensSnapshot;
  /** Per-RunConfig.tokenBudget. When undefined / 0, the budget check is a no-op. */
  tokenBudget?: number;
  /** Current iteration number (1-indexed). Used in the message. */
  round: number;
  /** Total iterations the loop will run. Used in the message. */
  totalRounds: number;
  /** Loop noun ("round" for council/RR/stigmergy/etc.; "cycle" for
   *  map-reduce/OW/OW-deep). */
  unit: LoopUnit;
}

export interface BudgetGuardResult {
  /** True when the loop should break this iteration. */
  halt: boolean;
  /** When halt=true, the human-readable detail to assign to
   *  `this.earlyStopDetail`. Mirrors the existing per-runner format. */
  earlyStopDetail?: string;
  /** When halt=true, the message to push via `this.appendSystem(...)`. */
  message?: string;
}

/** Check both budget caps. Returns { halt: false } when both pass.
 *  When either trips, returns { halt: true, earlyStopDetail, message }
 *  with the same wording the runners had inline before extraction.
 *
 *  Token-budget check fires first (cheaper to format the message),
 *  then quota wall — same order every runner used. The "round"/"cycle"
 *  noun in the message is parameterized via `opts.unit`. */
export function checkBudgetGuards(opts: BudgetGuardCheckOpts): BudgetGuardResult {
  // The runner is at the TOP of iteration `round` but hasn't done work
  // yet — so the message references `round - 1` as the last completed
  // iteration. Mirrors existing runner copy verbatim.
  const completed = Math.max(0, opts.round - 1);

  if (tokenBudgetExceeded(opts.tokenBaseline, opts.tokenBudget)) {
    const detail = `token-budget reached (${opts.tokenBudget?.toLocaleString()} tokens)`;
    return {
      halt: true,
      earlyStopDetail: detail,
      message: `Token budget of ${opts.tokenBudget?.toLocaleString()} tokens reached at ${opts.unit} ${completed}/${opts.totalRounds} — ending run early.`,
    };
  }

  if (shouldHaltOnQuota()) {
    const q = tokenTracker.getQuotaState();
    const detail = `ollama-quota-exhausted (${q?.statusCode}: ${q?.reason.slice(0, 100)})`;
    return {
      halt: true,
      earlyStopDetail: detail,
      message: `Ollama quota wall hit at ${opts.unit} ${completed}/${opts.totalRounds} (${q?.statusCode}) — ending run early.`,
    };
  }

  return { halt: false };
}
