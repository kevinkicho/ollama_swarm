import { z } from "zod";
import { TopologySchema } from "@ollama-swarm/shared/topology";

export const MemoryStorePostBody = z.object({
  key: z.string().min(1).max(200),
  value: z.string().min(1).max(10000),
  clonePath: z.string().min(1).max(500),
  tags: z.array(z.string().max(100)).optional(),
});

export const MemoryStoreDeleteParams = z.object({
  key: z.string().min(1).max(200),
});

export const ClonePathQuery = z.object({
  clonePath: z.string().min(1).max(500),
  includeOtherParents: z.coerce.boolean().optional(),
});

export const PreflightQuery = z.object({
  repoUrl: z.string().optional().default(""),
  parentPath: z.string().min(1).max(500),
  preset: z.string().optional(),
  model: z.string().optional(),
  plannerModel: z.string().optional(),
  workerModel: z.string().optional(),
  auditorModel: z.string().optional(),
  agentCount: z.coerce.number().int().min(1).max(16).optional(),
  topology: z.string().optional(),
  directive: z.string().max(4000).optional(),
});

export const MemoryQuery = ClonePathQuery;

export const RunSummaryQuery = z.object({
  clonePath: z.string().min(1).max(500),
  runId: z.string().max(100).optional(),
});

export const OutcomeStatsQuery = ClonePathQuery;

export const OutcomeRecommendQuery = z.object({
  directive: z.string().min(1).max(4000),
  clonePath: z.string().max(500).optional(),
});

export const CheckpointsParams = z.object({
  runId: z.string().min(1).max(100),
});

export const CheckpointFileParams = z.object({
  runId: z.string().min(1).max(100),
  fileName: z
    .string()
    .min(1)
    .max(200)
    .refine(
      (n) => !n.includes("..") && !n.includes("/") && !n.includes("\\"),
      "fileName must be a bare filename",
    ),
});

export const TimelineParams = z.object({
  runId: z.string().min(1).max(100),
});

export const V2EventLogRunParams = z.object({
  runId: z.string().min(1).max(100),
});

export const SayPerRunBody = z.object({
  text: z.string().min(1).max(10000),
  intent: z.enum(["instruct", "question", "feedback", "suggest", "steer", "ask"]).optional(),
  targetAgent: z.string().max(50).optional(),
});

export const RunsQuery = z.object({
  includeOtherParents: z.coerce.boolean().optional(),
  parentPath: z.string().min(1).max(500).optional(),
});

export const StatusQuery = z.object({
  runId: z.string().min(1).max(100).optional(),
});

export const LegacyRunBody = z.object({
  runId: z.string().min(1).max(100).optional(),
});

export const BrainPatchHunkSchema = z.object({
  file: z.string().min(1).max(500),
  search: z.string().max(50_000).optional(),
  replace: z.string().max(50_000).optional(),
});

export const BrainApplyBody = z.object({
  proposalId: z.string().min(1).max(200),
  patchContent: z.array(BrainPatchHunkSchema).min(1).max(64),
  clonePath: z.string().min(1).max(500).optional(),
});

export const BrainRejectBody = z.object({
  proposalId: z.string().min(1).max(200),
  reason: z.string().max(2000).optional(),
  clonePath: z.string().min(1).max(500).optional(),
});

import type { Request, Response, NextFunction } from "express";

// Extracted from swarm.ts (2026-05-09 UML-B)
export const SwarmRoleSchema = z.object({
  name: z.string().trim().min(1).max(80),
  guidance: z.string().trim().min(1).max(2000),
});

