// Wrappers around TodoQueue + FindingsLog mutations that bundle the
// side effects every BlackboardRunner site needs: state-write
// scheduling, BoardEvent emission for UI sync, and observer
// callbacks for the runner's lifecycle reducer + replan queue.
//
// Extracted from BlackboardRunner (commit 52bda05 follow-up) so the
// orchestration is unit-testable without spinning up a full runner
// instance. The runner instantiates one TodoQueueWrappers via
// makeTodoQueueWrappers in its constructor and delegates all queue
// mutations through it.

import type { TodoQueue, PostTodoInput, QueuedTodo } from "./TodoQueue.js";
import type { FindingsLog } from "./FindingsLog.js";
import type { BoardEvent } from "./types.js";
import { v2QueueTodoToWireTodo } from "./boardWireCompat.js";

export interface TodoQueueWrapperDeps {
  todoQueue: TodoQueue;
  findings: FindingsLog;
  /** BoardEvent → SwarmEvent broadcast (typically boardBroadcaster.emit). */
  emit: (ev: BoardEvent) => void;
  /** Schedule a debounced write of blackboard-state.json. */
  scheduleStateWrite: () => void;
  /** Called after every successful complete() or skip(). The `remaining`
   *  arg is the queue's pending count AFTER the mutation — the runner's
   *  reducer uses it to transition executing → auditing on drain. */
  onTerminal: (kind: "committed" | "skipped", remainingPending: number) => void;
  /** Called after fail() with the failed todo id. Runner enqueues
   *  replan + bumps the stale-events telemetry counter. */
  onFailed: (todoId: string) => void;
}

export interface ResetUpdates {
  description?: string;
  expectedFiles?: readonly string[];
  expectedAnchors?: readonly string[];
  kind?: "hunks" | "build";
  command?: string;
}

export interface TodoQueueWrappers {
  /** Post a new todo. Returns the queue-assigned id. */
  postTodoQ: (input: PostTodoInput) => string;
  /** Dequeue + atomic claim. Emits board_todo_claimed (with synthesized
   *  Claim payload) when a todo is returned. */
  dequeueTodoQ: (workerId: string, preferTag?: string) => QueuedTodo | null;
  /** Mark in-progress → completed; emits board_todo_committed + fires
   *  the onTerminal callback for the runner's reducer. */
  completeTodoQ: (id: string) => void;
  /** Mark in-progress → failed; emits board_todo_stale + fires
   *  onFailed for replan-queue routing + telemetry. */
  failTodoQ: (id: string, reason: string) => void;
  /** Mark any non-terminal → skipped; emits board_todo_skipped + fires
   *  onTerminal. */
  skipTodoQ: (id: string, reason: string) => void;
  /** Reset failed → pending with optional revisions (description /
   *  files / anchors / kind / command). Emits board_todo_replanned. */
  resetTodoQ: (id: string, updates?: ResetUpdates) => void;
  /** Append a diagnostic finding (auditor / replanner notes). Emits
   *  board_finding_posted. */
  postFindingQ: (input: { agentId: string; text: string; createdAt: number }) => void;
}

export function makeTodoQueueWrappers(deps: TodoQueueWrapperDeps): TodoQueueWrappers {
  const { todoQueue, findings, emit, scheduleStateWrite, onTerminal, onFailed } = deps;

  return {
    postTodoQ(input) {
      const id = todoQueue.post(input);
      const wire = v2QueueTodoToWireTodo(todoQueue.get(id)!);
      emit({ type: "todo_posted", todo: wire });
      scheduleStateWrite();
      return id;
    },

    dequeueTodoQ(workerId, preferTag) {
      const t = todoQueue.dequeue(workerId, preferTag);
      if (!t) return null;
      const wire = v2QueueTodoToWireTodo(t);
      if (wire.claim) {
        emit({ type: "todo_claimed", todoId: t.id, claim: wire.claim });
      }
      scheduleStateWrite();
      return t;
    },

    completeTodoQ(id) {
      todoQueue.complete(id);
      emit({ type: "todo_committed", todoId: id });
      scheduleStateWrite();
      onTerminal("committed", todoQueue.counts().pending);
    },

    failTodoQ(id, reason) {
      todoQueue.fail(id, reason);
      const t = todoQueue.get(id);
      emit({
        type: "todo_stale",
        todoId: id,
        reason,
        replanCount: t?.retries ?? 0,
      });
      scheduleStateWrite();
      onFailed(id);
    },

    skipTodoQ(id, reason) {
      todoQueue.skip(id, reason);
      emit({ type: "todo_skipped", todoId: id, reason });
      scheduleStateWrite();
      onTerminal("skipped", todoQueue.counts().pending);
    },

    resetTodoQ(id, updates) {
      todoQueue.reset(id, updates);
      const t = todoQueue.get(id);
      if (t) {
        emit({
          type: "todo_replanned",
          todoId: id,
          description: t.description,
          expectedFiles: t.expectedFiles.slice(),
          replanCount: t.retries,
          ...(t.expectedAnchors && t.expectedAnchors.length > 0
            ? { expectedAnchors: t.expectedAnchors.slice() }
            : {}),
        });
      }
      scheduleStateWrite();
    },

    postFindingQ(input) {
      const f = findings.post(input);
      emit({ type: "finding_posted", finding: f });
      scheduleStateWrite();
    },
  };
}
