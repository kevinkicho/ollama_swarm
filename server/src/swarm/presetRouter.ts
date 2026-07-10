// Q12 (2026-05-04): best-preset auto-pick router + unified runner factory.
//
// Factory maps preset → runner constructor; Orchestrator.start() calls
// createRunner() (with optional pipeline/role hooks) instead of a split switch.

import type { PresetId, RunConfig, RunnerOpts, SwarmRunner } from "./SwarmRunner.js";
import type { SwarmRole } from "./roles.js";

export type CreateRunnerHooks = {
  /** role-diff: pre-resolved role catalog */
  rolesForRoleDiff?: readonly SwarmRole[];
  /** baselineAttempts > 1 → harness */
  baselineMultiAttempt?: boolean;
  /** pipeline: build nested runners by preset id under same opts/cfg */
  pipelineFactory?: (preset: PresetId) => Promise<SwarmRunner>;
};

/** Unified factory — returns a typed SwarmRunner for every PresetId. */
export async function createRunner(
  cfg: RunConfig,
  opts: RunnerOpts,
  hooks: CreateRunnerHooks = {},
): Promise<SwarmRunner> {
  switch (cfg.preset) {
    case "blackboard": {
      const { BlackboardRunner } = await import("./blackboard/BlackboardRunner.js");
      return new BlackboardRunner(opts);
    }
    case "round-robin": {
      const { RoundRobinRunner } = await import("./RoundRobinRunner.js");
      return new RoundRobinRunner(opts);
    }
    case "role-diff": {
      const { RoundRobinRunner } = await import("./RoundRobinRunner.js");
      return new RoundRobinRunner(opts, {
        roles: hooks.rolesForRoleDiff ? [...hooks.rolesForRoleDiff] : undefined,
      });
    }
    case "council": {
      const { CouncilRunner } = await import("./CouncilRunner.js");
      return new CouncilRunner(opts);
    }
    case "orchestrator-worker": {
      const { OrchestratorWorkerRunner } = await import("./OrchestratorWorkerRunner.js");
      return new OrchestratorWorkerRunner(opts);
    }
    case "orchestrator-worker-deep": {
      const { OrchestratorWorkerDeepRunner } = await import("./OrchestratorWorkerDeepRunner.js");
      return new OrchestratorWorkerDeepRunner(opts);
    }
    case "debate-judge": {
      const { DebateJudgeRunner } = await import("./DebateJudgeRunner.js");
      return new DebateJudgeRunner(opts);
    }
    case "map-reduce": {
      const { MapReduceRunner } = await import("./MapReduceRunner.js");
      return new MapReduceRunner(opts);
    }
    case "stigmergy": {
      const { StigmergyRunner } = await import("./StigmergyRunner.js");
      return new StigmergyRunner(opts);
    }
    case "moa": {
      const { MoaRunner } = await import("./MoaRunner.js");
      return new MoaRunner(opts);
    }
    case "baseline": {
      if (hooks.baselineMultiAttempt) {
        const { BaselineSwarmHarness } = await import("./BaselineSwarmHarness.js");
        return new BaselineSwarmHarness(opts);
      }
      const { BaselineRunner } = await import("./BaselineRunner.js");
      return new BaselineRunner(opts);
    }
    case "pipeline": {
      if (!hooks.pipelineFactory) {
        throw new Error("pipeline preset requires pipelineFactory hook");
      }
      const { PipelineRunner } = await import("./PipelineRunner.js");
      return new PipelineRunner(opts, hooks.pipelineFactory);
    }
    default: {
      const _exhaustive: never = cfg.preset;
      throw new Error(`Unknown preset: ${_exhaustive}`);
    }
  }
}

export interface PresetRouterDecision {
  pickedPreset: PresetId;
  /** "heuristic" when the keyword matcher picked confidently; "llm"
   *  when the heuristic was ambiguous + an LLM router was consulted;
   *  "default" when neither produced a confident pick. */
  source: "heuristic" | "llm" | "default";
  /** One-sentence rationale. */
  rationale: string;
}

/** Pure heuristic. Returns a confident pick when keywords clearly
 *  signal a category; null when ambiguous (let the LLM router decide
 *  OR fall back to a default).
 *
 *  Order matters: intent markers (debate/decide/audit/explore) check
 *  BEFORE write verbs because "should we migrate" should be a debate,
 *  not a code-modify (the "migrate" verb on its own would otherwise
 *  win). Write verbs are the catch-all last layer. */
