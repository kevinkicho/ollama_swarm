import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import * as nodePath from "node:path";
import type { AgentManager } from "./AgentManager.js";
import type { RepoService } from "./RepoService.js";
import type { AgentState, SwarmEvent, SwarmPhase, SwarmStatus, SwarmStatusRunConfig } from "../types.js";
import type { PresetId, RunConfig, RunnerOpts, SwarmRunner } from "../swarm/SwarmRunner.js";

import { roleForAgent, selectRoleCatalog } from "../swarm/roles.js";
import { ConformanceMonitor } from "./ConformanceMonitor.js";
import { EmbeddingDriftMonitor } from "./EmbeddingDriftMonitor.js";
import { tokenTracker } from "./ollamaProxy.js";
import { setupConformanceAndDriftMonitors as setupConformanceAndDriftMonitorsExtracted } from "./orchestratorMonitors.js";
import { createWrappedEmit as createWrappedEmitExtracted } from "./orchestratorEmit.js";
import { AmendmentsBuffer, type Amendment } from "./AmendmentsBuffer.js";
import {
  applyRunReconfig,
  type RunReconfigPatch,
  type RunReconfigResult,
} from "../swarm/runReconfig.js";
import { RunStatePersister, findRecoverableRuns, isRecoverablePhase, loadSnapshot, type RecoverableRun } from "./RunStatePersister.js";
import { tryAcquireLock, releaseLock } from "../swarm/cloneLock.js";
import { config } from "../config.js";
import { createLogger, rootLogger } from "./logger.js";
import { ActiveRun } from "./ActiveRun.js";
import { RunEventHub } from "./RunEventHub.js";
import { prepareResearchConfig, isResearchRun } from "../swarm/researchHelpers.js";
import { BrainIntegration } from "./BrainIntegration.js";
import {
  mergeKnownParents,
  scanForRunParents,
  readPersistedLastParent,
  writePersistedLastParent,
  readPersistedKnownParents,
  writePersistedKnownParents,
  KNOWN_PARENTS_MAX,
} from "./knownParents.js";
import { statusForRun as statusForRunExtracted } from "./statusForRun.js";
import { buildSwarmStatusRunConfig } from "./orchestratorRunConfig.js";

// Re-export pure helpers for existing tests (Orchestrator.test.ts).
export { mergeKnownParents, scanForRunParents, KNOWN_PARENTS_MAX };

/** Thrown when a second start targets a clone that already has an active run. */
export class WorkspaceBusyError extends Error {
  readonly code = "workspace_busy" as const;
  constructor(
    readonly activeRunId: string,
    readonly localPath: string,
  ) {
    super(
      `Another run ${activeRunId} is already active on this workspace (${localPath}). ` +
      `Stop it first, or start the second run from a different parent path for true concurrency.`,
    );
    this.name = "WorkspaceBusyError";
  }
}

export interface OrchestratorOpts {
  /**
   * One RunEventHub per run with all sinks (WS / event log / debug).
   * Manager + runners share this hub — never create a second sink-less hub.
   */
  createHub: (runId: string) => RunEventHub;
  /** Mint one AgentManager per run bound to the run's hub. */
  createManager: (runId: string, hub: RunEventHub) => AgentManager;
  repos: RepoService;
  emit: (e: SwarmEvent) => void;
  logDiag?: (record: unknown) => void;
  ollamaBaseUrl?: string;
  /** T-Item-MultiTenant Phase 4 (2026-05-04): max concurrent runs.
   *  Default 4 (when unset). When the orchestrator's run map size
   *  hits this number, start() throws "cap reached". The route layer
   *  reads config.SWARM_MAX_CONCURRENT_RUNS to set this. */
  maxConcurrentRuns?: number;
}

/** Per-run context threaded into buildRunner so wrappedEmit and the
 *  runner's AgentManager stay bound to one runId under concurrency. */
interface BuildRunnerContext {
  runId: string;
  startedAt: number;
  persister: RunStatePersister;
  manager: AgentManager;
  getRunner: () => SwarmRunner;
  hub?: RunEventHub;
}

// Re-exported so callers (routes/swarm.ts, index.ts) don't have to reach into
// the swarm/ namespace to pass a RunConfig.
export type { RunConfig };

// T-Item-MultiTenant Phase 3 (2026-05-04): per-active-run record.
// Aggregates everything the orchestrator tracks PER run. Cross-run
// state (lastParentPath, knownParentPaths, the amendments buffer)
// stays at the orchestrator level.
//
// Phase 3 keeps the cap at 1 (start() rejects when the map is non-
// empty). Phase 4 relaxes the cap to N concurrent runs.
// interface ActiveRun has been moved to ActiveRun.ts for RAII
// type ActiveRun = import("./ActiveRun.js").ActiveRun;
// Per-run state is now managed by the ActiveRun class (see ActiveRun.ts)
// for centralized RAII cleanup. The map below holds instances of it.

// Thin preset dispatcher. Holds the active runs (Phase 3: max 1 by
// design; Phase 4 will relax to N) and delegates the public surface
// to whichever run the caller targets. State per run lives on the
// runner + the ActiveRun record.
export class Orchestrator {
  private readonly log = createLogger();

