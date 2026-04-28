import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Agent } from "../../services/AgentManager.js";
import { AgentManager } from "../../services/AgentManager.js";
import type {
  AgentState,
  SwarmEvent,
  SwarmPhase,
  SwarmStatus,
  TranscriptEntry,
  TranscriptEntrySummary,
} from "../../types.js";
import type { RunConfig, RunnerOpts, SwarmRunner } from "../SwarmRunner.js";
// V2 cutover Phase 2c (2026-04-28): Board.ts is unreferenced from
// BlackboardRunner. The class file still exists for the dev.ts smoke
// route + the boardCompat type aliases; Phase 2f deletes it once
// dev.ts is migrated to the V2 queue.
import { FindingsLog } from "./FindingsLog.js";
import {
  buildWireSnapshot,
  v2QueueCountsToWireCounts,
  v2QueueTodoToWireTodo,
} from "./boardWireCompat.js";
import { RunStateObserver } from "./RunStateObserver.js";
import {
  TodoQueue,
  type PostTodoInput,
  type QueuedTodo,
} from "./TodoQueue.js";
import { applyAndCommit } from "./WorkerPipeline.js";
import { realFilesystemAdapter, realGitAdapter } from "./v2Adapters.js";
import { createBoardBroadcaster, type BoardBroadcaster } from "./boardBroadcaster.js";
import {
  advanceTickAccumulator,
  checkCaps,
  createTickAccumulator,
  WALL_CLOCK_CAP_MS,
  type TickAccumulator,
} from "./caps.js";
import { buildCrashSnapshot } from "./crashSnapshot.js";
import {
  buildStateSnapshot,
  STATE_SNAPSHOT_DEBOUNCE_MS,
} from "./stateSnapshot.js";
import { shouldRunFinalAudit } from "./finalAudit.js";
import { promptWithRetry } from "../promptWithRetry.js";
import { shouldHaltOnQuota, snapshotLifetimeTokens, tokenBudgetExceeded, tokenTracker } from "../../services/ollamaProxy.js";
import { formatCloneMessage } from "../cloneMessage.js";
import { buildSummary, computeLatencyStats, type PerAgentStat, type RunSummary } from "./summary.js";
import { applyHunks } from "./applyHunks.js";
import { findBomPrefixed, findZeroedFiles } from "./diffValidation.js";
import { resolveSafe } from "./resolveSafe.js";
import { writeFileAtomic } from "./writeFileAtomic.js";
import { buildPerRunSummaryFileName, buildRunFinishedSummary, findAndReadNewestPriorSummary, formatPortReleaseLine, formatRunFinishedBanner } from "../runSummary.js";
import type { PriorRunSummary } from "./prompts/planner.js";
import { summarizeAgentResponse } from "./transcriptSummary.js";
import { readBlackboardStateSnapshot, type BlackboardStateSnapshot } from "./stateSnapshot.js";
import { assignWorkerRole } from "./workerRoles.js";
import {
  buildPlannerUserPrompt,
  buildRepairPrompt,
  parsePlannerResponse,
  PLANNER_SYSTEM_PROMPT,
  type PlannerSeed,
} from "./prompts/planner.js";
import {
  buildCouncilContractMergePrompt,
  buildFirstPassContractRepairPrompt,
  buildFirstPassContractUserPrompt,
  buildTierUpPrompt,
  type CouncilContractDraft,
  FIRST_PASS_CONTRACT_SYSTEM_PROMPT,
  parseFirstPassContractResponse,
  type ParsedContract,
} from "./prompts/firstPassContract.js";
import {
  AUDITOR_SYSTEM_PROMPT,
  buildAuditorRepairPrompt,
  buildAuditorUserPrompt,
  parseAuditorResponse,
  type AuditorResult,
  type AuditorSeed,
} from "./prompts/auditor.js";
import {
  buildReplannerRepairPrompt,
  buildReplannerUserPrompt,
  parseReplannerResponse,
  REPLANNER_SYSTEM_PROMPT,
  type ReplannerSeed,
} from "./prompts/replanner.js";
import { classifyExpectedFiles } from "./prompts/pathValidation.js";
import type { BoardEvent, ExitContract, Todo } from "./types.js";
import {
  buildHunkRepairPrompt,
  buildWorkerRepairPrompt,
  buildWorkerUserPrompt,
  parseWorkerResponse,
  WORKER_SYSTEM_PROMPT,
  type WorkerSeed,
} from "./prompts/worker.js";
import {
  readRecentMemory,
  renderMemoryForSeed,
} from "./memoryStore.js";
// Task #177: design memory (north-star + decisions + roadmap).
import {
  readDesignMemory,
  renderDesignMemoryForSeed,
} from "./designMemoryStore.js";
// Task #164 (refactor): post-completion reflection passes split out.
import {
  runStretchGoalReflectionPass,
  runMemoryDistillationPass,
  runDesignMemoryUpdatePass,
  type ReflectionContext,
} from "./reflectionPasses.js";
// Task #164 (refactor): goal-list parser split out (used by both
// goal-generation pre-pass and stretch reflection).
import { parseGoalList } from "./goalListParser.js";
// V2 cutover (2026-04-28): per-commit critic + verifier modules were
// deleted with the V1 worker pipeline. cfg.critic / cfg.verifier /
// cfg.criticEnsemble route flags are accepted but no-op. Re-wiring
// either feature into the V2 worker is a separate enhancement; revive
// from git history (1110084 + prior) when needed.
// Task #164 (refactor): goal-generation pre-pass split out.
import { runGoalGenerationPrePass as runGoalGenerationPrePassExtracted } from "./goalGenerationPrePass.js";
// Task #164 (refactor): auditor seed builder + UI snapshot capture split out.
import { buildAuditorSeed as buildAuditorSeedExtracted } from "./auditorSeedBuilder.js";
import { truncate } from "./truncate.js";
import { config } from "../../config.js";
import { stripAgentText } from "../../../../shared/src/stripAgentText.js";
import {
  getAgentAddendum,
  getAgentOllamaOptions,
  type Topology,
} from "../../../../shared/src/topology.js";
import { describeSdkError } from "../sdkError.js";
import { interruptibleSleep } from "../interruptibleSleep.js";
import {
  bumpAgentCounter,
  checkExpectedSymbols,
  countNewlines,
} from "./runnerHelpers.js";

