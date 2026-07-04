import type { AgentManager } from "./AgentManager.js";
import type { RunStatePersister } from "./RunStatePersister.js";
import type { ConformanceMonitor } from "./ConformanceMonitor.js";
import type { EmbeddingDriftMonitor } from "./EmbeddingDriftMonitor.js";
import type { AmendmentsBuffer } from "./AmendmentsBuffer.js";
import type { RunConfig } from "../swarm/SwarmRunner.js";
import type { SwarmStatusRunConfig } from "../types.js";
import type { SwarmRunner } from "../swarm/SwarmRunner.js";
import { releaseLock } from "../swarm/cloneLock.js";
import { createLogger } from "./logger.js";
import { RunEventHub } from "./RunEventHub.js";

/**
 * ActiveRun encapsulates the full lifecycle of a single run.
 * Provides RAII-style cleanup via stop().
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

  /**
   * Clean stop + resource release. Idempotent.
   */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;

    try {
      await this.runner.stop();
    } catch (err) {
      this.log.warn('ActiveRun runner stop failed', { error: err instanceof Error ? err.message : err });
    }

    try { this.conformanceMonitor?.stop(); } catch {}
    try { this.embeddingDriftMonitor?.stop(); } catch {}
    try { this.persister.stop(); } catch {}

    if (this.holdsCloneLock && this.cfg.localPath) {
      try {
        releaseLock({ clonePath: this.cfg.localPath, runId: this.runId });
      } catch (err) {
        this.log.warn('ActiveRun release-lock failed', { error: err instanceof Error ? err.message : err });
      }
    }

    if (this.amendments && this.runId) {
      try { this.amendments.close(this.runId); } catch {}
    }

    this.log.info('ActiveRun stopped and cleaned up');
  }

  dispose() {
    // Sync version for cases where async not needed
    if (this.stopped) return;
    this.stopped = true;
    try { this.conformanceMonitor?.stop(); } catch {}
    try { this.embeddingDriftMonitor?.stop(); } catch {}
    try { this.persister.stop(); } catch {}
    if (this.holdsCloneLock && this.cfg.localPath) {
      try { releaseLock({ clonePath: this.cfg.localPath, runId: this.runId }); } catch {}
    }
  }

  isRunning(): boolean {
    return this.runner.isRunning?.() ?? true;
  }
}
