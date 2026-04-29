// #298 Phase 1: cost-breakdown analytics for the run summary.
//
// Pure helper that takes a RunSummary and produces:
//   - per-agent share of total tokens (% of run cost)
//   - dominant-agent identification (>40% of tokens)
//   - a savings hint when the dominant agent's role is one that
//     could plausibly be served by a cheaper/faster model
//
// "Savings" here is qualitative — we don't know real per-token
// costs because both glm-5.1 and gemma4 are "cloud" models on the
// same Ollama subscription. The win we surface is LATENCY (small
// fast models cold-start in seconds vs reasoning models taking
// 1-3 min). The hint nudges users toward per-role overrides they
// already have configurable in BlackboardSettings + topology grid.
//
// Phase 2 (deferred): actual auto-routing once this data shows
// real opportunity across multiple runs.

import type { RunSummary } from "../types";
import { defaultRoleForIndex } from "../../../shared/src/topology";

export interface AgentCostShare {
  agentIndex: number;
  role: string;
  tokensIn: number;
  tokensOut: number;
  totalTokens: number;
  /** 0–100, share of the run's total tokens. */
  pctOfTotal: number;
}

export interface CostBreakdown {
  totalTokens: number;
  byAgent: AgentCostShare[];
  /** Agent with >40% of total tokens, or null when no agent dominates. */
  dominantAgent: AgentCostShare | null;
  /** One-line user-facing recommendation. Null when no actionable
   *  pattern detected. */
  savingHint: string | null;
}

const DOMINANCE_THRESHOLD_PCT = 40;

// Roles where a fast-coding model is plausibly enough — these are
// structural-output emitters where reasoning quality matters less
// than throughput. Excludes planner/auditor/judge (judgment roles).
const CODING_TIER_ROLES = new Set([
  "worker",
  "mapper",
  "drafter",
  "explorer",
  "peer",
  "role-diff",
  "mid-lead",
  "pro",
  "con",
]);

/** Compute the per-run cost breakdown. Returns a structurally-empty
 *  result when summary is missing or has no per-agent token data. */
export function computeCostBreakdown(summary: RunSummary): CostBreakdown {
  const agents = summary.agents ?? [];
  const totalAgents = agents.length;
  let totalTokens = 0;

  // Pass 1: total
  for (const a of agents) {
    totalTokens += (a.tokensIn ?? 0) + (a.tokensOut ?? 0);
  }
  if (totalTokens === 0 || totalAgents === 0) {
    return {
      totalTokens: 0,
      byAgent: [],
      dominantAgent: null,
      savingHint: null,
    };
  }

  // Pass 2: per-agent shares with role lookup
  const byAgent: AgentCostShare[] = agents.map((a) => {
    const tIn = a.tokensIn ?? 0;
    const tOut = a.tokensOut ?? 0;
    const total = tIn + tOut;
    return {
      agentIndex: a.agentIndex,
      role: defaultRoleForIndex(summary.preset, a.agentIndex, totalAgents),
      tokensIn: tIn,
      tokensOut: tOut,
      totalTokens: total,
      pctOfTotal: Math.round((total / totalTokens) * 100),
    };
  });

  // Sort descending by share so the UI naturally shows biggest first.
  byAgent.sort((a, b) => b.totalTokens - a.totalTokens);

  // Dominance check
  const top = byAgent[0];
  const dominantAgent =
    top && top.pctOfTotal >= DOMINANCE_THRESHOLD_PCT ? top : null;

  // Hint generation
  let savingHint: string | null = null;
  if (dominantAgent && CODING_TIER_ROLES.has(dominantAgent.role)) {
    const modelHint =
      summary.preset === "blackboard"
        ? "set the Worker model override in Advanced settings"
        : "set the per-agent model override in the Topology grid";
    savingHint =
      `Agent ${dominantAgent.agentIndex} (${dominantAgent.role}) consumed ${dominantAgent.pctOfTotal}% of run tokens. ` +
      `If this work is structural (hunks, file summaries, ranking), ${modelHint} to a coding-tier model ` +
      `(e.g. gemma4:31b-cloud) for similar quality at meaningfully lower latency.`;
  } else if (dominantAgent && dominantAgent.role === "auditor") {
    savingHint =
      `Auditor consumed ${dominantAgent.pctOfTotal}% of run tokens — unusual since audits typically fire only at criterion checkpoints. ` +
      `Check if criteria are too granular or the auditor is being asked to re-evaluate every commit.`;
  }

  return {
    totalTokens,
    byAgent,
    dominantAgent,
    savingHint,
  };
}
