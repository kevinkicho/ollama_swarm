// TodoQueue: the swarm's primary in-memory todo store. FIFO with
// status bookkeeping (pending / in-progress / completed / failed /
// skipped). The git-based conflict-handling lives in WorkerPipeline;
// this module is queue + status only.
//
// Per ARCHITECTURE-V2.md section 5: the older Board model that
// preceded this file used "claim with file lock" semantics that
// reinvented what git does for free. Workers now dequeue → write
// hunks via search-anchor matching → git commit. Sibling-worker
// conflict shows up as anchor-not-found at apply time.
//
// History: shipped 2026-04-26 as a parallel-track substrate while
// the legacy Board.ts kept running. After zero divergences across
// 7 SDK presets, the V2 cutover (commits 4e08092 → 85c5614, 2026-
// 04-28) made this the only queue and Board.ts was deleted.

export type TodoQueueStatus =
  | "pending" // queued, not yet dequeued
  | "in-progress" // dequeued by a worker, not yet completed/failed
  | "completed" // worker finished + committed
  | "failed" // worker gave up after retry exhaustion
  | "skipped"; // worker declined (e.g., out of scope)

export interface QueuedTodo {
  id: string;
  description: string;
  expectedFiles: readonly string[];
  /** Originator agent id — for telemetry, not access control. */
  createdBy: string;
  createdAt: number;
  status: TodoQueueStatus;
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
  // Planner-time hints carried alongside the todo. Originally added
  // to V1 Board's Todo type; ported here during the V2 cutover
  // (commits 8177e90, 2026-04-28) so the new queue keeps parity.
  /** Unit 44b: planner-declared anchor strings the runner expands into
   *  ±25 lines of context in the worker prompt. Empty/absent → behaves
   *  like before (head + tail only). */
  expectedAnchors?: readonly string[];
  /** #237: build-style discriminator. Default "hunks" (omit). When
   *  "build", `command` is the shell command swarm-builder runs. */
  kind?: "hunks" | "build";
  command?: string;
  /** Phase 5c of #243: planner-emitted tag preference for claim
   *  routing. dequeue(workerId, preferTag) prefers todos whose tag
   *  matches the worker's tag. */
  preferredTag?: string;
}

export interface TodoQueueCounts {
  pending: number;
  inProgress: number;
  completed: number;
  failed: number;
  skipped: number;
  total: number;
}

export interface PostTodoInput {
  description: string;
  expectedFiles: readonly string[];
  createdBy: string;
  createdAt?: number;
  criterionId?: string;
  // Phase 2 of V2 cutover (2026-04-28): pass-through for V1-equivalent
  // planner hints. The queue stores them; consumers (worker prompt
  // builder, claim selector) read them.
  expectedAnchors?: readonly string[];
  kind?: "hunks" | "build";
  command?: string;
  preferredTag?: string;
}

export class TodoQueue {
  private todos: QueuedTodo[] = [];
  private nextIdCounter = 1;

