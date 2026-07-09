// Shared Zod wire-protocol schemas for the swarm WS API.
//
// Both the server (broadcast.ts) and the web client (types.ts) use these
// schemas to validate messages at the boundary. Keeping them in shared/
// prevents structural drift between what the server emits and what the
// client expects.
//
// Migration strategy: define schemas here → derive TS types via z.infer
// → replace hand-maintained interfaces in server/types.ts and
// web/types.ts with re-exports. Phase 1 establishes the schemas; phase 2
// (future) replaces the hand-maintained interfaces.

import { z } from "zod";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const SwarmPhaseSchema = z.enum([
  "idle", "cloning", "spawning", "seeding", "discussing", "planning",
  "executing", "paused", "draining", "stopping", "stopped", "completed",
  "failed",
]);
export type SwarmPhase = z.infer<typeof SwarmPhaseSchema>;

export const TodoStatusSchema = z.enum([
  "open", "claimed", "pending-commit", "committed", "stale", "skipped",
]);
export type TodoStatus = z.infer<typeof TodoStatusSchema>;

export const ExitCriterionStatusSchema = z.enum([
  "unmet", "met", "wont-do",
]);
export type ExitCriterionStatus = z.infer<typeof ExitCriterionStatusSchema>;

export const StopReasonSchema = z.enum([
  "completed", "user", "crash",
  "cap:wall-clock", "cap:commits", "cap:todos", "cap:tokens", "cap:quota",
  "early-stop", "no-progress", "partial-progress",
]);
export type StopReason = z.infer<typeof StopReasonSchema>;

export const AgentStatusSchema = z.enum([
  "spawning", "ready", "thinking", "retrying", "failed", "stopped", "killed",
]);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

/** Prompt-session lifecycle phases emitted by the transport layer (promptWithRetry). */
export const AgentActivityPhaseSchema = z.enum([
  /** @deprecated legacy logs — same as waiting (prompt in flight, no bytes yet) */
  "queued",
  "waiting",
  "streaming",
  "retrying",
  "done",
]);
export type AgentActivityPhase = z.infer<typeof AgentActivityPhaseSchema>;

export const TranscriptRoleSchema = z.enum(["system", "user", "agent"]);
export type TranscriptRole = z.infer<typeof TranscriptRoleSchema>;

// ---------------------------------------------------------------------------
// Compound types
// ---------------------------------------------------------------------------

export const ClaimSchema = z.object({
  todoId: z.string(),
  agentId: z.string(),
  fileHashes: z.record(z.string(), z.string()),
  claimedAt: z.number(),
  expiresAt: z.number(),
});
export type Claim = z.infer<typeof ClaimSchema>;

export const ExitCriterionSchema = z.object({
  id: z.string(),
  description: z.string(),
  expectedFiles: z.array(z.string()),
  status: ExitCriterionStatusSchema,
  rationale: z.string().optional(),
  addedAt: z.number(),
});
export type ExitCriterion = z.infer<typeof ExitCriterionSchema>;

export const ExitContractSchema = z.object({
  missionStatement: z.string(),
  criteria: z.array(ExitCriterionSchema),
});
export type ExitContract = z.infer<typeof ExitContractSchema>;

export const TodoSchema = z.object({
  id: z.string(),
  description: z.string(),
  expectedFiles: z.array(z.string()),
  createdBy: z.string(),
  createdAt: z.number(),
  status: TodoStatusSchema,
  staleReason: z.string().optional(),
  skippedReason: z.string().optional(),
  replanCount: z.number(),
  claim: ClaimSchema.optional(),
  committedAt: z.number().optional(),
  criterionId: z.string().optional(),
  expectedAnchors: z.array(z.string()).optional(),
  // Server-only fields (omitted from web type, included here for
  // server validation). The web type intentionally omits these;
  // the schema's .passthrough() allows them through.
});
export type Todo = z.infer<typeof TodoSchema>;

export const AgentStateSchema = z.object({
  id: z.string(),
  index: z.number(),
  sessionId: z.string().optional(),
  status: AgentStatusSchema,
  lastMessageAt: z.number().optional(),
  error: z.string().optional(),
  model: z.string().optional(),
  retryAttempt: z.number().optional(),
  retryMax: z.number().optional(),
  retryReason: z.string().optional(),
  thinkingSince: z.number().optional(),
  activityKind: z.string().optional(),
  activityLabel: z.string().optional(),
  activityAttempt: z.number().optional(),
  activityMaxAttempts: z.number().optional(),
});
export type AgentState = z.infer<typeof AgentStateSchema>;

