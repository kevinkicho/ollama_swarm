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
  getOrchestrator: () => { start: (cfg: unknown) => Promise<string> };
  maxConcurrentRuns: number;
  canStartRun: () => boolean;
  getActiveRunCount: () => number;
  /** Optional: called when a brain-initiated run is provisioned (for events/UI). */
  onProvision?: (runId: string | null, proposal: ImprovementProposal) => void;
  /** System pressure signal (from proxy or other) to decide on provisioning for stability. */
  getSystemPressure?: () => { recordCount: number; atLimit: boolean };
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

      const pressure = opts.getSystemPressure?.();
      if (pressure?.atLimit) {
        console.log(`[brain-provisioner] High system pressure (records at limit), delaying brain run for stability: ${proposal.title}`);
        // Still allow for efficiency/stability, but log; in future could queue.
      }

      const agentCount = (pressure && pressure.atLimit) ? 4 : 8;
      const cfg = generateRunConfig(proposal, clonePath, agentCount);
      if (!cfg) {
        console.log(`[brain-provisioner] Cannot generate RunConfig for proposal: ${proposal.title}`);
        return null;
      }

      try {
        const orch = opts.getOrchestrator();
        await orch.start(cfg);
        const runId = (cfg as any).runId ?? null;
        console.log(`[brain-provisioner] Started brain run for proposal: ${proposal.title} → ${runId ?? "unknown"}`);
        opts.onProvision?.(runId, { ...proposal, id: (proposal as any).id });
        return runId;
      } catch (err) {
        console.error(`[brain-provisioner] Failed to start run: ${err instanceof Error ? err.message : err}`);
        return null;
      }
    },

    getActiveRunCount(): number {
      return opts.getActiveRunCount();
    },

    canStartRun(): boolean {
      return opts.canStartRun();
    },
  };
}

/**
 * Generate a RunConfig from a proposal.
 */
function generateRunConfig(proposal: ImprovementProposal, clonePath: string, agentCount: number): Record<string, unknown> | null {
  // Determine the directive based on the proposal
  const directive = `Implement the following improvement: ${proposal.title}. ${proposal.description}. Target component: ${proposal.affectedComponent}.`;

  return {
    preset: "blackboard",
    localPath: clonePath,
    repoUrl: "",
    agentCount,
    rounds: 0,
    continuous: false,
    userDirective: directive,
    autoGenerateGoals: true,
    writeMode: "multi",
    conflictPolicy: "merge",
    // Use the default high-quality model for Brain-OS work.
    plannerModel: "deepseek-v4-flash:cloud",
    workerModel: "deepseek-v4-flash:cloud",
    // Marker for system awareness (UI badges, filtering concurrent runs, etc.)
    brainInitiated: true,
    brainProposalId: proposal.id,
  };
}
