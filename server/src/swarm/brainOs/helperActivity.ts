/**
 * Live Brain OS helper activity — surfaces on Active Runs / status / agent
 * sidebar without full AgentManager roster participation (helpers are ephemeral).
 */

export interface BrainOsHelperActivity {
  helperId: string;
  runId: string;
  kind: string;
  privilege: string;
  depth: number;
  model?: string;
  startedAt: number;
  phase?: string;
}

export type HelperActivityListener = (
  runId: string,
  helpers: BrainOsHelperActivity[],
  change: { action: "start" | "end"; helper: BrainOsHelperActivity },
) => void;

const activeByRun = new Map<string, Map<string, BrainOsHelperActivity>>();
const listeners = new Set<HelperActivityListener>();

/** Orchestrator / runners subscribe to push WS events. */
export function onHelperActivityChange(fn: HelperActivityListener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function notify(
  runId: string,
  change: { action: "start" | "end"; helper: BrainOsHelperActivity },
): void {
  const helpers = listActiveHelpers(runId);
  for (const fn of listeners) {
    try {
      fn(runId, helpers, change);
    } catch {
      /* ignore listener errors */
    }
  }
}

export function noteHelperStarted(a: BrainOsHelperActivity): void {
  let m = activeByRun.get(a.runId);
  if (!m) {
    m = new Map();
    activeByRun.set(a.runId, m);
  }
  m.set(a.helperId, a);
  notify(a.runId, { action: "start", helper: a });
}

export function noteHelperEnded(runId: string, helperId: string): void {
  const m = activeByRun.get(runId);
  if (!m) return;
  const prev = m.get(helperId);
  m.delete(helperId);
  if (m.size === 0) activeByRun.delete(runId);
  if (prev) notify(runId, { action: "end", helper: prev });
}

export function listActiveHelpers(runId?: string): BrainOsHelperActivity[] {
  if (runId) {
    const m = activeByRun.get(runId);
    return m ? [...m.values()] : [];
  }
  const out: BrainOsHelperActivity[] = [];
  for (const m of activeByRun.values()) {
    out.push(...m.values());
  }
  return out;
}

export function activeHelperCount(runId: string): number {
  return activeByRun.get(runId)?.size ?? 0;
}

/** Test / run-start reset. */
export function resetHelperActivity(runId?: string): void {
  if (runId) activeByRun.delete(runId);
  else activeByRun.clear();
}