// Phase 5c of #243: derive {tag → count} for the planner prompt's
// AVAILABLE WORKER TAGS section. Empty array when no workers carry a
// tag — the planner sees no tag block + emits no preferredTag.
function computeWorkerTagCounts(
  topology: Topology | undefined,
): Array<{ tag: string; count: number }> {
  if (!topology) return [];
  const counts = new Map<string, number>();
  for (const a of topology.agents) {
    if (!a.tag) continue;
    const t = a.tag.trim();
    if (t.length === 0) continue;
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return Array.from(counts.entries()).map(([tag, count]) => ({ tag, count }));
}
import { checkBuildCommand } from "./buildCommandAllowlist.js";

// Blackboard preset: planner posts TODOs, workers drain them in a
// claim/execute loop. Workers produce full-file diffs as JSON; the runner
// does an optimistic-CAS re-hash at commit time, writes each diff via
// tmp+rename, then records the commit on the board.
//
// Lifecycle: cloning -> spawning -> seeding -> planning -> executing -> completed.
// Stop at any point aborts in-flight prompts, kills agents, frees ports.

// V2 cutover Phase 2c (2026-04-28): in-progress timeout. The reaper
// transitions any in-progress todo older than this to failed →
// replan. Was originally V1's CLAIM_TTL_MS (10 min); kept the same
// value so behavior carries over.
const IN_PROGRESS_TTL_MS = 10 * 60_000;
const REAPER_INTERVAL_MS = 30_000;
const WORKER_POLL_MS = 2_000;
const WORKER_POLL_JITTER_MS = 500;
const WORKER_COOLDOWN_MS = 5_000;
// Phase 6: after this many replans, stop trying and mark the todo skipped.
// Keeps a pathological todo from burning planner turns indefinitely.
const MAX_REPLAN_ATTEMPTS = 3;
// Fallback sweep in case the event path missed a stale (e.g. replanOne threw).
const REPLAN_FALLBACK_TICK_MS = 20_000;
// Backstop on the drain-audit-repeat loop. Without this, a confused auditor
// could keep proposing todos that workers produce empty diffs for, cycling
// forever. The cap is now `cfg.rounds` (the setup-form "Rounds" value) —
// Unit 11 flipped this from a hardcoded 5 so users can turn the knob.
// `cfg.rounds` is validated to [1, 10] by the Zod schema on the start
// endpoint. See `maxAuditInvocations` getter below.
// No "idle silence" cap. OpenCode's SSE /event stream is observed to stay
// completely silent across session.prompt's entire duration for our setup, so
// there is no reliable activity signal to gate on. We rely solely on the
// absolute turn cap below — if a prompt hasn't returned in 20 minutes, abort.
const ABSOLUTE_MAX_MS = 20 * 60_000;
// Task #165: pause-on-quota constants. When the proxy detects a
// persistent Ollama-quota wall, the run pauses (workers idle, no
// new prompts) and probes upstream every PAUSE_PROBE_INTERVAL_MS.
// Resume on first successful probe. Total pause time is capped so
// a never-clearing wall (plan exhausted till next billing cycle)
// eventually escalates to a real cap:quota halt rather than
// pausing forever.
const PAUSE_PROBE_INTERVAL_MS = 5 * 60_000;
const MAX_PAUSE_TOTAL_MS = 2 * 60 * 60_000;
// Task #167: soft-stop deadline. After drain() fires we wait up to
// this long for in-flight worker claims to commit cleanly; if they
// don't, escalate to hard stop. 3 minutes covers a normal worker
// turn (usually <60s on glm/gemma) plus headroom for retries.
const DRAIN_DEADLINE_MS = 3 * 60_000;
const DRAIN_WATCHER_INTERVAL_MS = 2_000;

// Issue #3 (2026-04-27): planner-empty model fallback. When the
// primary planner returns 0 valid todos after parse + grounding +
// repair, we re-prompt ONCE with a sibling model — same prompt,
// different model. Hardcoded for the REASONING-tier models we ship;
// per-run cfg.plannerFallbackModel overrides. Returns undefined for
// unknown / coding-tier / verifier-tier models so the caller falls
// through to "no fallback."
//
// 2026-04-27 (later): pair is glm-5.1 ↔ nemotron now. deepseek-v4-pro
// kept as a fallback target FROM either (in case user picks it
// explicitly), but it's unstable and not chosen as a sibling FOR
// either. nemotron is the safer fallback for all three.
const SIBLING_MODELS: Readonly<Record<string, string>> = {
  "glm-5.1:cloud": "nemotron-3-super:cloud",
  "nemotron-3-super:cloud": "glm-5.1:cloud",
  "deepseek-v4-pro:cloud": "nemotron-3-super:cloud",
};
function siblingModelFor(model: string): string | undefined {
  return SIBLING_MODELS[model];
}

export class BlackboardRunner implements SwarmRunner {
  private transcript: TranscriptEntry[] = [];
  private phase: SwarmPhase = "idle";
  private round = 0;
  private stopping = false;
  private active?: RunConfig;
  private boardBroadcaster: BoardBroadcaster;
  // V2 cutover Phase 2c-pre (2026-04-28): findings extracted from Board
  // into their own append-only log. Lives alongside the V2 TodoQueue
  // (which doesn't model findings) so the auditor + replanner still
  // have somewhere to emit diagnostic notes.
  private findings: FindingsLog;
  // Every in-flight prompt registers its AbortController so stop() can abort
  // them all at once without needing to know about planner vs worker.
  private activeAborts = new Set<AbortController>();
  // V2 cutover Phase 2c (2026-04-28): timer for the V2 TodoQueue
  // reaper. Sole TTL enforcer now that V1 Board's expireClaims is
  // unreachable.
  private reaperTimer?: NodeJS.Timeout;
  // Phase 6: replan orchestration. Planner is captured during executing and
  // reused to replan stale todos — see docs/known-limitations.md.
  private planner?: Agent;
  // Unit 58: dedicated auditor agent. Populated when
  // cfg.dedicatedAuditor === true; runAuditor routes to this agent
  // instead of reusing the planner. Undefined otherwise (default
  // behavior — planner wears the auditor hat).
  private auditor?: Agent;
  // Unit 59 (59a): per-worker role guidance (correctness / simplicity
  // / consistency). Populated at spawn time when
  // cfg.specializedWorkers === true; looked up by agent id when
  // building each worker prompt. Empty map = default flat-pool
  // behavior.
  private workerRoles = new Map<string, string>();
  // Unit 62: bounded per-agent rolling latency window for the
  // page-refresh catch-up snapshot. Same shape + cap (20) as the
  // client-side store.latency. Populated alongside the
  // agent_latency_sample WS emit so live and catch-up paths use
  // identical data.
  private recentLatencySamples = new Map<
    string,
    Array<{ ts: number; elapsedMs: number; success: boolean; attempt: number }>
  >();
  // Unit 62: cloneState payload stashed at clone time so the
  // page-refresh catch-up returns it. The WS clone_state event still
  // fires for live observers; this stash is purely for catch-up.
  private cloneStateForStatus?: {
    alreadyPresent: boolean;
    clonePath: string;
    priorCommits: number;
    priorChangedFiles: number;
    priorUntrackedFiles: number;
  };
  private replanPending = new Set<string>();
  private replanRunning = false;
  private replanTickTimer?: NodeJS.Timeout;
  // Phase 7: hard-cap state. runStartedAt is stamped when executing begins so
  // the wall-clock cap is scoped to the worker loop (planning time doesn't
  // count). terminationReason is set by the cap-enforcement helper so the
  // finally block can tell "user pressed stop" (phase → stopped) apart from
  // "cap tripped and asked us to stop" (phase → completed, with a transcript
  // note explaining which cap).
  private runStartedAt?: number;
  // Task #124: lifetime token total at run-start, snapshotted alongside
  // runStartedAt. Used by checkAndApplyCaps to compute "tokens consumed
  // by THIS run" = current lifetime - this baseline.
  private tokenBaselineForRun?: number;
  // Unit 27: host-sleep-proof tick accumulator. Advanced in
  // checkAndApplyCaps; inter-tick deltas are clamped so an 8-hour host
  // suspend contributes at most MAX_REASONABLE_TICK_DELTA_MS. Seeded
  // alongside runStartedAt when the executing phase begins.
  private tickAccumulator?: TickAccumulator;
  // Task #165: pause-on-quota state. When a persistent quota wall
  // trips, paused=true; pauseStartedAt stamps when the current
  // pause began (cleared on resume); totalPausedMs accumulates
  // across all pause periods in this run; pauseProbeTimer drives
  // the 5-min upstream probe.
  private paused = false;
  private pauseStartedAt?: number;
  private totalPausedMs = 0;
  private pauseProbeTimer?: NodeJS.Timeout;
  // Task #167: soft-stop state. Set by drain(); workers see this in
  // their poll loop and exit after their current claim commits (no
  // new claims). drainWatcherTimer polls every 2s for "all in-flight
  // settled" and escalates to hard stop once true (or on the deadline).
  private draining = false;
  private drainStartedAt?: number;
  private drainWatcherTimer?: NodeJS.Timeout;
  // Task #168: sticks across drain → stop transition so post-run
  // gates (memory distillation, stretch reflection) treat a drained
  // run as a clean exit (the user opted into "finish current work
  // and stop") rather than as a hard user-stop (which suppresses
  // both passes). Reset to false on next start().
  private wasDrained = false;
  private terminationReason?: string;
  // Phase 9: run-summary counters. runBootedAt is the wall-clock origin
  // (stamped in start(), covers cloning+spawning+seeding+planning+executing)
  // while runStartedAt scopes hard caps. staleEventCount tracks every stale
  // transition, including ones that get replanned back — the spec's
  // "staleEvents" metric is the total thrash count, not the residual.
  // turnsPerAgent counts promptAgent calls, incremented on each invocation
  // regardless of whether the prompt succeeded.
  private runBootedAt?: number;
  private staleEventCount = 0;
  private turnsPerAgent = new Map<string, number>();
  // Unit 21: per-agent attempt + retry + latency tallies fed by the
  // existing onTiming / onRetry callbacks on promptWithRetry. Cleared
  // alongside turnsPerAgent on each start(). Latency samples are only
  // pushed when the SDK call SUCCEEDED — failed attempts are usually
  // headers-timeout aborts that don't measure model speed.
  private attemptsPerAgent = new Map<string, number>();
  private retriesPerAgent = new Map<string, number>();
  private latenciesPerAgent = new Map<string, number[]>();
  // Task #66: per-agent commit + line attribution. Incremented at
  // commit-success below applyHunks; the modal renders these as
  // columns in the per-agent table so users can see who actually
  // produced code vs who just spent turns thinking.
  private commitsPerAgent = new Map<string, number>();
  private linesAddedPerAgent = new Map<string, number>();
  private linesRemovedPerAgent = new Map<string, number>();
  // Task #67: per-agent rejected-work + recovery counters.
  private rejectedAttemptsPerAgent = new Map<string, number>();
  private jsonRepairsPerAgent = new Map<string, number>();
  private promptErrorsPerAgent = new Map<string, number>();
  // Task #163: per-agent token accumulators populated via promptWithRetry's
  // onTokens hook. Approximate for parallel paths (worker pool, audit
  // ensemble) since the underlying tracker is global.
  private promptTokensPerAgent = new Map<string, number>();
  private responseTokensPerAgent = new Map<string, number>();
  // Stashed at spawn time so writeRunSummary can still produce per-agent
  // stats even after AgentManager.killAll() has cleared its own roster
  // (stop() path runs killAll concurrently with the summary write).
  private agentRoster: Array<{ id: string; index: number }> = [];
  // Phase 11b: first-pass exit contract. Populated by runFirstPassContract
  // before the planner posts todos. Undefined when the contract prompt failed
  // to parse after one repair — in that case the run falls back to the
  // Phase 10 drain-exit termination (no auditor is invoked).
  private contract?: ExitContract;
  // Unit 57: snapshot of the prior run's blackboard-state.json, captured
  // at the very TOP of start() BEFORE any setPhase fires. tryResumeContract
  // reads from THIS cached value, not the live disk file — by the time
  // tryResumeContract runs, our own setPhase("spawning") has fired
  // scheduleStateWrite which after ~1 s overwrites the prior snapshot
  // with our own fresh phase=spawning + no-contract shape. Race window
  // is ~3-5 s (spawning takes that long for N opencode subprocesses);
  // caching at the very top sidesteps it entirely.
  private priorSnapshot?: BlackboardStateSnapshot | null;
  // Phase 11c: drain-audit-repeat bookkeeping. auditInvocations is the
  // backstop counter compared against maxAuditInvocations (Unit 11: now
  // derived from cfg.rounds). completionDetail, when set, propagates into
  // the run summary's stopDetail on the "completed" branch to explain WHY
  // a contract-driven run chose to stop.
  private auditInvocations = 0;
  private completionDetail?: string;
  // Stashed by writeRunSummary so status() can hand it to the WS catch-up
  // on reconnect. Without this, reloading the page after a completed run
  // would lose the Summary card since run_summary only fires once.
  private lastSummary?: RunSummary;
  // Unit 31: live state-snapshot debounce machinery. Writes
  // `<clone>/blackboard-state.json` on every phase change, board event, or
  // contract update. Trailing-edge debounce (see STATE_SNAPSHOT_DEBOUNCE_MS)
  // so a burst of events coalesces into one write; `stateWriteAgain` flags
  // that another write is due once the in-flight one finishes, so we never
  // lose the latest state.
  private stateWriteTimer?: NodeJS.Timeout;
  private stateWriteInFlight = false;
  private stateWriteAgain = false;
  // Unit 34: ambition ratchet. currentTier starts at 1 once the first
  // contract is installed; tiersCompleted bumps every time a tier's
  // criteria all resolve AND the ratchet fires; tierHistory captures a
  // per-tier summary for cross-run analysis. tierStartedAt is reset on
  // every successful promotion so each tier has its own wall-clock
  // delta. tierUpFailures guards against an infinite failed-ratchet
  // loop — after 3 consecutive parse failures we bail to the normal
  // termination path.
  private currentTier = 0;
  private tiersCompleted = 0;
  private tierHistory: Array<{
    tier: number;
    missionStatement: string;
    criteriaTotal: number;
    criteriaMet: number;
    criteriaWontDo: number;
    criteriaUnmet: number;
    wallClockMs: number;
    startedAt: number;
    endedAt: number;
  }> = [];
  private tierStartedAt?: number;
  private tierUpFailures = 0;
  // V2 Step 3b: parallel-track state observer. User-action events
  // (start/stop/drain/pause/resume/fatal) are wired here; internal
  // events (todos posted, todo committed, auditor returned, tier-up
  // decision) are NOT yet wired — that's Step 3b.2. checkPhase() is
  // therefore not yet called against the V1 phase, since the V2
  // reducer would lag without the internal events. The observer's
  // current state still ships in the run summary as `v2State` for
  // telemetry — Kevin can compare V2's user-action-only view to V1's
  // setPhase trail.
  // V2 Step 5c.1: parallel-track TodoQueue mirror. Observability-
  // only — V1 Board is still the source of truth for worker
  // operations. Posts/commits/skips/stale events fan out to BOTH
  // here. Validates that the V2 queue's count semantics match V1's
  // board.counts() across a real run. Cleared on every start().
  private todoQueue = new TodoQueue();
  private v2Observer = new RunStateObserver({
    getCtx: () => {
      const c = this.boardCounts();
      return {
        openTodos: c.open,
        claimedTodos: c.claimed,
        staleTodos: c.stale,
        auditInvocations: this.auditInvocations,
        maxAuditInvocations: this.maxAuditInvocations,
        currentTier: this.currentTier,
        maxTiers: this.resolvedMaxTiers(),
        allCriteriaResolved: this.allCriteriaResolvedSnapshot(),
      };
    },
  });

  constructor(private readonly opts: RunnerOpts) {
    this.boardBroadcaster = createBoardBroadcaster(this.opts.emit);
    this.findings = new FindingsLog();
    // V2 cutover Phase 2c (2026-04-28): the V1 Board instance is gone.
    // The boardBroadcaster pulls snapshots from V2 queue + FindingsLog
    // translated to V1 wire shape via boardWireCompat — UI keeps
    // consuming board_state events unchanged.
    this.boardBroadcaster.bindSnapshotSource(() => ({
      snapshot: buildWireSnapshot(this.todoQueue.list(), this.findings.list()),
      counts: v2QueueCountsToWireCounts(this.todoQueue.counts()),
    }));
  }

  // V2 Step 3b helper: derive whether all contract criteria have a
  // terminal status (met/wont-do). Mirrors the logic the auditor uses
  // when it decides "all resolved → completed". Returns false when
  // there's no contract yet (planning hasn't completed).
  private allCriteriaResolvedSnapshot(): boolean {
    if (!this.contract) return false;
    return this.contract.criteria.every(
      (c) => c.status === "met" || c.status === "wont-do",
    );
  }

  status(): SwarmStatus {
    // Unit 62: include the catch-up payload so a page refresh can
    // hydrate the zustand store from one HTTP fetch. WS events keep
    // the live store fresh; this is purely the reload path.
    const board = this.boardSnapshot();
    const counts = this.boardCounts();
    const latency: Record<string, Array<{ ts: number; elapsedMs: number; success: boolean; attempt: number }>> = {};
    for (const [agentId, samples] of this.recentLatencySamples.entries()) {
      // Defensive copy so callers can't mutate our internal buffer.
      latency[agentId] = samples.map((s) => ({ ...s }));
    }
    const runConfig = this.active
      ? {
          preset: this.active.preset,
          plannerModel: this.active.plannerModel ?? this.active.model,
          workerModel: this.active.workerModel ?? this.active.model,
          auditorModel: this.active.auditorModel ?? this.active.plannerModel ?? this.active.model,
          dedicatedAuditor: this.active.dedicatedAuditor === true,
          repoUrl: this.active.repoUrl,
          clonePath: this.active.localPath,
          agentCount: this.active.agentCount,
          rounds: this.active.rounds,
        }
      : undefined;
    return {
      phase: this.phase,
      round: this.round,
      repoUrl: this.active?.repoUrl,
      localPath: this.active?.localPath,
      model: this.active?.model,
      agents: this.opts.manager.toStates(),
      transcript: [...this.transcript],
      summary: this.lastSummary,
      contract: this.contract ? this.cloneContract(this.contract) : undefined,
      cloneState: this.cloneStateForStatus,
      runConfig,
      runStartedAt: this.runBootedAt,
      board: { todos: board.todos, findings: board.findings, counts },
      latency,
      // Task #39: include per-agent partial-stream buffer so a page-
      // refresh catch-up can restore mid-stream UI. AgentManager
      // owns the buffer; we just forward its current snapshot.
      streaming: this.opts.manager.getPartialStreams(),
    };
  }

  injectUser(text: string): void {
    const entry: TranscriptEntry = {
      id: randomUUID(),
      role: "user",
      text,
      ts: Date.now(),
    };
    this.transcript.push(entry);
    this.opts.emit({ type: "transcript_append", entry });
  }

  isRunning(): boolean {
    // Task #34: terminal phases ("completed", "failed") must NOT be
    // treated as running — otherwise the orchestrator can't accept a
    // new start without an explicit /stop in between, even though the
    // prior run is fully done. Sequential preset tours hit this on
    // every transition.
    return (
      this.phase !== "idle" &&
      this.phase !== "stopped" &&
      this.phase !== "completed" &&
      this.phase !== "failed"
    );
  }

  async start(cfg: RunConfig): Promise<void> {
    if (this.isRunning()) throw new Error("A swarm is already running. Stop it first.");
    this.transcript = [];
    this.stopping = false;
    this.round = 0;
    this.runStartedAt = undefined;
    this.tokenBaselineForRun = undefined;
    this.tickAccumulator = undefined;
    // Task #165: clear pause state from any prior run.
    this.paused = false;
    this.pauseStartedAt = undefined;
    this.totalPausedMs = 0;
    if (this.pauseProbeTimer) {
      clearTimeout(this.pauseProbeTimer);
      this.pauseProbeTimer = undefined;
    }
    // Task #167: clear drain state from any prior run.
    this.draining = false;
    this.drainStartedAt = undefined;
    if (this.drainWatcherTimer) {
      clearInterval(this.drainWatcherTimer);
      this.drainWatcherTimer = undefined;
    }
    // Task #168: clear the drain-marker so this fresh run defaults
    // to "stop = hard user-stop" classification unless drain() fires.
    this.wasDrained = false;
    this.terminationReason = undefined;
    // Unit 31: clear any lingering state-write timer from a prior run.
    // stateWriteInFlight may still be true momentarily if a run was torn
    // down mid-write; that's fine — the flush path handles re-entrancy
    // via stateWriteAgain.
    if (this.stateWriteTimer) {
      clearTimeout(this.stateWriteTimer);
      this.stateWriteTimer = undefined;
    }
    this.stateWriteAgain = false;
    this.runBootedAt = Date.now();
    // Task #171: persist a "Run started" entry as the FIRST transcript
    // line so it survives a page-refresh catch-up. The WS run_started
    // event already fires for live observers; this gives refreshing
    // observers (and review-mode readers) the same anchor at the top
    // of the transcript. Includes runId8 + preset + model summary so
    // it's self-explanatory without needing the surrounding UI chrome.
    {
      // Task #171 + 2026-04-26 fix: emit the "▸▸RUN-START▸▸" sentinel
      // format so the web RunStartDivider component renders the rich
      // horizontal-rule block (matching the divider shown when starting
      // a new run mid-session). Previously we emitted a plain "▶ Run
      // started" prose string which rendered as a generic system bubble
      // — visually inconsistent with the in-session run-start divider.
      const plannerModel = cfg.plannerModel ?? cfg.model;
      const workerModel = cfg.workerModel ?? cfg.model;
      const dividerText = [
        "▸▸RUN-START▸▸",
        `runId=${cfg.runId ?? ""}`,
        `preset=${cfg.preset ?? ""}`,
        `plannerModel=${plannerModel}`,
        `workerModel=${workerModel}`,
        `agentCount=${cfg.agentCount ?? ""}`,
        `repoUrl=${cfg.repoUrl ?? ""}`,
      ].join("|");
      this.appendSystem(dividerText);
    }
    this.staleEventCount = 0;
    this.turnsPerAgent.clear();
    this.attemptsPerAgent.clear();
    this.commitsPerAgent.clear();
    this.linesAddedPerAgent.clear();
    this.linesRemovedPerAgent.clear();
    this.rejectedAttemptsPerAgent.clear();
    this.jsonRepairsPerAgent.clear();
    this.promptErrorsPerAgent.clear();
    this.promptTokensPerAgent.clear();
    this.responseTokensPerAgent.clear();
    this.retriesPerAgent.clear();
    this.latenciesPerAgent.clear();
    this.agentRoster = [];
    this.contract = undefined;
    this.auditInvocations = 0;
    this.completionDetail = undefined;
    // Unit 34: reset tier state on every start.
    this.currentTier = 0;
    this.tiersCompleted = 0;
    this.tierHistory = [];
    this.tierStartedAt = undefined;
    this.tierUpFailures = 0;
    this.active = cfg;
    // V2 Step 3b: reset the parallel V2 reducer + fire start.
    this.v2Observer.reset();
    this.v2Observer.apply({ type: "start", ts: this.runBootedAt });
    // Reset the V2 todo-queue mirror so the run starts clean.
    this.todoQueue.clear();
    this.findings.clear();

    this.setPhase("cloning");
    const cloneResult = await this.opts.repos.clone({
      url: cfg.repoUrl,
      destPath: cfg.localPath,
    });
    const { destPath } = cloneResult;
    // Unit 47: tell the UI whether this is a fresh clone or a resume,
    // and how much prior work it's building on. The build-on-existing
    // pattern (Units 47-51) makes this distinction load-bearing —
    // user shouldn't be confused when their re-run silently picks up
    // 4 prior commits + 5 modified files.
    // Unit 62: ALSO stash for the page-refresh catch-up snapshot so a
    // reload re-renders the banner instead of forgetting we resumed.
    this.cloneStateForStatus = {
      alreadyPresent: cloneResult.alreadyPresent,
      clonePath: destPath,
      priorCommits: cloneResult.priorCommits,
      priorChangedFiles: cloneResult.priorChangedFiles,
      priorUntrackedFiles: cloneResult.priorUntrackedFiles,
    };
    this.opts.emit({
      type: "clone_state",
      ...this.cloneStateForStatus,
    });
    // Unit 42: per-agent model overrides. Each falls back to cfg.model
    // when absent, so existing single-model runs are byte-identical.
    const plannerModel = cfg.plannerModel ?? cfg.model;
    const workerModel = cfg.workerModel ?? cfg.model;
    // Unit 58: auditor model. Falls back to plannerModel (same role
    // family — reasoning over criteria + file state) then to model.
    // Only meaningful when cfg.dedicatedAuditor is true; harmless to
    // compute either way.
    const auditorModel = cfg.auditorModel ?? plannerModel;
    // Unit 48: hide runner-written artifacts (opencode.json,
    // blackboard-state.json, summary.json, summary-*.json) from
    // `git status` via the clone's local .git/info/exclude — NOT the
    // user's .gitignore. See RepoService.excludeRunnerArtifacts.
    await this.opts.repos.excludeRunnerArtifacts(destPath);
    // Unit 58: opencode.json must declare every distinct model so any
    // spawned agent can resolve at session.create time. dedupe in
    // writeOpencodeConfig handles the no-op case when models match.
    const declaredModels = cfg.dedicatedAuditor
      ? [plannerModel, workerModel, auditorModel]
      : [plannerModel, workerModel];
    await this.opts.repos.writeOpencodeConfig(destPath, declaredModels);
    this.appendSystem(formatCloneMessage(cfg.repoUrl, destPath, cloneResult));
    if (plannerModel !== workerModel) {
      this.appendSystem(`Per-agent models: planner=${plannerModel}, workers=${workerModel}`);
    }
    if (cfg.dedicatedAuditor && auditorModel !== plannerModel) {
      this.appendSystem(`Per-agent models: auditor=${auditorModel}`);
    }

    // Unit 57: cache the prior run's blackboard-state.json BEFORE the
    // spawning phase fires its scheduled snapshot write. See the field
    // declaration for the race details. Read here (clone exists, no
    // snapshot writes have fired yet because cloning phase skips
    // scheduleStateWrite). Always reads — Unit 51's tryResumeContract
    // uses the cached value when cfg.resumeContract is true; cheap
    // I/O when it's not.
    this.priorSnapshot = await readBlackboardStateSnapshot(destPath);

    this.setPhase("spawning");
    // Planner is always index 1. Workers take 2..N. If the user picks
    // agentCount=1 there are no workers — planner posts TODOs, nothing drains
    // them, and we transition straight to completed. Documented in README.
    const planner = await this.opts.manager.spawnAgent({
      cwd: destPath,
      index: 1,
      model: plannerModel,
    });
    this.appendSystem(`Planner agent ready on port ${planner.port}`);

    const workerCount = Math.max(0, cfg.agentCount - 1);
    const workers: Agent[] = [];
    if (workerCount > 0) {
      // Parallel spawn: each opencode serve takes a few seconds to boot,
      // sequential would compound that for every extra worker.
      const workerSpawns = Array.from({ length: workerCount }, (_, i) =>
        this.opts.manager.spawnAgent({ cwd: destPath, index: 2 + i, model: workerModel }),
      );
      const spawned = await Promise.all(workerSpawns);
      workers.push(...spawned);
      // Unit 59 (59a): assign a static role bias to each worker when
      // specializedWorkers is on. workerOrdinal is 1-based (worker-2 is
      // ordinal 1). Roles cycle through workerRoles.ts catalog.
      this.workerRoles.clear();
      if (cfg.specializedWorkers) {
        spawned.forEach((w, i) => {
          const role = assignWorkerRole(i + 1);
          this.workerRoles.set(w.id, role.guidance);
          this.appendSystem(
            `Worker agent ${w.id} ready on port ${w.port} (role: ${role.name})`,
          );
        });
      } else {
        for (const w of workers) this.appendSystem(`Worker agent ${w.id} ready on port ${w.port}`);
      }
    } else {
      this.appendSystem("No workers spawned (agentCount=1). Planner will post TODOs, nothing will drain them.");
    }

    // Unit 58: spawn the dedicated auditor agent (opt-in). Index is
    // agentCount + 1 so it doesn't collide with workers (1=planner,
    // 2..N=workers, N+1=auditor). Total agents = agentCount + 1.
    if (cfg.dedicatedAuditor) {
      const auditorIndex = cfg.agentCount + 1;
      this.auditor = await this.opts.manager.spawnAgent({
        cwd: destPath,
        index: auditorIndex,
        model: auditorModel,
      });
      this.appendSystem(
        `Auditor agent ${this.auditor.id} ready on port ${this.auditor.port} (model=${auditorModel}). Audit calls will route here in parallel with workers.`,
      );
    } else {
      this.auditor = undefined;
    }

    // Freeze the roster for the summary artifact — killAll() will later
    // empty AgentManager's own map.
    this.agentRoster = [planner, ...workers, ...(this.auditor ? [this.auditor] : [])]
      .map((a) => ({ id: a.id, index: a.index }));

    this.setPhase("seeding");
    const seed = await this.buildSeed(destPath, cfg);
    this.appendSystem(
      `Seed: ${seed.topLevel.length} top-level entries, README ${
        seed.readmeExcerpt ? `${seed.readmeExcerpt.length} chars` : "(missing)"
      }.`,
    );

    // Task #127: goal-generation pre-pass. When no userDirective is
    // set AND autoGenerateGoals isn't explicitly disabled, ask the
    // planner to propose 3-5 ambitious-but-feasible improvements;
    // the top one becomes the directive for this run. Lifts the
    // swarm from "do something" to "do something that matters."
    const shouldGenerateGoals =
      (!seed.userDirective || seed.userDirective.length === 0) &&
      cfg.autoGenerateGoals !== false;
    if (shouldGenerateGoals) {
      const generated = await runGoalGenerationPrePassExtracted(
        planner,
        seed,
        (text) => this.appendSystem(text),
        // Issue C-min: status callback so the UI shows the planner as
        // thinking during the pre-pass (was showing "ready" because
        // this code path bypassed promptAgent's markStatus).
        { onStatusChange: (status) => this.markPlannerStatus(planner, status) },
      );
      if (generated && generated.length > 0) {
        seed.userDirective = generated;
        this.appendSystem(
          `Goal-generation pre-pass: directive set to "${generated.length > 200 ? generated.slice(0, 200) + "…" : generated}"`,
        );
      } else {
        this.appendSystem(
          `Goal-generation pre-pass: no usable directive returned — falling back to planner-from-scratch.`,
        );
      }
    }

    // V2 Step 3b.2: agents are ready — fire spawned event so the V2
    // reducer can advance from "spawning" to "planning".
    this.v2Observer.apply({
      type: "spawned",
      ts: Date.now(),
      agentCount: this.agentRoster.length,
    });
    this.setPhase("planning");
    // Background so the HTTP POST that triggered start() returns immediately.
    // The UI watches progress over /ws.
    // Task #198: planAndExecute has internal try/catch (line ~676), but its
    // finally block runs async ops (writeRunSummary, runAuditor) that can
    // throw on their own. Defense in depth: surface any leak as an error
    // event so the UI doesn't hang in "planning" forever.
    this.planAndExecute(planner, workers, seed).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.opts.emit({ type: "error", message: `Run aborted (unhandled): ${msg}` });
      this.appendSystem(`Run aborted (unhandled): ${msg}`);
      void this.stop().catch(() => {});
    });
  }

  private async planAndExecute(
    planner: Agent,
    workers: Agent[],
    seed: PlannerSeed,
  ): Promise<void> {
    let errored = false;
    let crashMessage: string | undefined;
    try {
      // Unit 51: opt-in resume from blackboard-state.json. When the
      // user set cfg.resumeContract AND the snapshot is present +
      // valid, install the prior contract directly and skip the
      // first-pass-contract round entirely. Tier counters hydrate
      // from the snapshot too. Falls through to the normal path on
      // missing/invalid snapshot — silent fallback so the user gets
      // SOMETHING even if the resume can't bind.
      const resumed = this.active?.resumeContract === true
        ? await this.tryResumeContract(seed.clonePath)
        : false;
      if (!resumed) {
        await this.runFirstPassContractOrchestrator(planner, workers, seed);
      }
      if (this.stopping) return;
      await this.runPlanner(planner, seed);
      if (this.stopping) return;
      if (workers.length > 0 && this.boardCounts().open > 0) {
        // Stamp the wall-clock origin just before caps start being checked.
        // Planning time (seeding, initial planner prompt, repair) does NOT
        // count toward the cap — the cap is a worker-loop guard, not a total
        // run guard.
        this.runStartedAt = Date.now();
        // Task #124: same baseline timing for token-budget — planner
        // tokens before this point don't count toward the budget.
        this.tokenBaselineForRun = snapshotLifetimeTokens();
        this.tickAccumulator = createTickAccumulator(this.runStartedAt);
        this.setPhase("executing");
        this.startQueueReaper();
        this.planner = planner;
        this.startReplanWatcher();
        await this.runAuditedExecution(planner, workers);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Task #168: when stop() or drain() aborted in-flight prompts,
      // the abort propagates here as an exception. That's exactly
      // what the user asked for — don't classify it as a crash.
      // Leaves errored=false + crashMessage=undefined so summary
      // classification routes to "user" / drain-completion paths
      // instead of "crash" (which previously caused user-stop runs
      // to mis-show stopReason="crash" + write a crash snapshot).
      if (this.stopping) {
        this.appendSystem(`Run halted: ${msg}`);
      } else {
        errored = true;
        crashMessage = msg;
        this.opts.emit({ type: "error", message: `blackboard run failed: ${crashMessage}` });
        this.appendSystem(`Run failed: ${crashMessage}`);
        // Best-effort post-mortem. Awaited so the write lands before the
        // finally block flips phase to "failed" — a WS consumer watching for
        // the failed transition should be able to trust the artifact is
        // already on disk.
        await this.writeCrashSnapshot(err);
      }
    } finally {
      this.stopQueueReaper();
      this.stopReplanWatcher();
      // Cap-trip audit: one last pass so the summary's contract reflects
      // true met/wont-do/unmet distribution instead of leaving every
      // unresolved criterion at the default "unmet". shouldRunFinalAudit
      // narrows this to the exact case that benefits — cap trip, no crash,
      // no user stop, budget remaining, unresolved criteria still present.
      // Errors here are swallowed: a missing final audit is worse than
      // "all unmet" but better than trading a useful summary for a crash.
      if (
        shouldRunFinalAudit({
          errored,
          hasContract: !!this.contract && this.contract.criteria.length > 0,
          allCriteriaResolved: this.allCriteriaResolved(),
          terminationReason: this.terminationReason,
          auditInvocations: this.auditInvocations,
          maxInvocations: this.maxAuditInvocations,
          // Task #168: drained runs should run the final audit (the
          // user opted into a clean exit + wants final criterion
          // status). Hard user-stop still suppresses.
          userStopped: this.stopping && !this.terminationReason && !this.wasDrained,
        })
      ) {
        try {
          await this.runAuditor(planner, { allowWhenStopping: true });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.appendSystem(`Final audit failed: ${msg}`);
        }
      }
      // Task #129: stretch-goal reflection pass. Asks the planner one
      // meta-question — "what would the BEST version of this work have
      // done?" — so the next run (or the user) has a launchpad for a
      // more ambitious follow-up. Gated on:
      //   - run did NOT error (a crashed run can't reflect honestly)
      //   - was NOT stopped manually by the user (they explicitly opted
      //     out of finishing — pestering them with reflection is rude)
      //   - has substantive output (committed > 0 OR a contract exists)
      //   - autoStretchReflection !== false (default ON)
      //   - wall-clock cap not exceeded (each pass is a 1-3 min planner
      //     prompt; running them past the user's cap defeats the cap
      //     entirely — see run 0254ca7c which overshot 15-min by 4 min
      //     because reflection happened post-audit unconditionally).
      // Errors are swallowed for the same reason as the final audit:
      // a missing reflection is annoying, not run-fatal.
      // Task #168: differentiate hard-user-stop from drain-stop. Drained
      // runs ARE "the user opted into a clean exit" — let memory +
      // stretch reflection fire so the work isn't lost. Only hard
      // user-stop (Stop button, no drain) suppresses both passes.
      const userStoppedHard =
        this.stopping && !this.terminationReason && !this.wasDrained;
      const hasOutput =
        this.boardCounts().committed > 0 ||
        (this.contract?.criteria.length ?? 0) > 0;
      const overWallClockCap = this.isOverWallClockCap();
      if (overWallClockCap) {
        const capMin = Math.round(
          (this.active?.wallClockCapMs ?? WALL_CLOCK_CAP_MS) / 60_000,
        );
        this.appendSystem(
          `Wall-clock cap (${capMin} min) already exceeded by the time the audit loop ended; skipping post-audit reflection passes (stretch goals, memory distillation, design memory) to honor the cap. Set wallClockCapMs higher to allow them.`,
        );
      }
      // Issue B (2026-04-27): hard-cap watchdog for the reflection
      // block. Pre-fix, isOverWallClockCap was checked PER-PASS so a
      // pass starting at 19m30s with cap=20m would run for 3-5 more
      // min past cap (run 04575ce4 overshot 20-min cap to 25.6 min).
      // Now: a 5s-tick interval polls isOverWallClockCap and aborts
      // the shared signal as soon as cap is hit. Each reflection pass
      // forwards the signal to its session.prompt call, so an
      // in-flight prompt past cap gets aborted promptly.
      const reflectionAbort = new AbortController();
      const reflectionWatchdog = setInterval(() => {
        if (this.isOverWallClockCap() && !reflectionAbort.signal.aborted) {
          const capMin = Math.round(
            (this.active?.wallClockCapMs ?? WALL_CLOCK_CAP_MS) / 60_000,
          );
          this.appendSystem(
            `Wall-clock cap (${capMin} min) hit during reflection passes — aborting any in-flight reflection prompt to honor the cap.`,
          );
          reflectionAbort.abort(new Error("wallClockCapMs hit during reflection passes"));
        }
      }, 5_000);
      reflectionWatchdog.unref?.();
      // Task #164 (refactor): build the reflection context once and
      // pass to both extracted helpers.
      const reflectionCtx: ReflectionContext = {
        transcript: this.transcript,
        appendSystem: (text, summary) => this.appendSystem(text, summary),
        emit: (e) => this.opts.emit(e),
        currentTier: this.currentTier,
        committedCount: this.boardCounts().committed,
        contractCriteria: this.contract?.criteria ?? [],
        runId: this.active?.runId ?? "unknown",
        // Issue B: forward the cap-watchdog signal so reflection
        // prompts get aborted when the cap fires mid-flight.
        signal: reflectionAbort.signal,
        // Issue C-min: status callback so the planner agent's UI
        // status flips to "thinking" while reflection prompts are
        // in-flight, restoring the truthful UI signal pre-fix lacked.
        onPlannerStatusChange: (status) => this.markPlannerStatus(planner, status),
      };
      if (
        !errored &&
        !userStoppedHard &&
        hasOutput &&
        !overWallClockCap &&
        this.active?.autoStretchReflection !== false
      ) {
        try {
          await runStretchGoalReflectionPass(planner, reflectionCtx);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.appendSystem(`Stretch-goal reflection failed: ${msg}`);
        }
      }
      // Task #130: persistent memory write. Runs AFTER the stretch
      // reflection so the planner has the most context (commits +
      // contract resolution + stretch goals all in transcript) when
      // distilling lessons. Same gating as stretch reflection plus
      // autoMemory !== false. Errors swallowed; missing memory write
      // is annoying, not run-fatal.
      if (
        !errored &&
        !userStoppedHard &&
        hasOutput &&
        !overWallClockCap &&
        this.active?.autoMemory !== false
      ) {
        try {
          await runMemoryDistillationPass(planner, this.active?.localPath, reflectionCtx);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.appendSystem(`Memory distillation failed: ${msg}`);
        }
      }
      // Task #177: design memory update pass. Runs AFTER memory
      // distillation so the planner has the freshest engineering
      // lessons to inform its creative/product update. Same gates
      // as the other reflection passes plus autoDesignMemory !== false.
      if (
        !errored &&
        !userStoppedHard &&
        hasOutput &&
        !overWallClockCap &&
        this.active?.autoDesignMemory !== false
      ) {
        try {
          await runDesignMemoryUpdatePass(planner, this.active?.localPath, reflectionCtx);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.appendSystem(`Design memory update failed: ${msg}`);
        }
      }
      // Issue B: stop the reflection-cap watchdog now that all
      // reflection passes are done. The setInterval would otherwise
      // keep firing isOverWallClockCap probes until process exit.
      clearInterval(reflectionWatchdog);
      // Phase 9: always try to write a summary, regardless of how we got
      // here (completed / stopped / failed / cap). Awaited so the file and
      // the broadcast event land before the terminal phase transition, so
      // a UI consumer reacting to `completed|stopped|failed` can trust the
      // summary is already available.
      await this.writeRunSummary(crashMessage);
    }
    // Ensure the final snapshot lands even if the debounce timer hasn't fired.
    this.boardBroadcaster.flushSnapshot();
    // User-initiated stop: stop() sets phase to "stopping" → "stopped" itself,
    // so we bail. Cap-initiated stop also sets this.stopping, but we detect
    // that via terminationReason and fall through to setPhase("completed")
    // so the UI reflects the run actually finishing at the cap boundary.
    if (this.stopping && !this.terminationReason) {
      await this.flushStateWrite();
      return;
    }
    // Unit 55: auto-killAll on natural completion (and on errored
    // termination). Before this unit, only stop() killed agents — a
    // run that finished naturally ("auditor produced no new work,"
    // all-met, cap reached) left every opencode subprocess and cloud
    // session alive, holding ports + paying cloud upkeep until the
    // user/Claude manually intervened. Mirrors the killAll inside
    // stop(): same verified-kill semantics from Unit 41 (poll +
    // taskkill escalation + pidTracker.remove). Idempotent if a
    // sibling code path already cleared the roster.
    // Task #68: surface the kill result in the transcript.
    const killResult = await this.opts.manager.killAll();
    this.appendSystem(formatPortReleaseLine(killResult));
    // V2 Step 3b: feed terminal event to the parallel reducer.
    if (errored) {
      this.v2Observer.apply({
        type: "fatal-error",
        ts: Date.now(),
        message: crashMessage ?? "(no message)",
      });
    }
    this.setPhase(errored ? "failed" : "completed");
    // Unit 31: final non-debounced write so the on-disk state reflects the
    // terminal phase even if the debounced timer hasn't fired yet.
    if (this.stateWriteTimer) {
      clearTimeout(this.stateWriteTimer);
      this.stateWriteTimer = undefined;
    }
    await this.flushStateWrite();
  }

  // Task #167: soft-stop. Sets draining=true; workers that are
  // mid-claim finish + commit cleanly, and no new claims are taken.
  // A 2s-tick watcher polls for "all in-flight settled" (no claimed
  // todos AND no active prompts) and escalates to hard stop()
  // when quiet — or hits the DRAIN_DEADLINE_MS backstop and force-
  // escalates so a stuck claim can't deadlock the drain.
  //
  // No-op if already stopping/draining (idempotent — clicking
  // Drain twice doesn't compound; clicking Stop after Drain
  // immediately escalates via the separate stop() path).
  async drain(): Promise<void> {
    if (this.stopping || this.draining) return;
    this.draining = true;
    this.drainStartedAt = Date.now();
    // Task #168: marker for the post-run gate — drained runs ARE
    // allowed to fire memory distillation + stretch reflection (the
    // user opted in to "finish work then stop", which is closer to
    // a natural completion than to a hard abort).
    this.wasDrained = true;
    // V2 Step 3b: feed drain event to the parallel reducer.
    this.v2Observer.apply({ type: "drain-requested", ts: this.drainStartedAt });
    this.setPhase("draining");
    this.appendSystem(
      `Drain & Stop requested. Workers will finish their current claim (${this.boardCounts().claimed} in-flight); no new claims. ` +
        `Backstop ${DRAIN_DEADLINE_MS / 60_000} min before forced hard stop. ` +
        `Press Stop to escalate immediately.`,
    );
    // Cancel pause probe (no point continuing to poll upstream
    // during drain — we're committed to stopping).
    if (this.pauseProbeTimer) {
      clearTimeout(this.pauseProbeTimer);
      this.pauseProbeTimer = undefined;
    }
    this.paused = false;
    // Task #199: surface unhandled rejections so a single bad tick doesn't
    // become a silent stream of unhandled errors firing every 2s.
    this.drainWatcherTimer = setInterval(() => {
      this.checkDrainComplete().catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.appendSystem(`Drain watcher tick failed: ${msg}`);
      });
    }, DRAIN_WATCHER_INTERVAL_MS);
  }

  private async checkDrainComplete(): Promise<void> {
    if (this.stopping || !this.draining) {
      if (this.drainWatcherTimer) {
        clearInterval(this.drainWatcherTimer);
        this.drainWatcherTimer = undefined;
      }
      return;
    }
    const claimed = this.boardCounts().claimed;
    const activePrompts = this.activeAborts.size;
    const elapsed = Date.now() - (this.drainStartedAt ?? Date.now());
    const overDeadline = elapsed >= DRAIN_DEADLINE_MS;
    if (claimed === 0 && activePrompts === 0) {
      this.appendSystem(`Drain complete (${Math.round(elapsed / 1000)}s); escalating to hard stop.`);
      if (this.drainWatcherTimer) {
        clearInterval(this.drainWatcherTimer);
        this.drainWatcherTimer = undefined;
      }
      await this.stop();
      return;
    }
    if (overDeadline) {
      this.appendSystem(
        `Drain deadline reached (${DRAIN_DEADLINE_MS / 60_000} min) with ${claimed} claim(s) + ${activePrompts} prompt(s) still in-flight. Forcing hard stop.`,
      );
      if (this.drainWatcherTimer) {
        clearInterval(this.drainWatcherTimer);
        this.drainWatcherTimer = undefined;
      }
      await this.stop();
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    // V2 Step 3b: feed user-stop event to the parallel reducer.
    this.v2Observer.apply({ type: "stop-requested", ts: Date.now() });
    this.setPhase("stopping");
    this.stopQueueReaper();
    this.stopReplanWatcher();
    // Task #165: cancel any in-flight quota-pause probe so it doesn't
    // try to resume a run that's being torn down.
    if (this.pauseProbeTimer) {
      clearTimeout(this.pauseProbeTimer);
      this.pauseProbeTimer = undefined;
    }
    this.paused = false;
    // Task #167: cancel drain watcher if soft-stop is being escalated
    // to hard stop (either by completion or by user clicking Stop
    // during drain).
    if (this.drainWatcherTimer) {
      clearInterval(this.drainWatcherTimer);
      this.drainWatcherTimer = undefined;
    }
    this.draining = false;
    for (const ctrl of this.activeAborts) {
      try {
        ctrl.abort(new Error("user stop"));
      } catch {
        // ignore — best-effort
      }
    }
    this.activeAborts.clear();
    await this.opts.manager.killAll();
    this.boardBroadcaster.dispose();
    this.setPhase("stopped");
  }

  private async buildSeed(clonePath: string, cfg: RunConfig): Promise<PlannerSeed> {
    const topLevel = (await this.opts.repos.listTopLevel(clonePath)).slice(0, 200);
    const readmeExcerpt = await this.opts.repos.readReadme(clonePath);
    // Grounding Unit 6a: real file paths from a BFS walk, with common
    // ignores (node_modules, .git, dist, binaries) stripped. Gives the
    // planner + first-pass-contract something concrete to reference in
    // expectedFiles instead of guessing from top-level directories.
    const repoFiles = await this.opts.repos.listRepoFiles(clonePath, { maxFiles: 150 });
    // Unit 50: when this run is a resume on an existing clone, look for
    // the newest prior summary and distill it for the planner. The
    // first-pass-contract prompt's Rule 12 instructs the planner to
    // build on it rather than re-attempt resolved criteria. Fresh
    // clones skip this (no prior summary on disk, returns null).
    const priorRunSummary = await this.loadPriorRunSummary(clonePath);
    // Task #130: persistent cross-run memory (.swarm-memory.jsonl).
    // Independent of priorRunSummary above — that's the immediately-
    // preceding run's contract; this is the planner-authored "lessons
    // learned" log across many runs. Read failure here is not fatal:
    // a missing file returns []; bad JSON lines are skipped silently.
    // Disabled by cfg.autoMemory === false (default true).
    let priorMemoryRendered: string | undefined;
    if (cfg.autoMemory !== false) {
      try {
        const recent = await readRecentMemory(clonePath);
        const rendered = renderMemoryForSeed(recent);
        priorMemoryRendered = rendered.length > 0 ? rendered : undefined;
        if (recent.length > 0) {
          this.appendSystem(
            `Memory: surfaced ${recent.length} prior-run lesson entry(ies) from .swarm-memory.jsonl into the planner seed.`,
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.appendSystem(`Memory read failed (${msg}); continuing without prior-run context.`);
      }
    }
    // Task #177: design memory (north-star + decisions + roadmap).
    // Read at seed time so the planner honors the long-horizon vision
    // when proposing the first-pass contract + tier-up missions.
    let priorDesignMemoryRendered: string | undefined;
    if (cfg.autoDesignMemory !== false) {
      try {
        const dm = await readDesignMemory(clonePath);
        priorDesignMemoryRendered = renderDesignMemoryForSeed(dm);
        if (priorDesignMemoryRendered) {
          const parts: string[] = [];
          if (dm.northStar) parts.push("north-star");
          if (dm.roadmap.length > 0) parts.push(`roadmap (${dm.roadmap.length})`);
          if (dm.decisions.length > 0) parts.push(`${dm.decisions.length} decision(s)`);
          this.appendSystem(
            `Design memory: surfaced ${parts.join(" + ")} from .swarm-design/ into the planner seed.`,
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.appendSystem(`Design memory read failed (${msg}); continuing without long-horizon vision context.`);
      }
    }
    // Phase 5c of #243: derive {tag → count} for any workers that
    // carry a topology tag. Renders into the planner prompt's
    // AVAILABLE WORKER TAGS section so the planner can emit
    // `preferredTag` per TODO. Empty array → no tags rendered.
    const workerTags = computeWorkerTagCounts(cfg.topology);
    return {
      repoUrl: cfg.repoUrl,
      clonePath,
      topLevel,
      repoFiles,
      readmeExcerpt,
      // Unit 25: pass user directive (if any) through to the first-pass
      // contract prompt. Empty/whitespace was already stripped at the
      // route boundary; this is just pass-through.
      userDirective: cfg.userDirective,
      priorRunSummary,
      priorMemoryRendered,
      priorDesignMemoryRendered,
      workerTags,
    };
  }

  // Unit 51: opt-in resume path. Reads blackboard-state.json from
  // the clone, installs the prior run's contract + tier state
  // directly, and tells the caller to skip first-pass-contract.
  // Returns false on missing/invalid snapshot — caller falls back
  // to the normal planner-derives-contract path silently. Logs the
  // resume to the transcript so the user knows we picked it up.
  //
  // Unit 57: reads from the cached priorSnapshot (captured at the top
  // of start() BEFORE any spawning-phase scheduleStateWrite fires).
  // Re-reading from disk here would race with our own snapshot writes
  // and almost always see our own freshly-written empty-contract
  // shape — exactly the bug Unit 57 fixes.
  private async tryResumeContract(_clonePath: string): Promise<boolean> {
    const snap = this.priorSnapshot;
    if (!snap || !snap.contract) {
      this.appendSystem(
        "Resume requested but no valid blackboard-state.json found — falling back to first-pass-contract.",
      );
      return false;
    }
    // Install contract + tier state from the snapshot. cloneContract
    // (NOT buildContract) is intentional — buildContract resets every
    // criterion to status="unmet" and renumbers ids, but on resume we
    // want to PRESERVE the prior met/unmet/wont-do status, rationales,
    // and ids. The auditor will re-evaluate them against the current
    // working tree on its first invocation, so a "met" criterion whose
    // evidence got reverted will flip back to unmet.
    this.contract = this.cloneContract(snap.contract);
    this.currentTier = snap.currentTier ?? 1;
    this.tiersCompleted = snap.tiersCompleted ?? 0;
    this.tierStartedAt = Date.now();
    if (snap.tierHistory && snap.tierHistory.length > 0) {
      // Restore the prior tier-history entries verbatim. The current
      // (in-flight) tier isn't in there yet — recordTierCompletion
      // appends as tiers close. Defensive copy so a downstream
      // mutation doesn't reach into the snapshot.
      this.tierHistory = snap.tierHistory.map((t) => ({ ...t }));
    }
    this.opts.emit({
      type: "contract_updated",
      contract: this.cloneContract(this.contract),
    });
    this.scheduleStateWrite();
    let met = 0;
    let unmet = 0;
    let wontDo = 0;
    for (const c of this.contract.criteria) {
      if (c.status === "met") met++;
      else if (c.status === "wont-do") wontDo++;
      else unmet++;
    }
    this.appendSystem(
      `Resumed contract from blackboard-state.json (tier ${this.currentTier}, ${this.tiersCompleted} tiers completed prior). ` +
        `${met} met / ${unmet} unmet / ${wontDo} wont-do criteria carried over — ` +
        `auditor will re-evaluate against the current working tree.`,
    );
    return true;
  }

  // Unit 50: read + distill the most recent prior summary in this
  // clone path. Returns undefined when no prior summary exists OR when
  // it lacks a usable contract (e.g. a discussion-preset run has no
  // contract at all — those runs can't inform a blackboard resume).
  private async loadPriorRunSummary(clonePath: string): Promise<PriorRunSummary | undefined> {
    const summary = await findAndReadNewestPriorSummary(clonePath);
    if (!summary || !summary.contract || summary.contract.criteria.length === 0) {
      return undefined;
    }
    const startedAtIso = new Date(summary.startedAt).toISOString();
    return {
      startedAtIso,
      missionStatement: summary.contract.missionStatement,
      criteria: summary.contract.criteria.map((c) => ({
        id: c.id,
        description: c.description,
        status: c.status,
        rationale: c.rationale,
        expectedFiles: [...c.expectedFiles],
      })),
    };
  }

  // ---------------------------------------------------------------------
  // Phase 11b: first-pass exit contract
  // ---------------------------------------------------------------------

  // Ask the planner for a mission statement + criteria list BEFORE it posts
  // todos. One shot + one repair attempt, matching runPlanner's pattern. If
  // the contract can't be parsed we log, leave this.contract undefined, and
  // return — the caller proceeds to runPlanner either way.
  private async runFirstPassContract(agent: Agent, seed: PlannerSeed): Promise<void> {
    // Unit 24: planner fallback. If primary planner exhausts retries,
    // fall through to each worker in turn so the run survives a
    // single-shard cloud cold-start failure.
    // #233: pass ollamaFormat="json" so Ollama's decoder constrains
    // output to valid JSON. Closes the XML marker leak (#231) at the
    // source for the contract pass.
    const { response: firstResponse, agentUsed: contractAgent } = await this.promptPlannerSafely(
      agent,
      `${FIRST_PASS_CONTRACT_SYSTEM_PROMPT}\n\n${buildFirstPassContractUserPrompt(seed)}`,
      "swarm",
      "json",
    );
    if (this.stopping) return;
    this.appendAgent(contractAgent, firstResponse);

    let parsed = parseFirstPassContractResponse(firstResponse);
    if (!parsed.ok) {
      this.appendSystem(
        `Contract response did not parse (${parsed.reason}). Issuing repair prompt.`,
      );
      const { response: repairResponse, agentUsed: repairAgent } = await this.promptPlannerSafely(
        contractAgent,
        `${FIRST_PASS_CONTRACT_SYSTEM_PROMPT}\n\n${buildFirstPassContractRepairPrompt(
          firstResponse,
          parsed.reason,
        )}`,
        "swarm",
        "json",
      );
      if (this.stopping) return;
      this.appendAgent(repairAgent, repairResponse);
      parsed = parseFirstPassContractResponse(repairResponse);
      if (!parsed.ok) {
        this.appendSystem(
          `Contract still invalid after repair (${parsed.reason}). Proceeding without a contract.`,
        );
        return;
      }
    }

    if (parsed.dropped.length > 0) {
      this.appendSystem(
        `Dropped ${parsed.dropped.length} invalid criterion(s): ${parsed.dropped
          .map((d) => d.reason)
          .join(" | ")}`,
      );
    }

    this.finalizeContract(parsed.contract, seed, agent);
  }

  // Unit 30: council-mode dispatch. When COUNCIL_CONTRACT_ENABLED is on AND
  // there's at least one worker to add cognitive diversity, run the
  // two-phase council flow (N drafts in parallel, then planner-merge). If
  // Task #164 (refactor): goal-generation pre-pass body now lives in
  // ./goalGenerationPrePass.ts.

  // Task #164 (refactor): the inline stretch-goal (#129) +
  // memory-distillation (#130) method bodies that lived here are now
  // in ./reflectionPasses.ts. Call sites in the run-end finally block
  // construct a ReflectionContext and invoke the exported
  // runStretchGoalReflectionPass + runMemoryDistillationPass.

  // the council flow produces nothing usable (all drafts failed to parse
  // OR the merge itself failed), fall through to the legacy single-agent
  // path so the run still gets a contract. When the flag is off, skip
  // straight to single-agent.
  private async runFirstPassContractOrchestrator(
    planner: Agent,
    workers: Agent[],
    seed: PlannerSeed,
  ): Promise<void> {
    // Unit 32: per-run knob wins over env flag. Absent → env decides,
    // same as pre-Unit-32 behavior. Lets users A/B with and without
    // council via the form without restarting the server to flip
    // COUNCIL_CONTRACT_ENABLED.
    const councilEnabled =
      this.active?.councilContract ?? config.COUNCIL_CONTRACT_ENABLED;
    if (councilEnabled && workers.length > 0) {
      const merged = await this.tryCouncilContract(planner, workers, seed);
      if (merged !== null) {
        this.finalizeContract(merged, seed, planner);
        return;
      }
      this.appendSystem(
        "Council contract produced no usable drafts or merge failed; falling back to single-agent contract.",
      );
    }
    await this.runFirstPassContract(planner, seed);
  }

  // Unit 30: two-phase council contract.
  //
  // Phase A (DRAFT): every agent in [planner, ...workers] produces a
  // first-pass contract INDEPENDENTLY from the same seed. Parallel,
  // peer-hidden (each agent's prompt is identical to the single-agent
  // one — no agent sees any other agent's draft).
  //
  // Phase B (MERGE): the planner receives all parseable drafts in one
  // prompt and produces the final authoritative contract. Uses the
  // usual promptPlannerSafely so a planner cold-start failure
  // cycles through workers as merge candidates.
  //
  // Returns the merged ParsedContract on success, OR the sole
  // surviving draft when only 1 agent's draft parsed (no merge needed),
  // OR null when nothing usable came back (caller falls back to
  // single-agent). The caller is responsible for grounding + finalizing.
  private async tryCouncilContract(
    planner: Agent,
    workers: Agent[],
    seed: PlannerSeed,
  ): Promise<ParsedContract | null> {
    const allAgents = [planner, ...workers];
    const draftPrompt = `${FIRST_PASS_CONTRACT_SYSTEM_PROMPT}\n\n${buildFirstPassContractUserPrompt(
      seed,
    )}`;

    this.appendSystem(
      `Council contract: prompting ${allAgents.length} agents for independent first-pass drafts.`,
    );

    const draftResults = await Promise.allSettled(
      allAgents.map(async (a) => {
        // #231 (2026-04-27 evening): drop tools for council contract
        // drafts. FIRST_PASS_CONTRACT_SYSTEM_PROMPT is tool-agnostic;
        // file list comes from the user prompt. With tools enabled,
        // glm-5.1 / nemotron-3-super hallucinate <read>/<grep> markers
        // that prefix the JSON envelope and cause parse failures (RCA
        // run 6a256a18, 2026-04-27 evening).
        const text = await this.promptAgent(a, draftPrompt, "swarm");
        return { agent: a, text };
      }),
    );

    const drafts: CouncilContractDraft[] = [];
    for (const r of draftResults) {
      if (r.status !== "fulfilled") {
        this.appendSystem(
          `Council draft prompt rejected: ${
            r.reason instanceof Error ? r.reason.message : String(r.reason)
          }`,
        );
        continue;
      }
      this.appendAgent(r.value.agent, r.value.text);
      const parsed = parseFirstPassContractResponse(r.value.text);
      if (!parsed.ok) {
        this.appendSystem(
          `Council draft from ${r.value.agent.id} did not parse (${parsed.reason}); skipping.`,
        );
        continue;
      }
      if (parsed.dropped.length > 0) {
        this.appendSystem(
          `Council draft from ${r.value.agent.id}: dropped ${parsed.dropped.length} invalid criterion(s) at parse time.`,
        );
      }
      drafts.push({ agentId: r.value.agent.id, contract: parsed.contract });
    }

    if (drafts.length === 0) {
      this.appendSystem("Council contract: 0 drafts survived parsing.");
      return null;
    }
    if (drafts.length === 1) {
      this.appendSystem(
        `Council contract: only 1 of ${allAgents.length} drafts parsed — using it directly (no merge).`,
      );
      return drafts[0].contract;
    }

    this.appendSystem(
      `Council contract: ${drafts.length} drafts parsed; running merge via planner.`,
    );
    const mergePrompt = buildCouncilContractMergePrompt(seed, drafts);
    const { response: mergeResponse, agentUsed: mergeAgent } =
      await this.promptPlannerSafely(planner, mergePrompt);
    if (this.stopping) return null;
    this.appendAgent(mergeAgent, mergeResponse);

    let mergeParsed = parseFirstPassContractResponse(mergeResponse);
    if (!mergeParsed.ok) {
      this.appendSystem(
        `Council merge response did not parse (${mergeParsed.reason}). Issuing repair prompt.`,
      );
      const { response: repairResponse, agentUsed: repairAgent } =
        await this.promptPlannerSafely(
          mergeAgent,
          `${FIRST_PASS_CONTRACT_SYSTEM_PROMPT}\n\n${buildFirstPassContractRepairPrompt(
            mergeResponse,
            mergeParsed.reason,
          )}`,
        );
      if (this.stopping) return null;
      this.appendAgent(repairAgent, repairResponse);
      mergeParsed = parseFirstPassContractResponse(repairResponse);
      if (!mergeParsed.ok) {
        this.appendSystem(
          `Council merge still invalid after repair (${mergeParsed.reason}). Using best draft (most criteria) as fallback.`,
        );
        // Deterministic tie-break: prefer the draft with the most criteria;
        // ties go to the earliest agent (planner first). Gives us *some*
        // contract rather than punting back to single-agent after we've
        // already paid for N drafts.
        const best = drafts.reduce((a, b) =>
          b.contract.criteria.length > a.contract.criteria.length ? b : a,
        );
        return best.contract;
      }
    }
    if (mergeParsed.dropped.length > 0) {
      this.appendSystem(
        `Council merge: dropped ${mergeParsed.dropped.length} invalid criterion(s) at parse time.`,
      );
    }
    return mergeParsed.contract;
  }

  // Unit 6b grounding + contract publish, extracted (Unit 30) so both the
  // single-agent and council paths produce identical downstream shape.
  // `ownerAgent` is only used to label the agent on path-strip findings
  // — both paths treat the planner as the nominal author.
  private finalizeContract(
    parsed: ParsedContract,
    seed: PlannerSeed,
    ownerAgent: Agent,
  ): void {
    // Unit 6b: strip criterion paths not grounded in the REPO FILE LIST.
    // v9 showed rule 9 is ignorable as advice (planner invented `src/tests/`
    // despite colocated tests being right there); enforcement turns it from
    // "might work" into "only bindable paths can reach the auditor".
    const groundedCriteria = parsed.criteria.map((c, idx) => {
      const { accepted, rejected } = classifyExpectedFiles(c.expectedFiles, seed.repoFiles);
      for (const r of rejected) {
        this.findings.post({
          agentId: ownerAgent.id,
          text: `Contract c${idx + 1}: stripped suspicious path '${r.path}' (${r.reason}). Unit 5d linked-commit fallback will rebind from later commits.`,
          createdAt: Date.now(),
        });
      }
      if (rejected.length > 0) {
        this.appendSystem(
          `Contract c${idx + 1}: ${rejected.length}/${c.expectedFiles.length} path(s) stripped as unbindable — criterion kept with expectedFiles=${JSON.stringify(accepted)}.`,
        );
      }
      return { description: c.description, expectedFiles: accepted };
    });
    const groundedContract: ParsedContract = {
      missionStatement: parsed.missionStatement,
      criteria: groundedCriteria,
    };

    this.contract = this.buildContract(groundedContract);
    // Unit 34: first-pass contract installation → tier 1.
    this.currentTier = 1;
    this.tierStartedAt = Date.now();
    this.opts.emit({ type: "contract_updated", contract: this.cloneContract(this.contract) });
    // V2 Step 3b.2: contract installed — fire contract-built event.
    // Empty-contract path (criteria.length === 0) transitions V2 directly
    // to "completed"; otherwise V2 stays in "planning" awaiting todos.
    this.v2Observer.apply({
      type: "contract-built",
      ts: Date.now(),
      criteriaCount: this.contract.criteria.length,
    });
    // Unit 31: the contract is load-bearing state; make sure the very next
    // observer read sees it even if no board event follows for a while.
    this.scheduleStateWrite();

    if (this.contract.criteria.length === 0) {
      this.appendSystem(
        `Contract (tier 1): "${this.contract.missionStatement}" (0 criteria — planner found nothing to commit to).`,
      );
    } else {
      this.appendSystem(
        `Contract (tier 1): "${this.contract.missionStatement}" (${this.contract.criteria.length} criteria).`,
      );
    }
  }

  private buildContract(parsed: ParsedContract): ExitContract {
    const addedAt = Date.now();
    return {
      missionStatement: parsed.missionStatement,
      criteria: parsed.criteria.map((c, i) => ({
        id: `c${i + 1}`,
        description: c.description,
        expectedFiles: [...c.expectedFiles],
        status: "unmet",
        addedAt,
      })),
    };
  }

  private cloneContract(c: ExitContract): ExitContract {
    return {
      missionStatement: c.missionStatement,
      criteria: c.criteria.map((crit) => ({
        ...crit,
        expectedFiles: [...crit.expectedFiles],
      })),
    };
  }

  // ---------------------------------------------------------------------
  // Planner
  // ---------------------------------------------------------------------

  private async runPlanner(
    agent: Agent,
    seed: PlannerSeed,
    // Issue #3 (2026-04-27): when the primary model produces 0 valid
    // todos, this method recurses ONCE with the sibling model. The
    // flag prevents infinite recursion if the fallback also fails.
    isFallbackAttempt = false,
  ): Promise<void> {
    // Unit 24: planner fallback (see promptPlannerSafely comment).
    // #231 follow-up (2026-04-27 evening): the todos pass uses
    // PLANNER_SYSTEM_PROMPT which explicitly requires tool use ("USE
    // THEM", "REQUIRED VERIFICATION: GREP for the symbol FIRST"). With
    // tools removed, the model returns empty (validation run 07e37525).
    // Pass "swarm-read" explicitly here so todos has tool access. Marker
    // leaks are now caught by stripAgentText (#229+#230) so the parse
    // path sees clean JSON via extractFirstBalanced. Contract pass keeps
    // the new "swarm" default since FIRST_PASS_CONTRACT_SYSTEM_PROMPT is
    // tool-agnostic (file list is supplied in the user prompt).
    // #231 follow-up: pass the just-produced contract into the todos
    // prompt so the planner can ground each TODO against a specific
    // criterion. RCA: without this, the model returns [] because it has
    // no actionable target.
    const contractForPrompt = this.contract
      ? {
          missionStatement: this.contract.missionStatement,
          criteria: this.contract.criteria.map((c) => ({
            description: c.description,
            expectedFiles: c.expectedFiles,
          })),
        }
      : undefined;
    // #233: pass ollamaFormat="json" so Ollama's decoder constrains
    // output to a JSON array. Even though tools are enabled here for
    // grounding (per #231 follow-up), the model can't emit XML
    // markers as the FINAL output — they go in the marker-stripped
    // path naturally, but the JSON envelope is structurally enforced.
    const { response: firstResponse, agentUsed: planAgent } = await this.promptPlannerSafely(
      agent,
      `${PLANNER_SYSTEM_PROMPT}\n\n${buildPlannerUserPrompt(seed, contractForPrompt)}`,
      "swarm-read",
      "json",
    );
    if (this.stopping) return;
    this.appendAgent(planAgent, firstResponse);

    let parsed = parsePlannerResponse(firstResponse);
    if (!parsed.ok) {
      this.appendSystem(`Planner response did not parse (${parsed.reason}). Issuing repair prompt.`);
      const { response: repairResponse, agentUsed: repairAgent } = await this.promptPlannerSafely(
        planAgent,
        `${PLANNER_SYSTEM_PROMPT}\n\n${buildRepairPrompt(firstResponse, parsed.reason)}`,
        "swarm-read",
        "json",
      );
      if (this.stopping) return;
      this.appendAgent(repairAgent, repairResponse);
      parsed = parsePlannerResponse(repairResponse);
      if (!parsed.ok) {
        this.appendSystem(`Planner still invalid after repair (${parsed.reason}). Giving up this run.`);
        this.findings.post({
          agentId: agent.id,
          text: `Planner failed to produce valid JSON after one repair attempt. Last error: ${parsed.reason}`,
          createdAt: Date.now(),
        });
        return;
      }
    }

    if (parsed.dropped.length > 0) {
      this.appendSystem(
        `Dropped ${parsed.dropped.length} invalid todo(s): ${parsed.dropped
          .map((d) => d.reason)
          .join(" | ")}`,
      );
    }

    // Unit 6b: apply the same grounding filter to each todo. Planner schema
    // requires expectedFiles.min(1), so a todo that loses every path has to
    // be dropped entirely — leaving it with [] would later fail board CAS.
    const groundedTodos: typeof parsed.todos = [];
    let suspiciousStripped = 0;
    let todosDropped = 0;
    for (const t of parsed.todos) {
      const { accepted, rejected } = classifyExpectedFiles(t.expectedFiles, seed.repoFiles);
      for (const r of rejected) {
        suspiciousStripped += 1;
        this.findings.post({
          agentId: agent.id,
          text: `Todo "${t.description.slice(0, 80)}${t.description.length > 80 ? "…" : ""}": stripped suspicious path '${r.path}' (${r.reason}).`,
          createdAt: Date.now(),
        });
      }
      if (accepted.length === 0) {
        todosDropped += 1;
        this.findings.post({
          agentId: agent.id,
          text: `Todo "${t.description.slice(0, 80)}${t.description.length > 80 ? "…" : ""}": dropped entirely — all ${t.expectedFiles.length} path(s) rejected by grounding check.`,
          createdAt: Date.now(),
        });
        continue;
      }
      groundedTodos.push({
        description: t.description,
        expectedFiles: accepted,
        expectedAnchors: t.expectedAnchors,
        expectedSymbols: t.expectedSymbols,
      });
    }
    if (suspiciousStripped > 0 || todosDropped > 0) {
      this.appendSystem(
        `Grounding check: stripped ${suspiciousStripped} suspicious path(s); dropped ${todosDropped} todo(s) that lost every path.`,
      );
    }

    // Task #70: symbol-grounding pass. For each surviving todo, read
    // each expectedFile and word-boundary-grep each expectedSymbol.
    // Drop the todo if ANY declared symbol is missing from EVERY
    // expectedFile (the file probably doesn't have it; the worker
    // would just decline). Files that don't exist on disk are
    // skipped (create-style todo). Cheap: cap=5 todos × ≤2 files.
    const symbolGroundedTodos: typeof groundedTodos = [];
    let symbolDropped = 0;
    for (const t of groundedTodos) {
      const result = await checkExpectedSymbols(t, seed.clonePath);
      if (!result.ok) {
        symbolDropped += 1;
        this.findings.post({
          agentId: agent.id,
          text: `Todo "${t.description.slice(0, 80)}${t.description.length > 80 ? "…" : ""}": dropped by symbol-grounding — missing ${result.missing.map((m) => `'${m.symbol}' in ${m.file}`).join(", ")}.`,
          createdAt: Date.now(),
        });
        continue;
      }
      symbolGroundedTodos.push(t);
    }
    if (symbolDropped > 0) {
      this.appendSystem(
        `Symbol-grounding check: dropped ${symbolDropped} todo(s) whose declared expectedSymbols don't exist in expectedFiles.`,
      );
    }
    // Re-bind for downstream code paths.
    groundedTodos.length = 0;
    groundedTodos.push(...symbolGroundedTodos);

    if (groundedTodos.length === 0) {
      // Issue #3 (2026-04-27): minimal-viable model fallback. Per-run
      // cfg.plannerFallbackModel wins; otherwise look up sibling
      // (deepseek↔nemotron). Fallback is one shot — if the recursion
      // also returns 0 todos, we declare failure.
      const fallback = !isFallbackAttempt
        ? this.active?.plannerFallbackModel ?? siblingModelFor(agent.model)
        : undefined;
      if (fallback && fallback !== agent.model) {
        const original = agent.model;
        this.appendSystem(
          `Planner produced 0 valid todos with ${original}; retrying once with sibling model ${fallback}.`,
        );
        agent.model = fallback;
        try {
          await this.runPlanner(agent, seed, true);
          return; // recursive call already handled posting OR loud-warn
        } finally {
          // Restore original so subsequent planner calls (replan,
          // auditor pass, reflection) use the user's chosen model.
          agent.model = original;
        }
      }
      // Either no fallback exists, or fallback also produced 0 todos.
      // Surface the failure loudly — previous wording ("Planner produced
      // 0 valid todos after grounding.") read as a benign system note
      // while the run was actually headed for a no-op terminal state.
      const dropDetail =
        parsed.dropped.length > 0 || todosDropped > 0
          ? `Planner returned only invalid/unbindable todos (${parsed.dropped.length} schema-dropped, ${todosDropped} grounding-dropped).`
          : "Planner returned an empty todo list — nothing actionable in the repo.";
      const fallbackNote = isFallbackAttempt
        ? " (sibling-model fallback also produced 0 todos)"
        : "";
      this.appendSystem(
        `⚠ Planner failed to produce actionable todos${fallbackNote}. ${dropDetail} The run will exit with stopReason="no-progress" after fallback reflection — no commits will land.`,
      );
      this.findings.post({
        agentId: agent.id,
        text: dropDetail,
        createdAt: Date.now(),
      });
      return;
    }

    const now = Date.now();
    for (const t of groundedTodos) {
      this.postTodoQ({
        description: t.description,
        expectedFiles: t.expectedFiles,
        createdBy: agent.id,
        createdAt: now,
        // Unit 44b: forward planner-declared anchors. Undefined / empty
        // → omitted. Each surviving anchor gets resolved at worker
        // prompt build time.
        expectedAnchors: t.expectedAnchors,
        // #237 (2026-04-28): forward kind + command for build-style
        // TODOs. Defaults (kind="hunks", command undefined) keep the
        // existing hunks-emit pipeline unchanged.
        ...(t.kind ? { kind: t.kind } : {}),
        ...(t.command ? { command: t.command } : {}),
        // Phase 5c of #243: forward planner-emitted tag preference for
        // claim routing. Empty / absent → omitted (no preference).
        ...(t.preferredTag ? { preferredTag: t.preferredTag } : {}),
      });
    }
    this.appendSystem(`Posted ${groundedTodos.length} todo(s) to the board.`);
    // V2 Step 3b.2: planner finished — fire todos-posted event so V2
    // can transition from "planning" to "executing" (count>0) or
    // "auditing" (count=0). The reducer's branch on count drives the
    // next phase without needing a separate setPhase call.
    this.v2Observer.apply({
      type: "todos-posted",
      ts: now,
      count: groundedTodos.length,
    });
  }

  // ---------------------------------------------------------------------
  // Phase 11c: drain-audit-repeat loop
  //
  // Each iteration drains the board (runWorkers returns once all todos are
  // open=0/claimed=0/stale=0 and no replans are in flight), then asks the
  // auditor whether the contract is satisfied. The auditor's verdicts are
  // applied in-place: "met"/"wont-do" flip the criterion's status; "unmet"
  // also posts fresh todos linked by criterionId. If the auditor adds new
  // criteria, they get a fresh c{N+1} id and show up in the next round.
  //
  // Exit conditions (first match wins):
  //   1. stopping set (user stop / cap / crash)     → caller handles phase
  //   2. no contract or contract.criteria == 0      → drain-exit (Phase 10)
  //   3. every criterion has a terminal status      → completionDetail
  //   4. auditor invocation cap reached             → completionDetail
  //   5. auditor's parse failed twice and no new
  //      todos were posted (workers would spin)     → completionDetail
  // ---------------------------------------------------------------------

  private async runAuditedExecution(planner: Agent, workers: Agent[]): Promise<void> {
    while (!this.stopping) {
      // Task #116: cap-check before each audit cycle. Worker loop
      // checks per-iteration too, but if workers are stuck in long
      // retry sequences (Pattern 8 / glm-5.1 slow turns) the loop can
      // overshoot the wall-clock cap by minutes. This adds a second
      // gate at the audit boundary so the cap fires reliably.
      if (this.checkAndApplyCaps()) return;
      await this.runWorkers(workers);
      if (this.stopping) return;

      // No contract at all → drain-exit behavior (back-compat). An empty
      // criteria list means the planner had nothing to commit to, so an
      // audit can't add information — also exit.
      if (!this.contract || this.contract.criteria.length === 0) return;

      if (this.allCriteriaResolved()) {
        // Unit 34: intercept the natural "all met" termination. If the
        // ratchet is enabled AND we haven't hit max tiers AND the
        // tier-up prompt hasn't failed too many times in a row, climb
        // to tier N+1 instead of terminating. If the ratchet is off or
        // any guard trips, fall through to the normal termination
        // path (completionDetail below).
        const maxTiers = this.resolvedMaxTiers();
        if (
          maxTiers > 1 &&
          this.currentTier < maxTiers &&
          this.tierUpFailures < 3 &&
          !this.stopping
        ) {
          this.recordTierCompletion();
          const promoted = await this.tryPromoteNextTier(planner, maxTiers);
          if (this.stopping) return;
          // V2 Step 3b.2: tier-up decision made — fire event so the V2
          // reducer transitions tier-up → planning (promoted) or
          // tier-up → completed (failed). Also need to bump V2 into
          // tier-up first via auditor-returned with allCriteriaResolved.
          this.v2Observer.apply({
            type: "tier-up-decision",
            ts: Date.now(),
            promoted,
          });
          if (promoted) {
            // New tier installed; auditor's criteria are fresh "unmet"
            // and runWorkers will pick up the new todos on the next
            // loop iteration. Continue without returning.
            continue;
          }
          // Promotion failed — fall through to normal completion.
          this.completionDetail =
            "all tier criteria satisfied; tier-up failed after retries — ending run.";
          this.appendSystem(this.completionDetail);
          return;
        }
        // Ratchet disabled / max tiers reached / too many failures —
        // record the final tier's stats, then terminate as before.
        this.recordTierCompletion();
        this.completionDetail =
          this.currentTier > 1
            ? `all tier ${this.currentTier} criteria satisfied; ratchet cap reached (${maxTiers} tier${maxTiers === 1 ? "" : "s"}).`
            : "all contract criteria satisfied";
        this.appendSystem("All contract criteria resolved. Stopping.");
        return;
      }

      const cap = this.maxAuditInvocations;
      if (this.auditInvocations >= cap) {
        this.completionDetail = `auditor invocation cap reached (${cap})`;
        this.appendSystem(
          `Auditor invocation cap reached (${cap}). Stopping with unresolved criteria. Raise "Rounds" on the setup form if you want more plan-audit cycles.`,
        );
        return;
      }

      const openBefore = this.boardCounts().open;
      await this.runAuditor(planner);
      if (this.stopping) return;

      // Guard against a wedge: auditor produced no new todos AND no new
      // criteria AND nothing transitioned to terminal — another loop would
      // just re-audit against the same state.
      //
      // Unit 64b: before giving up, give the planner one chance to author
      // todos for the unmet criteria. The auditor doesn't always post
      // todos for fresh criteria — most notably right after a tier
      // promotion (Unit 34), where the just-installed tier-N+1 criteria
      // have no prior worker output for the auditor to evaluate. The
      // pre-fix wedge fired immediately on that empty audit and stopped
      // the run, leaving the entire new tier abandoned. Calling the
      // planner here lets it ground a fresh batch of todos against the
      // current repo state + the unmet criteria sitting on the contract.
      // If even the planner produces nothing, THEN we stop with a more
      // accurate completion detail.
      const openAfter = this.boardCounts().open;
      if (openAfter === openBefore && !this.allCriteriaResolved() && openAfter === 0) {
        const fallbackSucceeded = await this.runPlannerFallbackForUnmetCriteria(planner);
        if (this.stopping) return;
        if (fallbackSucceeded) {
          // Planner posted todos; continue to runWorkers on the next
          // iteration so they can be drained.
          continue;
        }
        this.completionDetail = "auditor + planner produced no new work; unresolved criteria remain";
        this.appendSystem(this.completionDetail + ".");
        return;
      }
    }
  }

  // Unit 64b: rebuild a fresh PlannerSeed and ask the planner to author
  // todos. Returns true if at least one todo landed on the board.
  // Best-effort — a missing clonePath or seed-build failure returns false
  // so the caller stops cleanly. Caller is responsible for the post-call
  // continue/stop branch.
  private async runPlannerFallbackForUnmetCriteria(planner: Agent): Promise<boolean> {
    if (!this.active) return false;
    const openBefore = this.boardCounts().open;
    this.appendSystem(
      "Auditor produced no new work; trying a planner pass against the current contract before stopping.",
    );
    let seed: PlannerSeed;
    try {
      seed = await this.buildSeed(this.active.localPath, this.active);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.appendSystem(`Planner-fallback seed build failed: ${msg}.`);
      return false;
    }
    if (this.stopping) return false;
    await this.runPlanner(planner, seed);
    if (this.stopping) return false;
    const openAfter = this.boardCounts().open;
    return openAfter > openBefore;
  }

  private allCriteriaResolved(): boolean {
    if (!this.contract) return true;
    return this.contract.criteria.every((c) => c.status !== "unmet");
  }

  // Unit 34: resolve the effective tier cap for this run.
  //
  //   - `cfg.ambitionTiers === 0` → ratchet explicitly disabled (max = 1,
  //     meaning "stop at tier 1" = today's behavior).
  //   - `cfg.ambitionTiers >= 1` → that value, regardless of env flag.
  //   - Otherwise, check env: AMBITION_RATCHET_ENABLED=true →
  //     AMBITION_RATCHET_MAX_TIERS; AMBITION_RATCHET_ENABLED=false → 1.
  //
  // Capped at 20 by the route schema; also capped by the env's
  // max-tier value when inheriting.
  private resolvedMaxTiers(): number {
    const perRun = this.active?.ambitionTiers;
    if (perRun !== undefined) {
      return Math.max(1, perRun);
    }
    if (!config.AMBITION_RATCHET_ENABLED) return 1;
    return config.AMBITION_RATCHET_MAX_TIERS;
  }

  // Unit 34: capture the just-completed tier's stats. Called when all
  // criteria for the CURRENT tier are resolved — either right before a
  // tier promotion or right before final termination. Push stats to
  // tierHistory; the summary + state snapshot include this array so
  // cross-run analysis can see the per-tier breakdown.
  //
  // The "current tier's criteria" are the tail slice of this.contract.criteria
  // whose addedAt matches the current tier's startedAt — since buildContract /
  // appendTierCriteria stamp each batch with the tier's start time, a group-by
  // on addedAt recovers the per-tier subset.
  private recordTierCompletion(): void {
    if (!this.contract || this.currentTier < 1) return;
    const now = Date.now();
    const startedAt = this.tierStartedAt ?? now;
    // The current tier's criteria are the ones whose addedAt is >= this
    // tier's startedAt (tier N criteria are stamped with tierStartedAt
    // when promoted; tier 1's are stamped at buildContract time just
    // after tierStartedAt was set).
    const tierCriteria = this.contract.criteria.filter(
      (c) => c.addedAt >= startedAt,
    );
    const met = tierCriteria.filter((c) => c.status === "met").length;
    const wontDo = tierCriteria.filter((c) => c.status === "wont-do").length;
    const unmet = tierCriteria.filter((c) => c.status === "unmet").length;
    this.tierHistory.push({
      tier: this.currentTier,
      missionStatement: this.contract.missionStatement,
      criteriaTotal: tierCriteria.length,
      criteriaMet: met,
      criteriaWontDo: wontDo,
      criteriaUnmet: unmet,
      wallClockMs: Math.max(0, now - startedAt),
      startedAt,
      endedAt: now,
    });
    this.tiersCompleted += 1;
  }

  // Unit 34: attempt to promote tier N → tier N+1 via a planner prompt.
  // Returns true if a new tier contract was installed; false otherwise
  // (parse failure, zero valid criteria, or user stop mid-prompt).
  //
  // Preserves prior-tier criteria in this.contract.criteria (they stay
  // "met"/"wont-do" for the summary record) and appends the new tier's
  // criteria with continuing IDs (tier 1 = c1-c5; tier 2 = c6-cN; etc.).
  // The missionStatement is replaced with the new tier's so the UI and
  // downstream prompts frame work by the current ambition level.
  private async tryPromoteNextTier(
    planner: Agent,
    maxTiers: number,
  ): Promise<boolean> {
    if (!this.contract || !this.active) return false;
    const nextTier = this.currentTier + 1;
    this.appendSystem(
      `Ambition ratchet: all tier ${this.currentTier} criteria resolved; attempting tier ${nextTier} (max ${maxTiers}).`,
    );

    // Gather committed files across all tiers so the planner doesn't
    // propose duplicating prior work.
    const committed = this.boardListTodos().filter((t) => t.status === "committed");
    const committedFiles = Array.from(
      new Set(committed.flatMap((t) => t.expectedFiles)),
    );

    const priorCriteria = this.contract.criteria.map((c) => ({
      id: c.id,
      description: c.description,
      status: c.status,
      rationale: c.rationale,
      expectedFiles: [...c.expectedFiles],
    }));

    // We need the latest PlannerSeed-style inputs (REPO FILE LIST, README,
    // user directive). Rebuild from the active cfg — cheap and the
    // directive is carried on the run config.
    const clone = this.active.localPath;
    // Task #209: log tier-up file-read failures instead of silent fallback.
    // Previously these `.catch(() => null/[])` swallows let a deleted-clone
    // or unreadable-repo scenario produce an empty file list → planner
    // posts 0 todos → run "succeeds" doing nothing. Surface the failure
    // both to diag log and transcript so the user can recognize the
    // degraded-context state.
    const readmeExcerpt = await this.opts.repos.readReadme(clone).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.opts.logDiag?.({ type: "_tier_up_readme_failed", clone, error: msg });
      this.appendSystem(`Tier-up README read failed (${msg}); planner gets no README context.`);
      return null;
    });
    const repoFiles = await this.opts.repos.listRepoFiles(clone, { maxFiles: 150 }).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.opts.logDiag?.({ type: "_tier_up_files_failed", clone, error: msg });
      this.appendSystem(`Tier-up file list failed (${msg}); planner gets empty file list.`);
      return [] as string[];
    });

    const prompt = buildTierUpPrompt({
      nextTier,
      maxTiers,
      priorMissionStatement: this.contract.missionStatement,
      priorCriteria,
      committedFiles,
      repoFiles,
      readmeExcerpt,
      userDirective: this.active.userDirective,
    });

    const { response, agentUsed } = await this.promptPlannerSafely(
      planner,
      prompt,
    );
    if (this.stopping) return false;
    this.appendAgent(agentUsed, response);

    let parsed = parseFirstPassContractResponse(response);
    if (!parsed.ok) {
      this.appendSystem(
        `Tier ${nextTier} response did not parse (${parsed.reason}). Issuing repair prompt.`,
      );
      const { response: repairResponse, agentUsed: repairAgent } =
        await this.promptPlannerSafely(
          agentUsed,
          `${FIRST_PASS_CONTRACT_SYSTEM_PROMPT}\n\n${buildFirstPassContractRepairPrompt(
            response,
            parsed.reason,
          )}`,
        );
      if (this.stopping) return false;
      this.appendAgent(repairAgent, repairResponse);
      parsed = parseFirstPassContractResponse(repairResponse);
      if (!parsed.ok) {
        this.tierUpFailures += 1;
        this.appendSystem(
          `Tier ${nextTier} still invalid after repair (${parsed.reason}). Ratchet failure ${this.tierUpFailures}/3.`,
        );
        return false;
      }
    }
    if (parsed.contract.criteria.length === 0) {
      this.tierUpFailures += 1;
      this.appendSystem(
        `Tier ${nextTier} produced 0 criteria — planner saw nothing left to do. Ratchet failure ${this.tierUpFailures}/3.`,
      );
      return false;
    }

    // Reset the failure counter on successful parse — we only count
    // CONSECUTIVE failures.
    this.tierUpFailures = 0;

    // Ground paths (Unit 6b). Same as the first-pass pass.
    const priorMaxId = this.largestCriterionIdNumber();
    const tierStartedAt = Date.now();
    const appendedCriteria = parsed.contract.criteria.map((c, idx) => {
      const { accepted, rejected } = classifyExpectedFiles(c.expectedFiles, repoFiles);
      for (const r of rejected) {
        this.findings.post({
          agentId: planner.id,
          text: `Tier ${nextTier} c${priorMaxId + idx + 1}: stripped suspicious path '${r.path}' (${r.reason}).`,
          createdAt: Date.now(),
        });
      }
      if (rejected.length > 0) {
        this.appendSystem(
          `Tier ${nextTier} c${priorMaxId + idx + 1}: ${rejected.length}/${c.expectedFiles.length} path(s) stripped as unbindable.`,
        );
      }
      return {
        id: `c${priorMaxId + idx + 1}`,
        description: c.description,
        expectedFiles: accepted,
        status: "unmet" as const,
        addedAt: tierStartedAt,
      };
    });

    // Install the new tier on top of prior criteria.
    this.contract = {
      missionStatement: parsed.contract.missionStatement,
      criteria: [...this.contract.criteria, ...appendedCriteria],
    };
    this.currentTier = nextTier;
    this.tierStartedAt = tierStartedAt;
    this.opts.emit({
      type: "contract_updated",
      contract: this.cloneContract(this.contract),
    });
    this.scheduleStateWrite();
    this.appendSystem(
      `Contract (tier ${nextTier}): "${this.contract.missionStatement}" (+${appendedCriteria.length} new criteria, ${this.contract.criteria.length} total).`,
    );
    return true;
  }

  // Unit 34: highest numeric suffix across current criterion IDs, for ID
  // continuation on tier promotion. Criteria are IDed c1, c2, c3, ... so
  // the number is the part after 'c'. Returns 0 if no criteria exist or
  // none parse (shouldn't happen at ratchet time — we just saw a full
  // tier complete).
  private largestCriterionIdNumber(): number {
    if (!this.contract) return 0;
    let max = 0;
    for (const c of this.contract.criteria) {
      const m = /^c(\d+)$/.exec(c.id);
      if (m) {
        const n = Number.parseInt(m[1], 10);
        if (n > max) max = n;
      }
    }
    return max;
  }

  // Audit fix (2026-04-28): criticEnabled() / verifierEnabled() gate
  // methods removed — neither feature has been re-wired into the V2
  // worker pipeline since V2 cutover Phase 2c. cfg.critic / cfg.verifier
  // / cfg.criticEnsemble flags continue to be accepted by the route
  // schema for back-compat (older clients won't 400) but are no-op.
  // When the features get re-wired, the gates come back with them.

  // Unit 11: the drain-audit-repeat loop's backstop. Reads from cfg.rounds so
  // the user's setup-form "Rounds" slider actually has teeth in blackboard
  // mode (previously ignored — see README notes). The fallback of 5 matches
  // the pre-Unit-11 hardcoded value and only triggers if this.active is
  // missing, which shouldn't happen once start() has run.
  private get maxAuditInvocations(): number {
    return this.active?.rounds ?? 5;
  }

  private async runAuditor(
    planner: Agent,
    opts: { allowWhenStopping?: boolean } = {},
  ): Promise<void> {
    if (!this.contract) return;
    this.auditInvocations++;
    const label = opts.allowWhenStopping ? "final audit" : "auditor invocation";
    this.appendSystem(
      `${label} ${this.auditInvocations}/${this.maxAuditInvocations}.`,
    );
    // V2 Step 3b.2: auditor invocation counter just incremented; fire
    // auditor-fired so the V2 reducer can advance executing → auditing
    // (it already entered auditing on the last todo-committed event,
    // but keep the explicit fire for symmetry with auditor-returned).
    this.v2Observer.apply({ type: "auditor-fired", ts: Date.now() });

    const seed = await buildAuditorSeedExtracted({
      contract: this.contract!,
      todos: this.boardListTodos(),
      findings: this.findings.list(),
      readExpectedFiles: (paths) => this.readExpectedFiles(paths),
      auditInvocation: this.auditInvocations,
      maxInvocations: this.maxAuditInvocations,
      uiUrl: this.active?.uiUrl,
      model: this.active?.model ?? "glm-5.1:cloud",
      clonePath: this.active?.localPath ?? "",
      appendSystem: (text) => this.appendSystem(text),
    });
    // Unit 24: planner fallback (see promptPlannerSafely comment).
    // Unit 58: when a dedicated auditor agent was spawned, route the
    // audit prompt to it instead of reusing the planner. Workers can
    // continue draining new todos in parallel during the audit (they
    // were idle on the planner-as-auditor path). promptPlannerSafely's
    // fallback-to-worker safety net still kicks in if the auditor times out.
    const auditPrimary = this.auditor ?? planner;
    const { response: firstResponse, agentUsed: auditAgent } = await this.promptPlannerSafely(
      auditPrimary,
      `${AUDITOR_SYSTEM_PROMPT}\n\n${buildAuditorUserPrompt(seed)}`,
    );
    // Cap-trip final audit needs to keep going even though stopping=true —
    // that IS the whole reason it's running. In-loop audits short-circuit
    // as before to honor user stops and crash aborts.
    if (this.stopping && !opts.allowWhenStopping) return;
    this.appendAgent(auditAgent, firstResponse);

    let parsed = parseAuditorResponse(firstResponse);
    if (!parsed.ok) {
      this.appendSystem(
        `Auditor response did not parse (${parsed.reason}). Issuing repair prompt.`,
      );
      // Unit 58: repair pass also stays on the auditor (or falls back).
      const { response: repairResponse, agentUsed: repairAgent } = await this.promptPlannerSafely(
        auditAgent,
        `${AUDITOR_SYSTEM_PROMPT}\n\n${buildAuditorRepairPrompt(firstResponse, parsed.reason)}`,
      );
      if (this.stopping && !opts.allowWhenStopping) return;
      this.appendAgent(repairAgent, repairResponse);
      parsed = parseAuditorResponse(repairResponse);
      if (!parsed.ok) {
        this.appendSystem(
          `Auditor still invalid after repair (${parsed.reason}). Skipping this round; unresolved criteria remain.`,
        );
        return;
      }
    }

    if (parsed.dropped.length > 0) {
      this.appendSystem(
        `Auditor dropped ${parsed.dropped.length} invalid item(s): ${parsed.dropped
          .map((d) => d.reason)
          .join(" | ")}`,
      );
    }

    // V2 Step 3b.2: count new todos the auditor added BEFORE applying
    // (applyAuditorResult mutates the board, so post-apply counts would
    // include any prior open todos too). The reducer uses
    // newTodosCount + allCriteriaResolved together to decide whether
    // to keep auditing, transition to executing, or terminate.
    const newTodosCount = parsed.result.verdicts.reduce(
      (n, v) => n + (v.status === "unmet" ? v.todos.length : 0),
      0,
    );
    this.applyAuditorResult(parsed.result, planner);
    this.v2Observer.apply({
      type: "auditor-returned",
      ts: Date.now(),
      allCriteriaResolved: this.allCriteriaResolvedSnapshot(),
      newTodosCount,
    });
  }

  private applyAuditorResult(result: AuditorResult, planner: Agent): void {
    if (!this.contract) return;
    const criteriaById = new Map(this.contract.criteria.map((c) => [c.id, c]));
    const now = Date.now();
    let statusChanges = 0;
    let todosPosted = 0;

    for (const v of result.verdicts) {
      const crit = criteriaById.get(v.id);
      if (!crit) {
        this.appendSystem(
          `Auditor emitted verdict for unknown criterion '${v.id}' — ignored.`,
        );
        continue;
      }
      if (crit.status !== "unmet") {
        // Prompt tells auditor not to re-verdict resolved criteria, but if it
        // does we skip silently (resolved is resolved).
        continue;
      }

      if (v.status === "unmet") {
        if (v.todos.length === 0) {
          // Schema permits this but the prompt forbids it — auto-convert to
          // wont-do rather than leaving the criterion wedged unmet with no
          // new work. The auto-rationale records that we did so.
          crit.status = "wont-do";
          crit.rationale = `auto-converted: auditor returned unmet with no todos. Original rationale: ${v.rationale}`;
          statusChanges++;
          continue;
        }
        for (const t of v.todos) {
          this.postTodoQ({
            description: t.description,
            expectedFiles: [...t.expectedFiles],
            createdBy: planner.id,
            createdAt: now,
            criterionId: crit.id,
            // Unit 44b: auditor-emitted todos may also carry anchors.
            // Optional chaining keeps the call backward-compatible if the
            // auditor schema wasn't extended yet.
            expectedAnchors: (t as { expectedAnchors?: string[] }).expectedAnchors,
          });
          todosPosted++;
        }
        // Leave crit.status as "unmet" — next audit round will re-check.
        crit.rationale = v.rationale;
      } else {
        crit.status = v.status;
        crit.rationale = v.rationale;
        statusChanges++;
      }
    }

    // New criteria are appended; their id is the next slot in the criteria
    // array. Future audit rounds can propose todos for them.
    let added = 0;
    if (result.newCriteria.length > 0) {
      let nextIdx = this.contract.criteria.length;
      for (const nc of result.newCriteria) {
        nextIdx++;
        this.contract.criteria.push({
          id: `c${nextIdx}`,
          description: nc.description,
          expectedFiles: [...nc.expectedFiles],
          status: "unmet",
          addedAt: now,
        });
        added++;
      }
    }

    this.opts.emit({ type: "contract_updated", contract: this.cloneContract(this.contract) });
    this.appendSystem(
      `Auditor applied: ${statusChanges} status change(s), ${todosPosted} new todo(s), ${added} new criterion(s).`,
    );
  }

  // ---------------------------------------------------------------------
  // Workers (Phase 4: dry-run — no file writes)
  // ---------------------------------------------------------------------

  private async runWorkers(workers: Agent[]): Promise<void> {
    await Promise.all(workers.map((w) => this.runWorker(w)));
  }

  private async runWorker(agent: Agent): Promise<void> {
    // Task #215: instrument the wait-loop to surface "all conditions to
    // exit are NOT met" wedges. Periodically log which condition is
    // keeping the worker in the wait branch so we can identify state
    // wedges in real-time instead of post-mortem.
    let waitTickN = 0;
    let lastWaitDiagAt = 0;
    while (!this.stopping) {
      // Jittered poll so N workers don't hit the board in lockstep.
      const jitter = Math.floor(Math.random() * WORKER_POLL_JITTER_MS);
      await this.sleep(WORKER_POLL_MS + jitter);
      if (this.stopping) return;

      // Phase 7: cap guard. Check BEFORE considering new work so we don't
      // burn another prompt right after a cap would have tripped. Sets
      // stopping=true under the hood, so the next loop iteration (if any)
      // exits cleanly; we also return early here for promptness.
      if (this.checkAndApplyCaps()) return;
      // Task #165: while paused on quota wall, idle silently — don't
      // claim work, don't burn cooldown, just wait for the probe to
      // resume. checkAndApplyCaps short-circuits during pause so the
      // wall-clock cap doesn't burn either.
      if (this.paused) continue;
      // Task #167: soft-stop. If draining was requested, this worker's
      // current iteration's executeWorkerTodo (if any) already ran to
      // completion above the loop boundary. Now: don't claim anything
      // new — exit cleanly so the drain watcher can escalate to hard
      // stop once all workers have exited and no claims remain.
      if (this.draining) return;

      const counts = this.boardCounts();
      // Nothing left to do: no open, nothing claimed, no stales, AND no
      // in-flight replan work. Stales can resurrect to open via replan, and
      // a slow replan can finish AFTER the last worker loop — so we must
      // also wait for replanPending to drain and replanRunning to clear,
      // otherwise a revised todo would be posted to an already-terminated
      // swarm and stuck at open forever.
      if (
        counts.open === 0 &&
        counts.claimed === 0 &&
        counts.stale === 0 &&
        this.replanPending.size === 0 &&
        !this.replanRunning
      ) {
        return;
      }
      // Task #216: emit "ready" status during the wait/poll branch so
      // the UI doesn't show stale "thinking" from the start of the
      // previous prompt. Without this, a worker that finished a prompt
      // and is now polling shows as actively-thinking for minutes.
      this.opts.manager.markStatus(agent.id, "ready", { lastMessageAt: Date.now() });
      this.emitAgentState({
        id: agent.id,
        index: agent.index,
        port: agent.port,
        sessionId: agent.sessionId,
        status: "ready",
        lastMessageAt: Date.now(),
      });
      // Task #215 + #219: log wedge state when the worker has been
      // wait-spinning for a while. Validation run c05898ab (2026-04-26)
      // showed the original "fire on first tick" was too eager — every
      // normal "one worker mid-flight while siblings finished" transient
      // tripped the alarm. Real wedges (b2a4d987 — 12+ min with claimed=1
      // stuck) need MULTIPLE consecutive wait ticks. Worker poll = 2-2.5s
      // per tick; require ~12 ticks (30s+ wait) before surfacing anything.
      if (counts.open === 0) {
        waitTickN += 1;
        const now = Date.now();
        const PERSISTENT_WEDGE_MIN_TICKS = 12; // ≈30s at WORKER_POLL_MS=2000+jitter
        // Task #222: only fire the wedge diag when NO agent is in flight.
        // Sibling waiting on a slow-but-alive worker is normal, not a wedge.
        // The wedge is for the case where everyone's idle but state is
        // stuck — that's when something is truly broken.
        const someoneInFlight = this.opts.manager.anyAgentThinking();
        const sustainedWedge = waitTickN >= PERSISTENT_WEDGE_MIN_TICKS && !someoneInFlight;
        if (sustainedWedge && now - lastWaitDiagAt > 30_000) {
          lastWaitDiagAt = now;
          this.opts.logDiag?.({
            type: "_worker_wait_wedge",
            agentId: agent.id,
            tickN: waitTickN,
            counts: { ...counts },
            replanPending: Array.from(this.replanPending),
            replanRunning: this.replanRunning,
            // V2 Step 3b.2: include the V2 reducer's view at wedge-
            // detection time. If V2 says "completed" or "auditing"
            // while V1 is sustained-executing, that's the wedge
            // bug class (#215, #219, #222) confirmed in real time.
            v2Phase: this.v2Observer.getState().phase,
            v2QueueCounts: this.todoQueue.counts(),
            ts: now,
          });
          // V2 cutover Phase 1a: explicit divergence-capture call
          // removed (was: this.v2Observer.checkPhase(...) — the
          // checkPhase method no longer exists). The diag emit above
          // still records the V2 phase + queue counts so wedges are
          // visible in logs/current.jsonl.
          // Surface to transcript ONCE per worker, the first time we
          // cross the persistent threshold. Subsequent re-logs (every
          // 30s while still wedged) only update the diag log, not the
          // transcript — avoid spam.
          if (waitTickN === PERSISTENT_WEDGE_MIN_TICKS) {
            this.appendSystem(
              `[${agent.id}] worker idle ${Math.round(waitTickN * (WORKER_POLL_MS + WORKER_POLL_JITTER_MS / 2) / 1000)}s but exit-condition not met: ` +
                `claimed=${counts.claimed} stale=${counts.stale} ` +
                `replanPending=${this.replanPending.size} replanRunning=${this.replanRunning}`,
            );
          }
        }
        continue;
      } else {
        // Reset on any tick where there's open work — the wedge counter
        // tracks CONSECUTIVE waits, not cumulative. A single open todo
        // appearing means the prior wait is over.
        waitTickN = 0;
      }

      // Unit 45: prefer the claimable-finder so we skip todos whose
      // expectedFiles are already locked by a sibling worker's live
      // claim. When every open todo is locked we just continue —
      // another worker will commit/expire soon and free a file. The
      // jittered sleep at the top of the loop is the implicit backoff.
      //
      // Phase 5c of #243: pass this worker's topology tag so the
      // selector picks a tag-matching TODO first when possible. Falls
      // through to any open todo when no match. Untagged workers
      // (no row tag in topology) get undefined → behaves like before.
      //
      // V2 cutover Phase 2c (2026-04-28): atomic dequeue replaces V1's
      // findClaimableTodo+claimTodo two-step. The todo arrives already
      // in-progress; downstream executors no longer call claimTodo.
      const myTag = this.active?.topology?.agents.find((a) => a.index === agent.index)?.tag;
      const queued = this.dequeueTodoQ(agent.id, myTag);
      if (!queued) continue;
      const todo = v2QueueTodoToWireTodo(queued);

      // #237 (2026-04-28): build-style TODOs short-circuit the hunks
      // pipeline entirely — dispatched through swarm-builder + opencode
      // bash. Hunks TODOs go through executeWorkerTodo (apply-and-commit
      // via search-anchor matching). V2 cutover Phase 2c removed the
      // V1 CAS-based pipeline; the env-gated A/B flag is gone with it.
      let outcome: "committed" | "stale" | "lost-race" | "aborted";
      if (todo.kind === "build") {
        outcome = await this.executeBuildTodo(agent, todo);
      } else {
        outcome = await this.executeWorkerTodo(agent, todo);
      }
      if (outcome === "committed") {
        // Cooldown so one worker doesn't monopolize the board. Random jitter
        // helps desync workers that all finished around the same time.
        await this.sleep(WORKER_COOLDOWN_MS + Math.floor(Math.random() * 500));
      }
    }
  }

  // #237 (2026-04-28): build-style TODO executor. Bypasses the
  // hunks-emit pipeline (executeWorkerTodo / executeWorkerTodo)
  // entirely. Flow: allowlist-check the command → prompt swarm-builder
  // agent to run it via opencode bash → check working tree for changes
  // → git add+commit if dirty → mark committed; else mark stale.
  // Defense-in-depth: buildCommandAllowlist enforces a binary
  // allowlist + forbids shell metacharacters; opencode bash sandbox
  // is the second safety layer.
  private async executeBuildTodo(
    agent: Agent,
    todo: Todo,
  ): Promise<"committed" | "stale" | "lost-race" | "aborted"> {
    if (!todo.command || todo.command.trim().length === 0) {
      this.appendSystem(`[${agent.id}] build TODO ${todo.id.slice(0, 8)} has no command — marking stale.`);
      this.failTodoQ(todo.id, "build TODO missing command field");
      return "stale";
    }
    // Allowlist check BEFORE any model call. Refused commands never
    // reach the agent.
    const check = checkBuildCommand(todo.command);
    if (!check.ok) {
      this.appendSystem(
        `[${agent.id}] build TODO ${todo.id.slice(0, 8)} command refused by allowlist: ${check.reason}`,
      );
      this.failTodoQ(todo.id, `build command not allowed: ${check.reason}`);
      return "stale";
    }
    this.appendSystem(
      `[${agent.id}] running build command for todo ${todo.id.slice(0, 8)}: \`${todo.command}\` (binary: ${check.binary})`,
    );

    // Capture pre-state of git status so we can detect what changed.
    const clonePath = this.active?.localPath;
    if (!clonePath) {
      this.failTodoQ(todo.id, "no localPath — runner state corrupt");
      return "stale";
    }

    // Prompt the agent. The model must invoke the bash tool with the
    // exact command we whitelisted (we tell it the command verbatim).
    const buildPrompt = [
      "You are a build worker. Your job is to run ONE shell command via the bash tool.",
      "",
      `Command to run: ${todo.command}`,
      `Working directory: ${clonePath}`,
      "",
      "Steps:",
      "1. Invoke the bash tool with the EXACT command above. Do not modify, prefix, or chain.",
      "2. After the command completes, respond with this JSON envelope and NOTHING ELSE:",
      `   {"ok": true|false, "exitCode": <number>, "summary": "<one-line summary of what changed>"}`,
      "",
      "If the command exits non-zero, set ok=false. Do not edit files manually — bash side effects are the entire delivery mechanism.",
    ].join("\n");

    let response: string;
    try {
      response = await this.promptAgent(agent, buildPrompt, "swarm-builder", "json", "json");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.appendSystem(`[${agent.id}] build prompt failed: ${msg.slice(0, 120)}`);
      this.failTodoQ(todo.id, `build prompt failed: ${msg.slice(0, 200)}`);
      return "stale";
    }
    this.appendAgent(agent, response);

    // Check working tree for changes via git status.
    const dirty = await this.opts.repos.gitStatus(clonePath);
    if (!dirty.changedFiles || dirty.changedFiles === 0) {
      this.appendSystem(
        `[${agent.id}] build command ran but working tree is clean — marking todo stale.`,
      );
      this.failTodoQ(todo.id, "build command produced no file changes");
      return "stale";
    }

    // Commit. simpleGit add+commit reusing existing helper.
    try {
      await this.opts.repos.commitAll(clonePath, `build: ${todo.description.slice(0, 80)}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.appendSystem(`[${agent.id}] git commit failed: ${msg.slice(0, 120)}`);
      this.failTodoQ(todo.id, `git commit failed: ${msg.slice(0, 200)}`);
      return "stale";
    }

    // Note: build TODOs don't go through Board.commitTodo's CAS check
    // because there's no per-file hash baseline. Mark committed
    // directly so the board state stays consistent.
    this.completeTodoQ(todo.id);
    this.appendSystem(
      `[${agent.id}] ✓ build commit landed for todo ${todo.id.slice(0, 8)} (${dirty.changedFiles} file change(s))`,
    );
    return "committed";
  }

  // The hunks worker pipeline. After V2 cutover Phase 2c (2026-04-28)
  // this is the only hunks pipeline — the V1 CAS-based pipeline was
  // deleted with its env-gated A/B flag. Apply via applyAndCommit;
  // search-anchor matching catches sibling-worker conflicts at apply
  // time. Method name keeps the V2 suffix until Phase 2g rename so
  // anyone reading the diff can see V1 truly went away.
  private async executeWorkerTodo(
    agent: Agent,
    todo: Todo,
  ): Promise<"committed" | "stale" | "lost-race" | "aborted"> {
    // V2 cutover Phase 2c (2026-04-28): the explicit claimTodo step is
    // gone — the dequeueTodoQ in runWorker already transitioned this
    // todo to in-progress atomically. If a worker crashes mid-prompt,
    // the reaper (startQueueReaper) sweeps in-progress todos older
    // than IN_PROGRESS_TTL_MS and routes them through replan.

    let contents: Record<string, string | null>;
    try {
      contents = await this.readExpectedFiles(todo.expectedFiles);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.failTodoQ(todo.id, `[v2] read failure: ${msg}`);
      return "stale";
    }

    const seed: WorkerSeed = {
      todoId: todo.id,
      description: todo.description,
      expectedFiles: todo.expectedFiles,
      fileContents: contents,
      expectedAnchors: todo.expectedAnchors,
      roleGuidance: this.workerRoles.get(agent.id),
    };

    let response: string;
    try {
      response = await this.promptAgent(agent, `${WORKER_SYSTEM_PROMPT}\n\n${buildWorkerUserPrompt(seed)}`);
    } catch (err) {
      if (this.stopping) return "aborted";
      const msg = err instanceof Error ? err.message : String(err);
      this.failTodoQ(todo.id, `[v2] worker prompt failed: ${msg}`);
      bumpAgentCounter(this.promptErrorsPerAgent, agent.id);
      bumpAgentCounter(this.rejectedAttemptsPerAgent, agent.id);
      return "stale";
    }
    if (this.stopping) return "aborted";
    this.appendAgent(agent, response);

    let parsed = parseWorkerResponse(response, todo.expectedFiles);
    if (!parsed.ok) {
      bumpAgentCounter(this.jsonRepairsPerAgent, agent.id);
      this.appendSystem(`[${agent.id}] [v2] worker JSON invalid (${parsed.reason}); issuing repair prompt.`);
      let repair: string;
      try {
        repair = await this.promptAgent(
          agent,
          `${WORKER_SYSTEM_PROMPT}\n\n${buildWorkerRepairPrompt(response, parsed.reason)}`,
        );
      } catch (err) {
        if (this.stopping) return "aborted";
        const msg = err instanceof Error ? err.message : String(err);
        this.failTodoQ(todo.id, `[v2] worker repair prompt failed: ${msg}`);
        bumpAgentCounter(this.promptErrorsPerAgent, agent.id);
        bumpAgentCounter(this.rejectedAttemptsPerAgent, agent.id);
        return "stale";
      }
      if (this.stopping) return "aborted";
      this.appendAgent(agent, repair);
      parsed = parseWorkerResponse(repair, todo.expectedFiles);
      if (!parsed.ok) {
        this.failTodoQ(todo.id, `[v2] worker produced invalid JSON after repair: ${parsed.reason}`);
        bumpAgentCounter(this.rejectedAttemptsPerAgent, agent.id);
        return "stale";
      }
    }

    if (parsed.skip) {
      this.appendSystem(`[${agent.id}] [v2] worker declined todo: ${parsed.skip}`);
      this.failTodoQ(todo.id, `[v2] worker declined: ${parsed.skip}`);
      bumpAgentCounter(this.rejectedAttemptsPerAgent, agent.id);
      return "stale";
    }

    if (parsed.hunks.length === 0) {
      this.failTodoQ(todo.id, "[v2] worker returned empty hunks with no skip reason");
      bumpAgentCounter(this.rejectedAttemptsPerAgent, agent.id);
      return "stale";
    }

    // V2 path: apply + git commit via the substrate. No CAS hash check —
    // applyHunks anchor failure catches sibling-worker conflicts.
    const fsAdapter = realFilesystemAdapter(this.active!.localPath);
    const gitAdapter = realGitAdapter(this.active!.localPath);
    const applyResult = await applyAndCommit({
      todoId: todo.id,
      workerId: agent.id,
      expectedFiles: todo.expectedFiles,
      hunks: parsed.hunks,
      fs: fsAdapter,
      git: gitAdapter,
    });
    if (!applyResult.ok) {
      this.failTodoQ(todo.id, `[v2] applyAndCommit failed: ${applyResult.reason}`);
      bumpAgentCounter(this.rejectedAttemptsPerAgent, agent.id);
      return "stale";
    }

    // V2 cutover Phase 2c (2026-04-28): commit transitions the V2 queue
    // entry. completeTodoQ also fires the v2Observer's todo-committed
    // event so the reducer transitions executing→auditing on drain.
    // If the reaper transitioned this todo to failed mid-prompt
    // (worker timeout), complete() throws — caught here as lost-race.
    try {
      this.completeTodoQ(todo.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.appendSystem(`[${agent.id}] commit lost race (todo reaped): ${msg}`);
      return "lost-race";
    }
    bumpAgentCounter(this.commitsPerAgent, agent.id);
    this.linesAddedPerAgent.set(
      agent.id,
      (this.linesAddedPerAgent.get(agent.id) ?? 0) + applyResult.linesAdded,
    );
    this.linesRemovedPerAgent.set(
      agent.id,
      (this.linesRemovedPerAgent.get(agent.id) ?? 0) + applyResult.linesRemoved,
    );
    return "committed";
  }

  // ---------------------------------------------------------------------
  // Phase 6 — replan orchestration
  //
  // Replan-enqueue used to flow through onBoardEvent (Board emitted
  // todo_stale → enqueueReplan). After V2 cutover Phase 2c, each
  // mutation wrapper (failTodoQ in particular) calls enqueueReplan
  // directly — onBoardEvent + mirrorToV2Queue + their event listener
  // are gone with V1 Board.
  // ---------------------------------------------------------------------

  private enqueueReplan(todoId: string): void {
    if (this.replanPending.has(todoId)) return;
    this.replanPending.add(todoId);
    void this.processReplanQueue();
  }

  private async processReplanQueue(): Promise<void> {
    // One-at-a-time: the planner is a single agent with one session, so
    // parallel replans would interleave prompts on the same session.
    if (this.replanRunning) return;
    if (!this.planner) return;
    this.replanRunning = true;
    try {
      while (!this.stopping && this.replanPending.size > 0 && this.planner) {
        // Task #116: cap-check at each replan iteration so a long
        // queue of replans can't drag the run past wall-clock.
        if (this.checkAndApplyCaps()) return;
        const todoId = this.replanPending.values().next().value as string;
        this.replanPending.delete(todoId);
        try {
          await this.replanOne(todoId);
        } catch (err) {
          // If replanOne crashes mid-prompt, don't kill the whole queue — but
          // also don't leave the todo hanging. The fallback tick would re-
          // enqueue a still-stale todo forever, which then prevents workers
          // from ever exiting (see shutdown-race fix). Mark it skipped so it
          // leaves in-flight state cleanly.
          const msg = err instanceof Error ? err.message : String(err);
          this.appendSystem(`Replan handler crashed on todo ${todoId}: ${msg}`);
          try {
            this.skipTodoQ(todoId, `replanner crashed: ${msg}`);
          } catch {
            // skip can throw if the todo moved state meanwhile — ignore.
          }
        }
      }
    } finally {
      this.replanRunning = false;
    }
  }

  private async replanOne(todoId: string): Promise<void> {
    const planner = this.planner;
    if (!planner) return;
    const todo = this.boardListTodos().find((t) => t.id === todoId);
    if (!todo) return;
    // Dedup: the same todo could be enqueued twice. Only act if still stale.
    if (todo.status !== "stale") return;

    if (todo.replanCount >= MAX_REPLAN_ATTEMPTS) {
      this.skipTodoQ(
        todoId,
        `auto-skipped: replan attempts exhausted (${todo.replanCount})`,
      );
      this.appendSystem(
        `Replan exhausted for todo ${todoId} after ${todo.replanCount} attempt(s). Skipped.`,
      );
      return;
    }

    let contents: Record<string, string | null>;
    try {
      contents = await this.readExpectedFiles(todo.expectedFiles);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.skipTodoQ(todoId, `replanner unable to read files: ${msg}`);
      return;
    }

    const seed: ReplannerSeed = {
      todoId: todo.id,
      originalDescription: todo.description,
      originalExpectedFiles: todo.expectedFiles,
      staleReason: todo.staleReason ?? "(unknown)",
      fileContents: contents,
      replanCount: todo.replanCount,
    };

    let response: string;
    let replanAgent: Agent;
    try {
      // Unit 24: planner fallback (see promptPlannerSafely comment).
      const r = await this.promptPlannerSafely(
        planner,
        `${REPLANNER_SYSTEM_PROMPT}\n\n${buildReplannerUserPrompt(seed)}`,
      );
      response = r.response;
      replanAgent = r.agentUsed;
    } catch (err) {
      if (this.stopping) return;
      const msg = err instanceof Error ? err.message : String(err);
      this.skipTodoQ(todoId, `replanner prompt failed: ${msg}`);
      return;
    }
    if (this.stopping) return;
    this.appendAgent(replanAgent, response);

    let parsed = parseReplannerResponse(response);
    if (!parsed.ok) {
      this.appendSystem(
        `Replanner JSON invalid for ${todoId} (${parsed.reason}); issuing repair prompt.`,
      );
      let repair: string;
      let repairAgent: Agent;
      try {
        const r = await this.promptPlannerSafely(
          replanAgent,
          `${REPLANNER_SYSTEM_PROMPT}\n\n${buildReplannerRepairPrompt(response, parsed.reason)}`,
        );
        repair = r.response;
        repairAgent = r.agentUsed;
      } catch (err) {
        if (this.stopping) return;
        const msg = err instanceof Error ? err.message : String(err);
        this.skipTodoQ(todoId, `replanner repair prompt failed: ${msg}`);
        return;
      }
      if (this.stopping) return;
      this.appendAgent(repairAgent, repair);
      parsed = parseReplannerResponse(repair);
      if (!parsed.ok) {
        this.skipTodoQ(
          todoId,
          `replanner produced invalid JSON after repair: ${parsed.reason}`,
        );
        return;
      }
    }

    if (parsed.action === "skip") {
      this.skipTodoQ(todoId, `replanner decided to skip: ${parsed.reason}`);
      this.appendSystem(`Replanner skipped todo ${todoId}: ${parsed.reason}`);
      return;
    }

    // V2 cutover Phase 2c (2026-04-28): replan via V2 queue's reset
    // (with optional updates). The replanner produces revisions for
    // description/files/anchors/kind/command; reset applies them
    // and transitions failed → pending atomically.
    try {
      this.resetTodoQ(todoId, {
        description: parsed.description,
        expectedFiles: parsed.expectedFiles,
        // Unit 44b: anchor revision is optional. undefined → keep prior
        // anchors; explicit array → replace them.
        expectedAnchors: parsed.expectedAnchors,
        // #241 (2026-04-28): replanner can switch a todo's kind.
        ...(parsed.kind ? { kind: parsed.kind } : {}),
        ...(parsed.command ? { command: parsed.command } : {}),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.appendSystem(`Replan refused for todo ${todoId}: ${msg}`);
      return;
    }
    const updated = this.boardGetTodo(todoId);
    this.appendSystem(
      `Replanned todo ${todoId} (attempt ${updated?.replanCount ?? 0}): "${truncate(updated?.description ?? parsed.description)}"`,
    );
  }

  private startReplanWatcher(): void {
    if (this.replanTickTimer) return;
    this.replanTickTimer = setInterval(() => {
      if (this.stopping) return;
      // Task #199: board.skip / enqueueReplan can throw on a corrupted
      // board state. Without try/catch the rejection silently kills the
      // replan loop AND fires every 20s as an unhandled rejection.
      try {
        for (const todo of this.boardListTodos()) {
          if (todo.status === "stale" && todo.replanCount < MAX_REPLAN_ATTEMPTS) {
            this.enqueueReplan(todo.id);
          }
        }
        // Also sweep exhausted stales into skipped right away — otherwise
        // workers would keep looping (counts.stale>0) waiting for them.
        for (const todo of this.boardListTodos()) {
          if (todo.status === "stale" && todo.replanCount >= MAX_REPLAN_ATTEMPTS) {
            this.skipTodoQ(
              todo.id,
              `auto-skipped: replan attempts exhausted (${todo.replanCount})`,
            );
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.appendSystem(`Replan tick failed: ${msg}`);
      }
    }, REPLAN_FALLBACK_TICK_MS);
    this.replanTickTimer.unref?.();
  }

  private stopReplanWatcher(): void {
    if (this.replanTickTimer) clearInterval(this.replanTickTimer);
    this.replanTickTimer = undefined;
    this.replanPending.clear();
    this.planner = undefined;
    // Unit 58: forget the auditor handle on stop too. AgentManager's
    // killAll has already terminated the underlying opencode process;
    // the field itself just shouldn't keep referencing a dead agent.
    this.auditor = undefined;
  }

  // ---------------------------------------------------------------------
  // Phase 7 — hard caps
  //
  // Called from each worker loop iteration. If any cap trips, sets
  // terminationReason, flips stopping=true so all workers exit their
  // `while (!this.stopping)` guard, and aborts in-flight prompts so a
  // worker mid-prompt doesn't sit for the full ABSOLUTE_MAX_MS watchdog.
  //
  // Idempotent: if terminationReason is already set (a peer worker beat us
  // to it) we just return true without double-logging or double-aborting.
  // Also returns true unconditionally once stopping is set — any non-cap
  // path that flipped stopping (user stop, shutdown race) wants workers
  // to exit too, so short-circuit here keeps the call site simple.
  // ---------------------------------------------------------------------

  // Cap probe that does NOT flip `stopping` / `terminationReason` (which
  // checkAndApplyCaps does as a side effect). Used by the post-audit
  // reflection-pass gate so we honor the cap by skipping bonus passes
  // instead of trying to halt an already-finished audit loop.
  // Advances the tick accumulator so a long gap since the last
  // checkAndApplyCaps doesn't undercount the cap.
  // Issue C-min (2026-04-27): UI-status helper for code paths that
  // bypass promptAgent (goal-gen pre-pass, all 3 reflection passes).
  // Those paths use planner.client.session.prompt(...) directly +
  // never call manager.markStatus, so the UI shows the planner as
  // "ready" while it's actually mid-prompt. Calling this from the
  // bypass paths' onStatusChange callback restores truthful UI signal.
  private markPlannerStatus(planner: Agent, status: "thinking" | "ready"): void {
    this.opts.manager.markStatus(planner.id, status);
    this.emitAgentState({
      id: planner.id,
      index: planner.index,
      port: planner.port,
      sessionId: planner.sessionId,
      status,
      ...(status === "thinking" ? { thinkingSince: Date.now() } : { lastMessageAt: Date.now() }),
    });
  }

  private isOverWallClockCap(): boolean {
    if (this.tickAccumulator === undefined) return false;
    const cap = this.active?.wallClockCapMs ?? WALL_CLOCK_CAP_MS;
    const { next } = advanceTickAccumulator(this.tickAccumulator, Date.now());
    this.tickAccumulator = next;
    return next.activeElapsedMs >= cap;
  }

  private checkAndApplyCaps(): boolean {
    if (this.stopping) return true;
    if (this.runStartedAt === undefined || this.tickAccumulator === undefined) {
      return false;
    }
    // Task #165: pause-on-quota. If we're already paused, skip the
    // tick accumulator advance entirely so wall-clock budget doesn't
    // burn during pause. The pause-cap (2h max paused total) is
    // checked inside runPauseProbe; here we just no-op cleanly so
    // worker / planner / replan loops keep ticking without acting.
    if (this.paused) return false;
    // Unit 27: advance the tick accumulator with host-sleep clamping,
    // then hand the active elapsed to checkCaps via `startedAt: 0`
    // semantics. `Date.now()` is still fine as the "now" SOURCE — it's
    // only the DELTA between consecutive ticks that we clamp. Wall
    // time → accumulator advance per tick, bounded by
    // MAX_REASONABLE_TICK_DELTA_MS so an 8-hour laptop sleep no longer
    // silently burns the cap.
    const now = Date.now();
    const { next, jumpMs } = advanceTickAccumulator(this.tickAccumulator, now);
    this.tickAccumulator = next;
    // Only surface jumps >1 min as "host sleep?" to avoid noise from
    // legitimate multi-minute gaps (e.g. a worker blocked on a cold-
    // start retry sequence while no other worker has ticked). Anything
    // smaller gets clamped silently.
    if (jumpMs > 60_000) {
      const skippedMin = Math.round(jumpMs / 60_000);
      this.appendSystem(
        `Clock jump detected: ~${skippedMin} min skipped from cap math (host sleep?).`,
      );
    }
    const reason = checkCaps({
      startedAt: 0,
      now: this.tickAccumulator.activeElapsedMs,
      committed: this.boardCounts().committed,
      totalTodos: this.boardListTodos().length,
      // Unit 43: thread the per-run override through. Undefined when
      // the user didn't set it — checkCaps falls back to the baked-in
      // 8-h default in that case.
      wallClockCapMs: this.active?.wallClockCapMs,
    });
    // Task #124: token-budget cap check. Independent of the wall-
    // clock/commits/todos caps. Returns its own reason string so the
    // run-summary distinguishes "budget hit" from other cap-trips.
    const tokenReason = (
      this.tokenBaselineForRun !== undefined &&
      tokenBudgetExceeded(this.tokenBaselineForRun, this.active?.tokenBudget)
    )
      ? `token-budget reached (${this.active?.tokenBudget?.toLocaleString()} tokens)`
      : null;
    // Task #165 (was #137-halt): quota-exhausted check. Was an
    // immediate halt; now triggers enterPause() which suspends new
    // prompts + probes upstream every 5 min. Persistent walls that
    // never clear escalate to a permanent halt after MAX_PAUSE_TOTAL_MS
    // (handled inside runPauseProbe); transient walls don't reach
    // here at all (shouldHaltOnQuota returns false for them).
    if (this.tokenBaselineForRun !== undefined && shouldHaltOnQuota()) {
      const quotaState = tokenTracker.getQuotaState();
      this.enterPause(quotaState);
      return false;
    }
    const finalReason = reason ?? tokenReason;
    if (!finalReason) return false;
    this.terminationReason = finalReason;
    this.appendSystem(`Stopping: ${finalReason}`);
    this.stopping = true;
    for (const ctrl of this.activeAborts) {
      try {
        ctrl.abort(new Error(`cap: ${finalReason}`));
      } catch {
        // best-effort; AbortController.abort throws on already-aborted in
        // some runtimes.
      }
    }
    return true;
  }

  // Task #165: enter a paused state on persistent Ollama-quota wall.
  // Suspends new prompt traffic (workers idle, planner idles between
  // turns) and aborts in-flight prompts so they don't keep hammering
  // a wall the proxy will keep rejecting. The 5-min probe timer is
  // armed here and self-reschedules until upstream clears or the 2h
  // pause cap escalates to a permanent halt.
  private enterPause(quotaState: { statusCode: number; reason: string } | null): void {
    if (this.paused) return;
    this.paused = true;
    this.pauseStartedAt = Date.now();
    // V2 Step 3b: feed pause event (orthogonal in V2 model).
    this.v2Observer.apply({
      type: "pause-on-quota",
      ts: this.pauseStartedAt,
      reason: quotaState
        ? `${quotaState.statusCode}: ${quotaState.reason.slice(0, 60)}`
        : "(no quota detail)",
    });
    this.setPhase("paused");
    const detail = quotaState
      ? `${quotaState.statusCode}: ${quotaState.reason.slice(0, 120)}`
      : "(no quota detail)";
    this.appendSystem(
      `Ollama quota wall hit (${detail}). Pausing run; will probe upstream every ${PAUSE_PROBE_INTERVAL_MS / 60_000} min and resume when it clears. Total pause cap: ${MAX_PAUSE_TOTAL_MS / 60_000} min.`,
      { kind: "quota_paused", statusCode: quotaState?.statusCode, reason: quotaState?.reason },
    );
    // Abort in-flight prompts so they fail fast — they'd hit the wall
    // and burn time anyway. Workers will see this.paused and idle.
    for (const ctrl of this.activeAborts) {
      try {
        ctrl.abort(new Error("paused: quota wall"));
      } catch {
        // best-effort
      }
    }
    this.schedulePauseProbe();
  }

  private schedulePauseProbe(): void {
    if (this.pauseProbeTimer) return;
    this.pauseProbeTimer = setTimeout(() => {
      this.pauseProbeTimer = undefined;
      // Task #199: if runPauseProbe throws (e.g., planner agent gone),
      // pause becomes permanent because nothing reschedules. Reschedule
      // on failure so the user's run can recover when the wall clears.
      this.runPauseProbe().catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.appendSystem(`Pause probe failed: ${msg}. Will retry.`);
        if (this.paused && !this.stopping) this.schedulePauseProbe();
      });
    }, PAUSE_PROBE_INTERVAL_MS);
  }

  // Task #165: pings the planner with a tiny prompt to test whether
  // the upstream wall has cleared. Cheap (~10 tokens). On success
  // (no thrown error AND quota state didn't re-flip), clears the
  // proxy quota state and resumes the run. On failure, reschedules
  // the next probe — UNLESS the total accumulated pause has crossed
  // MAX_PAUSE_TOTAL_MS, at which point we escalate to a permanent
  // halt with stopReason cap:quota.
  private async runPauseProbe(): Promise<void> {
    if (!this.paused || this.stopping) return;
    const totalSoFar = this.totalPausedMs + (this.pauseStartedAt ? Date.now() - this.pauseStartedAt : 0);
    if (totalSoFar >= MAX_PAUSE_TOTAL_MS) {
      // Escalate to permanent halt. Roll up totalPausedMs first so
      // the run summary reflects the full pause time.
      this.totalPausedMs = totalSoFar;
      this.pauseStartedAt = undefined;
      this.paused = false;
      const q = tokenTracker.getQuotaState();
      const detail = q ? `${q.statusCode}: ${q.reason.slice(0, 120)}` : "(no detail)";
      const reason = `ollama-quota-exhausted (${detail}) — pause cap exceeded after ${Math.round(totalSoFar / 60_000)} min`;
      this.terminationReason = reason;
      this.appendSystem(
        `Pause cap of ${MAX_PAUSE_TOTAL_MS / 60_000} min exceeded; upstream wall never cleared. Stopping permanently.`,
      );
      this.stopping = true;
      for (const ctrl of this.activeAborts) {
        try { ctrl.abort(new Error("paused: cap exceeded")); } catch { /* */ }
      }
      return;
    }
    const planner = this.opts.manager.list().find((a) => a.index === 1);
    if (!planner) {
      // No planner — odd state. Reschedule and try again.
      this.schedulePauseProbe();
      return;
    }
    let probeOk = false;
    try {
      const created = await planner.client.session.create({
        title: `quota-probe-${Date.now()}`,
      });
      const any = created as { data?: { id?: string; info?: { id?: string } }; id?: string };
      const sid = any?.data?.id ?? any?.data?.info?.id ?? any?.id;
      if (!sid) throw new Error("session.create returned no session id");
      await planner.client.session.prompt({
        sessionID: sid,
        agent: "swarm-read",
        model: { providerID: "ollama", modelID: planner.model },
        parts: [{ type: "text", text: "ping" }],
      });
      probeOk = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.appendSystem(`[quota-probe] still walled (${msg.slice(0, 120)}). Next probe in ${PAUSE_PROBE_INTERVAL_MS / 60_000} min.`);
    }
    if (!this.paused || this.stopping) return;
    if (probeOk && !shouldHaltOnQuota()) {
      // Real recovery: clear proxy state + resume.
      tokenTracker.clearQuotaState();
      this.exitPause();
      return;
    }
    if (probeOk && shouldHaltOnQuota()) {
      // Probe succeeded but proxy still flagged — rare race; another
      // request hit a fresh 429 between our probe + this check.
      // Treat as still-walled.
      this.appendSystem("[quota-probe] probe succeeded but proxy re-flagged quota mid-flight; staying paused.");
    }
    this.schedulePauseProbe();
  }

  private exitPause(): void {
    if (!this.paused) return;
    const pauseDur = this.pauseStartedAt ? Date.now() - this.pauseStartedAt : 0;
    this.totalPausedMs += pauseDur;
    this.pauseStartedAt = undefined;
    this.paused = false;
    if (this.pauseProbeTimer) {
      clearTimeout(this.pauseProbeTimer);
      this.pauseProbeTimer = undefined;
    }
    // Reset the tick accumulator's lastTickAt so the next advance
    // doesn't accidentally count the pause window — the clamp would
    // catch most of it but a pause < MAX_REASONABLE_TICK_DELTA_MS
    // would still leak through.
    if (this.tickAccumulator) {
      this.tickAccumulator = { ...this.tickAccumulator, lastTickAt: Date.now() };
    }
    // V2 Step 3b: clear pausedReason on the parallel reducer.
    this.v2Observer.apply({ type: "resume-from-quota", ts: Date.now() });
    this.setPhase("executing");
    this.appendSystem(
      `Quota wall cleared after ${Math.round(pauseDur / 60_000)} min. Resuming run (total paused this run: ${Math.round(this.totalPausedMs / 60_000)} min).`,
      { kind: "quota_resumed", pausedMs: pauseDur, totalPausedMs: this.totalPausedMs },
    );
  }

  // Phase 7 Step B: write a post-mortem blob at the clone root so a crashed
  // run leaves behind enough state to diagnose what happened. Writes via
  // writeFileAtomic so a crash *during* the snapshot write doesn't leave a
  // half-written JSON. Swallows its own errors — if we can't write the
  // snapshot, we log the failure to the transcript (which still broadcasts
  // over WS) and move on. Losing the snapshot is better than turning a
  // normal run failure into a recursive crash.
  // Phase 9: run summary artifact. Builds a RunSummary, writes it to
  // `<clone>/summary.json`, and broadcasts `run_summary` so the UI can
  // render without re-reading the file. Swallows its own errors like
  // writeCrashSnapshot — a missing summary is an annoyance, not worth
  // escalating into a run failure.
  private async writeRunSummary(crashMessage: string | undefined): Promise<void> {
    const cfg = this.active;
    if (!cfg) return;
    if (this.runBootedAt === undefined) return;

    const clone = cfg.localPath;
    let gitStatus = { porcelain: "", changedFiles: 0 };
    try {
      gitStatus = await this.opts.repos.gitStatus(clone);
    } catch {
      // gitStatus already swallows, but belt-and-braces.
    }

    // Unit 31: extracted to buildPerAgentStats so the state snapshot and
    // summary stay in sync on agent-row shape.
    const agentStats: PerAgentStat[] = this.buildPerAgentStats();

    const counts = this.boardCounts();
    const summary = buildSummary({
      config: {
        repoUrl: cfg.repoUrl,
        localPath: cfg.localPath,
        preset: cfg.preset,
        model: cfg.model,
        runId: cfg.runId,
      },
      agentCount: cfg.agentCount,
      rounds: cfg.rounds,
      startedAt: this.runBootedAt,
      endedAt: Date.now(),
      crashMessage,
      terminationReason: this.terminationReason,
      stopping: this.stopping,
      completionDetail: this.completionDetail,
      board: {
        committed: counts.committed,
        skipped: counts.skipped,
        total: counts.total,
      },
      staleEvents: this.staleEventCount,
      filesChanged: gitStatus.changedFiles,
      finalGitStatus: gitStatus.porcelain,
      agents: agentStats,
      contract: this.contract ? this.cloneContract(this.contract) : undefined,
      // Unit 34: ambition-ratchet output. Passed through unconditionally
      // when a tier was ever installed; `undefined` on the pre-contract
      // drain-exit path (which never even reached tier 1).
      maxTierReached: this.currentTier > 0 ? this.currentTier : undefined,
      tiersCompleted: this.currentTier > 0 ? this.tiersCompleted : undefined,
      tierHistory: this.tierHistory.length > 0 ? this.tierHistory.slice() : undefined,
      // Task #65: persist transcript so the modal + review view can replay.
      transcript: this.transcript,
      // V2 reducer snapshot at run end. After cutover Phase 1a
      // (2026-04-28), divergence tracking is gone; the field captures
      // the reducer's final phase + pause state for forward compat.
      v2State: {
        phase: this.v2Observer.getState().phase,
        enteredAt: this.v2Observer.getState().enteredAt,
        detail: this.v2Observer.getState().detail,
        pausedReason: this.v2Observer.getState().pausedReason,
      },
      // V2 TodoQueue snapshot at run end. After cutover Phase 1a,
      // divergence vs V1 Board is no longer recorded — counts only.
      v2QueueState: {
        counts: this.todoQueue.counts(),
      },
      // Phase 4a of #243: topology passthrough.
      topology: cfg.topology,
    });

    // Unit 49: dual write — per-run timestamped file (never overwrites
    // a prior run's summary) + summary.json "latest" pointer. Mirrors
    // the runSummary.ts helper used by the discussion presets so the
    // on-disk shape is identical across all 7 runners.
    const json = JSON.stringify(summary, null, 2);
    const perRunPath = path.join(clone, buildPerRunSummaryFileName(summary.startedAt));
    const latestPath = path.join(clone, "summary.json");
    try {
      await writeFileAtomic(perRunPath, json);
      await writeFileAtomic(latestPath, json);
      // Task #68: rich end-of-run banner with per-agent rollup,
      // posted before the file-write line so the most informative
      // content lands first.
      this.appendSystem(formatRunFinishedBanner(summary), buildRunFinishedSummary(summary));
      this.appendSystem(
        `Wrote run summary to ${perRunPath} + ${latestPath} (stopReason=${summary.stopReason}, commits=${summary.commits}, files=${summary.filesChanged}).`,
      );
    } catch (writeErr) {
      const msg = writeErr instanceof Error ? writeErr.message : String(writeErr);
      this.appendSystem(`Failed to write run summary (${msg})`);
    }
    // Stash before the broadcast so a client that connects between emit and
    // the next status() call still gets the summary via the WS catch-up.
    this.lastSummary = summary;
    // Broadcast regardless of write success so the UI still gets the card.
    this.opts.emit({ type: "run_summary", summary });
  }

  private async writeCrashSnapshot(err: unknown): Promise<void> {
    const clone = this.active?.localPath;
    if (!clone) {
      this.appendSystem("Could not write crash snapshot: no clone path set.");
      return;
    }
    const snapshot = buildCrashSnapshot({
      error: err,
      phase: this.phase,
      runStartedAt: this.runStartedAt,
      crashedAt: Date.now(),
      config: this.active,
      board: this.boardSnapshot(),
      transcript: this.transcript,
    });
    const outPath = path.join(clone, "board-final.json");
    try {
      await writeFileAtomic(outPath, JSON.stringify(snapshot, null, 2));
      this.appendSystem(`Wrote crash snapshot to ${outPath}`);
    } catch (writeErr) {
      const msg = writeErr instanceof Error ? writeErr.message : String(writeErr);
      this.appendSystem(`Failed to write crash snapshot (${msg})`);
    }
  }

  // Unit 31: per-agent stats shaped for summary.json / state snapshot
  // consumption. Extracted so both writers produce identical agent rows
  // without drift; the summary writer and the state-snapshot scheduler
  // both call this.
  private buildPerAgentStats(): PerAgentStat[] {
    return this.agentRoster.map((a) => {
      const lats = this.latenciesPerAgent.get(a.id) ?? [];
      const stats = computeLatencyStats(lats);
      return {
        agentId: a.id,
        agentIndex: a.index,
        turnsTaken: this.turnsPerAgent.get(a.id) ?? 0,
        // Task #163: per-agent token deltas captured via promptWithRetry's
        // onTokens hook. Approximate for parallel paths (worker pool +
        // audit ensemble may overlap with planner/auditor). Null when
        // no tokens recorded for this agent.
        tokensIn: this.promptTokensPerAgent.has(a.id) ? this.promptTokensPerAgent.get(a.id)! : null,
        tokensOut: this.responseTokensPerAgent.has(a.id) ? this.responseTokensPerAgent.get(a.id)! : null,
        totalAttempts: this.attemptsPerAgent.get(a.id) ?? 0,
        totalRetries: this.retriesPerAgent.get(a.id) ?? 0,
        successfulAttempts: lats.length,
        meanLatencyMs: stats.mean,
        p50LatencyMs: stats.p50,
        p95LatencyMs: stats.p95,
        // Task #66: blackboard-only signals; default 0 since the runner
        // attributes commits to the agent that landed each diff. Stays
        // 0 for the planner / auditor when they don't produce diffs.
        commits: this.commitsPerAgent.get(a.id) ?? 0,
        linesAdded: this.linesAddedPerAgent.get(a.id) ?? 0,
        linesRemoved: this.linesRemovedPerAgent.get(a.id) ?? 0,
        // Task #67: rejected-work + recovery counters.
        rejectedAttempts: this.rejectedAttemptsPerAgent.get(a.id) ?? 0,
        jsonRepairs: this.jsonRepairsPerAgent.get(a.id) ?? 0,
        promptErrors: this.promptErrorsPerAgent.get(a.id) ?? 0,
      };
    });
  }

  // Unit 31: schedule a debounced state-snapshot write to
  // `<clone>/blackboard-state.json`. Trailing-edge: every call resets the
  // timer so only the LATEST state gets written. When a write is already
  // in flight, flip `stateWriteAgain` so the next write fires as soon as
  // the current one finishes — we never stop at stale data.
  //
  // Skips when the phase is `idle` or `cloning`: `idle` means there's no
  // run to persist, and writing during `cloning` would land a file in the
  // destination directory BEFORE simpleGit.clone runs, tripping
  // RepoService's "destination is not empty and is not a git repo"
  // guard and failing the clone. Cloning is short enough that the
  // post-mortem hole isn't meaningful.
  private scheduleStateWrite(): void {
    if (this.phase === "idle" || this.phase === "cloning") return;
    if (this.stateWriteInFlight) {
      this.stateWriteAgain = true;
      return;
    }
    if (this.stateWriteTimer) clearTimeout(this.stateWriteTimer);
    this.stateWriteTimer = setTimeout(() => {
      this.stateWriteTimer = undefined;
      void this.flushStateWrite();
    }, STATE_SNAPSHOT_DEBOUNCE_MS);
    // Let Node exit even if this timer is pending (it's best-effort state).
    this.stateWriteTimer.unref?.();
  }

  // Immediate write, no debounce. Used at run termination so the final
  // state lands on disk before we clear the in-memory one. Also used as
  // the body of the debounced path.
  private async flushStateWrite(): Promise<void> {
    const clone = this.active?.localPath;
    if (!clone) return; // No active run; nothing to persist.
    // Defensive: also skip at flush time in case the phase moved back to
    // `cloning` (shouldn't happen, but we never want to race the clone).
    if (this.phase === "idle" || this.phase === "cloning") return;
    if (this.stateWriteInFlight) {
      // Another write raced in; mark that we need a follow-up and bail.
      this.stateWriteAgain = true;
      return;
    }
    this.stateWriteInFlight = true;
    this.stateWriteAgain = false;
    try {
      const snapshot = buildStateSnapshot({
        writtenAt: Date.now(),
        phase: this.phase,
        round: this.round,
        runBootedAt: this.runBootedAt,
        runStartedAt: this.runStartedAt,
        activeElapsedMs: this.tickAccumulator?.activeElapsedMs,
        config: this.active,
        contract: this.contract ? this.cloneContract(this.contract) : undefined,
        board: this.boardSnapshot(),
        perAgent: this.buildPerAgentStats(),
        staleEventCount: this.staleEventCount,
        auditInvocations: this.auditInvocations,
        agentRoster: this.agentRoster.map((a) => ({
          agentId: a.id,
          agentIndex: a.index,
        })),
        terminationReason: this.terminationReason,
        completionDetail: this.completionDetail,
        // Unit 34: tier state. currentTier is 0 before the first contract
        // lands, 1+ after. tierHistory grows one entry per completed tier.
        currentTier: this.currentTier > 0 ? this.currentTier : undefined,
        tiersCompleted: this.tiersCompleted,
        tierHistory: this.tierHistory.length > 0 ? this.tierHistory.slice() : undefined,
      });
      const outPath = path.join(clone, "blackboard-state.json");
      await writeFileAtomic(outPath, JSON.stringify(snapshot, null, 2));
    } catch (err) {
      // Best-effort — a state write failure must never crash the run.
      // Log to the transcript so operators can see it happened, but
      // swallow otherwise.
      const msg = err instanceof Error ? err.message : String(err);
      console.error("blackboard-state write failed:", msg);
    } finally {
      this.stateWriteInFlight = false;
      // If another scheduling request came in during our write, honor it now.
      if (this.stateWriteAgain) {
        this.stateWriteAgain = false;
        this.scheduleStateWrite();
      }
    }
  }

  // ---------------------------------------------------------------------
  // File I/O helpers
  // ---------------------------------------------------------------------

  // V2 cutover Phase 2c (2026-04-28): hashExpectedFiles / hashFile /
  // writeDiff used only by V1 worker pipeline (CAS baseline + atomic
  // write). V2 path uses applyAndCommit which does its own read +
  // write via the realFilesystemAdapter. Helpers removed with the V1
  // pipeline.

  // ---------------------------------------------------------------------
  // V2 queue mutation wrappers (V2 cutover Phase 2c, 2026-04-28)
  //
  // Each wraps a TodoQueue mutation + emits the equivalent BoardEvent
  // through boardBroadcaster so the wire protocol (board_todo_*
  // SwarmEvents) stays unchanged for the UI. Findings + replan
  // bookkeeping happen inline. State writes are scheduled here so the
  // caller doesn't have to remember.
  // ---------------------------------------------------------------------

  /** Post a new todo. Returns the queue-assigned id. */
  private postTodoQ(input: PostTodoInput): string {
    const id = this.todoQueue.post(input);
    const wire = v2QueueTodoToWireTodo(this.todoQueue.get(id)!);
    this.boardBroadcaster.emit({ type: "todo_posted", todo: wire });
    this.scheduleStateWrite();
    return id;
  }

  /** Dequeue the next todo for a worker. Returns the V2 queued shape;
   *  callers that need V1 Todo shape can translate via the helper.
   *  Emits board_todo_claimed for wire compat — synthesizes a Claim
   *  from the worker id + dequeue timestamp. */
  private dequeueTodoQ(workerId: string, preferTag?: string): QueuedTodo | null {
    const t = this.todoQueue.dequeue(workerId, preferTag);
    if (!t) return null;
    const wire = v2QueueTodoToWireTodo(t);
    if (wire.claim) {
      this.boardBroadcaster.emit({ type: "todo_claimed", todoId: t.id, claim: wire.claim });
    }
    this.scheduleStateWrite();
    return t;
  }

  /** Mark an in-progress todo completed. Fires v2Observer's todo-
   *  committed event so the reducer can transition executing→auditing
   *  on drain. Emits board_todo_committed for wire compat. */
  private completeTodoQ(id: string): void {
    this.todoQueue.complete(id);
    this.boardBroadcaster.emit({ type: "todo_committed", todoId: id });
    this.scheduleStateWrite();
    this.v2Observer.apply({
      type: "todo-committed",
      ts: Date.now(),
      remainingTodos: this.todoQueue.counts().pending,
    });
  }

  /** Mark a todo failed (V1 vocabulary: "stale"). Routes through the
   *  replan queue so the planner gets a chance to revise it. Emits
   *  board_todo_stale for wire compat — replanCount comes from the
   *  V2 queue's retries counter. */
  private failTodoQ(id: string, reason: string): void {
    this.todoQueue.fail(id, reason);
    const t = this.todoQueue.get(id);
    this.boardBroadcaster.emit({
      type: "todo_stale",
      todoId: id,
      reason,
      replanCount: t?.retries ?? 0,
    });
    this.scheduleStateWrite();
    this.staleEventCount++;
    this.enqueueReplan(id);
  }

  /** Mark a todo skipped (worker declined / replanner gave up).
   *  Distinct from failed — no replan retry. Fires v2Observer's
   *  todo-skipped event for the executing→auditing drain transition. */
  private skipTodoQ(id: string, reason: string): void {
    this.todoQueue.skip(id, reason);
    this.boardBroadcaster.emit({ type: "todo_skipped", todoId: id, reason });
    this.scheduleStateWrite();
    this.v2Observer.apply({
      type: "todo-skipped",
      ts: Date.now(),
      remainingTodos: this.todoQueue.counts().pending,
    });
  }

  /** Reset a failed todo back to pending so workers can re-claim it.
   *  Emits board_todo_replanned for wire compat. updates is the
   *  optional revision the replanner produced (description / files /
   *  anchors / kind / command). */
  private resetTodoQ(
    id: string,
    updates?: {
      description?: string;
      expectedFiles?: readonly string[];
      expectedAnchors?: readonly string[];
      kind?: "hunks" | "build";
      command?: string;
    },
  ): void {
    this.todoQueue.reset(id, updates);
    const t = this.todoQueue.get(id);
    if (t) {
      this.boardBroadcaster.emit({
        type: "todo_replanned",
        todoId: id,
        description: t.description,
        expectedFiles: t.expectedFiles.slice(),
        replanCount: t.retries,
        // Audit fix (2026-04-28): forward anchor revisions when the
        // replanner produced them, matching the schema declared on
        // BoardEvent.todo_replanned (types.ts) and the wire variant
        // in web/src/types.ts. Snapshot also carries them, but the
        // per-event update lets the UI's applyReplan hook attach
        // them immediately instead of waiting for the next snapshot.
        ...(t.expectedAnchors && t.expectedAnchors.length > 0
          ? { expectedAnchors: t.expectedAnchors.slice() }
          : {}),
      });
    }
    this.scheduleStateWrite();
  }

  /** Append a finding (diagnostic note). Emits board_finding_posted
   *  for wire compat. */
  private postFindingQ(input: { agentId: string; text: string; createdAt: number }): void {
    const f = this.findings.post(input);
    this.boardBroadcaster.emit({ type: "finding_posted", finding: f });
    this.scheduleStateWrite();
  }

  // V2 cutover Phase 2c read helpers — translate V2 queue to V1 wire
  // shapes so the rest of BlackboardRunner (and downstream consumers
  // like summary writer + crashSnapshot) keep working unchanged.
  private boardCounts() {
    return v2QueueCountsToWireCounts(this.todoQueue.counts());
  }
  private boardListTodos() {
    return this.todoQueue.list().map(v2QueueTodoToWireTodo);
  }
  private boardSnapshot() {
    return buildWireSnapshot(this.todoQueue.list(), this.findings.list());
  }
  /** Lookup a single todo by id, returning the V1 wire shape. */
  private boardGetTodo(id: string) {
    const t = this.todoQueue.get(id);
    return t ? v2QueueTodoToWireTodo(t) : undefined;
  }

  private async readExpectedFiles(files: string[]): Promise<Record<string, string | null>> {
    const out: Record<string, string | null> = {};
    for (const f of files) {
      const abs = await this.resolveSafe(f);
      try {
        out[f] = await fs.readFile(abs, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          out[f] = null;
        } else {
          throw err;
        }
      }
    }
    return out;
  }

  private async resolveSafe(relPath: string): Promise<string> {
    const clone = this.active?.localPath;
    if (!clone) throw new Error("no active clone path");
    return resolveSafe(clone, relPath);
  }

  // ---------------------------------------------------------------------
  // Expiry watchdog
  // ---------------------------------------------------------------------

  // V2 cutover Phase 2c (2026-04-28): startClaimExpiry / stopClaimExpiry
  // removed — V1 Board.expireClaims has no callers now that V2 queue
  // is the source of truth. The reaper (startQueueReaper, immediately
  // below) is the sole TTL enforcer.

  // Periodic sweep of the V2 TodoQueue. Reaps in-progress todos older
  // than IN_PROGRESS_TTL_MS (default 10 min) by transitioning them to
  // failed via reapStaleInProgress. Each reaped id is then:
  //   1. broadcast as board_todo_stale (UI sync)
  //   2. scheduleStateWrite (persist transition)
  //   3. enqueueReplan (planner decides retry vs skip)
  //
  // Audit fix (2026-04-28): the broadcast + persist were missing —
  // UI lagged the actual state by the snapshot debounce window.
  // The wrapper failTodoQ can't be reused here because the queue
  // already mutated to "failed" inside reapStaleInProgress; calling
  // failTodoQ would throw "Cannot fail todo: status=failed".
  private startQueueReaper(): void {
    if (this.reaperTimer) return;
    this.reaperTimer = setInterval(() => {
      const reaped = this.todoQueue.reapStaleInProgress(
        Date.now(),
        IN_PROGRESS_TTL_MS,
      );
      if (reaped.length === 0) return;
      this.appendSystem(
        `[v2-reaper] Reaped ${reaped.length} stale in-progress todo(s) past ${Math.round(IN_PROGRESS_TTL_MS / 60_000)}min TTL: ${reaped.join(", ")}`,
      );
      for (const id of reaped) {
        const t = this.todoQueue.get(id);
        const reason = t?.reason ?? `worker timeout (>${Math.round(IN_PROGRESS_TTL_MS / 60_000)}min in-progress)`;
        this.boardBroadcaster.emit({
          type: "todo_stale",
          todoId: id,
          reason,
          replanCount: t?.retries ?? 0,
        });
        this.staleEventCount++;
        this.enqueueReplan(id);
      }
      this.scheduleStateWrite();
    }, REAPER_INTERVAL_MS);
    this.reaperTimer.unref?.();
  }

  private stopQueueReaper(): void {
    if (this.reaperTimer) clearInterval(this.reaperTimer);
    this.reaperTimer = undefined;
  }

  // ---------------------------------------------------------------------
  // Prompting
  // ---------------------------------------------------------------------

  // Task #220: replaces Unit 24 fallback chain (#195/#190) with a
  // health-check + respawn approach. Why the change:
  //   - The old fallback chain re-routed planner prompts to a worker
  //     agent's session. Even with the model override (#195), the
  //     worker session has accumulated context from prior worker
  //     prompts — the planner's reasoning gets polluted.
  //   - The "primary chip reset to ready" (#190) was misleading when
  //     the primary's subprocess was actually dead — every subsequent
  //     planner call wastes one attempt on the dead primary, then
  //     fallback again, then chip resets to ready again. The UI looked
  //     like the agent was alive when it was a corpse.
  //
  // New behavior: before every planner-role call, ping the planner's
  // /api/health. If alive → proceed. If dead → respawn the subprocess
  // with the same identity (id, index, model) and a fresh session.
  // Then prompt. Identity preserved, no context pollution, no misleading
  // chip state. If respawn itself fails, the run ends cleanly with the
  // actual root cause surfaced.
  private async promptPlannerSafely(
    primaryAgent: Agent,
    promptText: string,
    // #231 (2026-04-27 evening): default flipped from "swarm-read" → "swarm".
    // Investigation showed glm-5.1 / nemotron-3-super / gemma4 don't emit
    // OpenAI-style structured tool_calls — they hallucinate XML markers
    // (<read path='X'>) which opencode never executes. The planner's
    // "tool inspection" was always a fiction; removing the tool grant
    // stops the hallucinations + the resulting JSON parse failures.
    // Discussion presets keep using swarm-read because they don't strict-
    // parse JSON envelopes; their prose tolerates the markers (and we now
    // strip + surface the markers via stripAgentText + ToolCallsBlock).
    // See runs_overnight/_INVESTIGATION-231-pseudo-tool-calls.md for
    // the full RCA.
    agentName: "swarm" | "swarm-read" | "swarm-builder" = "swarm",
    // #233: forward Ollama structured-output constraint for parser-
    // strict prompts. Pass "json" to constrain the decoder to valid
    // JSON; the model literally cannot emit XML markers when this is
    // set. Effective only on USE_OLLAMA_DIRECT path.
    ollamaFormat?: "json" | Record<string, unknown>,
  ): Promise<{ response: string; agentUsed: Agent }> {
    let agent = primaryAgent;
    // Pre-call health check. ~1s budget; cost negligible vs a planner prompt.
    // Catches "subprocess died before this call started".
    if (!(await this.opts.manager.pingAgentHealth(agent))) {
      agent = await this.respawnAndUpdatePlanner(agent);
    }
    // Try the prompt. If it fails with a transport-style error AND the
    // subprocess is now dead, this means the subprocess died MID-CALL —
    // respawn and retry once. If it fails for any other reason (model
    // returned bad JSON, format violation, etc.), propagate the error.
    try {
      const response = await this.promptAgent(agent, promptText, agentName, "json", ollamaFormat);
      return { response, agentUsed: agent };
    } catch (err) {
      if (this.stopping) throw err;
      const stillHealthy = await this.opts.manager.pingAgentHealth(agent);
      if (stillHealthy) {
        // Real failure (model bad output, etc.) — propagate.
        throw err;
      }
      // Subprocess died mid-call. Respawn and retry.
      const msg = err instanceof Error ? err.message : String(err);
      this.appendSystem(
        `[${agent.id}] subprocess died mid-call (${msg.slice(0, 80)}); respawning + retrying…`,
      );
      agent = await this.respawnAndUpdatePlanner(agent);
      // Retry once with the fresh subprocess.
      const response = await this.promptAgent(agent, promptText, agentName, "json", ollamaFormat);
      return { response, agentUsed: agent };
    }
  }

  // Task #220: respawn an agent's subprocess and update the runner's
  // planner reference if applicable. Returns the fresh Agent. Throws
  // with a clear message if respawn fails — the run can't continue
  // without a working planner subprocess.
  private async respawnAndUpdatePlanner(agent: Agent): Promise<Agent> {
    this.appendSystem(`[${agent.id}] subprocess unresponsive — respawning…`);
    let fresh: Agent;
    try {
      fresh = await this.opts.manager.respawnAgent(agent);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.appendSystem(`[${agent.id}] respawn failed: ${msg}. Run cannot continue.`);
      throw new Error(`Planner subprocess respawn failed: ${msg}`);
    }
    this.appendSystem(
      `[${fresh.id}] respawned on port ${fresh.port} (model=${fresh.model}). Resuming planner work.`,
    );
    if (this.planner && this.planner.id === fresh.id) {
      this.planner = fresh;
    }
    return fresh;
  }

  private async promptAgent(
    agent: Agent,
    prompt: string,
    agentName: "swarm" | "swarm-read" | "swarm-builder" = "swarm",
    // Task #196: default to "json" since virtually every blackboard
    // prompt (planner contract, worker hunks, auditor verdict, replanner)
    // expects JSON output. Pass "free" if a future prompt legitimately
    // produces prose. Sniff only fires after 2048 chars accumulated, so
    // short answers pass through naturally.
    formatExpect: "json" | "free" = "json",
    // #233 (2026-04-27 evening): Ollama structured-output passthrough.
    // When set + USE_OLLAMA_DIRECT=1, the model's decoder is grammar-
    // constrained to emit JSON (or output matching the schema). Closes
    // #231 at the source: model literally cannot emit XML markers for
    // parser-strict prompts. Pass "json" for free-form JSON, or a JSON
    // Schema for strict shape validation. Ignored when on the SDK path.
    ollamaFormat?: "json" | Record<string, unknown>,
  ): Promise<string> {
    // Unit 37: agentName defaults to "swarm" (no tools — preserved worker
    // behavior). Planner / auditor / replanner / tier-up / council-drafts
    // should pass "swarm-read" to get read / grep / glob / list tools so
    // they can actually inspect the repo before producing contracts or
    // verdicts. The route selects the opencode agent profile per-prompt
    // via session.prompt body.agent — profiles are declared in the
    // clone's opencode.json (RepoService.writeOpencodeConfig / Unit 20).
    this.turnsPerAgent.set(agent.id, (this.turnsPerAgent.get(agent.id) ?? 0) + 1);
    this.opts.manager.markStatus(agent.id, "thinking");
    const turnStart = Date.now();
    this.emitAgentState({
      id: agent.id,
      index: agent.index,
      port: agent.port,
      sessionId: agent.sessionId,
      status: "thinking",
      // Unit 39: UI uses this to render "thinking 3m54s" while we wait
      // for the real response, distinguishing a legitimate slow prompt
      // from an error.
      thinkingSince: turnStart,
    });

    this.opts.manager.touchActivity(agent.sessionId, turnStart);

    const controller = new AbortController();
    this.activeAborts.add(controller);
    let abortedReason: string | null = null;
    // Task #142: when the absolute turn cap fires, the @opencode-ai SDK
    // doesn't always honor AbortSignal — the underlying fetch can keep
    // running until natural completion. The agent's UI status stays
    // "thinking" past the documented 4-min cap, surprising users (smoke
    // tour 2026-04-25 17:30: agent-4 thinking for 7 min). Surface a
    // visible warning when the watchdog first fires AND the call hasn't
    // returned yet, then a periodic reminder every 60s thereafter.
    let abortFiredAt = 0;
    let lastVisibilityWarn = 0;

    const watchdog = setInterval(() => {
      if (Date.now() - turnStart > ABSOLUTE_MAX_MS) {
        // Task #191: consult the SSE per-chunk timer before guillotining.
        // The 90s STREAM_PER_CHUNK_TIMEOUT_MS is the SSE-aware liveness
        // signal — if it hasn't fired, chunks are arriving and the model
        // is actively producing tokens. The 1200s wall-clock cap predates
        // reliable SSE (#170); now that streaming works, the inner timer
        // is the better signal. Only fire the cap when SSE has ALSO been
        // silent for ≥60s — the call is genuinely stuck.
        const lastChunkAt = this.opts.manager.getLastChunkAt(agent.id);
        if (abortFiredAt === 0 && lastChunkAt && Date.now() - lastChunkAt < 60_000) {
          // Healthy SSE; let it keep running. Watchdog re-checks in 10s.
          return;
        }
        if (abortFiredAt === 0) {
          abortFiredAt = Date.now();
          const sseQuiet = lastChunkAt
            ? `SSE silent ${Math.round((Date.now() - lastChunkAt) / 1000)}s`
            : "no SSE chunks received";
          abortedReason = `absolute turn cap hit (${ABSOLUTE_MAX_MS / 1000}s, ${sseQuiet})`;
          controller.abort(new Error(abortedReason));
          void agent.client.session.abort({ sessionID: agent.sessionId }).catch(() => {});
          this.appendSystem(
            `[${agent.id}] absolute turn cap (${ABSOLUTE_MAX_MS / 1000}s) hit — ${sseQuiet}. Abort signaled.`,
          );
        } else if (Date.now() - lastVisibilityWarn > 60_000) {
          // Periodic reminder while the SDK refuses to return — gives
          // the user a signal that the agent is genuinely uncancellable
          // rather than the marker being stale.
          lastVisibilityWarn = Date.now();
          const stuckS = Math.round((Date.now() - turnStart) / 1000);
          this.appendSystem(
            `[${agent.id}] still in flight ${stuckS}s after start despite abort — SDK has not returned (Task #142).`,
          );
        }
      }
    }, 10_000);
    watchdog.unref?.();

    try {
      // Unit 16: retry loop extracted to shared helper. The onRetry
      // callback preserves the prior surface — system message + agent
      // status flip to "retrying" with attempt counter — so the UI and
      // event log read identically to the pre-Unit-16 behavior.
      const res = await promptWithRetry(agent, prompt, {
        signal: controller.signal,
        // Task #166: streamed-prompt path. Per-chunk SSE timeout
        // replaces the blocking 5-min headersTimeout that was wedging
        // on heavy planner / audit prompts.
        manager: this.opts.manager,
        // Task #196: early-format sniff aborts wrong-format responses
        // in ~10s instead of waiting for the absolute turn cap (1200s).
        formatExpect,
        // V2 Step 1: when USE_OLLAMA_DIRECT=1, route through OllamaClient
        // (bypasses OpenCode subprocess entirely). config import here is
        // safe — BlackboardRunner already depends on config. The flag
        // gates by env so dev can flip between paths without rebuilding.
        ollamaDirect: process.env.USE_OLLAMA_DIRECT === "1"
          ? { baseUrl: this.opts.ollamaBaseUrl ?? "http://127.0.0.1:11533" }
          : undefined,
        // #233: pass structured-output constraint to Ollama when
        // caller requested it AND we're on the direct path.
        ...(ollamaFormat !== undefined ? { ollamaFormat } : {}),
        // V2 Step 1: thread the diag logger so OllamaClient's
        // _ollama_direct_call entries land in logs/current.jsonl.
        logDiag: this.opts.logDiag,
        // Phase 5b of #243: per-agent addendum from the topology row.
        // Active topology lives on this.active (set in start()).
        promptAddendum: getAgentAddendum(this.active?.topology, agent.index),
        // Phase 5a of #243: per-agent generation params (temperature)
        // from the topology row. Effective only on USE_OLLAMA_DIRECT
        // path — the SDK path drops these because session.prompt has
        // no per-call generation-options field. To wire temperature
        // for the SDK path we'd need per-index opencode.json profiles.
        ollamaOptions: getAgentOllamaOptions(this.active?.topology, agent.index),
        onTokens: ({ promptTokens, responseTokens }) => {
          if (promptTokens > 0) this.promptTokensPerAgent.set(agent.id, (this.promptTokensPerAgent.get(agent.id) ?? 0) + promptTokens);
          if (responseTokens > 0) this.responseTokensPerAgent.set(agent.id, (this.responseTokensPerAgent.get(agent.id) ?? 0) + responseTokens);
        },
        agentName,
        describeError: (e) => describeSdkError(e),
        sleep: (ms, sig) => interruptibleSleep(ms, sig),
        onTiming: ({ attempt, elapsedMs, success }) => {
          // Unit 21: per-agent stats for summary.json. Count every
          // attempt (incl. retries); only sample latency on success.
          this.attemptsPerAgent.set(
            agent.id,
            (this.attemptsPerAgent.get(agent.id) ?? 0) + 1,
          );
          if (success) {
            const lats = this.latenciesPerAgent.get(agent.id) ?? [];
            lats.push(elapsedMs);
            this.latenciesPerAgent.set(agent.id, lats);
          }
          // Unit 19: per-call telemetry.
          this.opts.logDiag?.({
            type: "_prompt_timing",
            preset: this.active?.preset,
            agentId: agent.id,
            agentIndex: agent.index,
            attempt,
            elapsedMs,
            success,
          });
          // Improvement #4: per-agent first-prompt cold-start logging.
          this.opts.manager.recordPromptComplete(agent.id, { attempt, elapsedMs, success });
          // Unit 40: live latency sample over WS for the UI sparkline.
          const sampleTs = Date.now();
          this.opts.emit({
            type: "agent_latency_sample",
            agentId: agent.id,
            agentIndex: agent.index,
            attempt,
            elapsedMs,
            success,
            ts: sampleTs,
          });
          // Unit 62: also push into the bounded rolling window stash
          // so the page-refresh catch-up snapshot has the same data
          // a live observer would see. Cap at 20 (matches the
          // client-side LATENCY_WINDOW in store.ts).
          const recent = this.recentLatencySamples.get(agent.id) ?? [];
          recent.push({ ts: sampleTs, elapsedMs, success, attempt });
          if (recent.length > 20) recent.splice(0, recent.length - 20);
          this.recentLatencySamples.set(agent.id, recent);
        },
        onRetry: ({ attempt, max, reasonShort, delayMs }) => {
          // Unit 21: track retry firings per-agent for summary.json.
          this.retriesPerAgent.set(
            agent.id,
            (this.retriesPerAgent.get(agent.id) ?? 0) + 1,
          );
          this.appendSystem(
            `[${agent.id}] transport error (${reasonShort}) — retry ${attempt}/${max} in ${Math.round(delayMs / 1000)}s`,
          );
          this.opts.manager.markStatus(agent.id, "retrying", {
            retryAttempt: attempt,
            retryMax: max,
            retryReason: reasonShort,
          });
          this.emitAgentState({
            id: agent.id,
            index: agent.index,
            port: agent.port,
            sessionId: agent.sessionId,
            status: "retrying",
            retryAttempt: attempt,
            retryMax: max,
            retryReason: reasonShort,
          });
        },
      });
      const text = this.extractText(res) ?? "";
      this.opts.emit({ type: "agent_streaming_end", agentId: agent.id });
      this.opts.manager.markStatus(agent.id, "ready", { lastMessageAt: Date.now() });
      this.emitAgentState({
        id: agent.id,
        index: agent.index,
        port: agent.port,
        sessionId: agent.sessionId,
        status: "ready",
        lastMessageAt: Date.now(),
      });
      return text;
    } catch (err) {
      const msg = abortedReason ?? describeSdkError(err);
      this.opts.emit({ type: "agent_streaming_end", agentId: agent.id });
      this.opts.manager.markStatus(agent.id, "failed", { error: msg });
      this.emitAgentState({
        id: agent.id,
        index: agent.index,
        port: agent.port,
        sessionId: agent.sessionId,
        status: "failed",
        error: msg,
      });
      throw new Error(msg);
    } finally {
      clearInterval(watchdog);
      this.activeAborts.delete(controller);
    }
  }

  // ---------------------------------------------------------------------
  // Misc helpers
  // ---------------------------------------------------------------------

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }


  private appendSystem(text: string, summary?: TranscriptEntrySummary): void {
    const entry: TranscriptEntry = { id: randomUUID(), role: "system", text, ts: Date.now(), summary };
    this.transcript.push(entry);
    this.opts.emit({ type: "transcript_append", entry });
  }

  private appendAgent(agent: Agent, text: string): void {
    // Two-stage strip via shared helper (#230, 2026-04-27 evening):
    //  1. extractThinkTags pulls <think>...</think> reasoning into
    //     entry.thoughts (UI Phase 1, 2026-04-27).
    //  2. extractToolCallMarkers pulls <read>/<grep>/<list>/etc. into
    //     entry.toolCalls (#229, 2026-04-27 evening). Some models
    //     (notably glm-5.1) emit these as raw text when they think
    //     they're invoking SDK tools. Pre-fix they leaked into bubbles
    //     AND caused contract/todos parse failures.
    const { finalText, thoughts, toolCalls } = stripAgentText(text);
    // Unit 54: attach a structured summary when the response parses
    // as a known JSON envelope. UI uses this to collapse worker
    // hunks/skips into a one-line summary by default. Summary parses
    // against finalText (post-strip) so it doesn't mistake chain-of-
    // thought prose or pseudo-tool-calls for envelope content.
    const summary = summarizeAgentResponse(finalText);
    const entry: TranscriptEntry = {
      id: randomUUID(),
      role: "agent",
      agentId: agent.id,
      agentIndex: agent.index,
      text: finalText || "(empty response)",
      ts: Date.now(),
      summary,
      ...(thoughts.length > 0 ? { thoughts } : {}),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
    this.transcript.push(entry);
    this.opts.emit({ type: "transcript_append", entry });
  }

  private setPhase(phase: SwarmPhase): void {
    this.phase = phase;
    this.opts.emit({ type: "swarm_state", phase, round: this.round });
    // Unit 31: phase is a first-class state change; persist it so an
    // observer tailing blackboard-state.json sees the transition promptly.
    this.scheduleStateWrite();
    // V2 cutover Phase 1a (2026-04-28): the parallel-track divergence
    // check that lived here was removed after 7/7 SDK presets validated
    // zero divergences. V2 events still flow through this.v2Observer.apply
    // at their explicit call sites — that's all the V2 reducer needs
    // to stay in sync with V1's transitions. The reducer's snapshot
    // ships in summary.v2State for forward compat with Phase 1b/3
    // (UI-driven by V2 phase).
  }

  private emitAgentState(s: AgentState): void {
    // thinkingSince REST-snapshot fix: route through the manager so
    // the agentStates mirror gets updated AND the WS event still
    // fires (the manager's onState callback IS opts.emit-equivalent
    // for `agent_state` events). Before this change, fields like
    // `thinkingSince` (Unit 39) only appeared on the live WS stream
    // — REST /status served a stale mirror that omitted them.
    this.opts.manager.recordAgentState(s);
  }


  private extractText(res: unknown): string | undefined {
    const any = res as {
      data?: {
        parts?: Array<{ type?: string; text?: string }>;
        info?: { parts?: Array<{ type?: string; text?: string }> };
        text?: string;
      };
    };
    const parts = any?.data?.parts ?? any?.data?.info?.parts;
    if (Array.isArray(parts)) {
      const texts = parts
        .filter((p) => p?.type === "text" && typeof p.text === "string")
        .map((p) => p.text as string);
      if (texts.length) return texts.join("\n");
    }
    return any?.data?.text;
  }
}


// Task #164 (refactor): parseGoalList moved to ./goalListParser.ts.
// 2026-04-28: bumpAgentCounter / countNewlines / checkExpectedSymbols
// moved to ./runnerHelpers.ts. Re-exported from this module for
// back-compat with any external consumer that imported them by name.
export { parseGoalList } from "./goalListParser.js";