export const StartBody = z.object({
  repoUrl: z.string().optional().default(""),
  parentPath: z.string().min(1),
  agentCount: z.coerce.number().int().min(1).max(8),
  model: z.string().optional(),
  // rounds=0 means infinite for blackboard (ratchet-driven, no audit cap).
  // For non-blackboard presets, rounds maps to actual work — rounds=100
  // with 6 agents on a serial preset can mean hours of wall-clock and
  // proportional cloud-token spend. Use accordingly.
  rounds: z.coerce.number().int().min(0).max(100).optional(),
  preset: z
    .enum([
      "round-robin",
      "blackboard",
      "role-diff",
      "council",
      "orchestrator-worker",
      "orchestrator-worker-deep",
      "debate-judge",
      "map-reduce",
      "stigmergy",
      "baseline",
      "moa",
      "pipeline",
    ])
    .default("round-robin"),
  // Unit 25: optional free-text directive that shapes the blackboard
  // planner's first-pass contract. Capped at 4000 chars to match the
  // README-excerpt window already in the planner seed (same order of
  // magnitude of prompt real-estate). Empty/whitespace gets treated as
  // absent — the planner only sees it when there's actual content.
  userDirective: z.string().trim().max(4000).optional(),
  // Unit 32: per-preset knobs. Validated here so the route layer is the
  // sole boundary between user input and RunConfig. Runners receive
  // already-validated values and only need to decide how to apply them.
  roles: z.array(SwarmRoleSchema).min(1).max(16).optional(),
  councilContract: z.boolean().optional(),
  proposition: z.string().trim().max(2000).optional(),
  // Unit 34: per-run ambition ratchet cap. 0 = explicitly disabled; 1-20
  // enables with that many tiers max. Absent = inherit from env.
  // Blackboard-only.
  ambitionTiers: z.coerce.number().int().min(0).max(20).optional(),
  // Unit 35: per-run critic override. Blackboard-only.
  critic: z.boolean().optional(),
  // Unit 36: user-supplied running-app URL for auditor UI verification.
  // Requires MCP_PLAYWRIGHT_ENABLED=true. Blackboard-only.
  uiUrl: z.string().url().optional(),
  // Unit 42: per-agent model overrides (blackboard-only). Each falls
  // back to `model` when absent. Validated as the same loose string
  // shape as `model` itself — opencode/Ollama is the authoritative
  // resolver.
  plannerModel: z.string().trim().min(1).max(200).optional(),
  workerModel: z.string().trim().min(1).max(200).optional(),
  // Unit 43: per-run wall-clock cap override (ms). 0 or absent = use server
  // default (no hard override; blackboard etc. may run until other caps).
  // When >0: bounded [60_000, 8h]. 0 explicitly allowed from UI to mean "disabled".
  wallClockCapMs: z
    .number()
    .int()
    .min(0)
    .max(8 * 60 * 60_000)
    .optional(),
  // #296 (2026-04-28): pre-commit verify command (e.g. "npm test").
  // Bounded length so we don't accept a 100KB shell script via the
  // route. Trimmed; empty string → undefined → skip the gate
  // entirely (legacy behavior). Blackboard-only.
  verifyCommand: z.string().trim().min(1).max(500).optional(),
  // Opt-in: grant planner read/grep/glob tools (swarm-read profile).
  // Default false — backward compatible, avoids context blow-up.
  // Planner is limited to 3 file reads per turn when enabled.
  plannerTools: z.boolean().optional(),
  // Opt-in web tools (web_search + web_fetch) for research-oriented runs.
  // When true, planner/research agents can perform internet searches
  // (e.g. governmental data endpoints). Uses DuckDuckGo + fetch under
  // the hood, results are truncated. Pair with plannerTools for best effect.
  webTools: z.boolean().optional(),
  // Experimental MCP servers (future full dynamic connection).
  mcpServers: z.string().trim().optional(),
  // Local Ollama: strips :cloud suffix from all model refs.
  // Routes all prompts through local Ollama instead of Ollama Cloud.
  useLocal: z.boolean().optional(),
  // Multi-user: optional identifier for the user starting this run.
  // Used by /api/swarm/runs?user=X to filter by owner.
  createdBy: z.string().trim().min(1).max(50).optional(),
  // Unit 51: reload contract + tier state from prior run's
  // blackboard-state.json instead of re-deriving via first-pass-
  // contract. Blackboard-only. Default false = existing behavior.
  resumeContract: z.boolean().optional(),
  // Unit 58: opt-in to a 4th agent dedicated to the auditor role.
  // Total agents = agentCount + 1 (auditor is extra; workers
  // unchanged). Blackboard-only.
  dedicatedAuditor: z.boolean().optional(),
  auditorModel: z.string().trim().min(1).max(200).optional(),

  // NEW: auditorOnlyMutations - workers propose only, auditor commits.
  auditorOnlyMutations: z.boolean().optional(),
  // NEW: force verification in auditor path.
  requireAuditorVerification: z.boolean().optional(),
  // Unit 59 (59a): per-worker role bias (correctness / simplicity /
  // consistency cycling). Blackboard-only.
  specializedWorkers: z.boolean().optional(),
  // Unit 60: 3-critic ensemble (substance / regression / consistency)
  // with majority vote. Blackboard-only; only meaningful when critic
  // is enabled.
  criticEnsemble: z.boolean().optional(),
  // #87 (2026-05-01): self-consistency K for worker hunks. K > 1 runs
  // the worker prompt K times per todo + applies the majority-voted
  // hunks envelope. Capped at 5 to bound token cost. Blackboard-only.
  selfConsistencyK: z.coerce.number().int().min(1).max(5).optional(),
  // #93 deeper (2026-05-01): MoA aggregator count + convergence threshold.
  // moaAggregatorCount > 1 = K aggregators in parallel, pick most-central.
  // moaConvergenceThreshold gates round-to-round early stop. MoA-only.
  moaAggregatorCount: z.coerce.number().int().min(1).max(3).optional(),
  moaConvergenceThreshold: z.coerce.number().min(0).max(1).optional(),
  // #98 (2026-05-01): heterogeneous models per MoA layer. Tests the
  // value prop "N small + 1 big > 1 big alone" cleanly. MoA-only.
  moaProposerModel: z.string().trim().min(1).max(200).optional(),
  moaAggregatorModel: z.string().trim().min(1).max(200).optional(),

  // Hybrid planning + execution (suggestion #1 and #3)
  // Use a broad-understanding preset (e.g. council) for initial planning,
  // then pipe the deliverable/plan into blackboard for safe execution.
  planningPreset: z.string().optional(), // e.g. "council"
  executionPreset: z.string().optional(), // e.g. "blackboard"
  useHybridPlanning: z.boolean().optional(),
  // T196 + T199 (2026-05-04): per-tier model arrays + extras for the
  // open-weights-parallelism value prop. Each is opt-in, falls back
  // to cfg.model when absent.
  moaProposerModels: z
    .array(z.string().trim().min(0).max(200))
    .max(20)
    .optional(),
  moaAggregationLevels: z.coerce.number().int().min(1).max(4).optional(),
  orchestratorModel: z.string().trim().min(1).max(200).optional(),
  midLeadModel: z.string().trim().min(1).max(200).optional(),
  dispositionModels: z
    .object({
      critic: z.string().trim().min(1).max(200).optional(),
      synthesizer: z.string().trim().min(1).max(200).optional(),
      "gap-finder": z.string().trim().min(1).max(200).optional(),
      builder: z.string().trim().min(1).max(200).optional(),
    })
    .optional(),
  // T199 cluster of opt-in flags wired in earlier passes (T197/T198/T199).
  importGraphSlicing: z.boolean().optional(),
  crossClusterDiscovery: z.boolean().optional(),
  streamingReducer: z.boolean().optional(),
  dynamicRoles: z.boolean().optional(),
  parallelPropositions: z.boolean().optional(),
  twoStageMoA: z.boolean().optional(),
  bidirectionalRefinement: z.boolean().optional(),
  baselineSelfCritique: z.boolean().optional(),
  baselineAttempts: z.coerce.number().int().min(1).max(5).optional(),
  testDrivenTodos: z.boolean().optional(),
  parallelHypothesis: z.boolean().optional(),
  chainTo: z.enum(["blackboard", "baseline"]).optional(),
  adaptiveWorkers: z
    .object({
      min: z.coerce.number().int().min(1).max(20),
      max: z.coerce.number().int().min(1).max(20),
    })
    .optional(),
  // Task #102 (2026-04-25): opt-in post-verdict "build" round for
  // debate-judge — PRO becomes implementer, CON reviewer, JUDGE
  // signoff. Default off; debate-judge-only.
  executeNextAction: z.boolean().optional(),
  // Task #124: optional per-run hard cap on total tokens (prompt +
  // response) consumed. User-supplied number, no defaults.
  tokenBudget: z.coerce.number().int().positive().optional(),
  // Phase 2 of #314: optional per-run dollar ceiling for paid
  // providers. Capped at $100 to prevent obvious typos (extra zero)
  // from authorizing a runaway run; users with legitimately bigger
  // budgets can lift this in the schema after deliberate review.
  maxCostUsd: z.coerce.number().positive().max(100).optional(),
  // W13 wiring (2026-05-04): per-run provider failover chain. When
  // set, overrides the env-derived SWARM_PROVIDER_FAILOVER list. Each
  // element is a provider-prefixed model string (e.g.
  // "anthropic/claude-haiku-4-5", "glm-5.1:cloud"). Capped at 8
  // entries to keep failover bounded.
  providerFailover: z.array(z.string().min(1)).max(8).optional(),
  // AI brain fallback model override. When set, overrides the
  // SWARM_BRAIN_MODEL env var for this run. Lightly validated (non-empty
  // string). Empty string disables brain fallback for this run.
  brainModel: z.string().trim().max(200).optional(),
  // Task #127: when no userDirective is set, auto-generate one via a
  // pre-pass. Default true (caller can pass false to disable).
  autoGenerateGoals: z.boolean().optional(),
  // Task #129: post-completion stretch-goal reflection pass — one
  // planner prompt asks "what would the BEST version of this work
  // have done?" and tags the answer for next-run / user review.
  // Default true; pass false to skip.
  autoStretchReflection: z.boolean().optional(),
  // Task #128: per-commit verifier (claim-vs-diff). Default off; opt-in.
  verifier: z.boolean().optional(),
  // Per-run override for the V2 worker pipeline. When set, wins over
  // the USE_WORKER_PIPELINE_V2 env flag for THIS run only. Lets the
  // user A/B without restarting the dev server. Blackboard-only;
  // ignored by discussion presets. (See SwarmRunner RunConfig comment
  // for context.)
  useWorkerPipeline: z.boolean().optional(),
  // Issue #3: override the sibling-model fallback used when the
  // planner returns 0 valid todos. Set to the same value as the
  // planner model to disable fallback. Blackboard-only.
  plannerFallbackModel: z.string().trim().min(1).max(200).optional(),
  // Task #132: continuous mode — run-against-budget instead of
  // run-against-rounds. Requires at least one budget cap (tokenBudget
  // or wallClockCapMs); the start handler rejects otherwise.
  continuous: z.boolean().optional(),
  // Task #130: persistent cross-run memory (.swarm-memory.jsonl).
  // Read at planner-seed time + written at run-end (post-stretch).
  // Default true.
  autoMemory: z.boolean().optional(),
  // Task #177: long-horizon DESIGN memory at <clone>/.swarm-design/
  // (north-star + decisions + roadmap). Default true.
  autoDesignMemory: z.boolean().optional(),
  // Task #147: when true, the route auto-stops any existing runner
  // before starting the new one, instead of returning 409 "A swarm
  // is already running". Lets clients recover from a stuck-orchestrator
  // state (e.g. previous start hung in spawning phase, client gave up
  // on its HTTP request, but the server-side runner is still around).
  // Default false — explicit opt-in so the UI's normal Start button
  // can't accidentally clobber a healthy run.
  force: z.boolean().optional(),
  // Phase 1 of the topology refactor (#243): explicit per-agent specs.
  // When present, supersedes legacy fields (agentCount, plannerModel,
  // workerModel, auditorModel, dedicatedAuditor) — those are derived
  // from the topology via deriveLegacyFields() and re-injected into
  // the runner's RunConfig. When absent (older clients), the legacy
  // fields drive the run unchanged. Synthesis happens at the end of
  // the handler via synthesizeTopology(), so the post-resolution
  // RunConfig.topology is always populated for downstream phases
  // (4a History column, 4b AgentPanel mirroring) to consume.
  topology: TopologySchema.optional(),
  // Plan 5: post-round critique — 1 extra prompt/round, any discussion preset.
  postRoundCritique: z.boolean().optional(),
  // Plan 7: post-synthesis critique — 1 extra prompt after synthesis, MoA pattern.
  postSynthesisCritique: z.boolean().optional(),
  // Plan 6: rotating dispositions for blackboard workers across cycles.
  workerDispositions: z.boolean().optional(),
  // Write mode: controls how files are written during execution.
  // "none" = single-worker hunk-based, "single" = single-writer synthesis,
  // "multi" = multi-writer with conflict policy.
  writeMode: z.enum(["none", "single", "multi"]).optional(),
  // Conflict policy for multi-write mode.
  conflictPolicy: z.enum(["merge", "sequential", "vote", "judge", "pick"]).optional(),
  // Plan 1: debate-judge auditor — PRO/CON/JUDGE replaces single-agent audit.
  debateAudit: z.boolean().optional(),
  debateAuditRounds: z.coerce.number().int().min(1).max(2).optional(),
  // Plan 2: council inside map-reduce mappers — draft→revise per slice.
  councilMappers: z.boolean().optional(),
  councilMapperRounds: z.coerce.number().int().min(1).max(3).optional(),
  // Plan 3: pheromone heatmap — cross-preset file-attention signal.
  pheromoneHotseed: z.string().trim().max(100).optional(),
  pheromoneHotFiles: z.array(z.string().min(1).max(500)).max(50).optional(),
  // Plan 4: pipeline preset — chain sub-runs with transcript/deliverable piping.
  pipeline: z.object({
    phases: z.array(z.object({
      preset: z.enum([
        "round-robin", "blackboard", "role-diff", "council",
        "orchestrator-worker", "orchestrator-worker-deep", "debate-judge",
        "map-reduce", "stigmergy", "baseline", "moa",
      ]),
      rounds: z.coerce.number().int().min(0).max(100).optional(),
      agentCount: z.coerce.number().int().min(1).max(8).optional(),
      model: z.string().trim().min(1).max(200).optional(),
    })).min(2).max(10),
    pipeMode: z.enum(["transcript", "deliverable", "both"]).optional(),
    pipeMaxEntries: z.coerce.number().int().min(1).max(100).optional(),
  }).optional(),
  rubricGrading: z.boolean().optional(),
  checkpointing: z.boolean().optional(),
});


