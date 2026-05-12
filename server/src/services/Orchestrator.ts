import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import type { AgentManager } from "./AgentManager.js";
import type { RepoService } from "./RepoService.js";
import type { SwarmEvent, SwarmPhase, SwarmStatus, SwarmStatusRunConfig } from "../types.js";
import type { PresetId, RunConfig, RunnerOpts, SwarmRunner } from "../swarm/SwarmRunner.js";
import { RoundRobinRunner } from "../swarm/RoundRobinRunner.js";
import { BaselineRunner } from "../swarm/BaselineRunner.js";
import { BaselineSwarmHarness } from "../swarm/BaselineSwarmHarness.js";
import { PipelineRunner } from "../swarm/PipelineRunner.js";
import { roleForAgent, selectRoleCatalog } from "../swarm/roles.js";
import { ConformanceMonitor } from "./ConformanceMonitor.js";
import { EmbeddingDriftMonitor } from "./EmbeddingDriftMonitor.js";
import { AmendmentsBuffer, type Amendment } from "./AmendmentsBuffer.js";
import { RunStatePersister, findRecoverableRuns, isRecoverablePhase, loadSnapshot, type RecoverableRun } from "./RunStatePersister.js";
import { tryAcquireLock, releaseLock } from "../swarm/cloneLock.js";

export interface OrchestratorOpts extends RunnerOpts {
  manager: AgentManager;
  repos: RepoService;
  emit: (e: SwarmEvent) => void;
  /** T-Item-MultiTenant Phase 4 (2026-05-04): max concurrent runs.
   *  Default 4 (when unset). When the orchestrator's run map size
   *  hits this number, start() throws "cap reached". The route layer
   *  reads config.SWARM_MAX_CONCURRENT_RUNS to set this. */
  maxConcurrentRuns?: number;
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
    console.warn('[Orchestrator] read-persisted-last-parent-failed:', err instanceof Error ? err.message : String(err));
    return undefined;
  }
}
function writePersistedLastParent(p: string): void {
  try {
    writeFileSync(LAST_PARENT_FILE, p, "utf8");
  } catch (err) {
    console.warn('[Orchestrator] write-persisted-last-parent-failed:', err instanceof Error ? err.message : String(err));
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
    console.warn('[Orchestrator] read-persisted-known-parents-failed:', err instanceof Error ? err.message : String(err));
    return [];
  }
}
function writePersistedKnownParents(paths: string[]): void {
  try {
    writeFileSync(KNOWN_PARENTS_FILE, JSON.stringify(paths.slice(0, KNOWN_PARENTS_MAX)), "utf8");
  } catch (err) {
    console.warn('[Orchestrator] write-persisted-known-parents-failed:', err instanceof Error ? err.message : String(err));
  }
}

