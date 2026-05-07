// Direction 1 Phase 2: outcome history + preset recommender.
//
// OutcomeHistory reads/writes the append-only JSONL log of past run
// outcomes. PresetRecommender uses that history (plus the existing
// heuristic router) to suggest optimal preset + params for a new
// directive — learning from what worked and what didn't.

import { promises as fs } from "node:fs";
import path from "node:path";

import { readOutcomeHistory, type RunOutcome, type RunOutcomeDimension } from "./outcomeScorer.js";
import type { PresetId } from "./SwarmRunner.js";

export { readOutcomeHistory, appendOutcomeHistory, type RunOutcome } from "./outcomeScorer.js";

export interface OutcomeStats {
  preset: PresetId;
  sampleSize: number;
  avgScore: number;
  medianScore: number;
  avgEfficiency: number;
  bestVerdict: "ship-quality" | "needs-revision" | "fundamentally-flawed" | "unknown";
  dimensionAverages: Record<string, number>;
  confidence: number;
}

export interface RecommendResult {
  preset: PresetId;
  agentCount: number;
  rounds: number;
  confidence: number;
  rationale: string;
  source: "history" | "heuristic" | "default";
}

const ALL_PRESETS: PresetId[] = [
  "round-robin", "blackboard", "role-diff", "council",
  "orchestrator-worker", "orchestrator-worker-deep", "debate-judge",
  "map-reduce", "stigmergy", "baseline", "moa", "pipeline",
];

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

export function computeStats(outcomes: RunOutcome[]): Map<PresetId, OutcomeStats> {
  const byPreset = new Map<PresetId, RunOutcome[]>();
  for (const o of outcomes) {
    const arr = byPreset.get(o.preset) ?? [];
    arr.push(o);
    byPreset.set(o.preset, arr);
  }

  const stats = new Map<PresetId, OutcomeStats>();
  for (const [preset, runs] of byPreset) {
    const scores = runs.map((r) => r.score);
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    const med = median(scores);
    const efficiencies = runs.map((r) =>
      r.tokenUsage.completion > 0 ? r.score / (r.tokenUsage.completion / 1000) : 0,
    );
    const avgEff = efficiencies.reduce((a, b) => a + b, 0) / efficiencies.length;
    const verdictCounts = { "ship-quality": 0, "needs-revision": 0, "fundamentally-flawed": 0 };
    for (const r of runs) verdictCounts[r.verdict]++;
    const bestVerdict = (
      Object.entries(verdictCounts).sort((a, b) => b[1] - a[1])[0] as [string, number]
    )[0] as OutcomeStats["bestVerdict"];

    const dimAvgs: Record<string, number> = {};
    const dimCount: Record<string, number> = {};
    for (const r of runs) {
      for (const d of r.dimensions) {
        dimAvgs[d.id] = (dimAvgs[d.id] ?? 0) + d.score;
        dimCount[d.id] = (dimAvgs[d.id] ?? 0) + 1;
      }
    }
    for (const k of Object.keys(dimAvgs)) {
      dimAvgs[k] = dimAvgs[k] / (dimCount[k] || 1);
    }

    const confidence = Math.min(1, runs.length / 20);
    stats.set(preset, {
      preset,
      sampleSize: runs.length,
      avgScore: Math.round(avg * 100) / 100,
      medianScore: Math.round(med * 100) / 100,
      avgEfficiency: Math.round(avgEff * 100) / 100,
      bestVerdict,
      dimensionAverages: dimAvgs,
      confidence,
    });
  }
  return stats;
}

const PRESET_KEYWORDS: Record<string, string[]> = {
  "debate-judge": ["debate", "should we", "is it safe", "pros and cons", "argue", "versus", "vs"],
  council: ["design", "decide", "consider", "brainstorm", "ideas", "architect"],
  "map-reduce": ["audit", "find every", "map out", "comprehensive list", "all instances"],
  stigmergy: ["explore", "what does", "understand", "trace", "follow"],
  "orchestrator-worker": ["fix", "add", "refactor", "implement", "build", "create", "remove"],
  "orchestrator-worker-deep": ["complex refactor", "migrate", "overhaul", "deep rework"],
  "round-robin": ["discuss", "review", "thoughts on", "opinion", "weigh in"],
  blackboard: ["fix", "add", "refactor", "implement", "build", "create", "remove", "change files"],
  "role-diff": ["compare", "difference", "versus", "contrast"],
  baseline: ["simple", "straightforward", "quick"],
  moa: ["synthesize", "aggregate", "combine perspectives", "blend"],
  pipeline: ["multi-step", "pipeline", "sequence of steps", "chain"],
};