export function heuristicPickPreset(
  directive: string,
): PresetRouterDecision | null {
  const lower = directive.trim().toLowerCase();
  if (lower.length === 0) return null;
  const debateMarkers = ["debate", "should we", "is it safe", "is it worth", "vs.", " vs ", "argue"];
  for (const m of debateMarkers) {
    if (lower.includes(m)) {
      return {
        pickedPreset: "debate-judge",
        source: "heuristic",
        rationale: `Directive contains debate marker "${m.trim()}" → debate-judge.`,
      };
    }
  }
  const councilMarkers = ["design ", "decide", "consider", "evaluate", "choose between"];
  for (const m of councilMarkers) {
    if (lower.includes(m)) {
      return {
        pickedPreset: "council",
        source: "heuristic",
        rationale: `Directive contains design marker "${m.trim()}" → council (parallel-drafts + reconcile).`,
      };
    }
  }
  const auditMarkers = ["audit", "find every", "find all", "map out", "survey", "inventory", "catalog"];
  for (const m of auditMarkers) {
    if (lower.includes(m)) {
      return {
        pickedPreset: "map-reduce",
        source: "heuristic",
        rationale: `Directive contains audit marker "${m}" → map-reduce (sliced inspection + reduce).`,
      };
    }
  }
  const exploreMarkers = ["explore", "what does", "understand", "learn"];
  for (const m of exploreMarkers) {
    if (lower.includes(m)) {
      return {
        pickedPreset: "stigmergy",
        source: "heuristic",
        rationale: `Directive contains exploration marker "${m}" → stigmergy (pheromone-driven).`,
      };
    }
  }
  const writeVerbs = [
    "fix", "add", "remove", "delete", "rename", "refactor", "extract",
    "migrate", "implement", "wire", "port", "update", "patch", "resolve",
    "address", "convert", "replace", "reorganize", "rewrite",
  ];
  for (const v of writeVerbs) {
    const re = new RegExp(`\\b${v}\\b`, "i");
    if (re.test(lower)) {
      return {
        pickedPreset: "blackboard",
        source: "heuristic",
        rationale: `Directive contains code-modify verb "${v}" → blackboard (write-capable).`,
      };
    }
  }
  return null;
}

export function buildPresetRouterPrompt(args: {
  directive: string;
  available: readonly PresetId[];
}): string {
  const presetDescriptions: Record<PresetId, string> = {
    blackboard: "write-capable; small atomic file edits; planner+workers+auditor",
    "round-robin": "structured deliberation; rotating dispositions; lead synthesizes",
    "role-diff": "researcher/designer/implementer/tester/reviewer team produces deliverable",
    council: "parallel drafts + synthesis; preserves dissent",
    "orchestrator-worker": "lead decomposes; workers report on subtasks",
    "orchestrator-worker-deep": "3-tier hierarchy for ≥4 agents",
    "debate-judge": "exactly 3 agents Pro/Con/Judge; structured verdict",
    "map-reduce": "reducer + N mappers; mapper inspects a slice",
    stigmergy: "self-organizing repo exploration via pheromone trails",
    moa: "Mixture of Agents — N proposers + 1 aggregator",
    baseline: "single agent / single prompt — eval-harness floor",
    pipeline: "multi-phase pipeline; chains sub-runs with transcript/deliverable piping",
  };
  return [
    "You are picking the BEST preset to handle a user directive.",
    "Each preset has different strengths; mismatched presets fail in predictable ways (e.g., MoA on a code-modify task is discussion-only, never writes files).",
    "",
    `User directive: ${args.directive.trim()}`,
    "",
    "Available presets:",
    ...args.available.map((p) => `  - ${p}: ${presetDescriptions[p]}`),
    "",
    "Output STRICT JSON only — no prose, no fences:",
    `{"pickedPreset": "<one of: ${args.available.join(", ")}>", "rationale": "<one sentence why>"}`,
  ].join("\n");
}

export function parsePresetRouterDecision(
  raw: string,
  available: readonly PresetId[],
): PresetRouterDecision | null {
  const text = raw.trim();
  if (!text) return null;
  const candidates: string[] = [text];
  const fence = /```(?:json)?\s*\n?([\s\S]*?)\n?```/m.exec(text);
  if (fence) candidates.push(fence[1].trim());
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1));
  }
  const validSet = new Set(available);
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c) as Record<string, unknown>;
      const id = parsed.pickedPreset;
      if (typeof id !== "string") continue;
      const trimmed = id.trim() as PresetId;
      if (!validSet.has(trimmed)) continue;
      const rationale =
        typeof parsed.rationale === "string" ? parsed.rationale.trim() : "";
      return { pickedPreset: trimmed, source: "llm", rationale };
    } catch {
      // try next candidate
    }
  }
  return null;
}
