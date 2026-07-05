/**
 * HybridStateHelper — Phase 10 FULL REMOVAL.
 * All guards and phase state logic removed. Hybrid is transparent.
 * These are no-op stubs kept only to avoid import breakage in tests/old code.
 * All functions return neutral values; no special hybrid behavior.
 */

export function getSidebarAgentTitle(_showAsPlanner: boolean, _isTerminal: boolean, summaryLen: number, agentLen: number): string {
  return `Agents (${( _isTerminal && summaryLen) || agentLen})`;
}

// Legacy stubs (always neutral)
export const isHybridRun = () => false;
export const isExecPhase = () => false;
export const shouldFilterAgentForHybridDisplay = () => false;
export const shouldShowPlannerBox = () => false;
export const shouldShowSyntheticExecAgents = () => false;
export const shouldIgnoreEarlyTerminal = () => false;
export const useHybridInfo = () => ({ isHybrid: false, isExecPhase: false, isPlanningPhase: false });
export const getHybridInfo = () => ({ isHybrid: false, isExecPhase: false, isPlanningPhase: false });
