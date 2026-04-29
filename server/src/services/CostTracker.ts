// Phase 2 of #314 (multi-provider cost cap): per-(provider, model)
// pricing table + cumulative-cost accounting. Sibling of tokenTracker
// (ollamaProxy.ts) — both consume UsageRecord shapes; CostTracker just
// multiplies by the price. Ollama costs $0 (local), so a run that uses
// only Ollama models ignores maxCostUsd entirely.
//
// Pricing snapshot — verify against https://www.anthropic.com/pricing
// and https://openai.com/api/pricing/ before publishing the scoreboard.
// Numbers are PER 1,000,000 tokens, USD. The table below is as-of
// 2026-04-29; update PRICING_AS_OF when changed so scoreboard footers
// can show pricing-table provenance.

import {
  detectProvider,
  stripProviderPrefix,
  type Provider,
} from "../../../shared/src/providers.js";

export const PRICING_AS_OF = "2026-04-29";

interface Price {
  inputPerMtok: number;
  outputPerMtok: number;
}

// Models keyed by their bare id (no provider prefix). detectProvider
// determines which sub-table to consult; missing entries fall back to
// PRICE_FALLBACK so an unknown model never wedges the cap (it just
// over-estimates conservatively, which is the safe direction).
const PRICES: Record<Provider, Record<string, Price>> = {
  ollama: {},
  anthropic: {
    "claude-opus-4-7": { inputPerMtok: 15.0, outputPerMtok: 75.0 },
    "claude-sonnet-4-6": { inputPerMtok: 3.0, outputPerMtok: 15.0 },
    "claude-haiku-4-5-20251001": { inputPerMtok: 0.8, outputPerMtok: 4.0 },
  },
  openai: {
    "gpt-5": { inputPerMtok: 5.0, outputPerMtok: 20.0 },
    "gpt-5-mini": { inputPerMtok: 1.0, outputPerMtok: 4.0 },
    "gpt-5-nano": { inputPerMtok: 0.2, outputPerMtok: 0.8 },
  },
};

// Conservative fallback for unknown paid-provider models — better to
// overestimate cost (run halts early) than underestimate (overrun
// budget). Roughly Sonnet-tier; if a user picks an unknown model the
// cap fires at slightly below their declared maxCostUsd.
const PRICE_FALLBACK: Price = { inputPerMtok: 5.0, outputPerMtok: 25.0 };

export interface UsageForCost {
  model?: string;
  promptTokens: number;
  responseTokens: number;
}

// Returns the dollar cost of one usage record. Ollama → 0. Unknown
// paid model → fallback pricing. The math is deliberately simple
// (no caching discounts, no per-request overhead) — the cap exists
// to prevent runaway spend, not to reproduce the bill exactly.
export function costForUsage(rec: UsageForCost): number {
  if (!rec.model) return 0;
  const provider = detectProvider(rec.model);
  if (provider === "ollama") return 0;
  const id = stripProviderPrefix(rec.model);
  const price = PRICES[provider][id] ?? PRICE_FALLBACK;
  const inputDollars = (rec.promptTokens / 1_000_000) * price.inputPerMtok;
  const outputDollars = (rec.responseTokens / 1_000_000) * price.outputPerMtok;
  return inputDollars + outputDollars;
}

// Sums dollar cost across an array of usage records — used by the cap
// watchdog to compare lifetime spend since baseline against maxCostUsd.
export function sumCost(records: readonly UsageForCost[]): number {
  let total = 0;
  for (const r of records) total += costForUsage(r);
  return total;
}

// Cap predicate: same shape as tokenBudgetExceeded in ollamaProxy.
// Returns true when the records' total cost has reached or exceeded
// the cap. Returns false when cap is undefined / 0 (cap-disabled).
export function costCapExceeded(
  records: readonly UsageForCost[],
  maxCostUsd: number | undefined,
): boolean {
  if (!maxCostUsd || maxCostUsd <= 0) return false;
  return sumCost(records) >= maxCostUsd;
}

// Test seam — exposes the underlying table without leaking write
// access. Used by CostTracker.test.ts to assert each declared model
// has a price entry that matches the providers.ts model list.
export function getPricesForTest(): Readonly<Record<Provider, Readonly<Record<string, Price>>>> {
  return PRICES;
}
