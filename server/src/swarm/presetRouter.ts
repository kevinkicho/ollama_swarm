// Q12 (2026-05-04): best-preset auto-pick router.
//
// Given a user directive, infer which preset is most likely to
// succeed:
//   - "refactor X" / "fix bug Y" / "add feature Z" → blackboard
//     (write-capable; small atomic todos)
//   - "debate whether to migrate" / "is X safe?" → debate-judge
//   - "design how should we X" / "decide between A and B" → council
//   - "audit X" / "find every Y" / "map out Z" → map-reduce
//   - "explore the repo" / "what does this do" → stigmergy
//   - "answer this question" / "draft a doc" / discussion → moa or
//     round-robin (default to moa for breadth)
//
// Two-tier router:
//   1. Heuristic keyword matcher (cheap; deterministic; explainable)
//   2. LLM router (called ONLY when the heuristic is ambiguous; the
//      runner threads the call through promptWithRetry)
//
// This module ships the heuristic + the prompt builder for the LLM
// fallback. The LLM call itself is the runner's responsibility (it
// owns the model + provider).
//
// Tradeoffs:
//   - Wrong picks erode trust. The heuristic is conservative (defaults
//     to "blackboard" only when CONFIDENTLY a code-modify directive).
//   - When the LLM router fires, +1 prompt before the run starts (cost
//     proportional to how often the heuristic is ambiguous).

import type { PresetId } from "./SwarmRunner.js";

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
  // Debate / decision category (highest priority — "should we" is a
  // strong intent marker even when followed by a code-modify verb)
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
  // Design / decision-by-discussion category
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
  // Survey / audit category
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
  // Exploration category
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
  // Code-modify category (last layer — only fires when no intent marker matched)
  const writeVerbs = [
    "fix", "add", "remove", "delete", "rename", "refactor", "extract",
    "migrate", "implement", "wire", "port", "update", "patch", "resolve",
    "address", "convert", "replace", "reorganize", "rewrite",
  ];
  for (const v of writeVerbs) {
    // Word-boundary match to avoid "addiction" matching "add"
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

/** Build the LLM-router prompt for cases the heuristic couldn't
 *  decide. The router emits a JSON envelope with picked preset +
 *  rationale. Pure. */
export function buildPresetRouterPrompt(args: {
  directive: string;
  /** Available presets (the user's config may exclude some). */
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

/** Lenient parser. Returns null on parse failure or invalid id. Pure. */
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
