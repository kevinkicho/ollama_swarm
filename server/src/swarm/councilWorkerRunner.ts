/**
 * Council worker pool: dequeue → executeTodoWithRetryChain → settle.
 * Literature / emit+apply / stage recovery live in sibling modules
 * (councilWorkerLiterature, councilWorkerAttempt, councilWorkerRetryChain).
 */

import type { Agent } from "../services/AgentManager.js";
import { realFilesystemAdapter, realGitAdapter } from "./blackboard/v2Adapters.js";
import {
  emitCouncilTodoClaimed,
  emitCouncilTodoCommitted,
  emitCouncilTodoFailed,
  emitCouncilTodoSkipped,
} from "./councilTodoWire.js";
import type { CouncilAdapterState } from "./councilAdapter.js";
import { dequeueCouncilTodo } from "./councilWorkerDequeue.js";
import {
  recordCycleFail,
  recordCycleTodoSuccess,
} from "./cycleIntegrityStats.js";
import { classifyCycleFailReason } from "@ollama-swarm/shared/cycleIntegrityReport";
import { classifyWorkerSkip } from "@ollama-swarm/shared/skipClassify";
import { formatWorkerAttemptOutcomeLine } from "@ollama-swarm/shared/workerAttemptOutcome";
import { executeTodoWithRetryChain } from "./councilWorkerRetryChain.js";
import type {
  TodoExecuteResult,
  WorkerRunnerContext,
} from "./councilWorkerTypes.js";

// Re-export public types (back-compat for importers of councilWorkerRunner).
export type { TodoSettledOutcome, WorkerRunnerContext } from "./councilWorkerTypes.js";

const WORKER_COOLDOWN_MS = 5_000;
const WORKER_DEFER_POLL_MS = 750;

function setWorkerThinking(state: CouncilAdapterState, agent: Agent): void {
  (state.manager as { markStatus: (id: string, status: string, extra?: Record<string, unknown>) => void })
    .markStatus(agent.id, "thinking", { thinkingSince: Date.now() });
}

function setWorkerReady(state: CouncilAdapterState, agent: Agent): void {
  (state.manager as { markStatus: (id: string, status: string, extra?: Record<string, unknown>) => void })
    .markStatus(agent.id, "ready", { lastMessageAt: Date.now() });
}

export async function runCouncilWorkers(
  state: CouncilAdapterState,
  agents: Agent[],
  ctx: WorkerRunnerContext,
): Promise<{ completed: number; failed: number; skipped: number }> {
  if (agents.length === 0) return { completed: 0, failed: 0, skipped: 0 };

  const fsAdapter = realFilesystemAdapter(state.clonePath);
  const gitAdapter = realGitAdapter(state.clonePath);
  const results = await Promise.all(
    agents.map((agent) =>
      runCouncilWorker(state, agent, fsAdapter, gitAdapter, ctx),
    ),
  );

  return {
    completed: results.reduce((s, r) => s + r.completed, 0),
    failed: results.reduce((s, r) => s + r.failed, 0),
    skipped: results.reduce((s, r) => s + r.skipped, 0),
  };
}

async function runCouncilWorker(
  state: CouncilAdapterState,
  agent: Agent,
  fsAdapter: ReturnType<typeof realFilesystemAdapter>,
  gitAdapter: ReturnType<typeof realGitAdapter>,
  ctx: WorkerRunnerContext,
): Promise<{ completed: number; failed: number; skipped: number }> {
  let completed = 0, failed = 0, skipped = 0;

  while (!ctx.stopping()) {
    if (ctx.draining?.()) break;
    const todo = dequeueCouncilTodo(
      state.todoQueue,
      agent.id,
      ctx.getFileFailStreak?.(),
    );
    if (todo) {
      emitCouncilTodoClaimed(state.emit, todo);
    }
    if (!todo) {
      if (state.todoQueue.counts().pending === 0) break;
      await new Promise((r) => setTimeout(r, WORKER_DEFER_POLL_MS));
      continue;
    }

    setWorkerThinking(state, agent);
    ctx.appendSystem(`[execution] ${agent.id} working on: ${todo.description.slice(0, 120)}...`);

    let result: TodoExecuteResult;
    try {
      result = await executeTodoWithRetryChain(agent, todo, state, fsAdapter, gitAdapter, ctx);
    } finally {
      setWorkerReady(state, agent);
    }
    if (result.outcome === "completed") {
      state.todoQueue.complete(todo.id);
      emitCouncilTodoCommitted(state.emit, todo.id);
      completed++;
      recordCycleTodoSuccess(state.cfg.runId);
      ctx.appendSystem(
        formatWorkerAttemptOutcomeLine({
          todoId: todo.id,
          agentId: agent.id,
          stage: "settled",
          terminal: "completed",
          file: todo.expectedFiles[0],
        }),
      );
      const settled = {
        todoId: todo.id,
        description: todo.description,
        expectedFiles: [...(todo.expectedFiles ?? [])],
        outcome: "completed" as const,
      };
      ctx.onTodoSettled?.(settled);
      ctx.onTodoSettledByAgent?.(agent.id, settled);
      await new Promise((r) => setTimeout(r, WORKER_COOLDOWN_MS + Math.floor(Math.random() * 500)));
    } else if (result.outcome === "skipped") {
      // Record agent before skip clears workerId.
      const settled = {
        todoId: todo.id,
        description: todo.description,
        expectedFiles: [...(todo.expectedFiles ?? [])],
        outcome: "skipped" as const,
        detail: result.reason,
      };
      ctx.onTodoSettledByAgent?.(agent.id, settled);
      state.todoQueue.skip(todo.id, result.reason);
      emitCouncilTodoSkipped(state.emit, state.todoQueue, todo.id);
      skipped++;
      const skipClass = classifyWorkerSkip(result.reason);
      ctx.appendSystem(
        formatWorkerAttemptOutcomeLine({
          todoId: todo.id,
          agentId: agent.id,
          stage: "settled",
          terminal: "skipped",
          skipCode: skipClass.ok ? skipClass.code : "garbage",
          detail: result.reason.slice(0, 100),
          file: todo.expectedFiles[0],
        }),
      );
      // Skip is not a hard fail bucket unless permanent/noop-ish.
      if (/permanent|noop|exhausted|wont-do|won't do/i.test(result.reason)) {
        recordCycleFail(result.reason, state.cfg.runId, todo.id);
      }
      ctx.onTodoSettled?.(settled);
    } else {
      const settled = {
        todoId: todo.id,
        description: todo.description,
        expectedFiles: [...(todo.expectedFiles ?? [])],
        outcome: "failed" as const,
        detail: result.error,
      };
      ctx.onTodoSettledByAgent?.(agent.id, settled);
      state.todoQueue.fail(todo.id, result.error);
      emitCouncilTodoFailed(state.emit, state.todoQueue, todo.id);
      failed++;
      recordCycleFail(result.error, state.cfg.runId, todo.id);
      ctx.appendSystem(
        formatWorkerAttemptOutcomeLine({
          todoId: todo.id,
          agentId: agent.id,
          stage: "settled",
          terminal: "failed",
          bucket: classifyCycleFailReason(result.error),
          detail: result.error.slice(0, 100),
          file: todo.expectedFiles[0],
        }),
      );
      ctx.recordFailure?.(todo.id, todo.description, result.error.slice(0, 200));
      ctx.onTodoSettled?.(settled);
    }
  }

  return { completed, failed, skipped };
}
