/** Session-scoped bash failure count — survives per-prompt ToolDispatcher instances. */

/**
 * Disable bash after this many consecutive failures for the agent.
 * Windows defaults lower: Unix-cli thrash burns turns before coaches fire.
 */
export const BASH_ERROR_BACKOFF_THRESHOLD = process.platform === "win32" ? 3 : 4;

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

/** Clear all agents (run start / process hygiene). */
export function resetAllAgentBashBackoff(): void {
  bashErrorsByAgent.clear();
}