export const FindingSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  text: z.string(),
  createdAt: z.number(),
});
export type Finding = z.infer<typeof FindingSchema>;

export const BoardSnapshotSchema = z.object({
  todos: z.array(TodoSchema),
  findings: z.array(FindingSchema),
});
export type BoardSnapshot = z.infer<typeof BoardSnapshotSchema>;

export const BoardCountsDTOSchema = z.object({
  open: z.number(),
  claimed: z.number(),
  committed: z.number(),
  stale: z.number(),
  skipped: z.number(),
  total: z.number(),
});
export type BoardCountsDTO = z.infer<typeof BoardCountsDTOSchema>;

export const DeliverableSchema = z.object({
  path: z.string(),
  status: z.enum(["created", "modified"]),
});
export type Deliverable = z.infer<typeof DeliverableSchema>;

// ---------------------------------------------------------------------------
// SwarmEvent — discriminated union on `type`
// ---------------------------------------------------------------------------

export const SwarmEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("transcript_append"), entry: z.any() }),
  z.object({ type: z.literal("agent_state"), agent: AgentStateSchema, runId: z.string().optional() }),
  z.object({ type: z.literal("swarm_state"), phase: SwarmPhaseSchema, round: z.number(), runId: z.string().optional() }),
  z.object({
    type: z.literal("agent_streaming"),
    agentId: z.string(),
    agentIndex: z.number(),
    text: z.string(),
    runId: z.string().optional(),
  }),
  z.object({ type: z.literal("agent_streaming_end"), agentId: z.string(), runId: z.string().optional() }),
  z.object({
    type: z.literal("agent_activity"),
    agentId: z.string(),
    agentIndex: z.number(),
    phase: AgentActivityPhaseSchema,
    ts: z.number(),
    activityId: z.string().optional(),
    kind: z.string().optional(),
    label: z.string().optional(),
    attempt: z.number().optional(),
    maxAttempts: z.number().optional(),
    reason: z.string().optional(),
    runId: z.string().optional(),
  }),
  z.object({ type: z.literal("error"), message: z.string() }),
  z.object({ type: z.literal("todo_posted"), todo: TodoSchema }),
  z.object({ type: z.literal("todo_claimed"), todoId: z.string(), claim: ClaimSchema }),
  z.object({ type: z.literal("todo_committed"), todoId: z.string() }),
  z.object({ type: z.literal("todo_failed"), todoId: z.string(), reason: z.string(), replanCount: z.number() }),
  z.object({ type: z.literal("todo_skipped"), todoId: z.string(), reason: z.string() }),
  z.object({ type: z.literal("todo_proposed"), todo: TodoSchema }),
  z.object({ type: z.literal("todo_reverted"), todoId: z.string(), reason: z.string() }),
  z.object({
    type: z.literal("model_shift"),
    agentId: z.string(),
    agentIndex: z.number(),
    fromModel: z.string(),
    toModel: z.string(),
    reason: z.string(),
    rawError: z.string().optional(),
  }),
  z.object({
    type: z.literal("todo_replanned"),
    todoId: z.string(),
    description: z.string(),
    expectedFiles: z.array(z.string()),
    replanCount: z.number(),
    expectedAnchors: z.array(z.string()).optional(),
  }),
  z.object({ type: z.literal("finding_posted"), finding: FindingSchema }),
  z.object({ type: z.literal("queue_state"), snapshot: BoardSnapshotSchema, counts: BoardCountsDTOSchema }),
  z.object({ type: z.literal("contract_updated"), contract: ExitContractSchema }),
  z.object({ type: z.literal("run_summary"), summary: z.any() }),
  z.object({
    type: z.literal("pheromone_updated"),
    file: z.string(),
    state: z.object({ visits: z.number(), avgInterest: z.number(), avgConfidence: z.number(), latestNote: z.string() }),
  }),
  z.object({ type: z.literal("mapper_slices"), slices: z.record(z.string(), z.array(z.string())) }),
  z.object({
    type: z.literal("agent_latency_sample"),
    agentId: z.string(),
    agentIndex: z.number(),
    attempt: z.number(),
    elapsedMs: z.number(),
    success: z.boolean(),
    ts: z.number(),
  }),
  z.object({
    type: z.literal("directive_amended"),
    runId: z.string(),
    ts: z.number(),
    text: z.string(),
  }),
  z.object({
    type: z.literal("conformance_sample"),
    runId: z.string(),
    ts: z.number(),
    score: z.number(),
    smoothedScore: z.number(),
    reason: z.string().optional(),
    graderModel: z.string().optional(),
    latencyMs: z.number().optional(),
    excerptChars: z.number().optional(),
    windowScores: z.array(z.number()).optional(),
    anchorOverlap: z.number().optional(),
    offGraphPaths: z.array(z.string()).optional(),
    recoverySuggested: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("drift_sample"),
    runId: z.string(),
    ts: z.number(),
    similarity: z.number(),
    smoothedSimilarity: z.number(),
    embeddingModel: z.string(),
    excerptChars: z.number(),
    windowSimilarities: z.array(z.number()),
  }),
  z.object({
    type: z.literal("clone_state"),
    alreadyPresent: z.boolean(),
    clonePath: z.string(),
    priorCommits: z.number(),
    priorChangedFiles: z.number(),
    priorUntrackedFiles: z.number(),
  }),
  z.object({
    type: z.literal("run_started"),
    runId: z.string(),
    startedAt: z.number(),
    preset: z.string(),
    plannerModel: z.string(),
    workerModel: z.string(),
    auditorModel: z.string(),
    dedicatedAuditor: z.boolean(),
    roles: z.array(z.string()).optional(),
    repoUrl: z.string(),
    clonePath: z.string(),
    agentCount: z.number(),
    rounds: z.number(),
    topology: z.any().optional(),
    deliverables: z.array(DeliverableSchema).optional(),
  }),
  z.object({
    type: z.literal("outcome_scored"),
    runId: z.string(),
    score: z.number(),
    verdict: z.enum(["ship-quality", "needs-revision", "fundamentally-flawed"]),
    dimensions: z.array(z.object({ id: z.string(), label: z.string(), score: z.number(), note: z.string() })),
  }),
  // brain-fallback: server-only event, not rendered in UI
  z.object({
    type: z.literal("brain-fallback"),
    agentId: z.string(),
    agentIndex: z.number(),
    fromModel: z.string(),
    toModel: z.string(),
    reason: z.string(),
    originalError: z.string().optional(),
  }),
]);

