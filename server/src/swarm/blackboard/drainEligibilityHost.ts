// Drain eligibility input assembly extracted from BlackboardRunner.

import type { SwarmPhase } from "../../types.js";
import type { DrainEligibilityInput } from "./drainEligibility.js";

export interface DrainEligibilityHost {
  phase: SwarmPhase;
  replanPending: Set<string>;
  replanRunning: boolean;
  managerToStates: () => Array<{ index: number; status: string }>;
}

export function getDrainEligibilityInput(
  host: DrainEligibilityHost,
  partial: { claimed: number; pendingCommit: number },
): DrainEligibilityInput {
  const workerThinking = host.managerToStates().some(
    (a) => a.index > 1 && (a.status === "thinking" || a.status === "retrying"),
  );
  return {
    phase: host.phase,
    claimed: partial.claimed,
    pendingCommit: partial.pendingCommit,
    replanPending: host.replanPending.size,
    replanRunning: host.replanRunning,
    workerThinking,
  };
}