  // T-Item-MultiTenant Phase 3 (2026-05-04): runs keyed by runId.
  // Insertion order is most-recent-LAST so legacy single-arg APIs
  // (status() / stop() / injectUser without runId) can resolve to
  // the most-recently-started run without an explicit "active"
  // pointer. Capped at 1 in Phase 3; Phase 4 relaxes.
  private runs = new Map<string, ActiveRun>();
  /** Disk-resolved /status snapshots (post-restart deep links). */
  private statusForRunDiskCache = new Map<string, { status: SwarmStatus; at: number }>();
  private static readonly STATUS_FOR_RUN_DISK_CACHE_TTL_MS = 60_000;
  // After a run completes, its clonePath is retained here so that
  // statusForRun can fall back to the persister file on disk. Without
  // this, a page refresh after run completion would lose the contract.
  private runPaths = new Map<string, { clonePath: string; preset: string; startedAt: number }>();
  // Deeper extracted brain integration slice (brain chat histories, service, ready gate, history writer).
  private brain!: BrainIntegration;
  // 2026-04-24: parent dir of the last successfully-started run.
  // Survives stop() / completion (unlike runConfig + runId) so the
  // /api/swarm/runs route can keep showing historical runs from the
  // same parent dir even when no run is currently active. Without
  // this, the runs dropdown was empty between runs (the route had
  // no way to know where to look). Cleared only when a new start()
  // overwrites it — never on stop or terminal phase.
  // Persisted to /tmp/ollama-swarm-last-parent.txt so a dev-server
  // restart doesn't reset the dropdown to empty. Survives restart;
  // reset only on full host reboot (acceptable — user runs once
  // post-reboot and it's set again).
  private lastParentPath?: string = readPersistedLastParent();
  // #238 + #240: every parent path the user has started a run from,
  // most-recent first. Lets the runs/memory routes aggregate across
  // parents (so the dropdown isn't empty when the user picks a fresh
  // parent dir, even though they have plenty of prior runs elsewhere).
  // #293: backfill from a project-relative scan so a /tmp wipe doesn't
  // invisibly truncate this list. Persisted entries take precedence
  // (LRU recency); scanned entries fill in the rest.
  private knownParentPaths: string[] = mergeKnownParents(
    readPersistedKnownParents(),
    scanForRunParents(process.cwd()),
  );
  // #299: per-run buffer of user-submitted directive amendments.
  // Opened on run start; runner reads via getAmendments(); closed on
  // run end (success OR failure). Already runId-keyed so it survives
  // the multi-tenant refactor unchanged.
  private readonly amendments = new AmendmentsBuffer();

  // Gate to prevent concurrent start() calls from bypassing the cap.
  private startInProgress = false;

  /** T-Item-MultiTenant Phase 3 (2026-05-04): resolve "the active
   *  run" for legacy single-arg APIs (status / stop / injectUser
   *  without runId). Picks the MOST-RECENTLY-INSERTED entry, which
   *  with insertion-order Maps is the last value. Returns null when
   *  no runs are active. */
  private get activeRun(): ActiveRun | null {
    let last: ActiveRun | null = null;
    for (const r of this.runs.values()) last = r;
    return last;
  }

  // Backward-compat getters for the per-run fields the orchestrator
  // body still references in many places. Each reads from activeRun.
  // Phase 3 keeps cap=1 so "active run" is unambiguous; Phase 4 will
  // still use these for legacy single-arg APIs but per-runId APIs
  // (Phase 5) target a specific entry via runId.
  private get runner(): SwarmRunner | null { return this.activeRun?.runner ?? null; }
  private get runId(): string | undefined { return this.activeRun?.runId; }
  private get runConfig(): SwarmStatusRunConfig | undefined { return this.activeRun?.runConfig; }
  private get runStartedAt(): number | undefined { return this.activeRun?.startedAt; }
  private get conformanceMonitor(): ConformanceMonitor | undefined {
    return this.activeRun?.conformanceMonitor;
  }
  private get embeddingDriftMonitor(): EmbeddingDriftMonitor | undefined {
    return this.activeRun?.embeddingDriftMonitor;
  }
  private get runStatePersister(): RunStatePersister | undefined {
    return this.activeRun?.persister;
  }

  constructor(private readonly opts: OrchestratorOpts) {
    // Persist the merged list back so the next read is consistent
    // even if the project gets moved or the cwd changes.
    if (this.knownParentPaths.length > 0) {
      writePersistedKnownParents(this.knownParentPaths);
    }

    // Deeper slice: instantiate extracted BrainIntegration (replaces inline brain fields/methods).
    this.brain = new BrainIntegration({
      maxConcurrentRuns: this.opts.maxConcurrentRuns,
      // Base WS/diag emit only — BrainIntegration routes to the correct
      // per-run hub via event.runId (multi-tenant safe).
      emit: (e: any) => {
        this.opts.emit(e);
      },
      getLiveRunCount: () => this.countLiveRuns(),
      getRunsSize: () => this.runs.size,
      getStartInProgress: () => this.startInProgress,
      getActiveRun: () => this.activeRun,
      getRunById: (id: string) => this.runs.get(id),
      startRun: (cfg: RunConfig) => this.start(cfg),
    });
  }

  /** Await brain service initialization before serving brain routes. (delegated to deeper extracted slice) */
  async whenBrainReady(): Promise<void> {
    await this.brain.whenReady();
  }

  getActiveRunCount(): number {
    return this.countLiveRuns();
  }

  /** Runs whose runner still reports isRunning() (excludes terminal ghosts). */
  private countLiveRuns(): number {
    let n = 0;
    for (const run of this.runs.values()) {
      if (run.isRunning()) n++;
    }
    return n;
  }

  /**
   * Resolve an active run by exact id only. Prefix matching was removed —
   * under concurrency it could stop/drain the wrong run.
   */
  private getRunExact(runId: string): ActiveRun | undefined {
    if (!runId) return undefined;
    return this.runs.get(runId);
  }

