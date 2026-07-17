/**
 * Clear process-scoped per-run telemetry maps after summary snapshot.
 * Prevents unbounded growth across many runs in one server process.
 */

import { clearApplyIntegrityTracking } from "./applyIntegrityStats.js";
import { clearCycleIntegrityTracking } from "./cycleIntegrityStats.js";
import { clearResearchBudget } from "./research/researchBudget.js";
import { clearProgressHeartbeat } from "./progressHeartbeat.js";
import { resetAllAgentBashBackoff } from "../tools/agentBashBackoff.js";

/** Drop run-scoped counters after summary is assembled (or on start of next run). */
export function clearRunTelemetry(runId?: string | null): void {
  clearApplyIntegrityTracking(runId);
  clearCycleIntegrityTracking(runId);
  clearResearchBudget(runId);
  clearProgressHeartbeat(runId);
}

/** Call at run start so agent-N ids don't inherit prior-run bash lockouts. */
export function resetAgentSessionGuards(): void {
  resetAllAgentBashBackoff();
}
