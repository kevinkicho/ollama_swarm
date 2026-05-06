// Direction 1 Phase 3: adaptive hyperparameters.
//
// Given a preset + directive, suggest optimal agentCount, rounds, and
// model based on past outcome history. Uses grouped statistics from
// outcomeHistory with Bayesian averaging against defaults when sample
// size is too low (< 10).
//
// The API endpoint (`/outcome/recommend`) returns these suggestions
// alongside the preset recommendation, so the UI can pre-fill the
// setup form with learned values.

import type { PresetId } from "./SwarmRunner.js";
import type { RunOutcome } from "./outcomeScorer.js";
import { computeStats, type OutcomeStats } from "./outcomeHistory.js";

const DEFAULT_AGENT_COUNT: Record<PresetId, number> = {
  "round-robin": 3,
  blackboard: 4,
  "role-diff": 3,
  council: 3,
  "orchestrator-worker": 3,
  "orchestrator-worker-deep": 4,
  "debate-judge": 3,
  "map-reduce": 4,
  stigmergy: 3,
  baseline: 1,
  moa: 4,
  pipeline: 3,
};

const DEFAULT_ROUNDS: Record<PresetId, number> = {
  "round-robin": 3,
  blackboard: 1,
  "role-diff": 3,
  council: 3,
  "orchestrator-worker": 3,
  "orchestrator-worker-deep": 3,
  "debate-judge": 2,
  "map-reduce": 3,
  stigmergy: 3,
  baseline: 1,
  moa: 3,
  pipeline: 3,
};

export interface AdaptiveParams {
  preset: PresetId;
  agentCount: number;
  rounds: number;
  confidence: number;
  source: "history" | "heuristic" | "default";
}

function weightedAvg(historyValue: number, defaultValue: number, sampleSize: number, priorWeight: number = 10): number {
  const weight = Math.min(1, sampleSize / priorWeight);
  return historyValue * weight + defaultValue * (1 - weight);
}

export function suggestAdaptiveParams(
  preset: PresetId,
  outcomes: RunOutcome[],
): AdaptiveParams {
  const stats = computeStats(outcomes);
  const presetStats = stats.get(preset);

  const defaultAgents = DEFAULT_AGENT_COUNT[preset] ?? 3;
  const defaultRounds = DEFAULT_ROUNDS[preset] ?? 3;

  if (!presetStats || presetStats.sampleSize < 10) {
    return {
      preset,
      agentCount: defaultAgents,
      rounds: defaultRounds,
      confidence: presetStats ? presetStats.confidence : 0,
      source: presetStats ? "heuristic" : "default",
    };
  }

  // Group outcomes by agentCount to find the sweet spot
  const byAgentCount = new Map<number, RunOutcome[]>();
  for (const o of outcomes.filter((o) => o.preset === preset)) {
    const arr = byAgentCount.get(o.agentCount) ?? [];
    arr.push(o);
    byAgentCount.set(o.agentCount, arr);
  }

  let bestAgentCount = defaultAgents;
  let bestScorePerAgent = 0;
  for (const [count, runs] of byAgentCount) {
    if (runs.length < 3) continue;
    const avgScore = runs.reduce((s, r) => s + r.score, 0) / runs.length;
    // Prefer fewer agents with same quality (cost efficiency)
    const efficiency = avgScore / Math.sqrt(count);
    if (efficiency > bestScorePerAgent) {
      bestScorePerAgent = efficiency;
      bestAgentCount = count;
    }
  }

  // Group outcomes by rounds to find diminishing returns
  const byRounds = new Map<number, RunOutcome[]>();
  for (const o of outcomes.filter((o) => o.preset === preset)) {
    const arr = byRounds.get(o.rounds) ?? [];
    arr.push(o);
    byRounds.set(o.rounds, arr);
  }

  let bestRounds = defaultRounds;
  let bestScorePerRound = 0;
  for (const [rounds, runs] of byRounds) {
    if (runs.length < 2) continue;
    const avgScore = runs.reduce((s, r) => s + r.score, 0) / runs.length;
    // Prefer fewer rounds with same quality (time efficiency)
    const efficiency = avgScore / Math.sqrt(rounds);
    if (efficiency > bestScorePerRound) {
      bestScorePerRound = efficiency;
      bestRounds = rounds;
    }
  }

  return {
    preset,
    agentCount: Math.round(weightedAvg(bestAgentCount, defaultAgents, presetStats.sampleSize)),
    rounds: Math.round(weightedAvg(bestRounds, defaultRounds, presetStats.sampleSize)),
    confidence: presetStats.confidence,
    source: "history",
  };
}