  /**
   * Unified remove path: teardown ActiveRun + drop from the map.
   * Keeps runPaths for post-run status/history.
   */
  private async removeRun(
    run: ActiveRun,
    opts: {
      stopRunner?: boolean;
      terminalPhase?: import("../types.js").SwarmPhase;
      terminalReason?: string;
    } = {},
  ): Promise<void> {
    tokenTracker.setCurrentPreset(undefined, run.runId);
    const stillRunning = run.isRunning();
    await run.teardown({
      stopRunner: opts.stopRunner ?? stillRunning,
      terminalPhase: opts.terminalPhase,
      terminalReason: opts.terminalReason,
    });
    this.runs.delete(run.runId);
  }

  setBrainChatHistory(runId: string, history: Array<{ role: string; content: string }>) {
    this.brain.setChatHistory(runId, history);
  }

  getBrainChatHistory(runId: string): Array<{ role: string; content: string }> | undefined {
    return this.brain.getChatHistory(runId);
  }

  /** Clone paths from active and recently completed runs. */
  getTrackedClonePaths(): string[] {
    const paths = new Set<string>();
    for (const run of this.runs.values()) {
      if (run.cfg.localPath) paths.add(nodePath.resolve(run.cfg.localPath));
    }
    for (const info of this.runPaths.values()) {
      paths.add(nodePath.resolve(info.clonePath));
    }
    return [...paths];
  }

  /** Drop runs that reached a terminal phase but remain in the map.
   *  Must NOT call runner.stop() — that rewrites the summary as user-stopped
   *  and used to kill booting runs (phase idle) when a second start ran
   *  cleanup before runner.start() advanced phase. Uses dispose/teardown
   *  with stopRunner:false so clone lock + amendments still release. */
  private async cleanupStaleRuns(): Promise<void> {
    for (const [id, run] of [...this.runs.entries()]) {
      if (run.isRunning()) continue;
      const phase = run.runner.status?.().phase ?? "idle";
      const terminal =
        phase === "stopped" || phase === "completed" || phase === "failed";
      if (!terminal) continue;
      // stopRunner:false — runner already terminal; only free resources.
      await run.teardown({ stopRunner: false, ensureSummary: true });
      this.runs.delete(id);
    }
  }

  private aggregateAgentStates(): AgentState[] {
    const states: AgentState[] = [];
    for (const run of this.runs.values()) {
      states.push(...run.manager.toStates());
    }
    return states;
  }

  status(): SwarmStatus {
    if (this.runner) {
      const runnerStatus = this.runner.status();
      // Unit 62: stitch the orchestrator-level runId into the snapshot.
      // Leave runnerStatus.runId untouched if the runner already set one
      // (defensive — currently no runner does, but keeps the merge safe).
      // Pattern 9: same merge for runConfig + runStartedAt so the AgentPanel
      // role helper has cfg.preset to pick "drafter" / "mapper" / etc. even
      // for runs the runner itself doesn't surface runConfig for.
      return {
        ...runnerStatus,
        runId: runnerStatus.runId ?? this.runId,
        runConfig: this.mergeRunConfig(this.runConfig, runnerStatus.runConfig),
        runStartedAt: runnerStatus.runStartedAt ?? this.runStartedAt,
        regions: this.computeRegions(runnerStatus),
      };
    }
    return {
      phase: "idle",
      round: 0,
      agents: this.aggregateAgentStates(),
      transcript: [],
    };
  }

  private computeRegions(status: SwarmStatus): import("../types.js").RegionStatus {
    const agents = status.agents;
    const thinking = agents.filter((a) => a.status === "thinking").length;
    const plannerThinking = agents.length > 0 && agents[0].status === "thinking";
    const phase = status.phase;
    let lifecycle: import("../types.js").RegionStatus["lifecycle"] = "idle";
    if (phase === "booting") lifecycle = "booting";
    else if (phase === "draining") lifecycle = "draining";
    else if (phase === "stopped" || phase === "completed") lifecycle = "stopped";
    else if (phase !== "idle") lifecycle = "active";

    let capsPaused = false;
    let capsReason: import("../types.js").RegionStatus["caps"]["reason"];
    if (status.phase === "paused") {
      capsPaused = true;
      // Runner-specific cap flags aren't in SwarmStatus — best-effort from known paused reasons
      capsReason = "quota"; // most common reason; refine later when runner exposes cap detail
    }

    const board = status.board?.counts;
    return {
      lifecycle,
      planner: plannerThinking ? "thinking" : (phase !== "idle" && phase !== "stopped" && phase !== "completed") ? "waiting" : "idle",
      workers: {
        total: agents.length > 0 ? agents.length - 1 : 0, // exclude lead (index 1)
        thinking: thinking,
        idle: agents.length - thinking,
      },
      queue: {
        open: board?.open ?? 0,
        claimed: board?.claimed ?? 0,
        committed: board?.committed ?? 0,
        stale: board?.stale ?? 0,
      },
      caps: { paused: capsPaused, reason: capsReason },
    };
  }

  isRunning(): boolean {
    return this.runner?.isRunning() ?? false;
  }

  /** #299: append a user-submitted amendment to the active run.
   *  Returns the stored amendment, or null when there's no active
   *  run / the runId doesn't match / the text is empty. Emits a
   *  directive_amended SwarmEvent on success so all WS-connected
   *  tabs mirror the addition + the runner's next prompt picks it
   *  up via getAmendments(). */
  addAmendment(runId: string, text: string): Amendment | null {
    if (!this.runs.has(runId)) return null;
    const stored = this.amendments.add(runId, text);
    if (stored) {
      this.opts.emit({
        type: "directive_amended",
        runId,
        ts: stored.ts,
        text: stored.text,
      });
    }
    return stored;
  }