  /** Append a new pending todo to the FIFO. Returns its assigned id. */
  post(input: PostTodoInput): string {
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
      ...(input.expectedAnchors && input.expectedAnchors.length > 0
        ? { expectedAnchors: input.expectedAnchors.slice() }
        : {}),
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.command ? { command: input.command } : {}),
      ...(input.preferredTag ? { preferredTag: input.preferredTag } : {}),
    });
    return id;
  }

  /** Dequeue the next pending todo. Two-pass semantics when preferTag
   *  is supplied (Phase 5c of #243): first scan for a pending todo
   *  whose preferredTag matches; if none found, fall through to the
   *  oldest pending todo regardless of tag. preferTag undefined →
   *  pure FIFO. Returns null when no pending todos remain.
   *
   *  Stamps in-progress + workerId + startedAt on the matched todo
   *  before returning a defensive copy. */
  dequeue(
    workerId: string,
    preferTag?: string,
    ts: number = Date.now(),
  ): QueuedTodo | null {
    let next: QueuedTodo | undefined;
    const tag = preferTag?.trim();
    if (tag && tag.length > 0) {
      next = this.todos.find(
        (t) => t.status === "pending" && t.preferredTag === tag,
      );
    }
    if (!next) {
      next = this.todos.find((t) => t.status === "pending");
    }
    if (!next) return null;
    next.status = "in-progress";
    next.workerId = workerId;
    next.startedAt = ts;
    return this.copyTodo(next);
  }

  /** Phase 2 reaper: scan in-progress todos and transition any whose
   *  startedAt is more than maxAgeMs in the past to `failed`. Returns
   *  the array of reaped ids so the caller can route them through
   *  the replan queue. Idempotent — running back-to-back is safe.
   *
   *  Trigger is purely time-based — there's no per-claim TTL field on
   *  the todo. The queue uses a single global threshold instead of
   *  recording expiresAt per dequeue. */
  reapStaleInProgress(now: number, maxAgeMs: number): string[] {
    const reaped: string[] = [];
    for (const t of this.todos) {
      if (
        t.status === "in-progress" &&
        t.startedAt !== undefined &&
        now - t.startedAt > maxAgeMs
      ) {
        t.status = "failed";
        t.endedAt = now;
        t.reason = `worker timeout (>${Math.round(maxAgeMs / 60_000)}min in-progress)`;
        t.retries += 1;
        reaped.push(t.id);
      }
    }
    return reaped;
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

  /** Mark a todo as skipped (worker declined for legitimate reasons —
   *  out of scope, file doesn't exist, replanner gave up). Allowed
   *  from any non-terminal status; idempotent on already-skipped.
   *  Distinct from "failed" so retry policies ignore skips.
   *
   *  V2 cutover Phase 2c (2026-04-28): widened from "in-progress only"
   *  to "any non-terminal" to match Board.skip semantics — the
   *  replanner skips todos it can't process from `failed` state too. */
  skip(id: string, reason: string, ts: number = Date.now()): void {
    const t = this.findOrThrow(id);
    if (t.status === "skipped") return;
    if (t.status === "completed") {
      throw new Error(`Cannot skip todo ${id}: already completed`);
    }
    t.status = "skipped";
    t.endedAt = ts;
    t.reason = reason;
    t.workerId = undefined;
    t.startedAt = undefined;
  }

  /** Reset a failed todo back to pending so dequeue picks it up again.
   *  Preserves the retry count — the caller has visibility to enforce
   *  a max-retries policy via getRetries(). Throws if id unknown or
   *  not in failed state.
   *
   *  V2 cutover Phase 2c (2026-04-28): optional `updates` parameter
   *  matches Board.replan — the replanner can revise the todo's
   *  description / files / anchors / kind / command before re-pending
   *  it. expectedAnchors=undefined keeps prior anchors; an explicit
   *  empty array clears them (matches Board.replan policy). */
  reset(
    id: string,
    updates?: {
      description?: string;
      expectedFiles?: readonly string[];
      expectedAnchors?: readonly string[];
      kind?: "hunks" | "build";
      command?: string;
    },
  ): void {
    const t = this.findOrThrow(id);
    if (t.status !== "failed") {
      throw new Error(`Cannot reset todo ${id}: status=${t.status} (only failed allowed)`);
    }
    t.status = "pending";
    t.workerId = undefined;
    t.startedAt = undefined;
    t.endedAt = undefined;
    t.reason = undefined;
    if (updates) {
      if (updates.description !== undefined) {
        if (!updates.description.trim()) {
          throw new Error(`Cannot reset todo ${id}: empty description`);
        }
        t.description = updates.description;
      }
      if (updates.expectedFiles !== undefined) {
        t.expectedFiles = updates.expectedFiles.slice();
      }
      if (updates.expectedAnchors !== undefined) {
        t.expectedAnchors =
          updates.expectedAnchors.length > 0 ? updates.expectedAnchors.slice() : undefined;
      }
      if (updates.kind !== undefined) t.kind = updates.kind;
      if (updates.command !== undefined) t.command = updates.command;
    }
  }

  /** Get the retry count for a todo. Useful for "give up after N
   *  retries" policies the caller enforces above this layer. */
  getRetries(id: string): number {
    return this.findOrThrow(id).retries;
  }

  counts(): TodoQueueCounts {
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
  list(): QueuedTodo[] {
    return this.todos.map((t) => this.copyTodo(t));
  }

  /** Lookup by id. Returns undefined for unknown ids. */
  get(id: string): QueuedTodo | undefined {
    const t = this.todos.find((x) => x.id === id);
    return t ? this.copyTodo(t) : undefined;
  }

  /** Defensive copy — clones expectedFiles + expectedAnchors arrays so
   *  callers can't mutate internal state through them. Other fields
   *  are immutable scalars / strings. */
  private copyTodo(t: QueuedTodo): QueuedTodo {
    return {
      ...t,
      expectedFiles: t.expectedFiles.slice(),
      ...(t.expectedAnchors ? { expectedAnchors: t.expectedAnchors.slice() } : {}),
    };
  }

  /** Empty the queue. Useful for tests + run-restart. */
  clear(): void {
    this.todos = [];
    this.nextIdCounter = 1;
  }

  // syncStatus + postWithId removed (audit, 2026-04-28). Both were
  // V1-Board mirror helpers that bypassed the dequeue/complete state
  // machine; with V1 gone they have no callers.

  private findOrThrow(id: string): QueuedTodo {
    const t = this.todos.find((x) => x.id === id);
    if (!t) throw new Error(`Unknown todo id: ${id}`);
    return t;
  }
}
