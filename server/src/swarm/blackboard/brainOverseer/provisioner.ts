// Brain provisioner — librarian/master-admin support for starting runs.
//
// The brain produces run insights and recommendations. The provisioner
// can turn a "followup" insight into a new run configuration (new directive,
// different preset, etc). No longer tied to system code patches.

import type { RunInsight } from "./brainOverseer.js";

export interface RunProvisioner {
  /** Start a run suggested by a brain insight (e.g. followup). */
  startRunForProposal(insight: RunInsight, clonePath: string): Promise<string | null>;
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
  /** Optional: called when a brain-initiated run is provisioned. */
  onProvision?: (runId: string | null, insight: RunInsight) => void;
  getSystemPressure?: () => { recordCount: number; atLimit: boolean };
}

/**
 * Create a run provisioner that can start runs from proposals.
 */
export function createRunProvisioner(opts: RunProvisionerOpts): RunProvisioner {
  return {
    async startRunForProposal(insight: RunInsight, clonePath: string): Promise<string | null> {
      if (!opts.canStartRun()) {
        console.log(`[brain-provisioner] Cannot start run: at capacity (${opts.getActiveRunCount()}/${opts.maxConcurrentRuns})`);
        return null;
      }

      const pressure = opts.getSystemPressure?.();
      if (pressure?.atLimit) {
        console.log(`[brain-provisioner] High pressure, delaying brain run: ${insight.title}`);
      }

      const agentCount = (pressure && pressure.atLimit) ? 4 : 6;
      const cfg = generateRunConfig(insight, clonePath, agentCount);
      if (!cfg) {
        console.log(`[brain-provisioner] Cannot generate config for insight: ${insight.title}`);
        return null;
      }

      try {
        const orch = opts.getOrchestrator();
        const runId = await orch.start(cfg);
        console.log(`[brain-provisioner] Brain provisioned run: ${insight.title} → ${runId ?? "unknown"}`);
        opts.onProvision?.(runId, insight);
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
 * Generate a RunConfig from a run insight (followup recommendation from librarian brain).
 */
function generateRunConfig(insight: RunInsight, clonePath: string, agentCount: number): Record<string, unknown> | null {
  const directive = `Follow-up based on prior run analysis: ${insight.title}. ${insight.description}`;

  return {
    preset: "blackboard",
    localPath: clonePath,
    repoUrl: "",
    agentCount,
    rounds: 2,
    continuous: false,
    userDirective: directive,
    autoGenerateGoals: true,
    writeMode: "multi",
    conflictPolicy: "merge",
    plannerModel: "deepseek-v4-flash:cloud",
    workerModel: "deepseek-v4-flash:cloud",
    brainInitiated: true,
    brainProposalId: (insight as any).id,
  };
}
