// Brain service — persistent brain that survives across runs.
//
// The brain is called by the Orchestrator after each run completes.
// It accumulates knowledge across runs and can provision new runs.

import { runBrainAnalysis, type BrainAnalysisResult, type ImprovementProposal } from "./brainOverseer.js";
import { createRunProvisioner, type RunProvisioner } from "./provisioner.js";
import { createBrainQueue, type BrainQueue } from "./brainQueue.js";
import type { InteractionTracker } from "./interactionTracker.js";
import type { ExceptionCollector } from "./exceptionCollector.js";

export interface BrainService {
  /** Analyze a completed run. */
  analyzeRun(
    interactionTracker: InteractionTracker,
    exceptionCollector: ExceptionCollector,
    clonePath: string,
    runId: string,
    promptFn?: (prompt: string, model: string, maxTokens: number, timeoutMs: number) => Promise<string>,
    model?: string,
  ): Promise<BrainAnalysisResult>;
  /** Get the run provisioner for starting new runs. */
  getProvisioner(): RunProvisioner;
  /** Get the brain queue for coordinating work. */
  getQueue(): BrainQueue;
  /** Get all proposals across all runs. */
  getAllProposals(): Promise<Array<{ title: string; description: string; affectedComponent: string; priority: "high" | "medium" | "low" }>>;
  /** Track run health from events. */
  trackRunHealth(event: { type: string; runId?: string; [key: string]: unknown }): void;
  /** Get health summary for all tracked runs. */
  getHealthSummary(): Map<string, { status: string; errors: number; lastUpdate: number }>;
}

export interface BrainServiceOpts {
  /** Maximum concurrent runs. */
  maxConcurrentRuns: number;
  /** Get the Orchestrator instance. */
  getOrchestrator: () => { start: (cfg: unknown) => Promise<{ runId?: string }>; status: () => { activeRuns: number } };
}

/**
 * Create a persistent brain service that survives across runs.
 */
export function createBrainService(opts: BrainServiceOpts): BrainService {
  const provisioner = createRunProvisioner({
    getOrchestrator: opts.getOrchestrator,
    maxConcurrentRuns: opts.maxConcurrentRuns,
  });

  const queue = createBrainQueue();

  // Track run health across all runs
  const runHealth = new Map<string, { status: string; errors: number; lastUpdate: number }>();

  return {
    async analyzeRun(
      interactionTracker,
      exceptionCollector,
      clonePath,
      runId,
      promptFn,
      model,
    ): Promise<BrainAnalysisResult> {
      return runBrainAnalysis(
        interactionTracker,
        exceptionCollector,
        clonePath,
        runId,
        [], // priorImprovements
        promptFn,
        model,
      );
    },

    getProvisioner() {
      return provisioner;
    },

    getQueue() {
      return queue;
    },

    async getAllProposals() {
      const { readProposals } = await import("./proposalStore.js");
      // Read proposals from the current clone path
      // For now, return empty - will be implemented when we have a persistent clone path
      return [];
    },

    trackRunHealth(event) {
      const runId = event.runId;
      if (!runId) return;

      const current = runHealth.get(runId) ?? { status: "unknown", errors: 0, lastUpdate: 0 };

      if (event.type === "swarm_state") {
        current.status = (event as any).phase ?? current.status;
      } else if (event.type === "error") {
        current.errors += 1;
      }
      current.lastUpdate = Date.now();

      runHealth.set(runId, current);
    },

    getHealthSummary() {
      return new Map(runHealth);
    },
  };
}
