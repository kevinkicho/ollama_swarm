import type { SwarmPreset } from "./PresetExtras";

// Two-tier model framework — see docs/autonomous-productivity.md
// "Per-preset distribution" for the full rationale.
//   REASONING — judgment, decomposition, synthesis, multi-step
//     deliberation. Use for planners, drafters, judges, reducers,
//     orchestrators, peer-dialogue presets.
//   CODING — structured-output emission against a clear spec
//     (diffs, file summaries). Faster + cheaper than reasoning;
//     correct trade-off for blackboard workers and stigmergy peers.
//   VERIFIER — heaviest reasoning model, reserved for the auditor
//     role where rubber-stamping is the dominant failure mode.
//
// 2026-04-23: REASONING flipped from glm-5.1:cloud to
// nemotron-3-super:cloud after the vocabmaster v7 4-agent run
// showed nemotron mean=9.5s vs glm mean=57s on the auditor, and
// the multi-agent-orchestrator preset tour showed glm producing
// repeated empty responses on parallel-spawn fanout (Agent 3
// pattern across role-diff + council).
//
// 2026-04-27: REASONING flipped again, nemotron-3-super:cloud →
// deepseek-v4-pro:cloud, per Kevin's directive after he pulled +
// verified deepseek-v4-pro is loaded.
//
// 2026-04-27 (later): REVERTED back to glm-5.1:cloud. deepseek showed
// Ollama server-traffic congestion (HTTP 503 + slow batched chunks
// that bypassed our streaming-collapsibles + emitted XML tool-call
// syntax that broke JSON parsing). glm-5.1 + nemotron stay as the
// reliable reasoning-tier pair until deepseek's serving stabilizes.
// All three models remain available via the form's free-text Model
// field. Keep constants separate so a future per-role split can
// target REASONING / CODING / VERIFIER without touching every preset.
export const MODEL_REASONING = "deepseek-v4-flash:cloud";
export const MODEL_CODING = "deepseek-v4-flash:cloud";