  /** Extend mid-run limits (rounds, wall-clock cap, token budget).
   *  Also allowed briefly while stopping/draining so Brain RECONFIG still
   *  applies after the UI has flipped to a soft-terminal phase. */
  reconfigRun(runId: string, patch: RunReconfigPatch): RunReconfigResult | null {
    const run = this.runs.get(runId);
    if (!run) return null;
    const running = run.runner.isRunning();
    let softTerminal = false;
    if (!running) {
      try {
        const phase = run.runner.status?.()?.phase;
        softTerminal =
          phase === "stopping"
          || phase === "draining"
          || phase === "paused";
      } catch {
        softTerminal = false;
      }
    }
    if (!running && !softTerminal) return null;

    const applied = applyRunReconfig(run.cfg, patch, { startedAt: run.startedAt });
    if (!applied.ok) return applied;

    if (applied.changes.rounds) {
      run.runConfig.rounds = applied.changes.rounds.to;
    }
    if (applied.changes.wallClockCapMs) {
      run.runConfig.wallClockCapMin = String(Math.round(applied.changes.wallClockCapMs.to / 60_000));
    }

    // When soft-terminal, still patch cfg for any residual loop; runner may ignore.
    try {
      run.runner.reconfig?.(applied.changes);
      run.runner.appendSystemMessage?.(applied.message);
    } catch {
      /* runner tearing down */
    }

    this.opts.emit({
      type: "run_reconfigured",
      runId,
      ts: Date.now(),
      message: applied.message,
      changes: applied.changes,
    });

    return applied;
  }

  /** #299: read all amendments for a run, oldest first. Used by the
   *  runner to weave them into prompts. Defensive copy. */
  getAmendments(runId: string): Amendment[] {
    return this.amendments.list(runId);
  }

  // Returns the parent dir of the last successfully-started run.
  // Used by /api/swarm/runs to keep listing historical summaries
  // when no run is currently active.
  getLastParentPath(): string | undefined {
    return this.lastParentPath;
  }

  /** T-Item-MultiTenant Phase 4 (2026-05-04): list every currently
   *  active run. Returned in insertion order (oldest-started first).
   *  The legacy single-run REST routes call activeRun (most-recent);
   *  multi-tenant aware UIs call this to list ALL active runs. */
  listActiveRuns(): Array<{
    runId: string;
    runConfig: SwarmStatusRunConfig;
    startedAt: number;
    isRunning: boolean;
    createdBy: string;
    brainInitiated?: boolean;
    brainProposalId?: string;
    /** Live runner phase for multi-tenant ActiveRunsPanel honesty. */
    phase?: string;
    earlyStopDetail?: string;
    drainEligible?: boolean;
  }> {
    const out: Array<{
      runId: string;
      runConfig: SwarmStatusRunConfig;
      startedAt: number;
      isRunning: boolean;
      createdBy: string;
      brainInitiated?: boolean;
      brainProposalId?: string;
      phase?: string;
      earlyStopDetail?: string;
      drainEligible?: boolean;
    }> = [];
    for (const r of this.runs.values()) {
      if (!r.runner.isRunning()) continue; // only truly active runs
      let phase: string | undefined;
      let earlyStopDetail: string | undefined;
      let drainEligible: boolean | undefined;
      try {
        const st = r.runner.status() as {
          phase?: string;
          earlyStopDetail?: string;
          drainEligible?: boolean;
        };
        phase = st.phase;
        earlyStopDetail = st.earlyStopDetail;
        drainEligible = st.drainEligible;
      } catch {
        /* status() best-effort — list still works */
      }
      out.push({
        runId: r.runId,
        runConfig: r.runConfig,
        startedAt: r.startedAt,
        isRunning: r.runner.isRunning(),
        createdBy: r.cfg.createdBy ?? "default",
        brainInitiated: !!r.cfg.brainInitiated,
        brainProposalId: r.cfg.brainProposalId,
        phase,
        earlyStopDetail,
        drainEligible,
      } as any);
    }
    return out;
  }

  /** T-Item-MultiTenant Phase 5 (2026-05-04): status snapshot for ONE
   *  run (vs the single-run status() which targets activeRun).
   *  Falls back to the persister file on disk when the run is no longer
   *  in memory (completed + cleaned up). This ensures page refreshes
   *  after run completion still get the contract, summary, etc. */
  private cacheDiskStatusForRun(runId: string, status: SwarmStatus): SwarmStatus {
    this.statusForRunDiskCache.set(runId, { status, at: Date.now() });
    return status;
  }

  /** Live runner snapshots may omit tooling fields; keep orchestrator start cfg as base. */
  private mergeRunConfig(
    stored?: SwarmStatusRunConfig,
    live?: SwarmStatusRunConfig,
  ): SwarmStatusRunConfig | undefined {
    if (!stored && !live) return undefined;
    if (!stored) return live;
    if (!live) return stored;
    return { ...stored, ...live };
  }

  statusForRun(runId: string): SwarmStatus | null {
    return statusForRunExtracted(
      {
        runs: this.runs,
        runPaths: this.runPaths,
        knownParentPaths: this.knownParentPaths,
        getLastParentPath: () => this.getLastParentPath(),
        mergeRunConfig: (a, b) => this.mergeRunConfig(a, b),
        computeRegions: (s) => this.computeRegions(s),
        cacheDiskStatusForRun: (id, st) => this.cacheDiskStatusForRun(id, st),
        getDiskCache: (id) => this.statusForRunDiskCache.get(id),
        diskCacheTtlMs: Orchestrator.STATUS_FOR_RUN_DISK_CACHE_TTL_MS,
        repos: this.opts.repos,
      },
      runId,
    );
  }