const SEED_DIRECTIVES: Array<{ pattern: RegExp; preset: PresetId; agentCount: number; rounds: number }> = [
  { pattern: /\b(fix|repair|patch|resolve)\b.*\b(bug|issue|error|crash)\b/i, preset: "orchestrator-worker", agentCount: 3, rounds: 3 },
  { pattern: /\b(add|create|build|implement)\b.*\b(feature|function|endpoint|api)\b/i, preset: "orchestrator-worker", agentCount: 3, rounds: 3 },
  { pattern: /\b(refactor|rewrite|restructure|reorganize)\b/i, preset: "orchestrator-worker-deep", agentCount: 4, rounds: 4 },
  { pattern: /\b(design|architect|plan)\b.*\b(system|architecture|layout)\b/i, preset: "council", agentCount: 4, rounds: 3 },
  { pattern: /\b(debate|argue|pros?\s*cons|should\s+we)\b/i, preset: "debate-judge", agentCount: 3, rounds: 4 },
  { pattern: /\b(audit|find\s+all|list\s+every|comprehensive)\b/i, preset: "map-reduce", agentCount: 4, rounds: 3 },
  { pattern: /\b(explore|understand|what\s+does|how\s+does)\b/i, preset: "stigmergy", agentCount: 3, rounds: 3 },
  { pattern: /\b(compare|contrast|versus|vs\.?)\b/i, preset: "role-diff", agentCount: 3, rounds: 2 },
  { pattern: /\b(synthesize|aggregate|combine|blend)\b/i, preset: "moa", agentCount: 4, rounds: 3 },
  { pattern: /\bpipeline|multi.?step|chain\s+of\b/i, preset: "pipeline", agentCount: 3, rounds: 3 },
  { pattern: /\b(review|discuss|thoughts|opinion)\b/i, preset: "round-robin", agentCount: 3, rounds: 3 },
  { pattern: /\b(write|modify|change)\b.*\b(files?|code)\b/i, preset: "blackboard", agentCount: 4, rounds: 3 },
];

function heuristicPickPreset(directive: string): { preset: PresetId; confidence: number } | null {
  const lower = directive.toLowerCase();
  let bestMatch: PresetId | null = null;
  let bestScore = 0;
  for (const [preset, keywords] of Object.entries(PRESET_KEYWORDS)) {
    let score = 0;
    for (const kw of keywords) {
      if (lower.includes(kw)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestMatch = preset as PresetId;
    }
  }
  if (bestScore === 0) return null;
  return { preset: bestMatch!, confidence: Math.min(0.7, bestScore / 5) };
}

const DEFAULT_AGENT_COUNT: Record<string, number> = {
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

export function recommendPreset(
  directive: string,
  outcomes: RunOutcome[],
): RecommendResult {
  const stats = computeStats(outcomes);

  // Seed directive match: before heuristics, try curated patterns.
  // These encode domain knowledge about which preset works best for
  // common directive shapes. Only used when history is thin.
  if (outcomes.length < 5) {
    for (const seed of SEED_DIRECTIVES) {
      if (seed.pattern.test(directive)) {
        return {
          preset: seed.preset,
          agentCount: seed.agentCount,
          rounds: seed.rounds,
          confidence: 0.6,
          rationale: `Seed match (insufficient history: ${outcomes.length} runs)`,
          source: "heuristic",
        };
      }
    }
    const heuristic = heuristicPickPreset(directive);
    if (heuristic) {
      return {
        preset: heuristic.preset,
        agentCount: DEFAULT_AGENT_COUNT[heuristic.preset] ?? 3,
        rounds: 3,
        confidence: heuristic.confidence,
        rationale: `Heuristic match (insufficient history: ${outcomes.length} runs)`,
        source: "heuristic",
      };
    }
    return {
      preset: "round-robin",
      agentCount: 3,
      rounds: 3,
      confidence: 0.3,
      rationale: "Default fallback (no heuristic match and insufficient history)",
      source: "default",
    };
  }

  // Find best-performing preset from history
  let bestPreset: PresetId = "round-robin";
  let bestAvgScore = 0;
  let bestMedian = 0;
  for (const [preset, stat] of stats) {
    if (stat.sampleSize >= 3 && stat.avgScore > bestAvgScore) {
      bestAvgScore = stat.avgScore;
      bestMedian = stat.medianScore;
      bestPreset = preset;
    }
  }

  // Check if heuristic disagrees significantly
  const heuristic = heuristicPickPreset(directive);
  const heuristicStat = heuristic ? stats.get(heuristic.preset) : undefined;
  const bestStat = stats.get(bestPreset);

  // If heuristic preset has comparable performance (within 0.15 of best) and more confidence
  if (
    heuristic &&
    heuristicStat &&
    heuristicStat.sampleSize >= 3 &&
    bestStat &&
    heuristicStat.avgScore >= bestStat.avgScore - 0.15
  ) {
    return {
      preset: heuristic.preset,
      agentCount: DEFAULT_AGENT_COUNT[heuristic.preset] ?? 3,
      rounds: 3,
      confidence: Math.min(0.85, heuristicStat.confidence + heuristic.confidence * 0.3),
      rationale: `History-boosted heuristic: ${heuristic.preset} avg ${(heuristicStat.avgScore * 10).toFixed(1)}/10 over ${heuristicStat.sampleSize} runs`,
      source: "history",
    };
  }

  return {
    preset: bestPreset,
    agentCount: DEFAULT_AGENT_COUNT[bestPreset] ?? 3,
    rounds: 3,
    confidence: Math.min(0.9, (bestStat?.confidence ?? 0) + 0.3),
    rationale: `Best historical performer: avg ${(bestAvgScore * 10).toFixed(1)}/10 median ${(bestMedian * 10).toFixed(1)}/10 over ${bestStat?.sampleSize ?? 0} runs`,
    source: "history",
  };
}

export async function readOutcomeHistoryFromRepo(
  repoPath: string,
): Promise<RunOutcome[]> {
  return readOutcomeHistory(repoPath);
}

export function getStatsForPreset(
  outcomes: RunOutcome[],
  preset: PresetId,
): OutcomeStats | null {
  const stats = computeStats(outcomes);
  return stats.get(preset) ?? null;
}