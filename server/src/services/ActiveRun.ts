import type { AgentManager } from "./AgentManager.js";
import type { RunStatePersister } from "./RunStatePersister.js";
import type { ConformanceMonitor } from "./ConformanceMonitor.js";
import type { EmbeddingDriftMonitor } from "./EmbeddingDriftMonitor.js";
import type { AmendmentsBuffer } from "./AmendmentsBuffer.js";
import type { RunConfig } from "../swarm/SwarmRunner.js";
import type { SwarmStatusRunConfig, SwarmPhase } from "../types.js";
import type { SwarmRunner } from "../swarm/SwarmRunner.js";
import { releaseLock } from "../swarm/cloneLock.js";
import { createLogger } from "./logger.js";
import { RunEventHub } from "./RunEventHub.js";
import { loadRunSummaryForRunId } from "./runSummaryDiscovery.js";
import { recoverCrashSummaryFromSnapshot } from "./crashSummaryRecovery.js";
import type { RepoService } from "./RepoService.js";

export type ActiveRunTeardownOpts = {
  /**
   * Call runner.stop(). Default true for user/hard stop.
   * Use false when the runner already finished naturally — re-stop would
   * kill agents again and rewrite phase as "stopped".
   */
  stopRunner?: boolean;
  /** Optional forced terminal snapshot (user-stop backstop). */
  terminalPhase?: SwarmPhase;
  terminalReason?: string;
  /** Backfill summary.json when missing. Default true. */
  ensureSummary?: boolean;
};

/**
 * ActiveRun encapsulates the full lifecycle of a single run.
 * Provides RAII-style cleanup via teardown() / stop() / dispose().
 * This centralizes resource management that was previously scattered
 * in Orchestrator.start / stopRun / cleanupStaleRuns.
 */
export class ActiveRun {
  private readonly log = createLogger();
  private stopped = false;

  public hub?: RunEventHub;  // Per-run event hub for organized emission
  public conformanceMonitor?: ConformanceMonitor;
  public embeddingDriftMonitor?: EmbeddingDriftMonitor;

  constructor(
    public readonly runId: string,
    public readonly startedAt: number,
    public readonly cfg: RunConfig,
    public readonly runConfig: SwarmStatusRunConfig,
    public readonly runner: SwarmRunner,
    public readonly manager: AgentManager,
    public readonly persister: RunStatePersister,
    conformanceMonitor?: ConformanceMonitor,
    embeddingDriftMonitor?: EmbeddingDriftMonitor,
    public readonly amendments?: AmendmentsBuffer,
    public holdsCloneLock = false,
    hub?: RunEventHub,
    private readonly repos?: Pick<RepoService, "gitStatus">,
  ) {
    this.log = createLogger({ runId });
    this.conformanceMonitor = conformanceMonitor;
    this.embeddingDriftMonitor = embeddingDriftMonitor;
    this.hub = hub;
  }

  /** Attach monitors after construction (for paths that wire them later). */
  attachMonitors(conformance?: ConformanceMonitor, drift?: EmbeddingDriftMonitor) {
    if (conformance) this.conformanceMonitor = conformance;
    if (drift) this.embeddingDriftMonitor = drift;
  }

  /** Attach the per-run event hub. */
  attachHub(hub: RunEventHub) {
    this.hub = hub;
  }

  /** Emit via hub if available, falling back to no-op for now. */
  emit(event: any, category: any = "other") {
    if (this.hub) {
      this.hub.emit(event, category);
    }
  }

  /** True after teardown/stop/dispose has run (idempotent gate). */
  isTornDown(): boolean {
    return this.stopped;
  }

  /**
   * Unified cleanup for all terminal paths (user stop, natural complete,
   * start failure, stale reap). Idempotent.
   */
  async teardown(opts: ActiveRunTeardownOpts = {}): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;

    const stopRunner = opts.stopRunner !== false;
    if (stopRunner) {
      try {
        await this.runner.stop();
      } catch (err) {
        this.log.warn("ActiveRun runner stop failed", {
          error: err instanceof Error ? err.message : err,
        });
      }
    }

