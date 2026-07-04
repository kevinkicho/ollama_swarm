import { mkdirSync, writeFileSync } from "node:fs";
import * as nodePath from "node:path";
import type { RunConfig } from "../swarm/SwarmRunner.js";
import type { ActiveRun } from "./ActiveRun.js";
import { rootLogger } from "./logger.js";

// Extracted deeper brain integration slice from Orchestrator.
// Handles persistent BrainService (librarian/provisioner), per-run chat
// history for FAB/during-run Brain chat, and related wiring.
// This decouples brain lifecycle (init, ready gate, history persist, monitoring)
// from core run start/stop/recover logic for better maintainability.
// See prior refactor comments for "brain integration (brainChatHistories, get/setBrain, whenBrainReady)".

export interface BrainIntegrationOpts {
  maxConcurrentRuns?: number;
  emit: (e: any, cat?: string) => void;
  getRunsSize: () => number;
  getStartInProgress: () => boolean;
  getActiveRun: () => ActiveRun | null;
  getRunById: (runId: string) => ActiveRun | undefined;
  startRun: (cfg: RunConfig) => Promise<string>;
}

export class BrainIntegration {
  private brainChatHistories = new Map<string, Array<{ role: string; content: string }>>();
  private brainService: import("../swarm/blackboard/brainOverseer/brainService.js").BrainService | null = null;
  private brainReady!: Promise<void>;
  private opts: BrainIntegrationOpts;

  constructor(opts: BrainIntegrationOpts) {
    this.opts = opts;
    this.initialize();
  }

  private initialize(): void {
    // Deeper extracted: init + background monitoring + gates.
    this.brainReady = import("../swarm/blackboard/brainOverseer/brainService.js").then(
      ({ createBrainService }) => {
        const maxConcurrentRuns = this.opts.maxConcurrentRuns ?? 4;
        this.brainService = createBrainService({
          maxConcurrentRuns,
          getOrchestrator: () => ({ start: (cfg) => this.opts.startRun(cfg as RunConfig) }),
          getActiveRunCount: this.opts.getRunsSize,
          canStartRun: () => !this.opts.getStartInProgress() && this.opts.getRunsSize() < maxConcurrentRuns,
          emit: (e, cat) => {
            const active = this.opts.getActiveRun();
            if (active?.hub) active.hub.emit(e, (cat as any) || "brain");
          },
          getRunnerForRun: (runId) => {
            const active = this.opts.getRunById(runId);
            return active ? active.runner : null;
          },
        });
        this.brainService?.startBackgroundMonitoring(60000);
        rootLogger.info('brain-service initialized (deeper slice)');
      },
    );
  }

  async whenReady(): Promise<void> {
    await this.brainReady;
  }

  getService() {
    return this.brainService;
  }

  setChatHistory(runId: string, history: Array<{ role: string; content: string }>) {
    this.brainChatHistories.set(runId, history);
    this.writeDedicatedHistory(runId, history);
  }

  getChatHistory(runId: string): Array<{ role: string; content: string }> | undefined {
    return this.brainChatHistories.get(runId);
  }

  private writeDedicatedHistory(runId: string, history: Array<{ role: string; content: string }>) {
    try {
      const logDir = nodePath.join(process.cwd(), "logs", runId);
      mkdirSync(logDir, { recursive: true });
      writeFileSync(nodePath.join(logDir, "brain-chat.json"), JSON.stringify(history, null, 2), "utf8");
    } catch {
      // best-effort; don't block chat
    }
  }

  registerClonePath(localPath?: string) {
    if (localPath) this.brainService?.registerClonePath(localPath);
  }

  trackRunHealth(event: any) {
    this.brainService?.trackRunHealth(event);
  }

  // For use in wrappedEmit etc.
  getBrainChatHistoriesMap() {
    return this.brainChatHistories;
  }
}