// Keep server-side cap (max=8) in mind when editing `max` values here.
// Patterns that theoretically scale higher (blackboard, stigmergy) are
// capped at 8 until their backends land.
export const PRESETS: readonly SwarmPreset[] = [
  {
    id: "round-robin",
    label: "Round-robin transcript",
    // 2026-05-02 (improvement #5): no longer "neutral baseline" — every
    // turn rotates through Critic/Synthesizer/Gap-finder/Builder, the
    // user directive shapes seed + each turn + final synthesis.
    summary: "Structured deliberation. N agents take turns, each turn a different disposition (Critic/Synthesizer/Gap-finder/Builder). Lead synthesizes a directive answer at the end.",
    min: 2,
    max: 8,
    recommended: 3,
    recommendedModel: MODEL_REASONING,
    status: "active",
    maturity: "supported",
    directive: "honored",
    useCases: ["analysis", "deliberation"],
  },
  {
    id: "blackboard",
    label: "Blackboard (optimistic + small units)",
    summary: "Planner posts todos; workers claim and commit in parallel. CAS on file hashes catches stale plans.",
    // min 3 = planner + 1 worker + auditor (zero workers cannot run).
    min: 3,
    max: 8,
    recommended: 6,
    // Main Model = the planner's tier. Per-agent overrides
    // (BLACKBOARD_DEFAULT_*_MODEL) refine workers + auditor.
    recommendedModel: MODEL_REASONING,
    status: "active",
    maturity: "core",
    directive: "honored",
    useCases: ["code-writing", "research", "audit"],
  },
  {
    id: "role-diff",
    label: "Role differentiation",
    // 2026-05-02 (improvement #2+#4): with a directive, becomes a
    // BUILD team (Researcher/Designer/Implementer/Tester/Reviewer/
    // Documenter/Devil's-advocate) that produces a portable
    // deliverable.md. Without one, falls back to the original audit
    // catalog (Architect/Tester/Security/Perf/...).
    summary: "Specialist team. With a directive, agents become Researcher/Designer/Implementer/Tester/Reviewer/Documenter/Devil's-advocate and produce a deliverable.md. Without one, falls back to a 7-lens repo audit.",
    min: 3,
    max: 8,
    recommended: 5,
    recommendedModel: MODEL_REASONING,
    status: "active",
    maturity: "experimental",
    directive: "honored",
    useCases: ["analysis", "multi-perspective", "research"],
  },
  {
    id: "map-reduce",
    label: "Map-reduce over repo",
    // 2026-05-02 (improvement #1+#2): with a directive becomes a
    // parallel-coverage answerer ("find everything in this repo that
    // bears on X, in parallel"). Without one, falls back to the
    // original "tell me about this repo" sweep.
    summary: "Parallel coverage. With a directive, mappers search their slice for findings relevant to it (off-topic slices report 'no relevant findings'); reducer answers the directive. Without one, mappers describe their slice and reducer synthesizes a project picture.",
    // Task #109: floored at 4 (1 reducer + 3 mappers). Smaller setups
    // leave one mapper with a trivially-small slice and the model
    // collapses on it (run 2bcf662f). The route-layer Zod schema also
    // enforces this, so the form's min keeps both UIs aligned.
    min: 4,
    max: 8,
    recommended: 5,
    // Single-model preset today — pick reducer's tier so synthesis
    // doesn't bottleneck. When per-role model selection ships
    // (Unit 65 candidate), swap mappers to MODEL_CODING.
    recommendedModel: MODEL_REASONING,
    status: "active",
    maturity: "experimental",
    directive: "honored",
    useCases: ["literature-scan", "research", "coverage"],
  },
  {
    id: "council",
    label: "Council (parallel drafts + reconcile)",
    // 2026-05-02 (improvement #1+#2+#3+#4): each agent ends every turn
    // with a `### MY POSITION` block; Round-2+ requires explicit
    // KEEP/CHANGE ownership against prior position; synthesis includes
    // a Minority report; deliverable surfaces per-agent positions
    // side-by-side. Honors directive (drafters answer it; rubric +
    // synthesis frame around it).
    summary: "Independent parallel drafts + reveal/revise. Each agent commits to a `### MY POSITION` per round; Round-2+ must explicitly KEEP or CHANGE prior position. Synthesis preserves dissent via a Minority report. Honors directive.",
    min: 2,
    max: 8,
    recommended: 4,
    // All N drafters need actual angles; coding-tier produces
    // near-identical drafts → no diversity gain.
    recommendedModel: MODEL_REASONING,
    status: "active",
    maturity: "core",
    directive: "honored",
    useCases: ["research", "analysis", "debate", "synthesis"],
  },
  {
    id: "orchestrator-worker",
    label: "Orchestrator–worker hierarchy",
    // 2026-05-02 (OW directive lever): with directive set, lead
    // decomposes the directive into worker subtasks; workers report
    // findings RELEVANT to the directive (with off-topic valve);
    // synthesis answers the directive. Without a directive, falls
    // back to "tell me about this repo" via N lenses.
    summary: "Lead decomposes work for parallel workers, then synthesizes. With a directive, lead decomposes IT into worker subtasks; workers find directive-relevant evidence; synthesis answers the directive. Without one, falls back to a generic repo audit.",
    min: 2,
    max: 8,
    recommended: 4,
    // Single-model preset today — pick orchestrator's tier. Same
    // Unit 65 candidate as map-reduce.
    recommendedModel: MODEL_REASONING,
    status: "active",
    maturity: "supported",
    directive: "honored",
    useCases: ["hierarchical", "research"],
  },
  {
    id: "orchestrator-worker-deep",
    label: "Orchestrator–worker hierarchy (3-tier)",
    // 2026-05-02 (OW-Deep directive lever): top orchestrator
    // decomposes the directive into one coarse sub-question per
    // mid-lead; mid-leads decompose those into worker subtasks;
    // workers execute toward the directive; everything synthesizes
    // upward to a directive answer.
    summary: "3-tier OW for high agent counts. With a directive, orchestrator decomposes it across mid-leads; mid-leads dispatch directive-relevant subtasks to their workers; everything synthesizes upward to a directive answer. Without one, falls back to a tiered repo sweep.",
    // Floor at 4 (1 orchestrator + 1 mid-lead + 2 workers). Cap at 30
    // because past that the orchestrator's mid-lead pool exceeds 8 again
    // and the design rationale (no tier sees > ~8 reports) breaks.
    min: 4,
    max: 30,
    recommended: 8,
    recommendedModel: MODEL_REASONING,
    status: "active",
    maturity: "research",
    directive: "honored",
    useCases: ["hierarchical", "large-scale"],
  },
  {
    id: "debate-judge",
    label: "Debate + judge",
    // 2026-05-03 (debate-judge directive lever): with directive set,
    // judge auto-derives a sharp PRO/CON proposition; debaters argue
    // it with directive as broader context; implementer's nextAction
    // file edits target the directive. Proposition input still works
    // for power users who want to control the debate framing directly.
    summary: "PRO vs CON debate (3 agents fixed). Judge auto-derives a debatable proposition from your directive; implementer's nextAction file edits target the directive. Optional Proposition (Advanced) lets you set the debate framing directly.",
    min: 3,
    max: 3,
    recommended: 3,
    // All three roles need higher-reasoning. Heterogeneous-judge
    // (PRO/CON on one model, JUDGE on another) is a Unit 65
    // candidate — bias mitigation gain isn't huge.
    recommendedModel: MODEL_REASONING,
    status: "active",
    maturity: "experimental",
    directive: "honored",
    useCases: ["debate", "analysis"],
  },
  {
    id: "stigmergy",
    label: "Stigmergy / pheromone trails",
    summary: "Self-organizing repo exploration. Each agent picks a file based on a shared annotation table; untouched files attract, well-covered ones repel.",
    min: 2,
    max: 8,
    recommended: 5,
    // Each task is read-and-summarize; coding-tier finishes faster
    // → more parallel coverage per minute. Coordination is via the
    // pheromone table, not deliberation, so reasoning doesn't pay.
    recommendedModel: MODEL_CODING,
    status: "active",
    maturity: "research",
    directive: "ignored",
    useCases: ["exploration"],
  },
  {
    id: "moa",
    label: "Mixture of Agents (MoA)",
    summary: "N proposers each draft independently (peer-hidden, parallel). One aggregator synthesizes their drafts. Reproducibly beats single-large-model on reasoning benchmarks using only small open-weights models.",
    min: 2,
    max: 8,
    recommended: 5,
    recommendedModel: MODEL_REASONING,
    status: "active",
    maturity: "experimental",
    directive: "honored",
    useCases: ["synthesis", "research"],
  },
  {
    id: "pipeline",
    label: "Pipeline (sequential stages)",
    summary: "Chain multiple presets together. Each phase's output feeds the next. Default: Explore (stigmergy) → Decompose (orchestrator-worker) → Validate (debate-judge).",
    min: 2,
    max: 8,
    recommended: 4,
    recommendedModel: MODEL_REASONING,
    status: "active",
    maturity: "experimental",
    directive: "honored",
    useCases: ["multi-stage", "research", "pipeline"],
  },
];

