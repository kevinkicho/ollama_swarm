import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import type { AgentManager } from "./AgentManager.js";
import type { RepoService } from "./RepoService.js";
import type { AgentState, SwarmEvent, SwarmPhase, SwarmStatus, SwarmStatusRunConfig } from "../types.js";
import type { PresetId, RunConfig, RunnerOpts, SwarmRunner } from "../swarm/SwarmRunner.js";
import { RoundRobinRunner } from "../swarm/RoundRobinRunner.js";
import { BaselineRunner } from "../swarm/BaselineRunner.js";
import { BaselineSwarmHarness } from "../swarm/BaselineSwarmHarness.js";
import { PipelineRunner } from "../swarm/PipelineRunner.js";
import { roleForAgent, selectRoleCatalog } from "../swarm/roles.js";
import { ConformanceMonitor } from "./ConformanceMonitor.js";
import { EmbeddingDriftMonitor } from "./EmbeddingDriftMonitor.js";
import { tokenTracker } from "./ollamaProxy.js";
import { AmendmentsBuffer, type Amendment } from "./AmendmentsBuffer.js";
import { RunStatePersister, findRecoverableRuns, isRecoverablePhase, loadSnapshot, type RecoverableRun } from "./RunStatePersister.js";
import { tryAcquireLock, releaseLock } from "../swarm/cloneLock.js";
import { config } from "../config.js";
import { createLogger, rootLogger } from "./logger.js";
import { ActiveRun } from "./ActiveRun.js";
import { RunEventHub } from "./RunEventHub.js";
import { prepareResearchConfig, isResearchRun } from "../swarm/researchHelpers.js";
import { BrainIntegration } from "./BrainIntegration.js";