  /** T-Item-MultiTenant Phase 5 (2026-05-04): inject for ONE run.
   *  Returns true on success, false when the runId isn't active. */
  injectUserForRun(
    runId: string,
    text: string,
    opts?: { intent?: "suggest" | "steer" | "ask"; targetAgent?: string },
  ): boolean {
    const run = this.runs.get(runId);
    if (!run) return false;
    const intent = opts?.intent ?? "steer";
    run.runner.injectUser(text, opts);
    if (text.trim().length > 0 && intent === "steer") {
      this.amendments.add(runId, text);
    }
    return true;
  }

  /** W16 wiring (R7 promotion, 2026-05-04): set/clear the
   *  subscriber-disconnect pause flag on a specific runner. Called by
   *  the WS Broadcaster's subscriber-change listener when count
   *  crosses 0 ↔ N. Currently only BlackboardRunner implements the
   *  flag — calls on other runner types are silently no-ops (their
   *  setSubscriberPaused is undefined; the optional-chaining guard
   *  keeps it safe). */
  setRunSubscriberPaused(runId: string, paused: boolean): void {
    const run = this.runs.get(runId);
    if (!run) return;
    const r = run.runner as { setSubscriberPaused?: (paused: boolean) => void };
    r.setSubscriberPaused?.(paused);
  }

  /** T-Item-MultiTenant Phase 5 (2026-05-04): stop ONE run by id.
   *  Returns true on success, false when runId isn't active. Exact id only. */
  async stopRun(runId: string): Promise<boolean> {
    const run = this.getRunExact(runId);
    if (!run) {
      // Already terminated (exact id known from runPaths) → successful no-op.
      if (runId && this.runPaths.has(runId)) return true;
      return false;
    }
    const live = run.isRunning();
    await this.removeRun(run, {
      stopRunner: live,
      // Only force "stopped" when we actually interrupt a live run —
      // natural-complete ghosts keep their completed summary.
      ...(live
        ? { terminalPhase: "stopped" as const, terminalReason: "user-stop" }
        : {}),
    });
    return true;
  }

  // #238 + #240: union of every parent dir the user has ever started
  // a run from this session (or in prior sessions, persisted). Used
  // by /api/swarm/runs?includeOtherParents=true and /api/swarm/memory
  // aggregation so the UI can show prior runs even when the active
  // parent is fresh. Most-recent first.
  getKnownParentPaths(): string[] {
    return [...this.knownParentPaths];
  }

  /** P6: Get the brain service for system-level operations. (delegated) */
  getBrainService() {
    return this.brain.getService();
  }

  /** T-Item-Recovery (2026-05-04): scan known parent dirs for
   *  run-state.json snapshots. Filters out terminal-phase snapshots
   *  (those represent runs that finished cleanly; the snapshot just
   *  hasn't been cleaned up). Returns mid-flight snapshots only.
   *  Active runs in this orchestrator are EXCLUDED — no point
   *  offering to "recover" a run that's currently running. */
  listRecoverableRuns(): RecoverableRun[] {
    const all = findRecoverableRuns(this.knownParentPaths);
    const activeIds = new Set<string>();
    for (const r of this.runs.values()) activeIds.add(r.runId);
    return all.filter(
      (r) => isRecoverablePhase(r.phase) && !activeIds.has(r.runId),
    );
  }

  /** T-Item-Recover (2026-05-04): kick a fresh run using the cfg
   *  saved in a recoverable snapshot. The new run gets a NEW runId
   *  (it's a new run, not a restored runner) but uses the SAME cfg
   *  the original was started with. The clone path is preserved on
   *  disk so prior commits stay; the snapshot's transcript is
   *  returned to the caller so the UI can surface "this is what
   *  happened before".
   *
   *  Returns the new runId + the prior transcript on success.
   *  Throws on:
   *    - snapshot file unreadable / unparseable
   *    - schemaVersion < 2 (no cfg embedded; can't reconstruct)
   *    - the runner's start() failure (cap reached, etc.) */
  async recoverRun(originalRunId: string): Promise<{
    newRunId: string;
    priorTranscript: unknown[];
    priorAmendments: Array<{ ts: number; text: string }>;
    priorBrainChatHistory?: Array<{ role: string; content: string }>;
  }> {
    const all = findRecoverableRuns(this.knownParentPaths);
    const target = all.find((r) => r.runId === originalRunId);
    if (!target) {
      throw new Error(
        `recover: no recoverable snapshot found for runId=${originalRunId}`,
      );
    }
    const snap = loadSnapshot(target.stateFilePath);
    if (!snap) {
      throw new Error(
        `recover: failed to load snapshot at ${target.stateFilePath}`,
      );
    }
    if (snap.schemaVersion < 2 || !snap.runConfig) {
      throw new Error(
        `recover: snapshot at ${target.stateFilePath} predates schema v2 (no cfg embedded); cannot auto-resume. Use the SetupForm to start a new run on this clone.`,
      );
    }
    // Reconstruct RunConfig from the persisted shape.
    const persistedCfg = snap.runConfig;
    const cfg: RunConfig = {
      preset: persistedCfg.preset as PresetId,
      repoUrl: persistedCfg.repoUrl,
      localPath: persistedCfg.localPath,
      agentCount: persistedCfg.agentCount,
      rounds: persistedCfg.rounds,
      model: persistedCfg.model,
      ...(persistedCfg.extras ?? {}),
    };
    // Forward to start(); it mints a new runId + handles the cap +
    // wires monitors. The persister for the NEW run will overwrite
    // the snapshot file naturally as events fire.
    const newRunId = await this.start(cfg);
    return {
      newRunId,
      priorTranscript: snap.transcript,
      priorAmendments: snap.amendments,
      priorBrainChatHistory: snap.brainChatHistory,
    };
  }

