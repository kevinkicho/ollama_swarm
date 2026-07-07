// Auto-extracted from types.ts (DF-4, 2026-05-09)
// Import from "./types.js" for backward compatibility — this file
// is re-exported from types.ts as a barrel.

import type { TranscriptEntrySummary } from "@ollama-swarm/shared/transcriptEntrySummary";
import type { AgentState } from "./agents.js";
import type { SwarmPhase } from "./run.js";
import type { Todo, Claim, Finding, BoardSnapshot, ExitContract } from "../swarm/blackboard/types.js";
import type { RunSummary } from "../swarm/blackboard/summary.js";

export type TranscriptRole = "system" | "user" | "agent";

export interface TranscriptEntry {
  id: string;
  role: TranscriptRole;
  agentId?: string;
  agentIndex?: number;
  text: string;
  ts: number;
  // Phase 4 scoping: when emitted inside a composite/pipeline run, these tag
  // the entry to its originating phase. Additive; old entries and pure runs omit them.
  // Legacy phase attribution (on transcript entries / some events from old composite runs).
  // No longer emitted for new runs (Phase 10 removal).
  phaseIndex?: number;
  phasePreset?: string;
  // Unit 54: optional structured summary for agent responses that
  // parse as a known JSON envelope (worker hunks/skip, planner todo
  // list, auditor verdict, etc.). The UI uses this to render a
  // one-line summary by default and only show the raw text on
  // click-to-expand. Absent on system/user entries and on agent
  // entries that don't parse as a recognized envelope.
  summary?: TranscriptEntrySummary;
  // 2026-04-27 (UI Phase 1): when an agent emitted <think>...</think>
  // markers (reasoning models), the server-side appendAgent strips
  // them out into this field via shared/extractThinkTags. The text
  // field carries the FINAL response only. UI renders thoughts as a
  // collapsed-by-default ThoughtsBlock above the main bubble. Absent
  // on system/user entries and on agent entries with no <think> tags.
  thoughts?: string;
  // 2026-04-27 evening (#229): when an agent emitted XML pseudo-tool-
  // call markers (<read>, <grep>, <list>, <glob>, <edit>, <bash>) as
  // raw text, server-side appendAgent strips them via shared/
  // extractToolCallMarkers. UI renders as a collapsed-by-default
  // ToolCallsBlock above the main bubble. Each entry is the raw
  // marker text (e.g., `<read path='src/foo.ts' />`).
  toolCalls?: string[];
  // 2026-05-02: user-message intent tag from /api/swarm/say. Only set
  // on role:"user" entries. Lets runners weight the input differently
  // (suggest = low priority, steer = reshape next turn, ask = answer
  // inline + don't change direction). Absent = legacy "steer" semantics
  // for back-compat with pre-tagged callers.
  intent?: "suggest" | "steer" | "ask";
  // 2026-05-02: @mention routing. When set, only the targeted agent's
  // prompt sees this user entry; broadcast runners filter it out for
  // every other agent. Targets the agent's id (e.g. "agent-2") not the
  // role-name. Absent = broadcast to all agents (current default).
  targetAgent?: string;
  // T-Item-2 (2026-05-04): debate-judge K parallel debate streams.
  // When set, this entry belongs to a specific stream (e.g. "stream-1").
  // Lets the runner scope per-stream prompts (each stream sees only its
  // own transcript) while keeping a single source-of-truth main
  // transcript. Absent on entries from non-streamed runs.
  streamId?: string;
}

export interface BoardCountsDTO {
  open: number;
  claimed: number;
  committed: number;
  stale: number;
  skipped: number;
  total: number;
}

