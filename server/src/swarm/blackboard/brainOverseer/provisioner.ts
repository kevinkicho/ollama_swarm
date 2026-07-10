// Brain provisioner — librarian/master-admin support for starting runs.
//
// The brain produces run insights and recommendations. The provisioner
// can turn a "followup" insight into a new run configuration (new directive,
// different preset, etc). No longer tied to system code patches.
//
// Phase 7 (2026-07-09): approve-to-provision is the default. Auto-start only
// when SWARM_BRAIN_AUTO_PROVISION=true or opts.approved === true.

import type { RunInsight } from "./brainOverseer.js";
import { prepareResearchConfig } from "../../researchHelpers.js";
import { config } from "../../../config.js";

export interface ProvisionStartOpts {
  /** Explicit user/Brain UI approval for this start (required unless auto-provision is on). */
  approved?: boolean;
}

export interface RunProvisioner {
  /** Start a run suggested by a brain insight (e.g. followup). */
  startRunForProposal(
    insight: RunInsight,
    clonePath: string,
    startOpts?: ProvisionStartOpts,
  ): Promise<string | null>;
  /** Get the number of active runs. */
  getActiveRunCount(): number;
  /** Check if the system can start a new run. */
  canStartRun(): boolean;
  /** Whether auto-provision is enabled (env). */
  isAutoProvisionEnabled(): boolean;
}

export interface RunProvisionerOpts {
  getOrchestrator: () => { start: (cfg: unknown) => Promise<string> };
  maxConcurrentRuns: number;
  canStartRun: () => boolean;
  getActiveRunCount: () => number;
  /** Optional: called when a brain-initiated run is provisioned. */
  onProvision?: (runId: string | null, insight: RunInsight) => void;
  getSystemPressure?: () => { recordCount: number; atLimit: boolean };
  /** Override env for tests. */
  autoProvision?: boolean;
}

/**
 * Create a run provisioner that can start runs from proposals.
 */
export function createRunProvisioner(opts: RunProvisionerOpts): RunProvisioner {
  const autoEnabled = () =>
    opts.autoProvision !== undefined ? opts.autoProvision : config.SWARM_BRAIN_AUTO_PROVISION;

  return {
    isAutoProvisionEnabled(): boolean {
      return autoEnabled();
    },

    async startRunForProposal(
      insight: RunInsight,
      clonePath: string,
      startOpts?: ProvisionStartOpts,
    ): Promise<string | null> {
      if (!autoEnabled() && startOpts?.approved !== true) {
        console.log(
          `[brain-provisioner] Approve-to-provision: refusing auto-start for "${insight.title}" `
            + `(set SWARM_BRAIN_AUTO_PROVISION=true or pass approved: true)`,
        );
        return null;
      }

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

  // Research-friendly defaults when the insight suggests external knowledge work
  const isResearch = (insight.category && String(insight.category).includes("research")) ||
    /research|literature|scientific|web|internet|paper|study|superconductor/i.test(directive);

  const base = {
    preset: "blackboard",
    localPath: clonePath,
    repoUrl: "",
    agentCount,
    rounds: isResearch ? 1 : 2,
    continuous: false,
    userDirective: directive,
    autoGenerateGoals: true,
    writeMode: isResearch ? "single" : "multi",
    conflictPolicy: "merge",
    plannerModel: "deepseek-v4-flash:cloud",
    workerModel: "deepseek-v4-flash:cloud",
    webTools: isResearch,
    plannerTools: isResearch,
    brainInitiated: true,
    brainProposalId: (insight as any).id,
  };

  // Use the shared research helper for consistency with Orchestrator
  const prepared = prepareResearchConfig(base as any);
  return prepared as unknown as Record<string, unknown>;
}