  injectUser(
    text: string,
    opts?: { intent?: "suggest" | "steer" | "ask"; targetAgent?: string },
  ): void {
    const intent = opts?.intent ?? "steer";
    this.runner?.injectUser(text, opts);
    // #119 (2026-05-01): also feed the AmendmentsBuffer so blackboard's
    // planner picks up the chat as a mid-run nudge on its next turn.
    // Pre-fix: /api/swarm/say only landed in runner.transcript (display
    // only); only /api/swarm/amend reached the amendments buffer; the
    // UI never called /amend. Effect was that 7/10 runners surfaced
    // chat as `[HUMAN]` lines (council, debate-judge, mapreduce, ow,
    // ow-deep, round-robin, stigmergy) but blackboard + moa silently
    // dropped it. Dual-write here lets blackboard's
    // directiveWithAmendments() see chat without changing the UI.
    //
    // 2026-05-02: skip the amendments dual-write for intent="ask" and
    // intent="suggest". "ask" is a question to be answered inline (NOT
    // a directive change); "suggest" is low-pressure consideration that
    // should NOT force the planner to reshape its contract. Only "steer"
    // (the default) carries the original mid-run-nudge force.
    if (this.runId && text.trim().length > 0 && intent === "steer") {
      this.amendments.add(this.runId, text);
    }
  }

  async start(cfg: RunConfig): Promise<string> {
    // Gate: prevent concurrent start() calls from bypassing the cap.
    if (this.startInProgress) {
      throw new Error("A run is already being started. Wait for it to complete.");
    }
    this.startInProgress = true;

    let runId: string | undefined;
    /** True after tryAcquireLock succeeds and ownership not yet transferred to ActiveRun. */
    let orphanCloneLock = false;
    /** True after this.runs.set — ActiveRun owns the lock thereafter. */
    let registeredInMap = false;

    try {
      // T-Item-MultiTenant Phase 4 (2026-05-04): cap on concurrent runs.
      await this.cleanupStaleRuns();
      const cap = this.opts.maxConcurrentRuns ?? 4;
      const live = this.countLiveRuns();
      if (live >= cap) {
        throw new Error(
          `Concurrent-run cap reached (${live}/${cap}). Stop a run before starting another.`,
        );
      }
      // Drift check: validate prompt assertions before starting the run.
      // Non-blocking — drift warnings are informational.
      {
        try {
          const { checkPromptDrift } = await import("../swarm/blackboard/prompts/driftGuard.js");
          const drift = await checkPromptDrift();
          if (!drift.ok) {
            const names = [...new Set(drift.failures.map((f) => f.prompt))].join(", ");
            this.log.warn("prompt drift detected", {
              failed: drift.failedAssertions,
              total: drift.totalAssertions,
              names,
              runId,
            });
          }
        } catch {
          // best-effort
        }
      }

      runId = randomUUID();
      // Single hub for the whole run: manager control plane + runner domain events.
      const runHub = this.opts.createHub(runId);
      cfg.runId = runId;
      this.brain.registerClonePath(cfg.localPath);

      const resolvedLocal = nodePath.resolve(cfg.localPath);
      for (const [otherId, otherRun] of this.runs.entries()) {
        if (nodePath.resolve(otherRun.cfg.localPath) === resolvedLocal) {
          throw new WorkspaceBusyError(otherId, cfg.localPath);
        }
      }

      const lockResult = tryAcquireLock({ clonePath: cfg.localPath, runId });
      if (!lockResult.acquired) {
        const heldBy = lockResult.heldBy
          ? ` (held by pid=${lockResult.heldBy.pid} runId=${lockResult.heldBy.runId} on ${lockResult.heldBy.hostname})`
          : "";
        throw new Error(
          `Clone path is locked by another swarm process${heldBy}. ${lockResult.reason}`,
        );
      }
      orphanCloneLock = true;

      const persister = new RunStatePersister(cfg.localPath);
      const startedAt = Date.now();
      const manager = this.opts.createManager(runId, runHub);
      const runHolder: { runner: SwarmRunner | null } = { runner: null };
      const buildCtx: BuildRunnerContext = {
        runId,
        startedAt,
        persister,
        manager,
        getRunner: () => runHolder.runner!,
        hub: runHub,
      };
      const runner = await this.buildRunner(cfg.preset, cfg, buildCtx);
      runHolder.runner = runner;

      tokenTracker.setCurrentPreset(cfg.preset, runId);
      tokenTracker.clearQuotaState(runId);

      let rolesForRunStarted: string[] | undefined;
      if (cfg.preset === "role-diff") {
        const catalog = selectRoleCatalog({
          customRoles: cfg.roles,
          userDirective: cfg.userDirective,
          dynamicRoles: cfg.dynamicRoles,
        });
        rolesForRunStarted = [];
        for (let i = 1; i <= cfg.agentCount; i++) {
          rolesForRunStarted.push(roleForAgent(i, catalog).name);
        }
      }

      const runConfig: SwarmStatusRunConfig = buildSwarmStatusRunConfig(cfg, rolesForRunStarted);
      const activeRun = this.createActiveRun(
        runId,
        startedAt,
        cfg,
        runConfig,
        runner,
        manager,
        persister,
        true, // holdsCloneLock — ownership transferred to ActiveRun
        runHub,
      );
      this.runs.set(runId, activeRun);
      registeredInMap = true;
      orphanCloneLock = false; // ActiveRun owns release now

      this.runPaths.set(runId, {
        clonePath: cfg.localPath,
        preset: cfg.preset,
        startedAt: Date.now(),
      });

      const parentOfLocal = nodePath.dirname(resolvedLocal);
      this.lastParentPath = parentOfLocal;
      writePersistedLastParent(this.lastParentPath);
      const parentsToRemember = [parentOfLocal, resolvedLocal];
      this.knownParentPaths = [
        ...parentsToRemember,
        ...this.knownParentPaths.filter((p) => !parentsToRemember.includes(p)),
      ].slice(0, 32);
      writePersistedKnownParents(this.knownParentPaths);

      this.opts.emit({
        type: "run_started",
        runId,
        startedAt,
        ...runConfig,
      });

      this.amendments.open(runId);

      const trimmedDirective = cfg.userDirective?.trim();
      this.setupConformanceAndDriftMonitors(activeRun, runId, trimmedDirective, cfg);

      // Fire-and-forget: HTTP /start returns runId immediately. Most discussion
      // presets also fire-and-forget their internal loop (void this.loop), so
      // runner.start() resolves after seed/spawn — NOT when the run is done.
      // We must wait until the runner is no longer live before reaping.
      void (async () => {
        try {
          await runner.start(cfg);
          // Discussion presets now await their loop inside start().
          // Backstop: waitUntilSettled / isRunning poll for any remaining
          // fire-and-forget children (or mid-stop races).
          if (typeof runner.waitUntilSettled === "function") {
            await runner.waitUntilSettled();
          }
          while (this.runs.has(runId!) && activeRun.isRunning()) {
            await new Promise((r) => setTimeout(r, 2_000));
          }
          if (cfg.chainTo && this.runs.has(runId!)) {
            // Chain may call stopRun; if it no-ops early, we still reap below.
            try {
              await this.scheduleForwardChain(cfg, runId!, runner, cfg.chainTo);
            } catch (chainErr) {
              this.log.warn("forward-chain failed", {
                runId,
                error: chainErr instanceof Error ? chainErr.message : String(chainErr),
              });
            }
          }
          // Natural completion (or chain finished without removing): free
          // lock + map slot without re-calling runner.stop().
          if (this.runs.has(runId!) && !activeRun.isTornDown() && !activeRun.isRunning()) {
            await this.removeRun(activeRun, { stopRunner: false });
          }
        } catch (err) {
          const rid = runId ?? "unknown";
          this.log.error("start inner failure for run", {
            runId: rid,
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
          });
          try {
            if (this.runs.has(rid)) {
              await this.removeRun(activeRun, {
                stopRunner: true,
                terminalPhase: "failed",
                terminalReason: "start-failed",
              });
            } else if (!activeRun.isTornDown()) {
              await activeRun.teardown({ stopRunner: true });
            }
          } catch (stopErr) {
            this.log.warn("stop after failure failed", { error: stopErr });
          }
          try {
            this.opts.emit({
              type: "error",
              message: `Start failed: ${err instanceof Error ? err.message : String(err)}`,
              runId: rid,
            } as any);
          } catch (emitErr) {
            this.log.warn("failed to emit start error", { error: emitErr });
          }
        }
      })();

      return runId;
    } catch (err) {
      // Setup failed before (or without) map registration — release orphan lock.
      if (orphanCloneLock && runId && cfg.localPath) {
        try {
          releaseLock({ clonePath: cfg.localPath, runId });
        } catch (lockErr) {
          this.log.warn("start-orphan-lock-release-failed", {
            error: lockErr instanceof Error ? lockErr.message : String(lockErr),
            runId,
          });
        }
        orphanCloneLock = false;
      }
      // If we registered then threw before fire-and-forget (unlikely), reap.
      if (registeredInMap && runId) {
        const run = this.runs.get(runId);
        if (run && !run.isTornDown()) {
          try {
            await this.removeRun(run, { stopRunner: false });
          } catch {
            /* ignore */
          }
        }
      }
      throw err;
    } finally {
      this.startInProgress = false;
    }
  }