export type SwarmEvent = z.infer<typeof SwarmEventSchema>;

// ---------------------------------------------------------------------------
// PerAgentStat — used in RunSummary
// ---------------------------------------------------------------------------

export const PerAgentStatSchema = z.object({
  agentId: z.string(),
  agentIndex: z.number(),
  turnsTaken: z.number(),
  tokensIn: z.number().nullable().optional(),
  tokensOut: z.number().nullable().optional(),
  totalAttempts: z.number().optional(),
  totalRetries: z.number().optional(),
  successfulAttempts: z.number().optional(),
  meanLatencyMs: z.number().nullable().optional(),
  p50LatencyMs: z.number().nullable().optional(),
  p95LatencyMs: z.number().nullable().optional(),
  commits: z.number().optional(),
  linesAdded: z.number().optional(),
  linesRemoved: z.number().optional(),
  rejectedAttempts: z.number().optional(),
  jsonRepairs: z.number().optional(),
  promptErrors: z.number().optional(),
});
export type PerAgentStat = z.infer<typeof PerAgentStatSchema>;

// ---------------------------------------------------------------------------
// WS event validation helper
// ---------------------------------------------------------------------------

/**
 * Validate an incoming WS message as a SwarmEvent.
 * Returns the parsed event on success, or `{ ok: false, error }` on failure.
 * Used by the WS broadcast layer to ensure malformed events never reach clients.
 */
export function validateSwarmEvent(data: unknown): { ok: true; value: SwarmEvent } | { ok: false; error: z.ZodError } {
  const result = SwarmEventSchema.safeParse(data);
  if (result.success) {
    return { ok: true, value: result.data };
  }
  return { ok: false, error: result.error };
}