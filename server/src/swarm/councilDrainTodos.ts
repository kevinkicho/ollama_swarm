/**
 * Council execution drain: run workers on pending todos with reaper.
 * Extracted from CouncilRunner.drainTodos.
 */

import type { Agent, AgentManager } from "../services/AgentManager.js";
import type { RunConfig } from "./SwarmRunner.js";
import type { SwarmEvent } from "../types.js";
import type { CouncilAdapterState } from "./councilAdapter.js";
import { runCouncilWorkers } from "./councilWorkerRunner.js";
import type { SwarmControlCenter } from "./control/SwarmControlCenter.js";

export interface CouncilDrainHost {
  state: CouncilAdapterState;
  manager: AgentManager;
  appendSystem: (msg: string, summary?: unknown) => void;
  setPhase: (phase: string) => void;
  executionFailures: string[];
  recordTodoSettled: (
    cycle: number,
    info: { todoId: string; description: string; status: string; error?: string },
  ) => void;
  isStopping: () => boolean;
  isDraining: () => boolean;
  promptSignal: () => AbortSignal | undefined;
  swarmControl: SwarmControlCenter;
  emit: (e: SwarmEvent) => void;
  setWorkerDrainPromise: (p: Promise<void> | null) => void;
  resolveDrain?: () => void;
}

export async function drainCouncilTodos(
  host: CouncilDrainHost,
  cfg: RunConfig,
  cycle: number,
): Promise<void> {
  void cfg;
  const agents = host.manager.list();
  const executionAgents = agents.filter((a) => a.index > 1);
  if (executionAgents.length === 0) return;

  const pending = host.state.todoQueue.counts().pending;
  if (pending > 0) {
    host.appendSystem(`[execution] Starting ${pending} todo(s)…`, {
      kind: "council_stage",
      cycle,
      stage: "execution",
      detail: `${pending} todo${pending === 1 ? "" : "s"}`,
    });
  }

  host.setPhase("executing");

  const REAPER_INTERVAL = 30_000;
  const IN_PROGRESS_TTL = 15 * 60_000;
  const reaper = setInterval(() => {
    const reaped = host.state.todoQueue.reapStaleInProgress(Date.now(), IN_PROGRESS_TTL);
    for (const id of reaped) {
      host.appendSystem(`[reaper] Timed out todo ${id} — was in-progress for >10min.`);
    }
  }, REAPER_INTERVAL);
  reaper.unref();

  const drainWork = (async () => {
    const coachAgent = host.manager.list().find((a) => a.index === 1);
    const { completed, failed, skipped } = await runCouncilWorkers(
      host.state,
      executionAgents,
      {
        appendSystem: (msg) => host.appendSystem(msg),
        recordFailure: (_todoId, description, error) => {
          host.executionFailures.push(`${description}: ${error.slice(0, 200)}`);
        },
        onTodoSettled: (info) => host.recordTodoSettled(cycle, info as any),
        stopping: () => host.isStopping(),
        draining: () => host.isDraining(),
        promptSignal: host.promptSignal(),
        getSwarmControl: () => host.swarmControl,
        getCoachAgent: () => coachAgent,
        emit: (e) => host.emit(e as SwarmEvent),
      },
    );

    host.appendSystem(
      `[execution] Complete: ${completed} done, ${failed} failed, ${skipped} skipped.`,
      {
        kind: "council_stage",
        cycle,
        stage: "execution",
        detail: `${completed} done, ${failed} failed, ${skipped} skipped`,
      },
    );
    host.resolveDrain?.();
  })();

  host.setWorkerDrainPromise(
    drainWork.finally(() => {
      host.setWorkerDrainPromise(null);
    }),
  );

  try {
    const p = host as CouncilDrainHost & { workerDrainPromise?: Promise<void> | null };
    // Wait via the setter's stored promise — host must expose wait method.
    await drainWork;
  } finally {
    clearInterval(reaper);
  }
}
