// V2 Step 5a: TodoQueueV2 substrate. NOT yet integrated — Board.ts is
// still the active queue used by BlackboardRunner. This file is the
// V2-track replacement that, once stable, will let us delete Board.ts
// (~330 LOC of claim/CAS/lock-files/expiry/replan machinery) and the
// per-file lock cache (#205) along with it.
//
// Per ARCHITECTURE-V2.md section 5: Board's "claim with file lock"
// model was reinventing what git already does for free. Workers
// dequeue → write hunks → git apply → commit. Conflict detection is
// the merge-conflict result, not a per-file lock check.
//
// This module is the FIFO queue + status bookkeeping. The git-based
// conflict-handling lives in the worker pipeline (Step 5b, future).
//
// Why "V2" suffix: lets the V1 Board run unchanged while this proves
// out. Step 5b/c will integrate, then Board.ts gets deleted.

export type TodoQueueStatusV2 =
  | "pending" // queued, not yet dequeued
  | "in-progress" // dequeued by a worker, not yet completed/failed
  | "completed" // worker finished + committed
  | "failed" // worker gave up after retry exhaustion
  | "skipped"; // worker declined (e.g., out of scope)

export interface QueuedTodoV2 {
  id: string;
  description: string;
  expectedFiles: readonly string[];
  /** Originator agent id — for telemetry, not access control. */
  createdBy: string;
  createdAt: number;
  status: TodoQueueStatusV2;
  /** Set when status moves to in-progress. Cleared on completion/skip. */
  workerId?: string;
  startedAt?: number;
  /** Set when terminal (completed/failed/skipped). */
  endedAt?: number;
  /** Failure / skip reason. Empty for completed. */
  reason?: string;
  /** Optional link back to a contract criterion. Mirrors Board.Todo.criterionId. */
  criterionId?: string;
  /** Number of times this todo was retried after a failure. Capped per
   *  caller policy — the queue itself doesn't enforce a max. */
  retries: number;
}

export interface TodoQueueCountsV2 {
  pending: number;
  inProgress: number;
  completed: number;
  failed: number;
  skipped: number;
  total: number;
}

export interface PostTodoV2Input {
  description: string;
  expectedFiles: readonly string[];
  createdBy: string;
  createdAt?: number;
  criterionId?: string;
}

export class TodoQueueV2 {
  private todos: QueuedTodoV2[] = [];
  private nextIdCounter = 1;

  /** Append a new pending todo to the FIFO. Returns its assigned id. */
  post(input: PostTodoV2Input): string {
    const id = `t${this.nextIdCounter++}`;
    this.todos.push({
      id,
      description: input.description,
      expectedFiles: input.expectedFiles.slice(),
      createdBy: input.createdBy,
      createdAt: input.createdAt ?? Date.now(),
      status: "pending",
      criterionId: input.criterionId,
      retries: 0,
    });
    return id;
  }

  /** Dequeue the oldest pending todo, mark it in-progress, return it.
   *  Returns null if no pending todos. Preserves insertion order
   *  (FIFO) — older todos go out before newer ones. */
  dequeue(workerId: string, ts: number = Date.now()): QueuedTodoV2 | null {
    const next = this.todos.find((t) => t.status === "pending");
    if (!next) return null;
    next.status = "in-progress";
    next.workerId = workerId;
    next.startedAt = ts;
    return { ...next, expectedFiles: next.expectedFiles.slice() };
  }

  /** Mark an in-progress todo as completed. Throws if id unknown or
   *  not in-progress (callers should guard against double-complete). */
  complete(id: string, ts: number = Date.now()): void {
    const t = this.findOrThrow(id);
    if (t.status !== "in-progress") {
      throw new Error(`Cannot complete todo ${id}: status=${t.status}`);
    }
    t.status = "completed";
    t.endedAt = ts;
    t.reason = undefined;
  }

  /** Mark an in-progress todo as failed. Increments retries.
   *  Caller decides whether to re-enqueue (via reset()) or leave failed. */
  fail(id: string, reason: string, ts: number = Date.now()): void {
    const t = this.findOrThrow(id);
    if (t.status !== "in-progress") {
      throw new Error(`Cannot fail todo ${id}: status=${t.status}`);
    }
    t.status = "failed";
    t.endedAt = ts;
    t.reason = reason;
    t.retries += 1;
  }

  /** Mark an in-progress todo as skipped (worker declined this todo
   *  for legitimate reasons — e.g., out of scope, file doesn't exist).
   *  Distinct from "failed" so retry policies can ignore skips. */
  skip(id: string, reason: string, ts: number = Date.now()): void {
    const t = this.findOrThrow(id);
    if (t.status !== "in-progress") {
      throw new Error(`Cannot skip todo ${id}: status=${t.status}`);
    }
    t.status = "skipped";
    t.endedAt = ts;
    t.reason = reason;
  }

  /** Reset a failed todo back to pending so dequeue picks it up again.
   *  Preserves the retry count — the caller has visibility to enforce
   *  a max-retries policy via getRetries(). Throws if id unknown or
   *  not in failed state. */
  reset(id: string): void {
    const t = this.findOrThrow(id);
    if (t.status !== "failed") {
      throw new Error(`Cannot reset todo ${id}: status=${t.status} (only failed allowed)`);
    }
    t.status = "pending";
    t.workerId = undefined;
    t.startedAt = undefined;
    t.endedAt = undefined;
    t.reason = undefined;
  }

  /** Get the retry count for a todo. Useful for "give up after N
   *  retries" policies the caller enforces above this layer. */
  getRetries(id: string): number {
    return this.findOrThrow(id).retries;
  }

  counts(): TodoQueueCountsV2 {
    let pending = 0,
      inProgress = 0,
      completed = 0,
      failed = 0,
      skipped = 0;
    for (const t of this.todos) {
      if (t.status === "pending") pending++;
      else if (t.status === "in-progress") inProgress++;
      else if (t.status === "completed") completed++;
      else if (t.status === "failed") failed++;
      else if (t.status === "skipped") skipped++;
    }
    return {
      pending,
      inProgress,
      completed,
      failed,
      skipped,
      total: this.todos.length,
    };
  }

  /** Snapshot of all todos in insertion order. Returns defensive copies
   *  so the caller can't mutate internal state through the array. */
  list(): QueuedTodoV2[] {
    return this.todos.map((t) => ({
      ...t,
      expectedFiles: t.expectedFiles.slice(),
    }));
  }

  /** Lookup by id. Returns undefined for unknown ids. */
  get(id: string): QueuedTodoV2 | undefined {
    const t = this.todos.find((x) => x.id === id);
    if (!t) return undefined;
    return { ...t, expectedFiles: t.expectedFiles.slice() };
  }

  /** Empty the queue. Useful for tests + run-restart. */
  clear(): void {
    this.todos = [];
    this.nextIdCounter = 1;
  }

  private findOrThrow(id: string): QueuedTodoV2 {
    const t = this.todos.find((x) => x.id === id);
    if (!t) throw new Error(`Unknown todo id: ${id}`);
    return t;
  }
}
