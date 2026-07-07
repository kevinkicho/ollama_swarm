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
  contextFiles?: readonly string[];
}

export interface TodoQueueWrappers {
  /** Post a new todo. Returns the queue-assigned id. */
  postTodoQ: (input: PostTodoInput) => string;
  /** Dequeue + atomic claim. Emits todo_claimed (with synthesized
   *  Claim payload) when a todo is returned. */
  dequeueTodoQ: (workerId: string, preferTag?: string) => QueuedTodo | null;
  /** Mark in-progress → completed; emits todo_committed + fires
   *  the onTerminal callback for the runner's reducer. */
  completeTodoQ: (id: string, commitTier?: import("./types.js").CommitTier) => void;
  /** Mark in-progress → failed; emits todo_failed + fires
   *  onFailed for replan-queue routing + telemetry. */
  failTodoQ: (id: string, reason: string, staleReason?: import("./types.js").StaleReason) => void;
  /** Mark any non-terminal → skipped; emits todo_skipped + fires
   *  onTerminal. */
  skipTodoQ: (id: string, reason: string) => void;
  /** Reset failed → pending with optional revisions (description /
   *  files / anchors / kind / command). Emits todo_replanned. */
  resetTodoQ: (id: string, updates?: ResetUpdates) => void;
  /** Append a diagnostic finding (auditor / replanner notes). Emits
   *  finding_posted. */
  postFindingQ: (input: { agentId: string; text: string; createdAt: number }) => void;
  /** Auditor-gated commits: mark in-progress → pending-commit with
   *  proposed hunks. Emits todo_proposed. */
  proposeCommitQ: (id: string, hunks: readonly unknown[], files: readonly string[]) => void;
  /** Auditor-gated commits: approve pending-commit → completed.
   *  Emits todo_committed + fires onTerminal. */
  approveCommitQ: (id: string) => void;
  /** Auditor-gated commits: reject pending-commit → pending (claim released)
   *  with reason. Emits todo_reverted. */
  rejectCommitQ: (id: string, reason: string) => void;
  /** Release in-progress → pending (auditor overrode invalid worker skip).
   *  Does NOT enqueue replan. Emits todo_reverted. */
  releaseTodoQ: (id: string, reason: string, updates?: ResetUpdates) => void;
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

    completeTodoQ(id, commitTier?) {
      todoQueue.complete(id);
      if (commitTier) {
        const t = todoQueue.get(id);
        if (t) (t as any).commitTier = commitTier;
      }
      emit({ type: "todo_committed", todoId: id, commitTier } as any);
      scheduleStateWrite();
      onTerminal("committed", todoQueue.counts().pending);
    },

    failTodoQ(id, reason, staleReason?) {
      const transitioned = todoQueue.fail(id, reason);
      if (!transitioned) return;
      if (staleReason) {
        const t = todoQueue.get(id);
        if (t) (t as any).staleReason = staleReason;
      }
      const t2 = todoQueue.get(id);
      emit({
        type: "todo_stale",
        todoId: id,
        reason,
        staleReason,
        replanCount: t2?.retries ?? 0,
      } as any);
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

    proposeCommitQ(id, hunks, files) {
      todoQueue.proposeCommit(id, hunks, files);
      const todo = todoQueue.get(id);
      if (todo) {
        const wire = v2QueueTodoToWireTodo(todo);
        emit({ type: "todo_proposed", todo: wire });
      }
      scheduleStateWrite();
    },

    approveCommitQ(id) {
      todoQueue.approveCommit(id);
      const wire = v2QueueTodoToWireTodo(todoQueue.get(id)!);
      emit({ type: "todo_committed", todoId: id } as any);
      scheduleStateWrite();
      onTerminal("committed", todoQueue.counts().pending);
    },

    rejectCommitQ(id, reason) {
      todoQueue.rejectCommit(id, reason);
      const wire = v2QueueTodoToWireTodo(todoQueue.get(id)!);
      emit({ type: "todo_reverted", todoId: id, reason });
      scheduleStateWrite();
    },

    releaseTodoQ(id, reason, updates) {
      todoQueue.release(id, reason, updates);
      emit({ type: "todo_reverted", todoId: id, reason });
      scheduleStateWrite();
    },
  };
}