// 2026-05-02: extended /say body with optional intent tag + targetAgent.
//   intent="suggest" → low-pressure, considered if relevant
//   intent="steer"   → reshape next planner turn (current behavior, default)
//   intent="ask"     → answer inline; do NOT change direction
//   targetAgent      → @mention routing; only this agent's prompt sees the input
// Default intent is "steer" so existing /say callers keep current semantics.
export const SayBody = z.object({
  text: z.string().min(1),
  intent: z.enum(["suggest", "steer", "ask"]).optional(),
  targetAgent: z.string().min(1).max(64).optional(),
  runId: z.string().min(1).max(100).optional(),
});

// Unit 52c: open-clone request body. Path is the absolute path of the
// directory the user wants to open in the OS file manager. Validated
// at handler time against the orchestrator's known clone — we only
// open paths the runner is currently or was recently working in,
// never arbitrary filesystem locations.
export const OpenBody = z.object({ path: z.string().min(1).max(4096) });


export function validate<T>(schema: z.ZodSchema<T>, source: "body" | "query" | "params") {
  return (req: Request, res: Response, next: NextFunction): void => {
    const data = req[source];
    const result = schema.safeParse(data);
    if (!result.success) {
      const { error, details } = formatZodError(result.error);
      res.status(400).json({ error, ok: false, details });
      return;
    }
    (req as unknown as Record<string, unknown>)[source] = result.data;
    next();
  };
}

export function formatZodError(err: z.ZodError): { error: string; details: unknown } {
  const fieldErrors = err.flatten().fieldErrors;
  const formErrors = err.flatten().formErrors;
  const parts: string[] = [];
  if (formErrors.length > 0) parts.push(formErrors.join("; "));
  for (const [field, messages] of Object.entries(fieldErrors)) {
    if (messages && messages.length > 0) parts.push(`${field}: ${messages.join(", ")}`);
  }
  return { error: parts.join(" | ") || "Validation failed", details: { fieldErrors, formErrors } };
}