    if (opts.terminalPhase) {
      try {
        this.forceTerminalSnapshot(
          opts.terminalPhase,
          opts.terminalReason ?? opts.terminalPhase,
        );
      } catch (err) {
        this.log.warn("ActiveRun forceTerminalSnapshot failed", {
          error: err instanceof Error ? err.message : err,
        });
      }
    }

    if (opts.ensureSummary !== false) {
      await this.ensureSummaryOnDisk();
    }

    this.releaseResources();
    this.log.info("ActiveRun torn down", {
      stopRunner,
      terminalPhase: opts.terminalPhase,
    });
  }

  /**
   * User/hard stop: stop the runner + release resources.
   * Prefer Orchestrator.removeRun → teardown for map bookkeeping.
   */
  async stop(): Promise<void> {
    await this.teardown({
      stopRunner: true,
      terminalPhase: "stopped",
      terminalReason: "user-stop",
    });
  }

  /**
   * Sync resource release when the runner is already terminal (or never
   * started). Does not call runner.stop() — avoids rewriting "completed"
   * as "stopped". Always closes amendments + clone lock.
   */
  dispose(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.releaseResources();
  }

  isRunning(): boolean {
    return this.runner.isRunning?.() ?? true;
  }

  /** Release monitors, persister, clone lock, amendments. Safe to call once. */
  private releaseResources(): void {
    try {
      this.conformanceMonitor?.stop();
    } catch {
      /* ignore */
    }
    try {
      this.embeddingDriftMonitor?.stop();
    } catch {
      /* ignore */
    }
    try {
      this.persister.stop();
    } catch {
      /* ignore */
    }

    if (this.holdsCloneLock && this.cfg.localPath) {
      try {
        releaseLock({ clonePath: this.cfg.localPath, runId: this.runId });
      } catch (err) {
        this.log.warn("ActiveRun release-lock failed", {
          error: err instanceof Error ? err.message : err,
        });
      }
      this.holdsCloneLock = false;
    }

    if (this.amendments && this.runId) {
      try {
        this.amendments.close(this.runId);
      } catch {
        /* ignore */
      }
    }

    // End per-run debug WriteStream so multi-run servers don't leak FDs.
    if (this.hub) {
      try {
        this.hub.close();
      } catch {
        /* ignore */
      }
    }
  }

  /** Force a terminal snapshot write with the given phase and stopReason. */
  private async ensureSummaryOnDisk(): Promise<void> {
    if (!this.cfg.localPath) return;
    const existing = loadRunSummaryForRunId(this.cfg.localPath, this.runId);
    if (existing?.stopReason) return;
    try {
      const status = this.runner.status?.();
      await recoverCrashSummaryFromSnapshot(
        {
          runId: this.runId,
          preset: this.cfg.preset,
          phase: status?.phase ?? "stopped",
          startedAt: this.startedAt,
          lastEventAt: Date.now(),
          transcript: status?.transcript ?? [],
          runConfig: this.runConfig as any,
        },
        this.cfg.localPath,
        this.runId,
        this.repos,
      );
    } catch (err) {
      this.log.warn("ActiveRun crash summary backfill failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  forceTerminalSnapshot(phase: SwarmPhase, stopReason: string) {
    // The persister expects schedule with current runner status, but we override phase
    const status = (
      this.runner.status
        ? this.runner.status()
        : { phase, transcript: [], agents: [] }
    ) as any;
    status.phase = phase;
    this.persister.schedule({
      runId: this.runId,
      preset: this.cfg.preset,
      phase,
      startedAt: this.startedAt,
      lastEventAt: Date.now(),
      transcript: status.transcript || [],
      amendments: [],
      runConfig: this.runConfig,
      contract: status.contract,
      // stopReason is consumed by recovery tooling when present
      stopReason,
    } as any);
    this.persister.stop(); // flush immediately
  }
}
