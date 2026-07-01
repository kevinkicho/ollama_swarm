import { runBrainAnalysis, type BrainAnalysisResult, type ImprovementProposal } from "./brainOverseer.js";
import { createRunProvisioner, type RunProvisioner } from "./provisioner.js";
import { createBrainQueue, type BrainQueue } from "./brainQueue.js";
import type { InteractionTracker } from "./interactionTracker.js";
import type { ExceptionCollector } from "./exceptionCollector.js";

export interface BrainService {
  analyzeRun(
    interactionTracker: InteractionTracker,
    exceptionCollector: ExceptionCollector,
    clonePath: string,
    runId: string,
    promptFn?: (prompt: string, model: string, maxTokens: number, timeoutMs: number) => Promise<string>,
    model?: string,
  ): Promise<BrainAnalysisResult>;
  getProvisioner(): RunProvisioner;
  getQueue(): BrainQueue;
  getAllProposals(): Promise<Array<{ title: string; description: string; affectedComponent: string; priority: "high" | "medium" | "low" }>>;
  trackRunHealth(event: { type: string; runId?: string; [key: string]: unknown }): void;
  getHealthSummary(): Map<string, { status: string; errors: number; lastUpdate: number }>;
  subscribeToEvents(eventHandler: (event: { type: string; [key: string]: unknown }) => void): () => void;
  getBrainHealth(): { status: string; lastAnalysis: number; proposalCount: number; errorCount: number };
}

export interface BrainServiceOpts {
  maxConcurrentRuns: number;
  getOrchestrator: () => { start: (cfg: unknown) => Promise<{ runId?: string }>; status: () => { activeRuns: number } };
}

export function createBrainService(opts: BrainServiceOpts): BrainService {
  const provisioner = createRunProvisioner({
    getOrchestrator: opts.getOrchestrator,
    maxConcurrentRuns: opts.maxConcurrentRuns,
    canStartRun: () => opts.getOrchestrator().status().activeRuns < opts.maxConcurrentRuns,
    getActiveRunCount: () => opts.getOrchestrator().status().activeRuns,
  });

  const queue = createBrainQueue();
  const runHealth = new Map<string, { status: string; errors: number; lastUpdate: number }>();
  const eventSubscribers = new Set<(event: { type: string; [key: string]: unknown }) => void>();
  let brainHealth = { status: "idle", lastAnalysis: 0, proposalCount: 0, errorCount: 0 };

  return {
    async analyzeRun(interactionTracker, exceptionCollector, clonePath, runId, promptFn, model) {
      brainHealth.status = "analyzing";
      brainHealth.lastAnalysis = Date.now();
      try {
        const result = await runBrainAnalysis(interactionTracker, exceptionCollector, clonePath, runId, [], promptFn, model);
        brainHealth.proposalCount += result.proposals.length;
        brainHealth.status = "idle";
        return result;
      } catch (err) {
        brainHealth.errorCount++;
        brainHealth.status = "error";
        throw err;
      }
    },

    getProvisioner() { return provisioner; },
    getQueue() { return queue; },

    async getAllProposals() {
      const { readProposals } = await import("./proposalStore.js");
      return [];
    },

    trackRunHealth(event) {
      const runId = event.runId;
      if (!runId) return;
      const current = runHealth.get(runId) ?? { status: "unknown", errors: 0, lastUpdate: 0 };
      if (event.type === "swarm_state") current.status = (event as any).phase ?? current.status;
      else if (event.type === "error") current.errors += 1;
      current.lastUpdate = Date.now();
      runHealth.set(runId, current);
      for (const subscriber of eventSubscribers) {
        try { subscriber(event); } catch {}
      }
    },

    getHealthSummary() { return new Map(runHealth); },

    subscribeToEvents(eventHandler) {
      eventSubscribers.add(eventHandler);
      return () => { eventSubscribers.delete(eventHandler); };
    },

    getBrainHealth() { return { ...brainHealth }; },
  };
}
