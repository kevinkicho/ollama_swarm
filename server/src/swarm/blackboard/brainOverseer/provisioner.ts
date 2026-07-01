// Brain provisioner — creates runs on demand from proposals.
//
// The brain analyzes patterns and generates proposals. When a proposal
// is ready to implement, the provisioner generates a RunConfig and
// starts a run via the Orchestrator.

import type { ImprovementProposal, BrainAnalysisResult } from "./brainOverseer.js";

export interface RunProvisioner {
  /** Start a run for a specific proposal. */
  startRunForProposal(proposal: ImprovementProposal, clonePath: string): Promise<string | null>;
  /** Get the number of active runs. */
  getActiveRunCount(): number;
  /** Check if the system can start a new run. */
  canStartRun(): boolean;
}

export interface RunProvisionerOpts {
  /** Get the Orchestrator instance. */
  getOrchestrator: () => { start: (cfg: unknown) => Promise<{ runId?: string }>; status: () => { activeRuns: number } };
  /** Maximum concurrent runs. */
  maxConcurrentRuns: number;
}

/**
 * Create a run provisioner that can start runs from proposals.
 */
export function createRunProvisioner(opts: RunProvisionerOpts): RunProvisioner {
  return {
    async startRunForProposal(proposal: ImprovementProposal, clonePath: string): Promise<string | null> {
      if (!opts.canStartRun()) {
        console.log(`[brain-provisioner] Cannot start run: at capacity (${opts.getActiveRunCount()}/${opts.maxConcurrentRuns})`);
        return null;
      }

      // Generate RunConfig from proposal
      const cfg = generateRunConfig(proposal, clonePath);
      if (!cfg) {
        console.log(`[brain-provisioner] Cannot generate RunConfig for proposal: ${proposal.title}`);
        return null;
      }

      try {
        const orch = opts.getOrchestrator();
        const result = await orch.start(cfg as any);
        console.log(`[brain-provisioner] Started run for proposal: ${proposal.title} → ${result.runId ?? "unknown"}`);
        return result.runId ?? null;
      } catch (err) {
        console.error(`[brain-provisioner] Failed to start run: ${err instanceof Error ? err.message : err}`);
        return null;
      }
    },

    getActiveRunCount(): number {
      return opts.getOrchestrator().status().activeRuns;
    },

    canStartRun(): boolean {
      return opts.getActiveRunCount() < opts.maxConcurrentRuns;
    },
  };
}

/**
 * Generate a RunConfig from a proposal.
 */
function generateRunConfig(proposal: ImprovementProposal, clonePath: string): Record<string, unknown> | null {
  // Determine the directive based on the proposal
  const directive = `Implement the following improvement: ${proposal.title}. ${proposal.description}. Target component: ${proposal.affectedComponent}.`;

  return {
    preset: "blackboard",
    parentPath: clonePath,
    repoUrl: "",
    agentCount: 2, // Smaller team for targeted improvements
    rounds: 0,
    continuous: false, // One-shot for specific improvements
    userDirective: directive,
    autoGenerateGoals: true,
    writeMode: "multi",
    conflictPolicy: "merge",
  };
}
