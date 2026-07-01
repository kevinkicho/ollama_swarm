// Brain service — persistent brain that survives across runs.
//
// The brain is called by the Orchestrator after each run completes.
// It accumulates knowledge across runs and can provision new runs.

import { runBrainAnalysis, type BrainAnalysisResult, type ImprovementProposal } from "./brainOverseer.js";
import { createRunProvisioner, type RunProvisioner } from "./provisioner.js";
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
  /** Get all proposals across all runs. */
  getAllProposals(): Promise<Array<{ title: string; description: string; affectedComponent: string; priority: "high" | "medium" | "low" }>>;
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

    async getAllProposals() {
      const { readProposals } = await import("./proposalStore.js");
      // Read proposals from the current clone path
      // For now, return empty - will be implemented when we have a persistent clone path
      return [];
    },
  };
}