  // Task #167: soft-stop entry point. If the active runner supports
  // drain() (blackboard/council/discussion/pipeline), use it; otherwise
  // fall through to hard stop. The runner manages its own escalation
  // deadline + watcher.
  async drain(): Promise<"soft" | "hard-fallback" | "idle"> {
    if (!this.runner) return "idle";
    if (typeof this.runner.drain === "function") {
      await this.runner.drain();
      return "soft";
    }
    await this.stop();
    return "hard-fallback";
  }

  /**
   * Per-run soft stop.
   * - `false` when runId isn't active and unknown
   * - `{ ok, mode: "soft" }` when runner.drain() ran
   * - `{ ok, mode: "hard-fallback" }` when runner has no drain (e.g. baseline)
   * - `{ ok, mode: "already-stopped" }` when path known but run map empty
   */
  async drainRun(
    runId: string,
  ): Promise<false | { ok: true; mode: "soft" | "hard-fallback" | "already-stopped" }> {
    const run = this.getRunExact(runId);
    if (!run) {
      // Already terminated (exact id known from runPaths) → successful no-op.
      if (runId && this.runPaths.has(runId)) {
        return { ok: true, mode: "already-stopped" };
      }
      return false;
    }
    if (typeof run.runner.drain === "function") {
      await run.runner.drain();
      return { ok: true, mode: "soft" };
    }
    const stopped = await this.stopRun(runId);
    return stopped ? { ok: true, mode: "hard-fallback" } : false;
  }

  /** Stop every active run (used by force-restart and shutdown). */
  async stopAll(): Promise<void> {
    const ids = [...this.runs.keys()];
    for (const id of ids) {
      await this.stopRun(id);
    }
  }