// T-Item-MultiTenant Phase 1 (2026-05-04): every SwarmEvent carries an
// optional `runId`. Stamped by Orchestrator.wrappedEmit at broadcast
// time so the WS subscriber filter (Phase 2) can route per-run. The
// intersection-with-base-fields pattern lets us add the field without
// modifying every union variant — existing emit sites that don't set
// runId still type-check + work; the orchestrator hydrates it.
export type SwarmEventBody =
  | { type: "transcript_append"; entry: TranscriptEntry }
  | { type: "agent_state"; agent: AgentState; runId?: string; phaseIndex?: number; phasePreset?: string }
  | { type: "swarm_state"; phase: SwarmPhase; round: number; phaseIndex?: number; phasePreset?: string }
  | { type: "agent_streaming"; agentId: string; agentIndex: number; text: string }
  | { type: "agent_streaming_end"; agentId: string }
  | { type: "error"; message: string }
  | { type: "todo_posted"; todo: Todo }
  | { type: "todo_claimed"; todoId: string; claim: Claim }
  | { type: "todo_committed"; todoId: string }
  | { type: "todo_failed"; todoId: string; reason: string; replanCount: number }
  | { type: "todo_skipped"; todoId: string; reason: string }
  | { type: "todo_proposed"; todo: Todo }
  | { type: "todo_reverted"; todoId: string; reason: string }
  // W17: model shift event emitted when failover swaps an agent to a
  // different model. The UI renders these as distinct colored entries in
  // the transcript (amber "failover: X → Y" badges) so users can see
  // exactly when and why a provider change happened.
  | {
      type: "model_shift";
      agentId: string;
      agentIndex: number;
      fromModel: string;
      toModel: string;
      reason: string;
      /** Raw API error message that triggered the shift (for diagnosis). Absent on sibling-retry shifts. */
      rawError?: string;
    }
  | {
      type: "todo_replanned";
      todoId: string;
      description: string;
      expectedFiles: string[];
      replanCount: number;
    }
  | { type: "finding_posted"; finding: Finding }
  | { type: "queue_state"; snapshot: BoardSnapshot; counts: BoardCountsDTO }
  | { type: "contract_updated"; contract: ExitContract }
  | { type: "run_summary"; summary: RunSummary }
  // Phase 2a (2026-04-24): stigmergy pheromone update fired per
  // annotation commit. Carries the single file's new state so the
  // client can upsert without receiving the full table each time.
  | {
      type: "pheromone_updated";
      file: string;
      state: { visits: number; avgInterest: number; avgConfidence: number; latestNote: string };
    }
  // Phase 2d (2026-04-24): map-reduce mapper slice assignments. Fired
  // once at the top of the run, after slicing. Keyed by agentIndex;
  // agent-1 (reducer) is excluded (it sees everything via transcript).
  | {
      type: "mapper_slices";
      slices: Record<string, string[]>;
    }
  // Unit 40: per-attempt latency sample emitted by each runner's
  // onTiming callback (sibling of the existing logDiag /
  // _prompt_timing record but delivered over the WS stream so the UI
  // can accumulate recent samples and render a sparkline tooltip).
  // `elapsedMs` is wall-clock from the start of session.prompt to
  // either (a) its resolution if success, or (b) the headers-timeout
  // bail if not.
  | {
      type: "agent_latency_sample";
      agentId: string;
      agentIndex: number;
      attempt: number;
      elapsedMs: number;
      success: boolean;
      ts: number;
    }
  // #299 (2026-04-28): user submitted a mid-run directive amendment.
  // Broadcast to all WS clients so multiple tabs viewing the same
  // run mirror the addition. Runners pick up the amendment on their
  // next prompt cycle via getAmendments().
  | {
      type: "directive_amended";
      runId: string;
      ts: number;
      text: string;
    }
  // #302 Phase B (2026-04-28): live embedding-similarity drift sample.
  // Independent second signal alongside conformance_sample (LLM-judge).
  // Emitted by EmbeddingDriftMonitor when an embedding model is
  // available (default `nomic-embed-text`). When the model isn't
  // pulled, no events fire — UI surfaces a "pull model X to enable"
  // hint when conformance samples land but drift samples don't.
  | {
      type: "drift_sample";
      runId: string;
      ts: number;
      /** Raw 0-100 similarity score for THIS poll (higher = closer
       *  to the directive's semantic neighborhood). */
      similarity: number;
      /** 3-poll moving average. */
      smoothedSimilarity: number;
      /** Embedding model id used. */
      embeddingModel: string;
      /** Char count of the transcript excerpt that was embedded. */
      excerptChars: number;
      /** Raw similarities currently in the smoothing window (≤ 3). */
      windowSimilarities: number[];
    }
  // #295 (2026-04-28): live directive-conformance gauge sample. Emitted
  // by ConformanceMonitor every CONFORMANCE_INTERVAL_MS (default 90s)
  // during runs that have a non-empty userDirective. The smoothed score
  // is a 3-poll moving average so the UI sparkline isn't noisy. Only
  // ever emitted when the monitor is active — runs without directives
  // emit no samples at all.
  // #301 Phase A: enriched with grader metadata (model, latency, excerpt
  // size, raw window scores) for the tooltip infographic. All optional
  // for back-compat with summaries from before the enrichment landed.
  | {
      type: "conformance_sample";
      runId: string;
      ts: number;
      /** Raw 0–100 grader score for this poll. */
      score: number;
      /** 3-poll moving average. Same value as `score` until 3 samples land. */
      smoothedScore: number;
      /** Optional one-line "why" from the grader (≤200 chars). */
      reason?: string;
      /** Grader model id used for THIS sample. */
      graderModel?: string;
      /** Wall-clock ms for the grader call. */
      latencyMs?: number;
      /** Char count of the transcript excerpt sent to the grader. */
      excerptChars?: number;
      /** The raw scores currently in the smoothing window (≤ 3). */
      windowScores?: number[];
    }
  // Unit 47: emitted once per run, right after RepoService.clone
  // resolves. `alreadyPresent` distinguishes a fresh shallow clone
  // from a build-on-existing-clone resume. The 3 counts give the UI
  // enough to render a "you're resuming N prior commits + M modified
  // + K untracked" banner without a separate fetch. Clone path is
  // included so a UI banner can show what the resume targets.
  | {
      type: "clone_state";
      alreadyPresent: boolean;
      clonePath: string;
      priorCommits: number;
      priorChangedFiles: number;
      priorUntrackedFiles: number;
    }
  // Unit 52a + 52c + 52d: emitted once at the very top of Orchestrator.start.
  // runId (Unit 52d) is a fresh uuid the orchestrator mints at run-start
  // so the UI identifiers row has an app-level handle distinct from any
  // opencode session id. Other fields anchor the runtime ticker and
  // identity strip without a separate REST round-trip.
  | {
      type: "run_started";
      runId: string;
      startedAt: number;
      preset: string;
      plannerModel: string;
      workerModel: string;
      // Auditor model used when cfg.dedicatedAuditor is true. Emitted
      // unconditionally (falls back to plannerModel → main model when
      // the user didn't override) so the UI can label the agent at
      // index N+1 with its actual model. Discussion presets ignore.
      auditorModel: string;
      // Whether the run spawned a dedicated auditor at index N+1.
      // The UI uses this to label that agent's role correctly.
      dedicatedAuditor: boolean;
      // Task #42: role-diff only — array of role names indexed by
      // (agentIndex - 1). Empty/undefined on other presets. Drives
      // AgentPanel's role label for role-diff (e.g. "Architect"
      // instead of the generic "worker"). Wraps on (index % roles.length)
      // like roleForAgent() to match the runner's resolution.
      roles?: string[];
      repoUrl: string;
      clonePath: string;
      agentCount: number;
      rounds: number;
      // Caps carried in run_started for immediate UI hydration (bar, advanced panels).
      wallClockCapMin?: string;
      ambitionTiers?: string;
      // User directive + tool flags — Resume and identity strip read these.
      userDirective?: string;
      plannerTools?: boolean;
      webTools?: boolean;
      mcpServers?: string;
    }
  // Direction 1 Phase 1: emitted after outcome scoring completes at run-end.
  | {
      type: "outcome_scored";
      runId: string;
      score: number;
      verdict: "ship-quality" | "needs-revision" | "fundamentally-flawed";
      dimensions: Array<{ id: string; label: string; score: number; note: string }>;
    }
  // Brain fallback event: emitted when the AI-assisted parser is invoked
  // as a last resort after rule-based parsing fails. Always emitted —
  // both successes and failures — so post-run analysis can identify
  // common failure patterns and propose parser improvements.
  | {
      type: "brain-fallback";
      parser: string;
      originalError: string;
      rawSnippet: string;
      brainSuccess: boolean;
      fieldsFixed?: string[];
      durationMs: number;
      brainModel: string;
    }
  // Tier-ratchet promotion: emitted when the ambition ratchet climbs
  // from one tier to the next (tier 1 → 2 → 3). The UI can render
  // this as a milestone. Emitted on both success and failure.
  | {
      type: "tier-up-decision";
      fromTier: number;
      toTier: number;
      promoted: boolean;
      reason: string;
    }
  // Phase 10: phase_started / phase_completed emitters removed completely.
  // No more explicit phase state for composite runs.

// T-Item-MultiTenant Phase 1 (2026-05-04): the public SwarmEvent type
// intersects every variant with `{ runId?: string }` so consumers can
// read `event.runId` regardless of variant + emitters can stamp it.
// Variants that ALREADY carried a typed `runId` (run_started,
// directive_amended, drift_sample, conformance_sample) keep the
// stricter required field — the intersection only adds the optional
// fallback for the others.