export interface OrchestratorOpts {
  /** Mint one AgentManager per run so concurrent runs don't share
   *  agent ids, streaming buffers, or killAll() scope. */
  createManager: (runId: string) => AgentManager;
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

// Persisted lastParentPath store. /tmp survives dev-server restarts
// but resets on reboot — fine for this use, since the user runs at
// least once after reboot and the path gets re-set automatically.
const LAST_PARENT_FILE = nodePath.join(tmpdir(), "ollama-swarm-last-parent.txt");
function readPersistedLastParent(): string | undefined {
  try {
    const v = readFileSync(LAST_PARENT_FILE, "utf8").trim();
    return v.length > 0 ? v : undefined;
  } catch (err) {
    rootLogger.warn('read-persisted-last-parent-failed', { error: err instanceof Error ? err.message : String(err) });
    return undefined;
  }
}
function writePersistedLastParent(p: string): void {
  try {
    writeFileSync(LAST_PARENT_FILE, p, "utf8");
  } catch (err) {
    rootLogger.warn('write-persisted-last-parent-failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

// #238 + #240 (2026-04-28): persisted set of ALL parent paths the
// user has ever started a run from. Lets /api/swarm/runs and /api/
// swarm/memory aggregate across parents instead of being scoped to
// just the active clone's parent dir. Bounded to KNOWN_PARENTS_MAX
// entries (LRU on add) so the file doesn't grow unbounded.
const KNOWN_PARENTS_FILE = nodePath.join(tmpdir(), "ollama-swarm-known-parents.json");
const KNOWN_PARENTS_MAX = 32;
function readPersistedKnownParents(): string[] {
  try {
    const raw = readFileSync(KNOWN_PARENTS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
  } catch (err) {
    rootLogger.warn('read-persisted-known-parents-failed', { error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}
function writePersistedKnownParents(paths: string[]): void {
  try {
    writeFileSync(KNOWN_PARENTS_FILE, JSON.stringify(paths.slice(0, KNOWN_PARENTS_MAX)), "utf8");
  } catch (err) {
    rootLogger.warn('write-persisted-known-parents-failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

// #293 (2026-04-28): when /tmp gets cleared (reboot, WSL session
// reset, manual rm) the persisted parents file disappears AND
// historical runs become invisible in the dropdown until the user
// happens to re-run from those parents. The 95-vs-9 bug surfaced
// during the 9-preset tour: only the CURRENT session's parent was
// in the list, hiding 86 prior summaries.
//
// Fix: at orchestrator construction, scan each project's logs/
// subdirectories for summary*.json files. Treat those as known
// parents — backfills the LRU list with everything we can see on
// disk regardless of /tmp state.
/** #293: merge persisted (recent, ordered) + scanned (discovered)
 *  parent paths into a single LRU list. Persisted entries keep their
 *  order (most-recent first); scanned entries that aren't already in
 *  the list get appended. Capped at KNOWN_PARENTS_MAX. */
export function mergeKnownParents(persisted: string[], scanned: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of persisted) {
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  for (const p of scanned) {
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out.slice(0, KNOWN_PARENTS_MAX);
}

export function scanForRunParents(cwd: string): string[] {
  const found = new Set<string>();
  // Scan for logs/ directories containing {runId}/ subdirectories
  // with summary*.json files. Runs are stored in <project>/logs/{runId}/.
  const bases = [cwd, nodePath.dirname(cwd)];
  for (const base of bases) {
    // Look for logs/ directory at this base
    const logsDir = nodePath.join(base, "logs");
    let logEntries: string[];
    try {
      logEntries = readdirSync(logsDir);
    } catch {
      continue; // no logs/ dir — fine
    }
    for (const entry of logEntries) {
      const runDir = nodePath.join(logsDir, entry);
      let stat;
      try {
        stat = statSync(runDir);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      // Check if this run directory has a summary*.json
      let hasSummary = false;
      try {
        for (const e of readdirSync(runDir)) {
          if (e === "summary.json" || (e.startsWith("summary-") && e.endsWith(".json"))) {
            hasSummary = true;
            break;
          }
        }
      } catch {
        continue;
      }
      if (hasSummary) found.add(runDir);
    }
  }
  return [...found];
}

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
      emit: (e: any, cat?: string) => { if (this.activeRun?.hub) this.activeRun.hub.emit(e, (cat as any) || "brain"); },
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
    return this.runs.size;
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

  /** Cleanup any runs that have terminated naturally but weren't
   *  explicitly stopped. Prevents stale runs from counting against
   *  the concurrent-run cap. */
  private async cleanupStaleRuns(): Promise<void> {
    for (const [id, run] of [...this.runs.entries()]) {
      if (!run.isRunning()) {
        await run.stop();
        this.runs.delete(id);
      }
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
        runConfig: runnerStatus.runConfig ?? this.runConfig,
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
        total: agents.length > 0 ? agents.length - 1 : 0, // exclude planner (agent-0)
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
  }> {
    const out: Array<{
      runId: string;
      runConfig: SwarmStatusRunConfig;
      startedAt: number;
      isRunning: boolean;
      createdBy: string;
      brainInitiated?: boolean;
      brainProposalId?: string;
    }> = [];
    for (const r of this.runs.values()) {
      if (!r.runner.isRunning()) continue; // only truly active runs
      out.push({
        runId: r.runId,
        runConfig: r.runConfig,
        startedAt: r.startedAt,
        isRunning: r.runner.isRunning(),
        createdBy: r.cfg.createdBy ?? "default",
        brainInitiated: !!r.cfg.brainInitiated,
        brainProposalId: r.cfg.brainProposalId,
      } as any);
    }
    return out;
  }

  /** T-Item-MultiTenant Phase 5 (2026-05-04): status snapshot for ONE
   *  run (vs the single-run status() which targets activeRun).
   *  Falls back to the persister file on disk when the run is no longer
   *  in memory (completed + cleaned up). This ensures page refreshes
   *  after run completion still get the contract, summary, etc. */
  statusForRun(runId: string): SwarmStatus | null {
    let run = this.runs.get(runId);
    if (!run && runId) {
      // tolerant lookup for short prefix (UI may pass 8-char slice)
      for (const [k, v] of this.runs.entries()) {
        if (k.startsWith(runId) || runId.startsWith(k)) { run = v; break; }
      }
    }
    if (run) {
      const status = run.runner.status();
      return {
        ...status,
        runId: run.runId, // return canonical full
        runConfig: status.runConfig ?? run.runConfig,
        runStartedAt: status.runStartedAt ?? run.startedAt,
        regions: this.computeRegions(status),
      };
    }
    // Run no longer in memory — fall back to persister file on disk.
    let pathInfo = this.runPaths.get(runId);
    if (!pathInfo && runId) {
      for (const [k, v] of this.runPaths.entries()) {
        if (k.startsWith(runId) || runId.startsWith(k)) { pathInfo = v; break; }
      }
    }
    let stateFilePath: string | null = pathInfo ? `${pathInfo.clonePath}.run-state.json` : null;
    let snap = stateFilePath ? loadSnapshot(stateFilePath) : null;
    if (snap && snap.runId && snap.runId !== runId && !(runId && (snap.runId.startsWith(runId) || runId.startsWith(snap.runId)))) {
      snap = null; // wrong run's snapshot for this clone
    }
    if (!snap) {
      // Fallback for completed/old runs not in runPaths (e.g. after server restart):
      // scan known parents for any snapshot containing this runId.
      const recoverable = findRecoverableRuns(this.knownParentPaths);
      for (const rec of recoverable) {
        if (rec.runId === runId || (runId && (rec.runId.startsWith(runId) || runId.startsWith(rec.runId)))) {
          snap = loadSnapshot(rec.stateFilePath);
          if (snap) break;
        }
      }
    }

    // Broader last-ditch for direct /runs/:runId deep links after full server restart:
    // runPaths is empty, but /api/swarm/runs (via RunsScanner) can still find the
    // summary on disk. Here we scan known parents + cwd/logs to locate a matching
    // summary by runId and synthesize a proper terminal status. This prevents
    // /runs/:id/status 404 + WS initial "idle" that kicks the UI back to SetupForm.
    if (!snap && !pathInfo) {
      const parents = new Set<string>(this.knownParentPaths || []);
      try { parents.add(process.cwd()); } catch {}
      try { parents.add(nodePath.join(process.cwd(), "logs")); } catch {}
      const last = this.getLastParentPath();
      if (last) parents.add(last);
      for (const p of parents) {
        if (!p) continue;
        try {
          const entries = readdirSync(p);
          for (const e of entries) {
            const candidateDir = nodePath.join(p, e);
            try {
              if (!statSync(candidateDir).isDirectory()) continue;
            } catch { continue; }
            // Check direct summary files + logs/ subdir + per-run subdirs
            const cands: string[] = [];
            try {
              const ents = readdirSync(candidateDir);
              for (const ee of ents) {
                if (/^summary(?:-.*)?\.json$/.test(ee)) cands.push(nodePath.join(candidateDir, ee));
              }
              const logsD = nodePath.join(candidateDir, "logs");
              if (existsSync(logsD) && statSync(logsD).isDirectory()) {
                const le = readdirSync(logsD);
                for (const ll of le) {
                  if (/^summary(?:-.*)?\.json$/.test(ll)) cands.push(nodePath.join(logsD, ll));
                  const sub = nodePath.join(logsD, ll);
                  if (existsSync(sub) && statSync(sub).isDirectory()) {
                    for (const sse of readdirSync(sub)) {
                      if (/^summary(?:-.*)?\.json$/.test(sse)) cands.push(nodePath.join(sub, sse));
                    }
                  }
                }
              }
            } catch {}
            for (const cand of cands) {
              try {
                if (!existsSync(cand)) continue;
                const raw = readFileSync(cand, "utf8");
                const sum = JSON.parse(raw);
                if (sum && (sum.runId === runId || (runId && (sum.runId?.startsWith(runId) || runId.startsWith(sum.runId))))) {
                  const effPhase = (sum.stopReason === "completed" ? (sum.preset === 'blackboard' && sum.transcript && sum.transcript.some((e: any) => e.text && e.text.includes('council') && !sum.transcript.some((e: any) => e.text && e.text.includes('blackboard') && e.text.includes('phase'))) ? "failed" : "completed") :
                                   (sum.stopReason === "crash" || sum.stopReason === "crashed" ? "failed" : "stopped")) as SwarmPhase;
                  const rc = (sum as any).runConfig || { preset: sum.preset };
                  const cp = sum.localPath || sum.clonePath || candidateDir;
                  // Shape agents as AgentState (id/index/status) so traditional sidebar
                  // (Object.values(agents).map AgentPanel) gets proper data for historical runs
                  // without falling to stats fallback. This brings the original sidebar path alive.
                  const shapedAgents = Array.isArray(sum.agents)
                    ? sum.agents.map((pa: any) => ({ id: pa.agentId, index: pa.agentIndex, status: "stopped" as const, model: pa.model }))
                    : [];
                  return {
                    phase: effPhase,
                    round: 0,
                    agents: shapedAgents,
                    transcript: (sum.transcript || []) as SwarmStatus["transcript"],
                    contract: sum.contract,
                    summary: sum,
                    runId,
                    runConfig: rc ? { ...rc, clonePath: cp } as any : undefined,
                    runStartedAt: sum.startedAt,
                    wallClockMs: typeof sum.wallClockMs === "number" ? sum.wallClockMs : undefined,
                    endedAt: typeof sum.endedAt === "number" ? sum.endedAt : undefined,
                  } as any;
                }
              } catch {}
            }
          }
        } catch {}
      }
    }

    // Summary-only fallback (no .run-state snapshot for *this* runId, e.g. blackboard
    // "no-progress" finish + same-clone later run overwrote the sibling state file).
    // runPaths still has the clonePath, so locate the summary written by PipelineRunner
    // and synthesize a status. This makes /runs/:id/status and the WS on-connect for
    // /runs/:id deliver correct phase/agents/transcript/summary instead of falling
    // back to global idle/other-run and causing run-layer to show the start page.
    if (!snap && pathInfo?.clonePath) {
      const cp = pathInfo.clonePath;
      try {
        const logsDir = nodePath.join(cp, "logs");
        let entries: string[] = [];
        try { entries = readdirSync(logsDir); } catch {}
        const candidates: string[] = [
          ...entries.filter((e: string) => /^summary-.*\.json$/.test(e)).map((e: string) => nodePath.join(logsDir, e)),
          nodePath.join(logsDir, "summary.json"),
          nodePath.join(cp, "summary.json"),
        ];
        // Also descend into per-run subdirs under logs/ (e.g. logs/72b9d79d/summary.json)
        try {
          for (const sub of entries) {
            const subDir = nodePath.join(logsDir, sub);
            if (existsSync(subDir) && statSync(subDir).isDirectory()) {
              try {
                const subEnts = readdirSync(subDir);
                for (const e of subEnts) {
                  if (/^summary(?:-.*)?\.json$/.test(e)) {
                    candidates.push(nodePath.join(subDir, e));
                  }
                }
              } catch {}
            }
          }
        } catch {}
        // Sort by basename desc to prefer most recent timestamped summary (the final
        // aggregated one) over older/partial per-phase summaries. Ensures history gets
        // complete transcript + final run summary grid.
        const sortedCandidates = [...candidates].sort((a, b) =>
          nodePath.basename(b).localeCompare(nodePath.basename(a))
        );
        for (const cand of sortedCandidates) {
          try {
            if (!existsSync(cand)) continue;
            const sumRaw = readFileSync(cand, "utf8");
            const sum = JSON.parse(sumRaw);
            if (sum && (!sum.runId || sum.runId === runId ||
                (runId && (sum.runId.startsWith(runId) || runId.startsWith(sum.runId))))) {
              const effPhase = (sum.stopReason === "completed" ? (sum.preset === 'blackboard' && sum.transcript && sum.transcript.some((e: any) => e.text && e.text.includes('council') && !sum.transcript.some((e: any) => e.text && e.text.includes('blackboard') && e.text.includes('phase'))) ? "failed" : "completed") :
                               (sum.stopReason === "crash" || sum.stopReason === "crashed" ? "failed" : "stopped")) as SwarmPhase;
              const rc = (sum as any).runConfig || { preset: sum.preset };
              const shapedAgents = Array.isArray(sum.agents)
                ? sum.agents.map((pa: any) => ({ id: pa.agentId, index: pa.agentIndex, status: "stopped" as const, model: pa.model }))
                : [];
              return {
                phase: effPhase,
                round: 0,
                agents: shapedAgents,
                transcript: (sum.transcript || []) as SwarmStatus["transcript"],
                contract: sum.contract,
                summary: sum,
                runId,
                runConfig: rc ? {
                  ...rc,
                  clonePath: rc.clonePath || rc.localPath || cp,
                } as any : undefined,
                runStartedAt: sum.startedAt,
                wallClockMs: typeof sum.wallClockMs === "number" ? sum.wallClockMs : undefined,
                endedAt: typeof sum.endedAt === "number" ? sum.endedAt : undefined,
              } as any;
            }
          } catch {}
        }
      } catch {}
    }

    if (!snap) return null;

    let effectivePhase = snap.phase as SwarmPhase;
    // For finished runs the .run-state snapshot may contain a stale non-terminal
    // phase (e.g. "executing" from continued blackboard work after PipelineRunner
    // declared "completed", followed by hard kill with no final flush).
    // If a summary written by writeRunSummary (with stopReason) is present
    // under the clone's logs/ (or root), prefer the terminal phase derived from it.
    //
    // Abrupt termination (user hard-killed server because UI stop buttons were
    // missing due to sidebar bug, or process crash/SIGKILL) must NEVER be labeled
    // "completed". We detect:
    // - crash sum.stopReason → failed
    // - non-terminal last snap + no clean terminal sum → "failed" / "crashed"
    // Scenarios:
    //   - clean end of all phases + no error + !stopping → completed
    //   - user Stop/Drain → user / stopped
    //   - exception in runner (caught) → crash / failed
    //   - cap hit → cap:xxx (terminal but not failed)
    //   - no-progress / partial → stopped with detail
    //   - hard kill / server death mid-run (no finally) → crashed / failed
    //   - hybrid planning phase fail → failed (explicit in PipelineRunner)
    //   - sub phase in pipeline interrupted → crashed if no final main summary
    // This ensures /status and per-run views report the real end state and hide
    // ineffective stop/drain buttons.
    try {
      const rc = snap.runConfig as any;
      const cp = rc?.clonePath || rc?.localPath || pathInfo?.clonePath;
      if (cp) {
        const logsDir = nodePath.join(cp, "logs");
        // Scan for summary.json (latest) or timestamped summary-*.json like /run-summary does
        let entries: string[] = [];
        try { entries = readdirSync(logsDir); } catch {}
        const candidates = [
          ...entries.filter((e) => /^summary-.*\.json$/.test(e)).map(e => nodePath.join(logsDir, e)),
          nodePath.join(logsDir, "summary.json"),
          nodePath.join(cp, "summary.json"),
        ];
        for (const cand of candidates) {
          try {
            if (!existsSync(cand)) continue;
            const sumRaw = readFileSync(cand, "utf8");
            const sum = JSON.parse(sumRaw);
            if (sum && sum.stopReason && (!sum.runId || sum.runId === runId ||
                (runId && (sum.runId.startsWith(runId) || runId.startsWith(sum.runId))))) {
              if (sum.stopReason === "completed") {
                // For hybrid, if only planning phase completed (no blackboard execution marker in transcript), treat as crashed (user killed server due to UI bugs).
                const isHybridSum = sum.preset === 'blackboard' && sum.transcript && sum.transcript.some((e: any) => e.text && e.text.includes('council'));
                const hasExecution = sum.transcript && sum.transcript.some((e: any) => e.text && e.text.includes('blackboard') && e.text.includes('phase'));
                if (isHybridSum && !hasExecution) {
                  effectivePhase = "failed";
                } else {
                  effectivePhase = "completed";
                }
              } else if (sum.stopReason === "crash" || sum.stopReason === "crashed") {
                effectivePhase = "failed";
              } else {
                effectivePhase = "stopped";
              }
              // also try to pull wallClock for ticker
              if (typeof sum.wallClockMs === 'number') {
                (snap as any).wallClockMs = sum.wallClockMs;
              }
              if (typeof sum.endedAt === 'number') {
                (snap as any).endedAt = sum.endedAt;
              }
              break;
            }
          } catch {}
        }
      }
    } catch {}

    // Post-sum abrupt termination detection for hard kills (no graceful stop/catch/finally).
    // If after all recovery we still have a non-terminal phase for a run that is not
    // currently active in memory, it means the process died (e.g. user killed server
    // to stop a stuck hybrid run when UI stop buttons were missing).
    // Never let it stay "completed" or a mid-phase like "executing"/"planning".
    const terminalPhases = ["completed", "stopped", "failed"];
    if (!terminalPhases.includes(effectivePhase as any)) {
      effectivePhase = "failed";
    } else if (effectivePhase === "completed" && snap && !terminalPhases.includes(snap.phase as any)) {
      // Spurious "completed" from a sub-phase summary (e.g. planning phase in hybrid wrote
      // its "completed", but main execution was hard-killed before final write).
      // Last snap shows non-terminal → treat as crashed/failed.
      effectivePhase = "failed";
    }

    const rc = snap.runConfig as any;
    return {
      phase: effectivePhase,
      round: 0,
      agents: [],
      transcript: snap.transcript as SwarmStatus["transcript"],
      contract: snap.contract as SwarmStatus["contract"] | undefined,
      runId,
      runConfig: rc ? {
        ...rc,
        clonePath: rc.clonePath || rc.localPath,
      } as SwarmStatusRunConfig : undefined,
      runStartedAt: snap.startedAt,
    };
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
   *  Returns true on success, false when runId isn't active. Mirrors
   *  the legacy stop() cleanup but scoped to one entry. */
  async stopRun(runId: string): Promise<boolean> {
    let run = this.runs.get(runId);
    if (!run && runId) {
      // tolerant prefix match (UI sometimes passes short id)
      for (const [k, v] of this.runs.entries()) {
        if (k.startsWith(runId) || runId.startsWith(k)) { run = v; break; }
      }
    }
    if (!run) {
      // Already terminated (known from runPaths or recoverable snapshot).
      // Treat stop as successful no-op so clients don't get spurious errors
      // and UI state stays consistent.
      const known = this.runPaths.get(runId) ||
        (runId && [...this.runPaths.keys()].some(k => k.startsWith(runId) || runId.startsWith(k)));
      if (known) return true;
      return false;
    }

    // Clearing tokenTracker...
    tokenTracker.setCurrentPreset(undefined, run.runId);

    await run.stop();
    // Guarantee terminal snapshot
    run.forceTerminalSnapshot("stopped", "user-stop");
    this.runs.delete(run.runId);
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

    let amendmentsOpened = false;
    let runId: string | undefined;

    try {
      // T-Item-MultiTenant Phase 4 (2026-05-04): cap on concurrent runs.
      await this.cleanupStaleRuns();
      const cap = this.opts.maxConcurrentRuns ?? 4;
      if (this.runs.size >= cap) {
        throw new Error(
          `Concurrent-run cap reached (${this.runs.size}/${cap}). Stop a run before starting another.`,
        );
      }
    // Drift check: validate prompt assertions before starting the run.
    // Non-blocking — drift warnings are informational. The run proceeds
    // regardless, but the user sees drift warnings in the system transcript.
    {
      try {
        const { checkPromptDrift } = await import("../swarm/blackboard/prompts/driftGuard.js");
        const drift = await checkPromptDrift();
        if (!drift.ok) {
          const names = [...new Set(drift.failures.map((f) => f.prompt))].join(", ");
          this.log.warn('prompt drift detected', {
            failed: drift.failedAssertions,
            total: drift.totalAssertions,
            names,
            runId,
          });
        }
      } catch {
        // Drift check is best-effort. If the registry module can't be loaded
        // (e.g., during tests without full source tree), silently skip.
      }
    }
    // T-Item-MultiTenant Phase 3: mint runId FIRST so we can build the
    // ActiveRun atomically. 2026-05-02 (persistence lever #2): persister
    // construction moved into ActiveRun build below.
    runId = randomUUID();
    const runHub = new RunEventHub({ runId, reqId: cfg.reqId });
    // Task #36: forward the minted runId into cfg so the runner can
    // include it in buildSummary → summary.json. Otherwise the runId
    // only lives in memory + the WS run_started event, never making
    // it to disk where the history dropdown reads digests from.
    cfg.runId = runId;
    this.brain.registerClonePath(cfg.localPath);
    // Prevent concurrent runs on same clone even in same process (in-memory)
    for (const [otherId, otherRun] of this.runs.entries()) {
      if (otherRun.cfg.localPath === cfg.localPath) {
        throw new Error(
          `Another run ${otherId} is already active on this clone path ${cfg.localPath}. Stop it first.`,
        );
      }
    }
    // R8 wiring (2026-05-04): acquire the cross-process clone lock.
    // If another server process (or another run on this server) is
    // already operating on this clone path, fail fast — concurrent
    // edits to the same clone would corrupt git state.
    const lockResult = tryAcquireLock({ clonePath: cfg.localPath, runId });
    if (!lockResult.acquired) {
      const heldBy = lockResult.heldBy
        ? ` (held by pid=${lockResult.heldBy.pid} runId=${lockResult.heldBy.runId} on ${lockResult.heldBy.hostname})`
        : "";
      throw new Error(
        `Clone path is locked by another swarm process${heldBy}. ${lockResult.reason}`,
      );
    }
    const holdsCloneLock = true;
    const persister = new RunStatePersister(cfg.localPath);
    const startedAt = Date.now();
    const manager = this.opts.createManager(runId);
    const runHolder: { runner: SwarmRunner | null } = { runner: null };
    const buildCtx: BuildRunnerContext = {
      runId,
      startedAt,
      persister,
      manager,
      getRunner: () => runHolder.runner!,
      hub: runHub,
    };
    // Capture hybrid intent BEFORE buildRunner (which intentionally strips the flags
    // on the cfg object to avoid re-triggering inside phase factory). We preserve the
    // original values in the client-visible runConfig so UI correctly detects isHybrid,
    // shows council-as-planner boxed group in sidebar, etc.
    const capturedUseHybrid = cfg.useHybridPlanning;
    const capturedPlanningPreset = cfg.planningPreset;
    const capturedExecutionPreset = cfg.executionPreset;
    const runner = await this.buildRunner(cfg.preset, cfg, buildCtx);
    runHolder.runner = runner;
    // Task #125: tag every Ollama call made during this run with its
    // preset, so the usage dashboard can break down "blackboard ate
    // 60% of today's tokens" etc. Cleared in stop().
    tokenTracker.setCurrentPreset(cfg.preset, runId);
    // Task #137: clear any prior run's quota-exhausted flag so this
    // run gets to probe the wall fresh. If the rate window has
    // reset / the user upgraded their plan / etc., the new run finds
    // out by trying. The flag re-trips immediately if not.
    tokenTracker.clearQuotaState(runId);
    // Unit 52a + 52c + 52d: anchor for the UI's runtime ticker,
    // identity strip, and identifiers row. Single source of truth
    // across all 7 runners. Fires BEFORE runner.start so a slow clone
    // or spawn counts toward user-visible runtime.
    // Task #42: resolve per-agent role names for role-diff so the UI
    // can render role labels in AgentPanel. Other presets leave this
    // undefined — runs with no role catalog get the generic worker
    // label. Uses the same catalog + wrap semantics as roleForAgent
    // in RoundRobinRunner so the UI matches what actually ran.
    let rolesForRunStarted: string[] | undefined;
    if (cfg.preset === "role-diff") {
      // 2026-05-02 (improvement #2): selectRoleCatalog auto-picks
      // BUILD_ROLES vs DEFAULT_ROLES based on whether a userDirective
      // is set. User-supplied custom roles still win.
      const catalog = selectRoleCatalog({
        customRoles: cfg.roles,
        userDirective: cfg.userDirective,
        // T198b (2026-05-04): forward dynamicRoles flag.
        dynamicRoles: cfg.dynamicRoles,
      });
      rolesForRunStarted = [];
      for (let i = 1; i <= cfg.agentCount; i++) {
        rolesForRunStarted.push(roleForAgent(i, catalog).name);
      }
    }
    // Pattern 9: build the runConfig snapshot once and reuse — same fields
    // go to the WS run_started event AND the REST status() snapshot.
    // Single source of truth so the two paths can't drift.
    const runConfig: SwarmStatusRunConfig = {
      preset: cfg.preset,
      // Per-agent overrides (Unit 42) fall back to cfg.model when absent.
      plannerModel: cfg.plannerModel ?? cfg.model,
      workerModel: cfg.workerModel ?? cfg.model,
      // Auditor model fallback chain matches BlackboardRunner: explicit
      // override → planner override → main model. Same surface as the
      // runner so the UI label is honest about what's actually running.
      auditorModel: cfg.auditorModel ?? cfg.plannerModel ?? cfg.model,
      dedicatedAuditor: cfg.dedicatedAuditor === true,
      roles: rolesForRunStarted,
      repoUrl: cfg.repoUrl,
      clonePath: cfg.localPath,
      agentCount: cfg.agentCount,
      rounds: cfg.rounds,
      // Phase 4b of #243: include the resolved topology so the UI can
      // mirror exact agent specs (role chip + model override) without
      // re-deriving from preset+index. cfg.topology is always populated
      // by the route layer (synthesized from legacy fields when client
      // didn't post one).
      topology: cfg.topology,
      // Map server cfg caps to client strings for run events / status.
      wallClockCapMin: cfg.wallClockCapMs ? Math.round(cfg.wallClockCapMs / 60000).toString() : undefined,
      ambitionTiers: cfg.ambitionTiers !== undefined ? String(cfg.ambitionTiers) : undefined,
      useHybridPlanning: capturedUseHybrid,
      planningPreset: capturedPlanningPreset,
      executionPreset: capturedExecutionPreset,
    };
    const activeRun = this.createActiveRun(runId, startedAt, cfg, runConfig, runner, manager, persister, holdsCloneLock, runHub);
    this.runs.set(runId, activeRun);
    this.runPaths.set(runId, {
      clonePath: cfg.localPath,
      preset: cfg.preset,
      startedAt: Date.now(),
    });
    // Cache parent dir so /api/swarm/runs can keep showing historical
    // runs in this folder even after this run terminates. Persisted
    // to /tmp so a dev-server restart doesn't lose it.
    this.lastParentPath = nodePath.dirname(nodePath.resolve(cfg.localPath));
    writePersistedLastParent(this.lastParentPath);
    // #238 + #240: append to known-parents list (LRU on duplicates).
    this.knownParentPaths = [
      this.lastParentPath,
      ...this.knownParentPaths.filter((p) => p !== this.lastParentPath),
    ].slice(0, 32);
    writePersistedKnownParents(this.knownParentPaths);
    this.opts.emit({
      type: "run_started",
      runId,
      startedAt,
      ...runConfig,
    });
    // #299: open the amendments buffer for this run. /api/swarm/amend
    // appends here; runners read via getAmendments(runId) on each turn.
    this.amendments.open(runId);
    amendmentsOpened = true;
    // #295: spin up the conformance monitor when the run carries a
    // user directive. Polls Ollama every 90s with a "rate 0–100 how
    // on-topic is the recent transcript?" prompt. Skipped entirely
    // for runs without a directive (nothing to grade against) and
    // when CONFORMANCE_MONITOR=off in the env (escape hatch).
    const trimmedDirective = cfg.userDirective?.trim();
    this.setupConformanceAndDriftMonitors(activeRun, runId, trimmedDirective, cfg);
    // Start the runner asynchronously (fire-and-forget) so the /start response returns the runId
    // immediately. This fixes long delays (30s+) for hybrid/council planning before the view switches
    // to run-layer. The run executes in background; completion/errors handled inside runner (finally, catch).
    // For hybrid, this means the client sees the run page right away while council planning + blackboard proceeds.
    void (async () => {
      try {
        await runner.start(cfg);
        if (cfg.chainTo) {
          void this.scheduleForwardChain(cfg, runId, runner, cfg.chainTo);
        }
      } catch (err) {
        const rid = (typeof runId === 'string' ? runId : 'unknown');
        this.log.warn('start partial failure, cleaning up ActiveRun', { runId: rid, error: err instanceof Error ? err.message : String(err) });
        await activeRun.stop();
        this.runs.delete(rid);
        // rethrow not needed since fire-and-forget
      }
    })();
    return runId;
    } finally {
      this.startInProgress = false;
    }
  }

  // Task #167: soft-stop entry point. If the active runner supports
  // drain() (blackboard does), use it; otherwise fall through to hard
  // stop. The runner manages its own escalation deadline + watcher.
  async drain(): Promise<void> {
    if (!this.runner) return;
    if (typeof this.runner.drain === "function") {
      await this.runner.drain();
      return;
    }
    await this.stop();
  }

  /** Per-run soft stop. Returns false when runId isn't active. */
  async drainRun(runId: string): Promise<boolean> {
    let run = this.runs.get(runId);
    if (!run && runId) {
      for (const [k, v] of this.runs.entries()) {
        if (k.startsWith(runId) || runId.startsWith(k)) { run = v; break; }
      }
    }
    if (!run) {
      const known = this.runPaths.get(runId) ||
        (runId && [...this.runPaths.keys()].some(k => k.startsWith(runId) || runId.startsWith(k)));
      if (known) return true;
      return false;
    }
    if (typeof run.runner.drain === "function") {
      await run.runner.drain();
      return true;
    }
    return this.stopRun(runId);
  }

  /** Stop every active run (used by force-restart and shutdown). */
  async stopAll(): Promise<void> {
    const ids = [...this.runs.keys()];
    for (const id of ids) {
      await this.stopRun(id);
    }
  }

  async stop(): Promise<void> {
    // T-Item-MultiTenant Phase 3: stop the active run (legacy single-
    // arg API targets most-recent-started). Phase 5 will add an
    // explicit stopRun(runId) for per-run targeting.
    const active = this.activeRun;
    if (!active) return;
    try {
      await active.runner.stop();
    } finally {
      // #295 fix: backstop for the conformance monitor — covers the
      // explicit /api/swarm/stop path. Natural-completion path
      // self-stops via isActive() in the poll loop.
      active.conformanceMonitor?.stop();
      // #302: same backstop for the embedding drift monitor.
      active.embeddingDriftMonitor?.stop();
      // Task #125: clear preset tag — calls between runs (e.g. an
      // exploratory direct curl to the proxy) bucket as "(idle)".
      tokenTracker.setCurrentPreset(undefined, active.runId);
      // 2026-05-02 (persistence lever #2): flush any pending snapshot
      // so terminal phase is on disk before we drop the persister.
      active.persister.stop();
      // R8 wiring: release the clone lock so the path is reusable.
      if (active.holdsCloneLock) {
        try {
          releaseLock({ clonePath: active.cfg.localPath, runId: active.runId });
        } catch (err) {
          this.log.warn('stop-release-lock-failed', { error: err instanceof Error ? err.message : String(err), runId: active.runId });
        }
      }
      this.amendments.close(active.runId);
      // Drop the ActiveRun from the map. The next start gets a fresh
      // slate rather than inheriting the previous runner's terminal phase.
      this.runs.delete(active.runId);
    }
  }

  // T192 (2026-05-04): forward chain to a follow-up preset. Polls the
  // active runner until it stops; reads the top extracted next-action
  // from this run's next-actions.json sibling; fires a new run with
  // cfg.chainTo as the preset and the action as the directive. Soft
  // failures (file missing, no actions, parse error, race with user
  // starting another run) are logged + swallowed.
  private async scheduleForwardChain(
    originalCfg: RunConfig,
    originalRunId: string,
    originalRunner: SwarmRunner,
    chainPreset: "blackboard" | "baseline",
  ): Promise<void> {
    // Poll until the original runner truly stops (terminal phase).
    // Cap at 4h so a wedged runner doesn't keep this task alive
    // forever; the caller (orchestrator.start) returned long ago.
    const POLL_MS = 5_000;
    const MAX_WAIT_MS = 4 * 60 * 60_000;
    const waitStartedAt = Date.now();
    while (
      originalRunner.isRunning() &&
      Date.now() - waitStartedAt < MAX_WAIT_MS
    ) {
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    // Abandon if the run was stopped or cleaned up while we waited.
    if (!this.runs.has(originalRunId)) return;
    // Read the top action from the next-actions JSON sibling. We
    // dynamically import the helper to keep the orchestrator's
    // import surface lean.
    let topAction: string | null = null;
    try {
      const { readTopNextAction } = await import("../swarm/wrapUpApplyPhase.js");
      topAction = await readTopNextAction({
        clonePath: originalCfg.localPath,
        runId: originalRunId,
        // The presetName field selects which JSON file to read —
        // pass the ORIGINAL preset (e.g. "stigmergy"), not the chain
        // target. The original run wrote next-actions-stigmergy-*.json.
        presetName: originalCfg.preset,
      });
    } catch (err) {
      this.opts.emit({
        type: "error",
        message: `forward-chain: failed to read next-actions JSON — ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
    if (!topAction) {
      this.opts.emit({
        type: "error",
        message: `forward-chain: no extractable next-action in deliverable; nothing to chain to ${chainPreset}.`,
      });
      return;
    }
    // Stop the prior run cleanly so we get a fresh slate, then fire
    // the chained run. Recursion guard: chainTo cleared.
    try {
      await this.stopRun(originalRunId);
    } catch (err) {
      this.log.warn('forward-chain-stop-failed', { error: err instanceof Error ? err.message : String(err) });
    }
    const chainedCfg: RunConfig = {
      ...originalCfg,
      preset: chainPreset,
      userDirective: topAction,
      chainTo: undefined, // recursion guard
      // Keep agentCount; bump to blackboard's min if needed.
      agentCount:
        chainPreset === "blackboard" && originalCfg.agentCount < 3
          ? 3
          : originalCfg.agentCount,
    };
    try {
      await this.start(chainedCfg);
    } catch (err) {
      this.opts.emit({
        type: "error",
        message: `forward-chain: chained ${chainPreset} run failed to start — ${err instanceof Error ? err.message : String(err)}`,
      });
    }
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
    );
  }

  private setupConformanceAndDriftMonitors(
    activeRun: ActiveRun,
    runId: string,
    trimmedDirective: string | undefined,
    cfg: RunConfig,
  ): void {
    if (
      trimmedDirective &&
      trimmedDirective.length > 0 &&
      config.CONFORMANCE_MONITOR &&
      this.opts.ollamaBaseUrl
    ) {
      // #295 fix: monitor lives on the ActiveRun record so its
      // lifecycle is decoupled from runner.start()'s return.
      const monitor = new ConformanceMonitor({
        runId,
        directive: trimmedDirective,
        ollamaBaseUrl: this.opts.ollamaBaseUrl,
        graderModel: cfg.model,
        getTranscript: () => activeRun.runner.status().transcript ?? [],
        getPhase: () => activeRun.runner.status().phase ?? "idle",
        emit: this.opts.emit,
        isActive: () => activeRun.runner.isRunning(),
      });
      activeRun.attachMonitors(monitor);
      monitor.start();

      // #302 Phase B: independent embedding-similarity signal.
      const drift = new EmbeddingDriftMonitor({
        runId,
        directive: trimmedDirective,
        ollamaBaseUrl: this.opts.ollamaBaseUrl,
        getTranscript: () => activeRun.runner.status().transcript ?? [],
        emit: this.opts.emit,
        isActive: () => activeRun.runner.isRunning(),
      });
      activeRun.attachMonitors(undefined, drift);
      void drift.start();
    }
  }

  /**
   * Deeper extracted slice: creates the wrapped emit that:
   * - stamps runId
   * - routes via hub
   * - calls base emit
   * - tracks health for brain
   * - schedules persistence snapshot
   *
   * This was previously inline in buildRunner; extracting it is a step toward
   * separating "event lifecycle + durability" from runner construction.
   */
  private createWrappedEmit(params: {
    runId: string;
    startedAt: number;
    cfg: RunConfig;
    persister: RunStatePersister;
    hub?: RunEventHub;
    getRunner: () => SwarmRunner;
  }): (e: SwarmEvent) => void {
    const { runId, startedAt, cfg, persister, hub, getRunner } = params;
    const baseEmit = this.opts.emit;
    return (e: SwarmEvent) => {
      const stamped: SwarmEvent =
        e.runId === undefined ? { ...e, runId } : e;
      if (hub) hub.emit(stamped as any, "lifecycle");
      baseEmit(stamped);
      this.brain.trackRunHealth(stamped);
      const runner = getRunner();
      if (!runner) return;
      const status = runner.status();
      const { preset: p, repoUrl, localPath, agentCount, rounds, model, ...extras } = cfg;
      persister.schedule({
        runId,
        preset: cfg.preset,
        phase: status?.phase ?? "unknown",
        startedAt,
        transcript: status?.transcript ?? [],
        amendments: this.amendments.list(runId),
        brainChatHistory: this.brain.getChatHistory(runId),
        runConfig: {
          preset: p,
          repoUrl,
          localPath,
          agentCount,
          rounds,
          model,
          ...(Object.keys(extras).length > 0 ? { extras } : {}),
        },
        contract: status?.contract,
      });
    };
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

    // NEW: Hybrid planning + execution (#1, #3)
    // Extracted to keep buildRunner focused; hybrid logic is now a dedicated slice.
    if (cfg.useHybridPlanning && cfg.planningPreset && cfg.executionPreset) {
      return this.createHybridPipelineRunner(cfg, originalCfg, opts, ctx);
    }

    switch (preset) {
      // Special cases: role-diff → RoundRobin with custom roles
      case "role-diff": {
        const roles = selectRoleCatalog({ customRoles: cfg.roles, userDirective: cfg.userDirective, dynamicRoles: cfg.dynamicRoles });
        return new RoundRobinRunner(opts, { roles });
      }
      // Special case: baseline with parallel-clone harness
      case "baseline": {
        if ((cfg.baselineAttempts ?? 1) > 1) {
          return new BaselineSwarmHarness(opts);
        }
        return new BaselineRunner(opts);
      }
      // Special case: pipeline chains sub-runs
      case "pipeline": {
        const factory = async (p: PresetId) => this.buildRunner(p, cfg, ctx);
        return new PipelineRunner(opts, factory);
      }
      // Standard presets: delegate to factory
      default:
        return createRunner(cfg, opts);
    }
  }

  /**
   * Extracted hybrid planning+execution builder (refactor slice).
   * Keeps the main buildRunner lean; all hybrid-specific wiring (pipeline attach,
   * flag stripping for subs, brain disable, summary preservation) lives here.
   */
  private createHybridPipelineRunner(
    cfg: RunConfig,
    originalCfg: RunConfig,
    opts: RunnerOpts,
    ctx: BuildRunnerContext
  ) {
    const hybridPipeline = {
      phases: [
        {
          preset: cfg.planningPreset as PresetId,
          rounds: cfg.rounds ?? 3,
          agentCount: cfg.agentCount ?? 5,
          model: cfg.model,
        },
        {
          preset: cfg.executionPreset as PresetId,
          rounds: 0,
          agentCount: cfg.agentCount ?? 5,
          model: cfg.model,
        },
      ],
      pipeMode: "both" as const,
      pipeMaxEntries: 30,
    };
    // Attach pipeline to both cfgs for the top-level runner.start.
    originalCfg.pipeline = hybridPipeline;
    cfg.pipeline = hybridPipeline;

    const makePhaseCfg = (base: any, phasePreset: PresetId) => ({
      ...base,
      preset: phasePreset,
      pipeline: hybridPipeline,
      useHybridPlanning: false,
      planningPreset: undefined,
      executionPreset: undefined,
      enableBrainAnalysis: false,
    });
    const factory = async (p: PresetId) => this.buildRunner(p, makePhaseCfg(cfg, p), ctx);
    return new PipelineRunner(opts, factory);
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
      getBrainService: cfg.enableBrainAnalysis === false ? () => null : () => this.brain.getService(),
    };
  }
}