// #293 (2026-04-28): when /tmp gets cleared (reboot, WSL session
// reset, manual rm) the persisted parents file disappears AND
// historical runs become invisible in the dropdown until the user
// happens to re-run from those parents. The 95-vs-9 bug surfaced
// during the 9-preset tour: only the CURRENT session's parent was
// in the list, hiding 86 prior summaries.
//
// Fix: at orchestrator construction, scan project-relative `runs/`
// + `runs_overnight*/` directories for any subfolder containing a
// `summary*.json`. Treat those as known parents — backfills the
// LRU list with everything we can see on disk regardless of /tmp
// state. Cheap (one-shot dir walk, no I/O on individual summary
// files), and idempotent — if /tmp already has the entries, the
// existing dedupe handles it.
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
  // dev.mjs launches the server with cwd=<root>/server, but the actual
  // runs/ + runs_overnight*/ dirs live at the project root, one level
  // up. Scan both bases so the discovery works regardless of where
  // the orchestrator is launched from.
  const bases = [cwd, nodePath.dirname(cwd)];
  // Match runs, runs_overnight, runs_overnight2 — any top-level dir
  // whose name suggests it holds run output.
  const isRunRoot = (name: string) =>
    name === "runs" || name.startsWith("runs_") || name.startsWith("runs-");
  for (const base of bases) {
    let topLevel: string[];
    try {
      topLevel = readdirSync(base);
    } catch (err) {
      console.warn('[Orchestrator] scan-readdir-base-failed:', err instanceof Error ? err.message : String(err));
      continue;
    }
    for (const name of topLevel) {
      if (!isRunRoot(name)) continue;
      const root = nodePath.join(base, name);
      let stat;
      try {
        stat = statSync(root);
      } catch (err) {
        console.warn('[Orchestrator] scan-stat-root-failed:', err instanceof Error ? err.message : String(err));
        continue;
      }
      if (!stat.isDirectory()) continue;
      // Each clone-dir lives one level deep under the root.
      let clones: string[];
      try {
        clones = readdirSync(root);
      } catch (err) {
        console.warn('[Orchestrator] scan-readdir-root-failed:', err instanceof Error ? err.message : String(err));
        continue;
      }
      for (const clone of clones) {
        const cloneDir = nodePath.join(root, clone);
        try {
          if (!statSync(cloneDir).isDirectory()) continue;
        } catch (err) {
          console.warn('[Orchestrator] scan-stat-cloneDir-failed:', err instanceof Error ? err.message : String(err));
          continue;
        }
        // Cheap probe: is there at least one summary*.json? Fast since
        // we don't read it — just check the dir for any matching entry.
        let hasSummary = false;
        try {
          for (const e of readdirSync(cloneDir)) {
            if (e === "summary.json" || (e.startsWith("summary-") && e.endsWith(".json"))) {
              hasSummary = true;
              break;
            }
          }
        } catch (err) {
          console.warn('[Orchestrator] scan-readdir-cloneDir-failed:', err instanceof Error ? err.message : String(err));
          continue;
        }
        if (hasSummary) found.add(root);
      }
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
interface ActiveRun {
  runner: SwarmRunner;
  runId: string;
  runConfig: SwarmStatusRunConfig;
  startedAt: number;
  /** The full RunConfig the runner was started with. Stashed so
   *  scheduleForwardChain can derive the chained run's cfg. */
  cfg: RunConfig;
  /** The persister (constructed in start()) tied to this run's
   *  clone path. Closed on stop/completion so a write failure
   *  doesn't leak into the next run. */
  persister: RunStatePersister;
  /** Optional monitors — present only when cfg.userDirective is set
   *  AND the relevant model is available. */
  conformanceMonitor?: ConformanceMonitor;
  embeddingDriftMonitor?: EmbeddingDriftMonitor;
  /** R8 wiring (2026-05-04): true when this run holds a .lock at the
   *  clone path. stopRun + start (cleanup) call releaseLock() to
   *  drop it. Best-effort: a missing lock just means the OS reaped
   *  it (e.g. server crash); release becomes a no-op. */
  holdsCloneLock: boolean;
}

// Thin preset dispatcher. Holds the active runs (Phase 3: max 1 by
// design; Phase 4 will relax to N) and delegates the public surface
// to whichever run the caller targets. State per run lives on the
// runner + the ActiveRun record.
export class Orchestrator {
  // T-Item-MultiTenant Phase 3 (2026-05-04): runs keyed by runId.
  // Insertion order is most-recent-LAST so legacy single-arg APIs
  // (status() / stop() / injectUser without runId) can resolve to
  // the most-recently-started run without an explicit "active"
  // pointer. Capped at 1 in Phase 3; Phase 4 relaxes.
  private runs = new Map<string, ActiveRun>();
  // After a run completes and is removed from `runs`, its clonePath
  // is retained here so that statusForRun can fall back to the
  // persister file on disk. Without this, a page refresh after run
  // completion would lose the contract (404 on /runs/:id/status).
  private runPaths = new Map<string, { clonePath: string; preset: string; startedAt: number }>();
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
  }

  /** Cleanup any runs that have terminated naturally but weren't
   *  explicitly stopped. Prevents stale runs from counting against
   *  the concurrent-run cap. */
  private async cleanupStaleRuns(): Promise<void> {
    for (const [id, run] of [...this.runs.entries()]) {
      if (!run.runner.isRunning()) {
        try { await run.runner.stop(); } catch (err) {
          console.warn('cleanupStaleRuns stop failed:', err instanceof Error ? err.message : String(err));
        }
        run.conformanceMonitor?.stop();
        run.embeddingDriftMonitor?.stop();
        run.persister.stop();
        if (run.holdsCloneLock) {
          try { releaseLock({ clonePath: run.cfg.localPath, runId: run.runId }); } catch {}
        }
        this.runs.delete(id);
      }
    }
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
      agents: this.opts.manager.toStates(),
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
    if (!this.runId || this.runId !== runId) return null;
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
  }> {
    const out: Array<{
      runId: string;
      runConfig: SwarmStatusRunConfig;
      startedAt: number;
      isRunning: boolean;
      createdBy: string;
    }> = [];
    for (const r of this.runs.values()) {
      out.push({
        runId: r.runId,
        runConfig: r.runConfig,
        startedAt: r.startedAt,
        isRunning: r.runner.isRunning(),
        createdBy: r.cfg.createdBy ?? "default",
      });
    }
    return out;
  }

  /** T-Item-MultiTenant Phase 5 (2026-05-04): status snapshot for ONE
   *  run (vs the single-run status() which targets activeRun).
   *  Falls back to the persister file on disk when the run is no longer
   *  in memory (completed + cleaned up). This ensures page refreshes
   *  after run completion still get the contract, summary, etc. */
  statusForRun(runId: string): SwarmStatus | null {
    const run = this.runs.get(runId);
    if (run) {
      const status = run.runner.status();
      return {
        ...status,
        runId,
        runConfig: status.runConfig ?? run.runConfig,
        runStartedAt: status.runStartedAt ?? run.startedAt,
        regions: this.computeRegions(status),
      };
    }
    // Run no longer in memory — fall back to persister file on disk.
    const pathInfo = this.runPaths.get(runId);
    if (!pathInfo) return null;
    const stateFilePath = `${pathInfo.clonePath}.run-state.json`;
    const snap = loadSnapshot(stateFilePath);
    if (!snap) return null;
    return {
      phase: snap.phase as SwarmPhase,
      round: 0,
      agents: [],
      transcript: snap.transcript as SwarmStatus["transcript"],
      contract: snap.contract as SwarmStatus["contract"] | undefined,
      runId,
      runConfig: snap.runConfig as SwarmStatusRunConfig | undefined,
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
    const run = this.runs.get(runId);
    if (!run) return false;
    try {
      await run.runner.stop();
    } finally {
      run.conformanceMonitor?.stop();
      run.embeddingDriftMonitor?.stop();
      // Clearing tokenTracker.setCurrentPreset is a no-op when other
      // runs are still tagged; we accept the small attribution
      // imprecision here — multi-tenant cost attribution is a known
      // gap (the global tokenTracker can't bucket usage per active
      // runId today; cross-cutting refactor needed for full fidelity).
      tokenTracker.setCurrentPreset(undefined, run.runId);
      run.persister.stop();
      // R8 wiring: release the clone lock so the path is reusable.
      if (run.holdsCloneLock) {
        try {
          releaseLock({ clonePath: run.cfg.localPath, runId: run.runId });
        } catch (err) {
          console.warn('[Orchestrator] stopRun-release-lock-failed:', err instanceof Error ? err.message : String(err));
        }
      }
      this.runs.delete(runId);
    }
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
    await this.start(cfg);
    const newRunId = this.runId;
    if (!newRunId) {
      throw new Error("recover: start() did not yield a runId");
    }
    return {
      newRunId,
      priorTranscript: snap.transcript,
      priorAmendments: snap.amendments,
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

  async start(cfg: RunConfig): Promise<void> {
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
          console.warn(
            `[drift-guard] ${drift.failedAssertions}/${drift.totalAssertions} prompt assertions failed across: ${names}. ` +
            `Run will start but prompt behavior may differ from expected. Run 'npx tsx eval/drift-check.ts' for details.`,
          );
        }
      } catch {
        // Drift check is best-effort. If the registry module can't be loaded
        // (e.g., during tests without full source tree), silently skip.
      }
    }
    // T-Item-MultiTenant Phase 3: mint runId FIRST so we can build the
    // ActiveRun atomically. 2026-05-02 (persistence lever #2): persister
    // construction moved into ActiveRun build below.
    const runId = randomUUID();
    // Task #36: forward the minted runId into cfg so the runner can
    // include it in buildSummary → summary.json. Otherwise the runId
    // only lives in memory + the WS run_started event, never making
    // it to disk where the history dropdown reads digests from.
    cfg.runId = runId;
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
    // buildRunner's wrappedEmit closure reads this.runStatePersister
    // (= activeRun.persister via the getter) lazily, so it'll see the
    // right persister once we insert the ActiveRun below.
    const runner = await this.buildRunner(cfg.preset, cfg);
    // Task #125: tag every Ollama call made during this run with its
    // preset, so the usage dashboard can break down "blackboard ate
    // 60% of today's tokens" etc. Cleared in stop().
    tokenTracker.setCurrentPreset(cfg.preset, runId);
    // Task #137: clear any prior run's quota-exhausted flag so this
    // run gets to probe the wall fresh. If the rate window has
    // reset / the user upgraded their plan / etc., the new run finds
    // out by trying. The flag re-trips immediately if not.
    tokenTracker.clearQuotaState();
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
    const startedAt = Date.now();
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
    };
    // T-Item-MultiTenant Phase 3: build + insert the ActiveRun. Any
    // monitor wiring below mutates this entry's fields. Insertion-
    // order Map → activeRun getter resolves to this for legacy
    // single-arg APIs until the run terminates.
    const activeRun: ActiveRun = {
      runner,
      runId,
      runConfig,
      startedAt,
      cfg,
      persister,
      holdsCloneLock,
    };
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
    // #295: spin up the conformance monitor when the run carries a
    // user directive. Polls Ollama every 90s with a "rate 0–100 how
    // on-topic is the recent transcript?" prompt. Skipped entirely
    // for runs without a directive (nothing to grade against) and
    // when CONFORMANCE_MONITOR=off in the env (escape hatch).
    const trimmedDirective = cfg.userDirective?.trim();
    if (
      trimmedDirective &&
      trimmedDirective.length > 0 &&
      process.env.CONFORMANCE_MONITOR !== "off" &&
      this.opts.ollamaBaseUrl
    ) {
      // #295 fix: monitor lives on the ActiveRun record so its
      // lifecycle is decoupled from runner.start()'s return.
      // Discussion runners fire-and-forget their loop, so runner.start
      // resolves quickly even for long runs.
      const monitor = new ConformanceMonitor({
        runId,
        directive: trimmedDirective,
        ollamaBaseUrl: this.opts.ollamaBaseUrl,
        graderModel: cfg.model,
        getTranscript: () => activeRun.runner.status().transcript ?? [],
        emit: this.opts.emit,
        isActive: () => activeRun.runner.isRunning(),
      });
      activeRun.conformanceMonitor = monitor;
      monitor.start();

      // #302 Phase B: independent embedding-similarity signal.
      // Async-start because it embeds the directive once before the
      // poll loop kicks off. No-ops silently when the embedding
      // model isn't pulled (typical fresh-Ollama install).
      const drift = new EmbeddingDriftMonitor({
        runId,
        directive: trimmedDirective,
        ollamaBaseUrl: this.opts.ollamaBaseUrl,
        getTranscript: () => activeRun.runner.status().transcript ?? [],
        emit: this.opts.emit,
        isActive: () => activeRun.runner.isRunning(),
      });
      activeRun.embeddingDriftMonitor = drift;
      void drift.start();
    }
    try {
      await runner.start(cfg);
      // T192 (2026-05-04): forward chain. When cfg.chainTo is set,
      // schedule a follow-up run that fires after this run truly
      // completes. Runners use void this.loop() (fire-and-forget),
      // so we can't await completion here — instead, poll isRunning()
      // in a background task. Recursion guard: chainTo cleared on
      // the chained run.
      if (cfg.chainTo) {
        void this.scheduleForwardChain(cfg, runId, cfg.chainTo);
      }
    } catch (err) {
      // Runner's start threw partway through (e.g. clone failed, spawn timed out).
      // Clean up anything it managed to create and remove the ActiveRun
      // entry from the map — otherwise the dispatcher stays pinned to a
      // stuck runner and the next start call false-positives as "already running".
      try {
        await runner.stop();
      } catch (err) {
        console.warn('[Orchestrator] start-error-runner-stop-failed:', err instanceof Error ? err.message : String(err));
      }
      // T-Item-MultiTenant Phase 3: cleanup the ActiveRun entry. Stop
      // monitors + persister, then remove from the map.
      activeRun.conformanceMonitor?.stop();
      activeRun.embeddingDriftMonitor?.stop();
      activeRun.persister.stop();
      if (activeRun.holdsCloneLock) {
        try {
          releaseLock({ clonePath: activeRun.cfg.localPath, runId: activeRun.runId });
        } catch (err) {
          console.warn('[Orchestrator] start-error-release-lock-failed:', err instanceof Error ? err.message : String(err));
        }
      }
      this.runs.delete(runId);
      throw err;
    } finally {
      // #295 fix: do NOT stop the conformance monitor here. Discussion
      // runners' `runner.start()` returns before the actual run ends
      // (fire-and-forget loop), so this finally{} fires too early.
      // The monitor's own isActive() check (bound to runner.isRunning)
      // self-stops it when the run truly ends. orchestrator.stop()
      // also calls conformanceMonitor.stop() as a backstop.
      // #299: close the amendments buffer for this run. Safe here
      // because amendments are only consumed at planner-tier prompts;
      // by the time we get here the START phase is done.
      this.amendments.close(runId);
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
          console.warn('[Orchestrator] stop-release-lock-failed:', err instanceof Error ? err.message : String(err));
        }
      }
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
    chainPreset: "blackboard" | "baseline",
  ): Promise<void> {
    // Poll until the original runner truly stops (terminal phase).
    // Cap at 4h so a wedged runner doesn't keep this task alive
    // forever; the caller (orchestrator.start) returned long ago.
    const POLL_MS = 5_000;
    const MAX_WAIT_MS = 4 * 60 * 60_000;
    const startedAt = Date.now();
    while (
      this.runner &&
      this.runId === originalRunId &&
      this.runner.isRunning() &&
      Date.now() - startedAt < MAX_WAIT_MS
    ) {
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    // If the user kicked another run while we were waiting, our
    // originalRunId no longer matches — abandon the chain silently.
    if (this.runId !== originalRunId) return;
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
      await this.stop();
    } catch (err) {
      console.warn('[Orchestrator] forward-chain-stop-failed:', err instanceof Error ? err.message : String(err));
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

  private async buildRunner(preset: PresetId, cfg: RunConfig): Promise<SwarmRunner> {
    // #299: thread getAmendments into runner opts so each runner can
    // read live HITL nudges via this.opts.getAmendments(). The
    // amendments buffer lives on the orchestrator; we bind it here
    // (pre-bound to the active runId) so the runner doesn't need a
    // direct reference to AmendmentsBuffer or the runId. Returns []
    // safely when called before runId is minted (start-time race).
    // 2026-05-02 (persistence lever #2): wrap opts.emit so every
    // SwarmEvent ALSO triggers a debounced snapshot. The persister
    // collapses chunks within DEBOUNCE_MS into one fsync.
    const baseEmit = this.opts.emit;
    const wrappedEmit = (e: SwarmEvent) => {
      // T-Item-MultiTenant Phase 1 (2026-05-04): stamp the active
      // runId onto every SwarmEvent before broadcast so the per-run
      // WS subscriber filter (Phase 2) can route correctly. Variants
      // that already carry a typed runId leave it untouched (it's
      // already correct from the runner). Other variants pick up the
      // orchestrator-level runId.
      const stamped: SwarmEvent =
        e.runId === undefined && this.runId ? { ...e, runId: this.runId } : e;
      baseEmit(stamped);
      // Best-effort snapshot. Persister never throws; a write failure
      // is logged once + silenced for the run.
      const persister = this.runStatePersister;
      if (!persister || !this.runId || !this.runStartedAt) return;
      const status = this.runner?.status();
      // T-Item-Recover (2026-05-04): include cfg in snapshots so the
      // recover endpoint can reconstruct a runnable config without
      // asking the user to re-fill the SetupForm. The `extras`
      // catch-all carries non-core RunConfig fields verbatim so
      // preset-specific knobs survive the round-trip.
      const { preset, repoUrl, localPath, agentCount, rounds, model, ...extras } = cfg;
      persister.schedule({
        runId: this.runId,
        preset: cfg.preset,
        phase: status?.phase ?? "unknown",
        startedAt: this.runStartedAt,
        transcript: status?.transcript ?? [],
        amendments: this.amendments.list(this.runId),
        runConfig: {
          preset,
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
    const opts = {
      ...this.opts,
      emit: wrappedEmit,
      getAmendments: () =>
        this.runId ? this.amendments.list(this.runId) : [],
    };
        const { heuristicPickPreset, createRunner } = await import("../swarm/presetRouter.js");
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
        const factory = async (p: PresetId) => this.buildRunner(p, cfg);
        return new PipelineRunner(opts, factory);
      }
      // Standard presets: delegate to factory
      default:
        return createRunner(cfg, opts);
    }
  }
}
