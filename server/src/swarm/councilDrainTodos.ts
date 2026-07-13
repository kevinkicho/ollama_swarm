/**
 * Council execution drain: run workers on pending todos with reaper.
 * Does not return until the cycle's todos are settled (completed, permanent
 * skip, or exhausted fail/soft-skip after all agents have tried).
 */

import type { Agent, AgentManager } from "../services/AgentManager.js";
import type { RunConfig } from "./SwarmRunner.js";
import type { SwarmEvent } from "../types.js";
import type { CouncilAdapterState } from "./councilAdapter.js";
import { runCouncilWorkers } from "./councilWorkerRunner.js";
import type { SwarmControlCenter } from "./control/SwarmControlCenter.js";
import {
  createSettlementBook,
  cycleExecutionSettled,
  maxAttemptsForCycle,
  recordSettlementAttempt,
  requeueUnresolvedCouncilTodos,
  summarizeUnresolved,
} from "./councilCycleSettlement.js";

export interface CouncilDrainHost {
  state: CouncilAdapterState;
  manager: AgentManager;
  appendSystem: (msg: string, summary?: unknown) => void;
  setPhase: (phase: string) => void;
  executionFailures: string[];
  recordTodoSettled: (
    cycle: number,
    info: {
      description: string;
      expectedFiles?: readonly string[] | null;
      outcome: "completed" | "skipped" | "failed";
      detail?: string;
    },
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

  /** Per-worker abort so reaper can kill the stuck prompt, not only the queue entry. */
  const todoAborts = new Map<string, AbortController>();
  const settlementBook = createSettlementBook();
  const executionAgentIds = executionAgents.map((a) => a.id);
  const maxAttempts = maxAttemptsForCycle(executionAgents.length);

  const REAPER_INTERVAL = 30_000;
  const IN_PROGRESS_TTL = 15 * 60_000;
  const PENDING_COMMIT_TTL = 20 * 60_000;
  const reaper = setInterval(() => {
    const now = Date.now();
    const reaped = host.state.todoQueue.reapStaleInProgress(now, IN_PROGRESS_TTL);
    for (const id of reaped) {
      const todo = host.state.todoQueue.get(id);
      const workerId = todo?.workerId;
      if (workerId) {
        recordSettlementAttempt(settlementBook, id, workerId, "reaper: in-progress TTL");
        const ctrl = todoAborts.get(workerId);
        if (ctrl && !ctrl.signal.aborted) {
          try {
            ctrl.abort(new Error(`reaper: todo ${id} exceeded ${IN_PROGRESS_TTL / 60_000}min`));
          } catch {
            /* ignore */
          }
        }
      }
      host.appendSystem(
        `[reaper] Timed out todo ${id} — was in-progress for >${Math.round(IN_PROGRESS_TTL / 60_000)}min` +
          (workerId ? ` (aborted ${workerId})` : "") +
          ".",
      );
    }
    // C9: pending-commit must not block cycle settlement forever.
    const pcReaped = host.state.todoQueue.reapStalePendingCommit(now, PENDING_COMMIT_TTL);
    for (const id of pcReaped) {
      recordSettlementAttempt(settlementBook, id, "auditor", "reaper: pending-commit TTL");
      host.appendSystem(
        `[reaper] Timed out pending-commit ${id} — reopened after >${Math.round(PENDING_COMMIT_TTL / 60_000)}min.`,
      );
    }
  }, REAPER_INTERVAL);
  reaper.unref();

  const drainWork = (async () => {
    const coachAgent = host.manager.list().find((a) => a.index === 1);
    let totalCompleted = 0;
    let totalFailed = 0;
    let totalSkipped = 0;
    let pass = 0;
    const MAX_SETTLEMENT_PASSES = Math.max(4, maxAttempts + 2);

    while (!host.isStopping() && !host.isDraining()) {
      pass++;
      if (pass > MAX_SETTLEMENT_PASSES) {
        host.appendSystem(
          `[execution] Settlement pass limit (${MAX_SETTLEMENT_PASSES}) — leaving remaining unresolved: ${summarizeUnresolved(host.state.todoQueue)}.`,
        );
        break;
      }

      {
        const counts = host.state.todoQueue.counts();
        // Wait for pending-commit too (cycleExecutionSettled) so audit does not
        // run while auditor-gated commits are still open.
        if (
          counts.pending === 0
          && counts.inProgress === 0
          && counts.pendingCommit === 0
        ) {
          break;
        }
        // Only pending-commit remain — workers cannot progress; reaper will
        // reopen stale ones. Avoid spinning empty worker passes.
        if (counts.pending === 0 && counts.inProgress === 0 && counts.pendingCommit > 0) {
          host.appendSystem(
            `[execution] ${counts.pendingCommit} pending-commit todo(s) await auditor; ` +
              `pausing worker drain for this cycle (reaper TTL applies).`,
          );
          break;
        }
      }

      const { completed, failed, skipped } = await runCouncilWorkers(
        host.state,
        executionAgents,
        {
          appendSystem: (msg) => host.appendSystem(msg),
          recordFailure: (_todoId, description, error) => {
            host.executionFailures.push(`${description}: ${error.slice(0, 200)}`);
          },
          onTodoSettledByAgent: (agentId, info) => {
            if (info.outcome === "failed" || info.outcome === "skipped") {
              recordSettlementAttempt(
                settlementBook,
                info.todoId,
                agentId,
                info.detail,
              );
            }
            host.recordTodoSettled(cycle, {
              description: info.description,
              expectedFiles: info.expectedFiles ?? [],
              outcome: info.outcome,
              detail: info.detail,
            });
          },
          stopping: () => host.isStopping(),
          draining: () => host.isDraining(),
          promptSignal: host.promptSignal(),
          registerTodoAbort: (workerId, ctrl) => {
            todoAborts.set(workerId, ctrl);
          },
          unregisterTodoAbort: (workerId) => {
            todoAborts.delete(workerId);
          },
          getSwarmControl: () => host.swarmControl,
          getCoachAgent: () => coachAgent,
          emit: (e) => host.emit(e as SwarmEvent),
        },
      );

      totalCompleted += completed;
      totalFailed += failed;
      totalSkipped += skipped;

      // Fallback: if worker didn't report agent id, attribute fail/skip by last workerId on todo before clear — already recorded via onTodoSettledByAgent when wired.

      const { requeued, exhausted, permanentSkipped } = requeueUnresolvedCouncilTodos(
        host.state.todoQueue,
        executionAgentIds,
        settlementBook,
        { maxAttempts },
      );

      if (permanentSkipped.length > 0) {
        host.appendSystem(
          `[execution] Permanent-skipped ${permanentSkipped.length} todo(s) ` +
            `(noop/attempts exhausted): ${permanentSkipped.join(", ")}.`,
        );
      }

      if (requeued > 0) {
        host.appendSystem(
          `[execution] Re-queued ${requeued} unresolved todo(s) for another agent attempt ` +
            `(max ${maxAttempts} attempts/todo; pass ${pass}).`,
        );
        continue;
      }

      if (exhausted.length > 0) {
        host.appendSystem(
          `[execution] Exhausted retries on ${exhausted.length} todo(s) after all agents tried ` +
            `(or max attempts): ${exhausted.join(", ")}.`,
        );
      }
      break;
    }

    host.appendSystem(
      `[execution] Complete: ${totalCompleted} done, ${totalFailed} failed, ${totalSkipped} skipped` +
        (cycleExecutionSettled(host.state.todoQueue)
          ? " — cycle queue settled."
          : ` — residual: ${summarizeUnresolved(host.state.todoQueue)}.`),
      {
        kind: "council_stage",
        cycle,
        stage: "execution",
        detail: `${totalCompleted} done, ${totalFailed} failed, ${totalSkipped} skipped`,
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
    await drainWork;
  } finally {
    clearInterval(reaper);
  }
}
