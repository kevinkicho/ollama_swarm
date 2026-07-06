// (Hybrid mode removed 2026-07). No-op stubs kept only for test compatibility.
export function getSidebarAgentTitle(): string {
  return 'Agents';
}
export const isHybridRun = () => false;
export const isExecPhase = () => false;
export const shouldFilterAgentForHybridDisplay = () => false;
export const shouldShowPlannerBox = () => false;
export const shouldShowSyntheticExecAgents = () => false;
export const shouldIgnoreEarlyTerminal = () => false;
export const useHybridInfo = () => ({ isHybrid: false, isExecPhase: false, isPlanningPhase: false });
export const getHybridInfo = () => ({ isHybrid: false, isExecPhase: false, isPlanningPhase: false });
