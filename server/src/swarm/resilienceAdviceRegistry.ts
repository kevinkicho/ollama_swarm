/**
 * Run-scoped control/resilience advice for mid-run gates (zero-progress limit,
 * early Brain OS). Mirrors SwarmControlCenter history + brain_os emits.
 */

import type { SwarmControlAdviceRecord } from "@ollama-swarm/shared/swarmControl/controlAdvice";
import {
  computeResilienceRollup,
  type ResilienceRollup,
} from "@ollama-swarm/shared/swarmControl/controlAdvice";

const byRun = new Map<string, SwarmControlAdviceRecord[]>();

export function pushResilienceAdvice(
  runId: string | undefined | null,
  advice: SwarmControlAdviceRecord,
): void {
  const id = runId?.trim();
  if (!id) return;
  let list = byRun.get(id);
  if (!list) {
    list = [];
    byRun.set(id, list);
  }
  list.push(advice);
  if (list.length > 60) list.splice(0, list.length - 60);
}

export function getResilienceAdvice(
  runId: string | undefined | null,
): readonly SwarmControlAdviceRecord[] {
  const id = runId?.trim();
  if (!id) return [];
  return byRun.get(id) ?? [];
}

export function rollupResilienceForRun(
  runId: string | undefined | null,
  deliberation?: ReadonlyArray<{ verdict?: string }>,
): ResilienceRollup {
  return computeResilienceRollup(getResilienceAdvice(runId), deliberation);
}

export function resetResilienceAdvice(runId?: string | null): void {
  if (runId?.trim()) byRun.delete(runId.trim());
  else byRun.clear();
}