  /** Stop active runs on one clone only — used by force-restart on resume. */
  async stopRunsOnClonePath(localPath: string): Promise<string[]> {
    const target = nodePath.resolve(localPath);
    const stopped: string[] = [];
    for (const [id, run] of [...this.runs.entries()]) {
      if (nodePath.resolve(run.cfg.localPath) !== target) continue;
      await this.stopRun(id);
      stopped.push(id);
    }
    return stopped;
  }

  async stop(): Promise<void> {
    // Legacy single-arg API → most-recently-started run, same teardown as stopRun.
    const active = this.activeRun;
    if (!active) return;
    await this.stopRun(active.runId);
  }

  // T192 (2026-05-04): forward chain — see services/forwardChain.ts
  private async scheduleForwardChain(
    originalCfg: RunConfig,
    originalRunId: string,
    originalRunner: SwarmRunner,
    chainPreset: "blackboard" | "baseline",
  ): Promise<void> {
    const { scheduleForwardChain } = await import("./forwardChain.js");
    await scheduleForwardChain(
      {
        runsHas: (id) => this.runs.has(id),
        stopRun: (id) => this.stopRun(id),
        start: (cfg) => this.start(cfg),
        emit: (e) => this.opts.emit(e),
        warn: (msg, meta) => this.log.warn(msg, meta),
      },
      originalCfg,
      originalRunId,
      originalRunner,
      chainPreset,
    );
  }

  /**
   * Extracted monitor setup (conformance + drift) for cleaner start().
   * Monitors are attached to ActiveRun for proper RAII lifecycle.
   */
  private createActiveRun(
    runId: string,
    startedAt: number,
    cfg: RunConfig,
    runConfig: SwarmStatusRunConfig,
    runner: SwarmRunner,
    manager: AgentManager,
    persister: RunStatePersister,
    holdsCloneLock: boolean,
    runHub: RunEventHub,
  ): ActiveRun {
    return new ActiveRun(
      runId,
      startedAt,
      cfg,
      runConfig,
      runner,
      manager,
      persister,
      undefined,
      undefined,
      this.amendments,
      holdsCloneLock,
      runHub,
      this.opts.repos,
    );
  }

  private setupConformanceAndDriftMonitors(
    activeRun: ActiveRun,
    runId: string,
    trimmedDirective: string | undefined,
    cfg: RunConfig,
  ): void {
    setupConformanceAndDriftMonitorsExtracted({
      activeRun,
      runId,
      trimmedDirective,
      cfg,
      ollamaBaseUrl: this.opts.ollamaBaseUrl,
      emit: this.opts.emit,
      repos: this.opts.repos,
    });
  }

  private createWrappedEmit(params: {
    runId: string;
    startedAt: number;
    cfg: RunConfig;
    persister: RunStatePersister;
    hub?: RunEventHub;
    getRunner: () => SwarmRunner;
  }): (e: SwarmEvent) => void {
    return createWrappedEmitExtracted({
      ...params,
      baseEmit: this.opts.emit,
      brain: this.brain,
      amendments: this.amendments,
    });
  }

  private async buildRunner(
    preset: PresetId,
    cfg: RunConfig,
    ctx: BuildRunnerContext,
  ): Promise<SwarmRunner> {
    const originalCfg = cfg;
    // Carved research helper: normalize for scientific/internet use cases
    cfg = prepareResearchConfig(cfg);
    const { runId, startedAt, persister, manager, getRunner } = ctx;
    // #299: thread getAmendments into runner opts so each runner can
    // read live HITL nudges. Bound to this run's id — safe under
    // concurrent runs (no activeRun getter).
    // Deeper extract: the event wrapping + persistence scheduling is now its own method.
    // This keeps buildRunner smaller and makes the "emit + snapshot" lifecycle easier to test/refactor.
    const wrappedEmit = this.createWrappedEmit({
      runId,
      startedAt,
      cfg,
      persister,
      hub: ctx.hub,
      getRunner,
    });
    const opts: RunnerOpts = this.createRunnerOpts(runId, manager, wrappedEmit, cfg);

    const { createRunner } = await import("../swarm/presetRouter.js");
    // Unified factory (role-diff / baseline multi / pipeline via hooks).
    const roles =
      preset === "role-diff"
        ? selectRoleCatalog({
            customRoles: cfg.roles,
            userDirective: cfg.userDirective,
            dynamicRoles: cfg.dynamicRoles,
          })
        : undefined;
    return createRunner(cfg, opts, {
      rolesForRoleDiff: roles,
      baselineMultiAttempt: preset === "baseline" && (cfg.baselineAttempts ?? 1) > 1,
      pipelineFactory:
        preset === "pipeline"
          ? async (p: PresetId) => this.buildRunner(p, cfg, ctx)
          : undefined,
    });
  }

  /**
   * Extracted runner opts builder (deeper refactor slice for orchestrator).
   * Centralizes common wiring (amendments, brain guard, logging) so buildRunner
   * and callers stay lean. Supports future per-preset overrides.
   */
  private createRunnerOpts(
    runId: string,
    manager: any,
    wrappedEmit: any,
    cfg: RunConfig
  ): RunnerOpts {
    return {
      manager,
      repos: this.opts.repos,
      emit: wrappedEmit,
      logDiag: this.opts.logDiag,
      ollamaBaseUrl: this.opts.ollamaBaseUrl,
      getAmendments: () => this.amendments.list(runId),
      // Brain enablement controlled only by enableBrainAnalysis.
      getBrainService: (cfg.enableBrainAnalysis === false)
        ? () => null
        : () => this.brain.getService(),
    };
  }
}
