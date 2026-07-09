/** Session-scoped bash failure count — survives per-prompt ToolDispatcher instances. */

export const BASH_ERROR_BACKOFF_THRESHOLD = 4;

const bashErrorsByAgent = new Map<string, number>();

export function getAgentBashErrors(agentId: string | undefined): number {
  if (!agentId) return 0;
  return bashErrorsByAgent.get(agentId) ?? 0;
}

export function recordAgentBashResult(agentId: string | undefined, ok: boolean): number {
  if (!agentId) return 0;
  const next = ok ? 0 : (bashErrorsByAgent.get(agentId) ?? 0) + 1;
  bashErrorsByAgent.set(agentId, next);
  return next;
}

export function clearAgentBashBackoff(agentId: string): void {
  bashErrorsByAgent.delete(agentId);
}

/** Test-only */
export function resetAllAgentBashBackoff(): void {
  bashErrorsByAgent.clear();
}