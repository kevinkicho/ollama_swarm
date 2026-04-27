import { createHash, randomUUID } from "node:crypto";
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
import { Board } from "./Board.js";
import { createBoardBroadcaster, type BoardBroadcaster } from "./boardBroadcaster.js";
import {
  advanceTickAccumulator,
  checkCaps,
  createTickAccumulator,
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
// Task #164 (refactor): per-commit verifier invocation split out.
import {
  runVerifier as runVerifierExtracted,
  type VerifierContext,
} from "./verifierInvocation.js";
// Task #164 (refactor): per-commit critic + ensemble split out.
import {
  runCritic as runCriticExtracted,
  type CriticContext,
} from "./criticInvocation.js";
// Task #164 (refactor): goal-generation pre-pass split out.
import { runGoalGenerationPrePass as runGoalGenerationPrePassExtracted } from "./goalGenerationPrePass.js";
// Task #164 (refactor): auditor seed builder + UI snapshot capture split out.
import { buildAuditorSeed as buildAuditorSeedExtracted } from "./auditorSeedBuilder.js";
import { truncate } from "./truncate.js";
import { config } from "../../config.js";

// Blackboard preset: planner posts TODOs, workers drain them in a
// claim/execute loop. Workers produce full-file diffs as JSON; the runner
// does an optimistic-CAS re-hash at commit time, writes each diff via
// tmp+rename, then records the commit on the board.
//
// Lifecycle: cloning -> spawning -> seeding -> planning -> executing -> completed.
// Stop at any point aborts in-flight prompts, kills agents, frees ports.

const CLAIM_TTL_MS = 10 * 60_000;
const CLAIM_EXPIRY_INTERVAL_MS = 30_000;
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

export class BlackboardRunner implements SwarmRunner {
  private transcript: TranscriptEntry[] = [];
  private phase: SwarmPhase = "idle";
  private round = 0;
  private stopping = false;
  private active?: RunConfig;
  private board: Board;
  private boardBroadcaster: BoardBroadcaster;
  // Every in-flight prompt registers its AbortController so stop() can abort
  // them all at once without needing to know about planner vs worker.
  private activeAborts = new Set<AbortController>();
  private expiryTimer?: NodeJS.Timeout;
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

  constructor(private readonly opts: RunnerOpts) {
    this.boardBroadcaster = createBoardBroadcaster(this.opts.emit);
    this.board = new Board({
      emit: (ev) => {
        this.boardBroadcaster.emit(ev);
        this.onBoardEvent(ev);
      },
    });
    this.boardBroadcaster.bindBoard(this.board);
  }

  status(): SwarmStatus {
    // Unit 62: include the catch-up payload so a page refresh can
    // hydrate the zustand store from one HTTP fetch. WS events keep
    // the live store fresh; this is purely the reload path.
    const board = this.board.snapshot();
    const counts = this.board.counts();
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
      const generated = await runGoalGenerationPrePassExtracted(planner, seed, (text) => this.appendSystem(text));
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
      if (workers.length > 0 && this.board.counts().open > 0) {
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
        this.startClaimExpiry();
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
      this.stopClaimExpiry();
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
      // Errors are swallowed for the same reason as the final audit:
      // a missing reflection is annoying, not run-fatal.
      // Task #168: differentiate hard-user-stop from drain-stop. Drained
      // runs ARE "the user opted into a clean exit" — let memory +
      // stretch reflection fire so the work isn't lost. Only hard
      // user-stop (Stop button, no drain) suppresses both passes.
      const userStoppedHard =
        this.stopping && !this.terminationReason && !this.wasDrained;
      const hasOutput =
        this.board.counts().committed > 0 ||
        (this.contract?.criteria.length ?? 0) > 0;
      // Task #164 (refactor): build the reflection context once and
      // pass to both extracted helpers.
      const reflectionCtx: ReflectionContext = {
        transcript: this.transcript,
        appendSystem: (text, summary) => this.appendSystem(text, summary),
        emit: (e) => this.opts.emit(e),
        currentTier: this.currentTier,
        committedCount: this.board.counts().committed,
        contractCriteria: this.contract?.criteria ?? [],
        runId: this.active?.runId ?? "unknown",
      };
      if (
        !errored &&
        !userStoppedHard &&
        hasOutput &&
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
        this.active?.autoDesignMemory !== false
      ) {
        try {
          await runDesignMemoryUpdatePass(planner, this.active?.localPath, reflectionCtx);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.appendSystem(`Design memory update failed: ${msg}`);
        }
      }
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
    this.setPhase("draining");
    this.appendSystem(
      `Drain & Stop requested. Workers will finish their current claim (${this.board.counts().claimed} in-flight); no new claims. ` +
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
    const claimed = this.board.counts().claimed;
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
    this.setPhase("stopping");
    this.stopClaimExpiry();
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
    const { response: firstResponse, agentUsed: contractAgent } = await this.promptPlannerWithFallback(
      agent,
      `${FIRST_PASS_CONTRACT_SYSTEM_PROMPT}\n\n${buildFirstPassContractUserPrompt(seed)}`,
    );
    if (this.stopping) return;
    this.appendAgent(contractAgent, firstResponse);

    let parsed = parseFirstPassContractResponse(firstResponse);
    if (!parsed.ok) {
      this.appendSystem(
        `Contract response did not parse (${parsed.reason}). Issuing repair prompt.`,
      );
      const { response: repairResponse, agentUsed: repairAgent } = await this.promptPlannerWithFallback(
        contractAgent,
        `${FIRST_PASS_CONTRACT_SYSTEM_PROMPT}\n\n${buildFirstPassContractRepairPrompt(
          firstResponse,
          parsed.reason,
        )}`,
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
  // usual promptPlannerWithFallback so a planner cold-start failure
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
        // Unit 37: council drafts are PLANNER-role prompts (agents
        // drafting contracts, not producing diffs) — route through
        // swarm-read so the agent can inspect the code before drafting.
        const text = await this.promptAgent(a, draftPrompt, "swarm-read");
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
      await this.promptPlannerWithFallback(planner, mergePrompt);
    if (this.stopping) return null;
    this.appendAgent(mergeAgent, mergeResponse);

    let mergeParsed = parseFirstPassContractResponse(mergeResponse);
    if (!mergeParsed.ok) {
      this.appendSystem(
        `Council merge response did not parse (${mergeParsed.reason}). Issuing repair prompt.`,
      );
      const { response: repairResponse, agentUsed: repairAgent } =
        await this.promptPlannerWithFallback(
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
        this.board.postFinding({
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

  private async runPlanner(agent: Agent, seed: PlannerSeed): Promise<void> {
    // Unit 24: planner fallback (see promptPlannerWithFallback comment).
    const { response: firstResponse, agentUsed: planAgent } = await this.promptPlannerWithFallback(
      agent,
      `${PLANNER_SYSTEM_PROMPT}\n\n${buildPlannerUserPrompt(seed)}`,
    );
    if (this.stopping) return;
    this.appendAgent(planAgent, firstResponse);

    let parsed = parsePlannerResponse(firstResponse);
    if (!parsed.ok) {
      this.appendSystem(`Planner response did not parse (${parsed.reason}). Issuing repair prompt.`);
      const { response: repairResponse, agentUsed: repairAgent } = await this.promptPlannerWithFallback(
        planAgent,
        `${PLANNER_SYSTEM_PROMPT}\n\n${buildRepairPrompt(firstResponse, parsed.reason)}`,
      );
      if (this.stopping) return;
      this.appendAgent(repairAgent, repairResponse);
      parsed = parsePlannerResponse(repairResponse);
      if (!parsed.ok) {
        this.appendSystem(`Planner still invalid after repair (${parsed.reason}). Giving up this run.`);
        this.board.postFinding({
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
        this.board.postFinding({
          agentId: agent.id,
          text: `Todo "${t.description.slice(0, 80)}${t.description.length > 80 ? "…" : ""}": stripped suspicious path '${r.path}' (${r.reason}).`,
          createdAt: Date.now(),
        });
      }
      if (accepted.length === 0) {
        todosDropped += 1;
        this.board.postFinding({
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
        this.board.postFinding({
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
      this.appendSystem("Planner produced 0 valid todos after grounding.");
      this.board.postFinding({
        agentId: agent.id,
        text:
          parsed.dropped.length > 0 || todosDropped > 0
            ? `Planner returned only invalid/unbindable todos (${parsed.dropped.length} schema-dropped, ${todosDropped} grounding-dropped).`
            : "Planner returned an empty todo list — nothing actionable in the repo.",
        createdAt: Date.now(),
      });
      return;
    }

    const now = Date.now();
    for (const t of groundedTodos) {
      this.board.postTodo({
        description: t.description,
        expectedFiles: t.expectedFiles,
        createdBy: agent.id,
        createdAt: now,
        // Unit 44b: forward planner-declared anchors. Undefined / empty
        // → omitted in postTodo. Each surviving anchor gets resolved at
        // worker prompt build time.
        expectedAnchors: t.expectedAnchors,
      });
    }
    this.appendSystem(`Posted ${groundedTodos.length} todo(s) to the board.`);
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

      const openBefore = this.board.counts().open;
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
      const openAfter = this.board.counts().open;
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
    const openBefore = this.board.counts().open;
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
    const openAfter = this.board.counts().open;
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
    const committed = this.board.listTodos().filter((t) => t.status === "committed");
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

    const { response, agentUsed } = await this.promptPlannerWithFallback(
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
        await this.promptPlannerWithFallback(
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
        this.board.postFinding({
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

  // Unit 35: resolve whether the critic should fire for this run.
  // Per-run `cfg.critic` wins over env when present (explicit on/off);
  // otherwise CRITIC_ENABLED env decides.
  // Task #164 (refactor): single + ensemble critic implementations
  // moved to ./criticInvocation.ts; this method is just the gate.
  private criticEnabled(): boolean {
    const perRun = this.active?.critic;
    if (perRun !== undefined) return perRun;
    return config.CRITIC_ENABLED;
  }

  // Task #128 / #164: per-commit verifier — opt-in via cfg.verifier.
  // Implementation in ./verifierInvocation.ts; this method just gates.
  private verifierEnabled(): boolean {
    return this.active?.verifier === true;
  }

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

    const seed = await buildAuditorSeedExtracted({
      contract: this.contract!,
      board: this.board,
      readExpectedFiles: (paths) => this.readExpectedFiles(paths),
      auditInvocation: this.auditInvocations,
      maxInvocations: this.maxAuditInvocations,
      uiUrl: this.active?.uiUrl,
      model: this.active?.model ?? "glm-5.1:cloud",
      clonePath: this.active?.localPath ?? "",
      appendSystem: (text) => this.appendSystem(text),
    });
    // Unit 24: planner fallback (see promptPlannerWithFallback comment).
    // Unit 58: when a dedicated auditor agent was spawned, route the
    // audit prompt to it instead of reusing the planner. Workers can
    // continue draining new todos in parallel during the audit (they
    // were idle on the planner-as-auditor path). promptPlannerWithFallback's
    // fallback-to-worker safety net still kicks in if the auditor times out.
    const auditPrimary = this.auditor ?? planner;
    const { response: firstResponse, agentUsed: auditAgent } = await this.promptPlannerWithFallback(
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
      const { response: repairResponse, agentUsed: repairAgent } = await this.promptPlannerWithFallback(
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

    this.applyAuditorResult(parsed.result, planner);
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
          this.board.postTodo({
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

      const counts = this.board.counts();
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
        const sustainedWedge = waitTickN >= PERSISTENT_WEDGE_MIN_TICKS;
        if (sustainedWedge && now - lastWaitDiagAt > 30_000) {
          lastWaitDiagAt = now;
          this.opts.logDiag?.({
            type: "_worker_wait_wedge",
            agentId: agent.id,
            tickN: waitTickN,
            counts: { ...counts },
            replanPending: Array.from(this.replanPending),
            replanRunning: this.replanRunning,
            ts: now,
          });
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
      const todo = this.board.findClaimableTodo();
      if (!todo) continue;

      const outcome = await this.executeWorkerTodo(agent, todo);
      if (outcome === "committed") {
        // Cooldown so one worker doesn't monopolize the board. Random jitter
        // helps desync workers that all finished around the same time.
        await this.sleep(WORKER_COOLDOWN_MS + Math.floor(Math.random() * 500));
      }
    }
  }

  private async executeWorkerTodo(
    agent: Agent,
    todo: Todo,
  ): Promise<"committed" | "stale" | "lost-race" | "aborted"> {
    // Hash files BEFORE claiming so the claim records the CAS baseline. If we
    // lose the race with another worker, we throw away the hashes but the
    // operation was read-only so no harm done.
    let hashes: Record<string, string>;
    try {
      hashes = await this.hashExpectedFiles(todo.expectedFiles);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Can't even hash the paths — usually means path escape or a bad
      // planner output. Mark stale so Phase 6 replan can see it.
      this.appendSystem(`[${agent.id}] cannot hash todo "${truncate(todo.description)}": ${msg}`);
      this.board.markStale(todo.id, `hash failure: ${msg}`);
      return "stale";
    }

    const now = Date.now();
    const claim = this.board.claimTodo({
      todoId: todo.id,
      agentId: agent.id,
      fileHashes: hashes,
      claimedAt: now,
      expiresAt: now + CLAIM_TTL_MS,
    });
    if (!claim.ok) {
      // Another worker got it or it went stale/committed between find and claim.
      // Back off briefly to desync from whoever won.
      return "lost-race";
    }

    // Read current contents to feed the prompt. Use the same resolve-safe
    // check so we never leak anything outside the clone via a symlink.
    let contents: Record<string, string | null>;
    try {
      contents = await this.readExpectedFiles(todo.expectedFiles);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.board.markStale(todo.id, `read failure: ${msg}`);
      return "stale";
    }

    const seed: WorkerSeed = {
      todoId: todo.id,
      description: todo.description,
      expectedFiles: todo.expectedFiles,
      fileContents: contents,
      // Unit 44b: pass anchors through. buildWorkerUserPrompt switches
      // to the anchored window view when this is non-empty.
      expectedAnchors: todo.expectedAnchors,
      // Unit 59 (59a): inject the assigned role bias for this worker.
      // Empty string when specializedWorkers is off; buildWorkerUserPrompt
      // skips the preamble when absent → byte-identical pre-Unit-59 prompt.
      roleGuidance: this.workerRoles.get(agent.id),
    };

    let response: string;
    try {
      response = await this.promptAgent(agent, `${WORKER_SYSTEM_PROMPT}\n\n${buildWorkerUserPrompt(seed)}`);
    } catch (err) {
      if (this.stopping) return "aborted";
      const msg = err instanceof Error ? err.message : String(err);
      this.board.markStale(todo.id, `worker prompt failed: ${msg}`);
      // Task #67: hard error during this agent's worker prompt.
      bumpAgentCounter(this.promptErrorsPerAgent, agent.id);
      bumpAgentCounter(this.rejectedAttemptsPerAgent, agent.id);
      return "stale";
    }
    if (this.stopping) return "aborted";
    this.appendAgent(agent, response);

    let parsed = parseWorkerResponse(response, todo.expectedFiles);
    if (!parsed.ok) {
      // Task #67: JSON-invalid first attempt. Informational counter even
      // if the repair below succeeds — tells us which workers struggle
      // with the JSON envelope.
      bumpAgentCounter(this.jsonRepairsPerAgent, agent.id);
      this.appendSystem(`[${agent.id}] worker JSON invalid (${parsed.reason}); issuing repair prompt.`);
      let repair: string;
      try {
        repair = await this.promptAgent(
          agent,
          `${WORKER_SYSTEM_PROMPT}\n\n${buildWorkerRepairPrompt(response, parsed.reason)}`,
        );
      } catch (err) {
        if (this.stopping) return "aborted";
        const msg = err instanceof Error ? err.message : String(err);
        this.board.markStale(todo.id, `worker repair prompt failed: ${msg}`);
        bumpAgentCounter(this.promptErrorsPerAgent, agent.id);
        bumpAgentCounter(this.rejectedAttemptsPerAgent, agent.id);
        return "stale";
      }
      if (this.stopping) return "aborted";
      this.appendAgent(agent, repair);
      parsed = parseWorkerResponse(repair, todo.expectedFiles);
      if (!parsed.ok) {
        this.board.markStale(todo.id, `worker produced invalid JSON after repair: ${parsed.reason}`);
        // Repair didn't fix it; this attempt is fully wasted.
        bumpAgentCounter(this.rejectedAttemptsPerAgent, agent.id);
        return "stale";
      }
    }

    if (parsed.skip) {
      this.appendSystem(`[${agent.id}] worker declined todo: ${parsed.skip}`);
      // Mark stale (not skipped) so Phase 6 replan can decide whether to
      // re-prompt or formally skip it. Skipped is a human/planner decision.
      this.board.markStale(todo.id, `worker declined: ${parsed.skip}`);
      bumpAgentCounter(this.rejectedAttemptsPerAgent, agent.id);
      return "stale";
    }

    if (parsed.hunks.length === 0) {
      this.board.markStale(todo.id, "worker returned empty hunks with no skip reason");
      bumpAgentCounter(this.rejectedAttemptsPerAgent, agent.id);
      return "stale";
    }

    // Phase 5: re-hash the claimed files; if any drifted since claim time,
    // mark the todo stale and bail without writing. Otherwise apply hunks to
    // the pre-prompt contents, validate the resulting texts, and write each
    // touched file via tmp+rename before recording the commit on the board.
    let currentHashes: Record<string, string>;
    try {
      currentHashes = await this.hashExpectedFiles(todo.expectedFiles);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.board.markStale(todo.id, `re-hash failure: ${msg}`);
      return "stale";
    }

    const mismatched: string[] = [];
    for (const [p, claimed] of Object.entries(hashes)) {
      if ((currentHashes[p] ?? "") !== claimed) mismatched.push(p);
    }
    if (mismatched.length > 0) {
      this.board.markStale(todo.id, `CAS mismatch before write: ${mismatched.join(", ")}`);
      // Task #67: lost the optimistic-CAS race; agent's work is wasted.
      bumpAgentCounter(this.rejectedAttemptsPerAgent, agent.id);
      return "stale";
    }

    // Apply hunks against pre-prompt contents. CAS above already proved no
    // one touched these files since, so contents is the correct base. Any
    // hunk failure (anchor not unique, create on an existing file, etc.) is
    // surfaced with a hunk-index prefix from applyHunks — replanner can use
    // that to tell the worker which hunk to fix.
    let applied = applyHunks(contents, parsed.hunks);
    // Task #78: self-repair when the failure is a "search" mismatch
    // (whitespace drift, the worker imagined a slightly-different file).
    // Send the actual file content + failed hunks back to the SAME worker
    // for one corrective round. Cheaper than markStale → replan from
    // scratch with a fresh worker, which loses all the worker's context.
    if (!applied.ok && /text not found/.test(applied.error) && !this.stopping) {
      this.appendSystem(
        `[${agent.id}] hunk apply failed (search mismatch); issuing repair prompt with actual file content.`,
      );
      let repair: string;
      // Filter out files we couldn't read (null = not present); they
      // can't have a search-mismatch failure anyway.
      const readableContents: Record<string, string> = {};
      for (const [f, t] of Object.entries(contents)) {
        if (typeof t === "string") readableContents[f] = t;
      }
      try {
        repair = await this.promptAgent(
          agent,
          `${WORKER_SYSTEM_PROMPT}\n\n${buildHunkRepairPrompt(parsed.hunks, applied.error, readableContents)}`,
        );
      } catch (err) {
        if (this.stopping) return "aborted";
        const msg = err instanceof Error ? err.message : String(err);
        this.board.markStale(todo.id, `hunk repair prompt failed: ${msg}`);
        bumpAgentCounter(this.promptErrorsPerAgent, agent.id);
        bumpAgentCounter(this.rejectedAttemptsPerAgent, agent.id);
        return "stale";
      }
      if (this.stopping) return "aborted";
      this.appendAgent(agent, repair);
      const repairParsed = parseWorkerResponse(repair, todo.expectedFiles);
      if (!repairParsed.ok) {
        // Repair also produced bad JSON — give up and markStale with
        // the original applyHunks error (more actionable than the
        // repair-parse error).
        this.board.markStale(todo.id, `hunk apply failed: ${applied.error}`);
        bumpAgentCounter(this.rejectedAttemptsPerAgent, agent.id);
        return "stale";
      }
      if (repairParsed.skip || repairParsed.hunks.length === 0) {
        // Worker decided the todo wasn't doable after seeing the file.
        // Honor it as a decline; the replanner can re-route.
        const reason = repairParsed.skip || "empty hunks after repair";
        this.board.markStale(todo.id, `worker declined after hunk repair: ${reason}`);
        bumpAgentCounter(this.rejectedAttemptsPerAgent, agent.id);
        return "stale";
      }
      // Re-apply with the repaired hunks. The pre-prompt contents are
      // still the right base — CAS still holds (we haven't yielded
      // since the re-hash above).
      const reapplied = applyHunks(contents, repairParsed.hunks);
      if (!reapplied.ok) {
        this.board.markStale(todo.id, `hunk apply failed after repair: ${reapplied.error}`);
        bumpAgentCounter(this.rejectedAttemptsPerAgent, agent.id);
        return "stale";
      }
      this.appendSystem(`[${agent.id}] hunk repair succeeded.`);
      // Promote the repaired result into the downstream pipeline.
      applied = reapplied;
      parsed = repairParsed;
    }
    if (!applied.ok) {
      this.board.markStale(todo.id, `hunk apply failed: ${applied.error}`);
      bumpAgentCounter(this.rejectedAttemptsPerAgent, agent.id);
      return "stale";
    }

    // Convert the per-file post-apply output into the {file, newText} shape
    // the existing validators expect. Only files that actually had hunks are
    // present (applyHunks preserves that contract).
    const resultingDiffs = Object.entries(applied.newTextsByFile).map(
      ([file, newText]) => ({ file, newText }),
    );

    // Block a worker from zeroing out a previously non-empty file. We check
    // on the post-apply text, not on raw hunks — a sequence of replaces that
    // whittles a file down to "" would slip past a per-hunk check.
    const zeroed = findZeroedFiles(resultingDiffs, contents);
    if (zeroed.length > 0) {
      this.board.markStale(
        todo.id,
        `worker would zero non-empty file(s): ${zeroed.join(", ")}`,
      );
      return "stale";
    }

    // Reject leading UTF-8 BOMs in the resulting text. Writing one through
    // silently breaks tooling (git diffs look empty, node parsers throw,
    // linters lie).
    const bomFiles = findBomPrefixed(resultingDiffs);
    if (bomFiles.length > 0) {
      this.board.markStale(
        todo.id,
        `worker output has leading UTF-8 BOM in: ${bomFiles.join(", ")}`,
      );
      return "stale";
    }

    // Unit 35: critic intercept. Between CAS pass and disk write, a peer
    // agent reviews the diff for busywork patterns (duplicate content,
    // stub implementations, rename-only reorgs, tests-without-behavior,
    // etc.). Reject → markStale, no disk mutation, no commit burned.
    // Opt-in per run / env; when neither is set the critic is SKIPPED
    // and the worker-commit flow is byte-identical to pre-Unit-35.
    if (this.criticEnabled()) {
      const criticCtx: CriticContext = {
        manager: this.opts.manager,
        board: this.board,
        contractCriteria: this.contract?.criteria ?? [],
        appendSystem: (text, summary) => this.appendSystem(text, summary),
        isStopping: () => this.stopping,
        bumpRejected: (agentId) =>
          bumpAgentCounter(this.rejectedAttemptsPerAgent, agentId),
        ensembleEnabled: this.active?.criticEnsemble === true,
      };
      const verdict = await runCriticExtracted(
        todo,
        agent,
        contents,
        resultingDiffs,
        criticCtx,
      );
      if (this.stopping) return "stale";
      if (verdict === "reject") {
        // The "stale reason" is populated inside runCritic via
        // markStale-with-rationale; we just return the status bucket.
        return "stale";
      }
    }

    // Task #128: verifier intercept. After critic accept (or critic
    // disabled), an independent claim-checker reads the todo + diff
    // and asks "does this diff actually action this specific todo?".
    // FALSE blocks the commit (markStale → replanner picks a fresh
    // angle). PARTIAL / VERIFIED proceed; UNVERIFIABLE proceeds with
    // a logged warning. Opt-in via cfg.verifier — when off the worker
    // pipeline is byte-identical to pre-#128.
    if (this.verifierEnabled()) {
      const verifierCtx: VerifierContext = {
        manager: this.opts.manager,
        board: this.board,
        appendSystem: (text, summary) => this.appendSystem(text, summary),
        isStopping: () => this.stopping,
        bumpRejected: (agentId) =>
          bumpAgentCounter(this.rejectedAttemptsPerAgent, agentId),
      };
      const verdict = await runVerifierExtracted(
        todo,
        agent,
        contents,
        resultingDiffs,
        verifierCtx,
      );
      if (this.stopping) return "stale";
      if (verdict === "reject") {
        return "stale";
      }
    }

    // CAS passed locally. Write atomically; on any write error we leave the
    // claim in place — TTL expiry will convert it to stale and Phase 6 replan
    // will observe whatever state the partial write left on disk.
    try {
      for (const { file, newText } of resultingDiffs) {
        await this.writeDiff(file, newText);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.appendSystem(`[${agent.id}] write failed mid-commit: ${msg}`);
      this.opts.emit({
        type: "error",
        message: `Write failed after CAS pass for todo ${todo.id}: ${msg}`,
      });
      this.board.markStale(todo.id, `write failed: ${msg}`);
      return "stale";
    }

    // Record on the board. Trivially passes CAS since nothing touched the
    // files between our re-hash above and these writes (same event-loop tick).
    const commit = this.board.commitTodo({
      todoId: todo.id,
      agentId: agent.id,
      currentHashes,
      committedAt: Date.now(),
    });
    if (!commit.ok) {
      // Unexpected: we just verified the hashes. Surface as an error and
      // mark stale so the run can continue.
      this.appendSystem(`[${agent.id}] unexpected commit refusal: ${commit.reason}`);
      this.board.markStale(todo.id, `commit refused after write: ${commit.reason}`);
      return "stale";
    }

    const summary = resultingDiffs
      .map((d) => `${d.file} (${d.newText.length} chars)`)
      .join(", ");
    this.appendSystem(
      `[${agent.id}] committed ${parsed.hunks.length} hunk(s): ${summary}`,
    );
    // Task #66: attribute this commit + line counts to the agent so the
    // history modal's per-agent table can show who produced code.
    this.commitsPerAgent.set(agent.id, (this.commitsPerAgent.get(agent.id) ?? 0) + 1);
    let added = 0;
    let removed = 0;
    for (const h of parsed.hunks) {
      if (h.op === "replace") {
        added += countNewlines(h.replace);
        removed += countNewlines(h.search);
      } else if (h.op === "create" || h.op === "append") {
        added += countNewlines(h.content);
      }
    }
    this.linesAddedPerAgent.set(
      agent.id,
      (this.linesAddedPerAgent.get(agent.id) ?? 0) + added,
    );
    this.linesRemovedPerAgent.set(
      agent.id,
      (this.linesRemovedPerAgent.get(agent.id) ?? 0) + removed,
    );
    return "committed";
  }

  // ---------------------------------------------------------------------
  // Phase 6 — replan orchestration
  //
  // Hook into Board events so every todo_stale enqueues the todo for replan.
  // processReplanQueue serializes through the planner agent (single session),
  // bumps replanCount via board.replan, or skips via board.skip. A fallback
  // tick sweeps the board for any stale the event path missed (e.g. if
  // replanOne itself threw mid-prompt).
  // ---------------------------------------------------------------------

  private onBoardEvent(ev: BoardEvent): void {
    // Unit 31: every board event changes persisted state. Schedule ahead
    // of the stale-specific branch so todo_posted / todo_committed /
    // todo_claimed / finding_posted etc. also flush.
    this.scheduleStateWrite();
    if (ev.type !== "todo_stale") return;
    this.staleEventCount++;
    this.enqueueReplan(ev.todoId);
  }

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
            this.board.skip(todoId, `replanner crashed: ${msg}`);
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
    const todo = this.board.listTodos().find((t) => t.id === todoId);
    if (!todo) return;
    // Dedup: the same todo could be enqueued twice. Only act if still stale.
    if (todo.status !== "stale") return;

    if (todo.replanCount >= MAX_REPLAN_ATTEMPTS) {
      this.board.skip(
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
      this.board.skip(todoId, `replanner unable to read files: ${msg}`);
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
      // Unit 24: planner fallback (see promptPlannerWithFallback comment).
      const r = await this.promptPlannerWithFallback(
        planner,
        `${REPLANNER_SYSTEM_PROMPT}\n\n${buildReplannerUserPrompt(seed)}`,
      );
      response = r.response;
      replanAgent = r.agentUsed;
    } catch (err) {
      if (this.stopping) return;
      const msg = err instanceof Error ? err.message : String(err);
      this.board.skip(todoId, `replanner prompt failed: ${msg}`);
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
        const r = await this.promptPlannerWithFallback(
          replanAgent,
          `${REPLANNER_SYSTEM_PROMPT}\n\n${buildReplannerRepairPrompt(response, parsed.reason)}`,
        );
        repair = r.response;
        repairAgent = r.agentUsed;
      } catch (err) {
        if (this.stopping) return;
        const msg = err instanceof Error ? err.message : String(err);
        this.board.skip(todoId, `replanner repair prompt failed: ${msg}`);
        return;
      }
      if (this.stopping) return;
      this.appendAgent(repairAgent, repair);
      parsed = parseReplannerResponse(repair);
      if (!parsed.ok) {
        this.board.skip(
          todoId,
          `replanner produced invalid JSON after repair: ${parsed.reason}`,
        );
        return;
      }
    }

    if (parsed.action === "skip") {
      this.board.skip(todoId, `replanner decided to skip: ${parsed.reason}`);
      this.appendSystem(`Replanner skipped todo ${todoId}: ${parsed.reason}`);
      return;
    }

    const r = this.board.replan(todoId, {
      description: parsed.description,
      expectedFiles: parsed.expectedFiles,
      // Unit 44b: anchor revision is optional. undefined → keep prior
      // anchors; explicit array → replace them.
      expectedAnchors: parsed.expectedAnchors,
    });
    if (!r.ok) {
      // Board refused (e.g. status changed between our read and the call).
      // Log it and move on — the fallback tick will pick up any leftover.
      this.appendSystem(`Replan refused for todo ${todoId}: ${r.reason}`);
      return;
    }
    this.appendSystem(
      `Replanned todo ${todoId} (attempt ${r.todo.replanCount}): "${truncate(r.todo.description)}"`,
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
        for (const todo of this.board.listTodos()) {
          if (todo.status === "stale" && todo.replanCount < MAX_REPLAN_ATTEMPTS) {
            this.enqueueReplan(todo.id);
          }
        }
        // Also sweep exhausted stales into skipped right away — otherwise
        // workers would keep looping (counts.stale>0) waiting for them.
        for (const todo of this.board.listTodos()) {
          if (todo.status === "stale" && todo.replanCount >= MAX_REPLAN_ATTEMPTS) {
            this.board.skip(
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
      committed: this.board.counts().committed,
      totalTodos: this.board.listTodos().length,
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
        body: { title: `quota-probe-${Date.now()}` },
      });
      const any = created as { data?: { id?: string; info?: { id?: string } }; id?: string };
      const sid = any?.data?.id ?? any?.data?.info?.id ?? any?.id;
      if (!sid) throw new Error("session.create returned no session id");
      await planner.client.session.prompt({
        path: { id: sid },
        body: {
          agent: "swarm-read",
          model: { providerID: "ollama", modelID: planner.model },
          parts: [{ type: "text", text: "ping" }],
        },
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

    const counts = this.board.counts();
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
      board: this.board.snapshot(),
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
        board: this.board.snapshot(),
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

  private async hashExpectedFiles(files: string[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const f of files) out[f] = await this.hashFile(f);
    return out;
  }

  private async hashFile(relPath: string): Promise<string> {
    const abs = await this.resolveSafe(relPath);
    try {
      const buf = await fs.readFile(abs);
      return createHash("sha256").update(buf).digest("hex");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw err;
    }
  }

  private async writeDiff(relPath: string, contents: string): Promise<void> {
    await writeFileAtomic(await this.resolveSafe(relPath), contents);
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

  private startClaimExpiry(): void {
    if (this.expiryTimer) return;
    this.expiryTimer = setInterval(() => {
      const expired = this.board.expireClaims(Date.now());
      if (expired.length > 0) {
        this.appendSystem(`Expired ${expired.length} stale claim(s) past TTL`);
      }
    }, CLAIM_EXPIRY_INTERVAL_MS);
    this.expiryTimer.unref?.();
  }

  private stopClaimExpiry(): void {
    if (this.expiryTimer) clearInterval(this.expiryTimer);
    this.expiryTimer = undefined;
  }

  // ---------------------------------------------------------------------
  // Prompting
  // ---------------------------------------------------------------------

  // Absolute-cap-only watchdog. No idle-silence detection because OpenCode
  // doesn't forward usable activity events for our ollama provider setup.
  // Unit 24: planner-call fallback. Tries the primary planner first
  // (already gets 3 retries via promptAgent → promptWithRetry). If that
  // exhausts, falls through to each remaining live agent in index order
  // — each gets its own fresh 3-retry budget against its own session.
  // Planner identity stays with agent-1 in the UI/summary; only the
  // CALL is routed elsewhere. Throws only if every agent exhausted.
  //
  // Why this works for ALL planner prompts (not just the contract):
  // every planner call (contract / runPlanner / replanOne / runAuditor)
  // builds its prompt fresh from in-memory state (contract object,
  // board.listTodos(), file contents). The SDK session is just a
  // transport — no per-session memory carries between calls. So
  // routing the same prompt to a different agent's session yields an
  // equally valid answer.
  private async promptPlannerWithFallback(
    primaryAgent: Agent,
    promptText: string,
    agentName: "swarm" | "swarm-read" = "swarm-read",
  ): Promise<{ response: string; agentUsed: Agent }> {
    // Unit 37: planner / auditor / replanner / tier-up calls default to
    // `swarm-read` so they can actually inspect the code via read / grep /
    // glob / list tools. Workers continue calling promptAgent directly
    // with the default `swarm` (no tools) — see runWorker.
    const fallbacks = this.opts.manager.list().filter((a) => a.id !== primaryAgent.id);
    const tried: Agent[] = [primaryAgent, ...fallbacks];
    // Task #195: when routing to a fallback agent, override its model with
    // the primary planner's model. The session is just transport; the model
    // produces the answer. Without this, gemma4 (worker model) gets handed
    // the planner's JSON contract prompt and hallucinates markdown for
    // ~14 minutes (debate-tcg run e3738692, 2026-04-26).
    const plannerModel = primaryAgent.model;
    let lastErr: unknown;
    for (let i = 0; i < tried.length; i++) {
      const agent = tried[i];
      const modelOverride = i === 0 ? undefined : plannerModel;
      try {
        const response = await this.promptAgent(agent, promptText, agentName, modelOverride);
        if (i > 0) {
          this.appendSystem(
            `Planner call routed to ${agent.id} (using planner model ${plannerModel}) ` +
              `after ${primaryAgent.id} exhausted retries. ` +
              `Run continues; ${primaryAgent.id} keeps planner identity for future calls.`,
          );
          // Task #190: clear primary planner's "failed" chip after the
          // fallback succeeded — the failure was for ONE call, the agent
          // is still in the pool and will be tried again on the next
          // planner call. Without this the UI shows a scary red "failed"
          // panel for an entirely-recovered situation.
          this.opts.manager.markStatus(primaryAgent.id, "ready", { lastMessageAt: Date.now() });
          this.emitAgentState({
            id: primaryAgent.id,
            index: primaryAgent.index,
            port: primaryAgent.port,
            sessionId: primaryAgent.sessionId,
            status: "ready",
            lastMessageAt: Date.now(),
          });
        }
        return { response, agentUsed: agent };
      } catch (err) {
        lastErr = err;
        if (this.stopping) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        const isLast = i === tried.length - 1;
        this.appendSystem(
          `[${agent.id}] planner call exhausted retries (${msg}). ` +
            (isLast
              ? "All fallback agents exhausted; planner-phase will fail."
              : `Trying next fallback agent (${tried[i + 1].id}).`),
        );
      }
    }
    throw lastErr ?? new Error("all planner fallbacks exhausted");
  }

  private async promptAgent(
    agent: Agent,
    prompt: string,
    agentName: "swarm" | "swarm-read" = "swarm",
    modelOverride?: string,
    // Task #196: default to "json" since virtually every blackboard
    // prompt (planner contract, worker hunks, auditor verdict, replanner)
    // expects JSON output. Pass "free" if a future prompt legitimately
    // produces prose. Sniff only fires after 2048 chars accumulated, so
    // short answers pass through naturally.
    formatExpect: "json" | "free" = "json",
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
          void agent.client.session.abort({ path: { id: agent.sessionId } }).catch(() => {});
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
        // Task #195: planner-fallback uses fallback agent's session as
        // transport but should run the planner's model — without this
        // the worker's model gets a planner JSON prompt and produces
        // wrong-format hallucinated markdown for the entire turn cap.
        modelOverride,
        // Task #196: defense-in-depth even with #195 — early-format
        // sniff aborts wrong-format responses in ~10s instead of waiting
        // for the absolute turn cap to fire at 1200s.
        formatExpect,
        onTokens: ({ promptTokens, responseTokens }) => {
          if (promptTokens > 0) this.promptTokensPerAgent.set(agent.id, (this.promptTokensPerAgent.get(agent.id) ?? 0) + promptTokens);
          if (responseTokens > 0) this.responseTokensPerAgent.set(agent.id, (this.responseTokensPerAgent.get(agent.id) ?? 0) + responseTokens);
        },
        agentName,
        describeError: (e) => this.describeSdkError(e),
        sleep: (ms, sig) => this.interruptibleSleep(ms, sig),
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
      const msg = abortedReason ?? this.describeSdkError(err);
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

  // Resolves true if the full delay elapsed, false if `signal` aborted first.
  // Used by the prompt-retry loop so a user stop / cap trip / watchdog can
  // short-circuit the backoff instead of making the run wait 20+ seconds to
  // notice it's cancelled.
  private interruptibleSleep(ms: number, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve(true);
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        resolve(false);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private appendSystem(text: string, summary?: TranscriptEntrySummary): void {
    const entry: TranscriptEntry = { id: randomUUID(), role: "system", text, ts: Date.now(), summary };
    this.transcript.push(entry);
    this.opts.emit({ type: "transcript_append", entry });
  }

  private appendAgent(agent: Agent, text: string): void {
    // Unit 54: attach a structured summary when the response parses
    // as a known JSON envelope. UI uses this to collapse worker
    // hunks/skips into a one-line summary by default.
    const summary = summarizeAgentResponse(text);
    const entry: TranscriptEntry = {
      id: randomUUID(),
      role: "agent",
      agentId: agent.id,
      agentIndex: agent.index,
      text: text || "(empty response)",
      ts: Date.now(),
      summary,
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

  private describeSdkError(err: unknown): string {
    if (err instanceof Error) {
      const parts: string[] = [err.message];
      let cause: unknown = (err as { cause?: unknown }).cause;
      let depth = 0;
      while (cause && depth < 4) {
        if (cause instanceof Error) {
          const code = (cause as { code?: string }).code;
          parts.push(code ? `${cause.message} [${code}]` : cause.message);
          cause = (cause as { cause?: unknown }).cause;
        } else {
          parts.push(String(cause));
          cause = undefined;
        }
        depth++;
      }
      return parts.join(" <- ");
    }
    if (err && typeof err === "object") {
      const o = err as { name?: string; message?: string };
      const head = o.name ? `${o.name}: ` : "";
      if (o.message) return head + o.message;
      try {
        return head + JSON.stringify(o).slice(0, 500);
      } catch {
        return head + String(err);
      }
    }
    return String(err);
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


// Task #67: small helper to bump a per-agent counter Map without
// repeating the `(map.get(id) ?? 0) + 1` pattern at every call site.
// Mutates in place; no return value.
function bumpAgentCounter(m: Map<string, number>, agentId: string): void {
  m.set(agentId, (m.get(agentId) ?? 0) + 1);
}

// Task #70: word-boundary symbol grounding. For each declared
// expectedSymbol, read each expectedFile and grep for the symbol as
// a whole word (\bsym\b). The symbol is "found" if it appears in
// AT LEAST ONE of the todo's expectedFiles — the planner often
// declares two files where one contains the symbol and the other
// will receive the new edit. Files that don't exist on disk count
// as "not found" but are NOT a strike against the symbol (could be
// a create-style todo). Returns ok=true if every symbol is found
// in some file, or ok=false with the missing list otherwise.
async function checkExpectedSymbols(
  todo: { description: string; expectedFiles: string[]; expectedSymbols?: string[] },
  clonePath: string,
): Promise<{ ok: true } | { ok: false; missing: Array<{ symbol: string; file: string }> }> {
  const symbols = todo.expectedSymbols;
  if (!symbols || symbols.length === 0) return { ok: true };
  // Pre-read all expectedFiles once — avoid re-reading per symbol.
  const fileContents = new Map<string, string>();
  let anyFileExists = false;
  for (const file of todo.expectedFiles) {
    try {
      const text = await fs.readFile(path.join(clonePath, file), "utf8");
      fileContents.set(file, text);
      anyFileExists = true;
    } catch {
      // Doesn't exist — skip. Probably a create-style todo for this file.
    }
  }
  // If NO expectedFile exists, this is a pure create todo — symbol
  // grounding can't apply. Allow.
  if (!anyFileExists) return { ok: true };
  const missing: Array<{ symbol: string; file: string }> = [];
  for (const sym of symbols) {
    // Escape regex metachars; word-boundary on both sides for whole-
    // word match. \b is a Unicode-poor approximation but matches the
    // common JS/TS identifier shape (letters + digits + _).
    const escaped = sym.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}\\b`);
    let foundIn: string | null = null;
    for (const [file, text] of fileContents.entries()) {
      if (re.test(text)) {
        foundIn = file;
        break;
      }
    }
    if (!foundIn) {
      // Report against the FIRST existing file for the finding text
      // (the planner declared multiple — if missing from all of them,
      // pointing at one is enough context).
      const firstExisting = todo.expectedFiles.find((f) => fileContents.has(f)) ?? todo.expectedFiles[0];
      missing.push({ symbol: sym, file: firstExisting });
    }
  }
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true };
}

// Task #66: count line-equivalents in a hunk's text. Empty string → 0.
// Trailing-newline-tolerant: "a\nb" and "a\nb\n" both count as 2 lines.
// Used for per-agent linesAdded / linesRemoved attribution.
function countNewlines(s: string): number {
  if (!s) return 0;
  // Strip a single trailing \n so "a\n" doesn't count as 2 lines.
  const trimmed = s.endsWith("\n") ? s.slice(0, -1) : s;
  if (trimmed.length === 0) return 0;
  return trimmed.split("\n").length;
}

// Task #164 (refactor): parseGoalList moved to ./goalListParser.ts.
// Re-exported here for back-compat with any external consumer that
// previously imported it from BlackboardRunner.
export { parseGoalList } from "./goalListParser.js";
