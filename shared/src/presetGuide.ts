/**
 * Shared preset decision guide data.
 * Used by:
 * - Backend /brain/chat for prompting and structured responses
 * - UI BrainStartChat for rendering tables when user asks to "explain options"
 * - Docs and agents
 */

export interface PresetInfo {
  id: string;
  label: string;
  strengths: string;
  bestFor: string[];
}

export const PRESETS_GUIDE: Record<string, PresetInfo> = {
  blackboard: {
    id: "blackboard",
    label: "Blackboard",
    strengths: "Native writes + planner/workers/auditor + CAS + tier ratchet + verify gate. Best for code editing, implementing features, producing artifacts safely.",
    bestFor: ["code-editing", "writing", "research-write", "audit"],
  },
  council: {
    id: "council",
    label: "Council",
    strengths: "3-phase (debate → parallel execution → audit). Excellent for analysis, hypothesis generation, complex decisions, research synthesis. Supports hybrid (council planning → blackboard execution).",
    bestFor: ["research", "analysis", "debate", "synthesis", "hypothesis"],
  },
  "map-reduce": {
    id: "map-reduce",
    label: "Map-reduce",
    strengths: "Parallel mappers scan slices → reducer synthesizes. Ideal for broad literature scans, 'find all / map every', coverage-heavy research.",
    bestFor: ["literature-scan", "research", "coverage"],
  },
  moa: {
    id: "moa",
    label: "MoA (Mixture of Agents)",
    strengths: "Multiple independent proposers → aggregator. Strong for high-quality synthesis of findings or complex reasoning.",
    bestFor: ["synthesis", "research"],
  },
  "role-diff": {
    id: "role-diff",
    label: "Role-diff",
    strengths: "Specialist roles (Researcher, Critic, etc.) → deliverable. Good for multi-perspective structured analysis.",
    bestFor: ["analysis", "multi-perspective", "research"],
  },
  "orchestrator-worker": {
    id: "orchestrator-worker",
    label: "Orchestrator-worker",
    strengths: "Lead decomposes → workers investigate → synthesize. For hierarchical or large questions.",
    bestFor: ["hierarchical", "research"],
  },
  "orchestrator-worker-deep": {
    id: "orchestrator-worker-deep",
    label: "Orchestrator-worker-deep",
    strengths: "3-tier hierarchy for very large agent counts or complex decomposition.",
    bestFor: ["hierarchical", "large-scale"],
  },
  "debate-judge": {
    id: "debate-judge",
    label: "Debate-judge",
    strengths: "PRO/CON debate + judge verdict. For 'should we', pros/cons, decide between options.",
    bestFor: ["debate", "analysis"],
  },
  stigmergy: {
    id: "stigmergy",
    label: "Stigmergy",
    strengths: "Self-organizing exploration via pheromone table. Pure discovery / open-ended 'explore and understand' (read-only by design).",
    bestFor: ["exploration"],
  },
  pipeline: {
    id: "pipeline",
    label: "Pipeline",
    strengths: "Chained stages (e.g. explore → decompose → validate). For multi-stage scientific or research workflows.",
    bestFor: ["multi-stage", "research", "pipeline"],
  },
  "round-robin": {
    id: "round-robin",
    label: "Round-robin",
    strengths: "Rotating dispositions (Critic/Synthesizer/...). Structured deliberation.",
    bestFor: ["analysis", "deliberation"],
  },
};

export const USE_CASE_FILTERS = [
  { tag: "research", label: "Research" },
  { tag: "analysis", label: "Analysis/Debate" },
  { tag: "code-writing", label: "Code Writing" },
  { tag: "literature-scan", label: "Literature Scan" },
  { tag: "synthesis", label: "Synthesis" },
  { tag: "exploration", label: "Exploration" },
  { tag: "hierarchical", label: "Hierarchical" },
  { tag: "multi-stage", label: "Multi-stage" },
] as const;
