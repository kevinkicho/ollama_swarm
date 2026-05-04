// R4 (2026-05-04): pre-flight cost projector.
//
// Before launching a paid-provider run, project the worst-case spend
// so the user can refuse / lower the round count if it'll exceed
// their cfg.costCapUsd.
//
// Heuristics (intentionally conservative — overestimating is the safe
// failure mode for "should I refuse to start?"):
//   prompt tokens / turn  = baseContext + (turn - 1) × growthPerTurn
//     (each turn re-includes the full transcript so far → quadratic)
//   response tokens / turn = fixed estimate (~600 in practice)
//   total turns           = rounds × agentCount
//
// Pure: no I/O. Caller passes the cfg + invokes costForUsage.

import { costForUsage } from "../services/CostTracker.js";

export interface ProjectorInput {
  /** Provider-prefixed model string (e.g. "anthropic/claude-opus-4-7"). */
  model: string;
  /** Total turns in the run. Caller computes (rounds × agentCount). */
  totalTurns: number;
  /** Per-turn baseline prompt tokens (system + first turn context).
   *  Default 4000 — covers system prompt + a small repo context. */
  baseContextTokens?: number;
  /** Tokens added to the prompt per subsequent turn (roughly the
   *  per-turn average response, since each turn appends to transcript).
   *  Default 800. */
  growthPerTurnTokens?: number;
  /** Estimated response tokens per turn. Default 600. */
  responseTokensPerTurn?: number;
}

export interface ProjectorOutput {
  /** Sum of all per-turn prompt tokens across the run. */
  projectedPromptTokens: number;
  /** Sum of all per-turn response tokens across the run. */
  projectedResponseTokens: number;
  /** Cost in USD. 0 for ollama-local models. */
  projectedCostUsd: number;
  /** Plain-English breakdown for the UI. */
  breakdown: string;
}

const DEFAULT_BASE = 4_000;
const DEFAULT_GROWTH = 800;
const DEFAULT_RESPONSE = 600;

export function projectRunCost(input: ProjectorInput): ProjectorOutput {
  const {
    model,
    totalTurns,
    baseContextTokens = DEFAULT_BASE,
    growthPerTurnTokens = DEFAULT_GROWTH,
    responseTokensPerTurn = DEFAULT_RESPONSE,
  } = input;
  if (totalTurns <= 0) {
    return {
      projectedPromptTokens: 0,
      projectedResponseTokens: 0,
      projectedCostUsd: 0,
      breakdown: "0 turns — no projection",
    };
  }
  // Sum prompt tokens over turns 1..N where turn k has
  //   base + (k - 1) × growth
  // Closed form: N × base + growth × (0 + 1 + ... + N-1)
  //            = N × base + growth × N × (N - 1) / 2
  const projectedPromptTokens =
    totalTurns * baseContextTokens +
    growthPerTurnTokens * (totalTurns * (totalTurns - 1)) / 2;
  const projectedResponseTokens = totalTurns * responseTokensPerTurn;
  const projectedCostUsd = costForUsage({
    model,
    promptTokens: projectedPromptTokens,
    responseTokens: projectedResponseTokens,
  });
  const breakdown = renderBreakdown({
    model,
    totalTurns,
    projectedPromptTokens,
    projectedResponseTokens,
    projectedCostUsd,
  });
  return {
    projectedPromptTokens,
    projectedResponseTokens,
    projectedCostUsd,
    breakdown,
  };
}

/** True when the projected cost > cap. Caller passes cfg.costCapUsd. */
export function exceedsBudget(input: {
  projectedCostUsd: number;
  costCapUsd: number;
}): boolean {
  if (!Number.isFinite(input.costCapUsd) || input.costCapUsd <= 0) return false;
  return input.projectedCostUsd > input.costCapUsd;
}

function renderBreakdown(input: {
  model: string;
  totalTurns: number;
  projectedPromptTokens: number;
  projectedResponseTokens: number;
  projectedCostUsd: number;
}): string {
  const promptKtok = (input.projectedPromptTokens / 1000).toFixed(1);
  const respKtok = (input.projectedResponseTokens / 1000).toFixed(1);
  const dollars = input.projectedCostUsd.toFixed(2);
  return (
    `${input.totalTurns} turns on ${input.model}: ` +
    `~${promptKtok}k prompt + ~${respKtok}k response tokens → $${dollars}`
  );
}