export const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

// Quick-fill text for the "Deliver README + research" chip below the
// user-directive textarea. One-click way to seed the planner with the
// common README + online-research directive (project-agnostic template).
export const DIRECTIVE_README_AND_RESEARCH =
  "Make this project actually deliver every feature the README claims to support. Also, creatively enhance its functionalities by adding in more pipelines by conducting research online and then implement them. Use bash to run npm test / npx playwright test / npx vitest run and capture screenshots via Playwright; cite test output as evidence.";

// Mirror of server's deriveCloneDir for the preview hint under the Parent
// folder field. Server is the source of truth; this is a best-effort UX
// preview. Returns "" if the URL isn't parseable yet (so the user gets the
// plain placeholder hint instead).
export function buildPreviewClonePath(repoUrl: string, parentPath: string): string {
  if (!repoUrl || !parentPath) return "";
  let u: URL;
  try {
    u = new URL(repoUrl);
  } catch {
    return "";
  }
  const segments = u.pathname.split("/").filter((s) => s.length > 0);
  const last = segments[segments.length - 1];
  if (!last) return "";
  const name = last.replace(/\.git$/i, "");
  if (!name) return "";
  const sep = parentPath.includes("\\") && !parentPath.includes("/") ? "\\" : "/";
  const trimmed = parentPath.replace(/[\\/]+$/, "");
  return `${trimmed}${sep}${name}`;
}
