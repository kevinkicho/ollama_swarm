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
  /** 2026-05-02 (auto-rollback decision #1): full multi-criterion
   *  attribution from the planner. When set, rollback eligibility +
   *  per-criterion commit attribution use this list. The legacy
   *  singular criterionId mirrors criteriaIds[0] for back-compat. */
  criteriaIds?: readonly string[];
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
  /** T-Item-3 (2026-05-04): in-flight parallel hypothesis. When the
   *  planner emits multiple alternatives (`[hypothesis: A/B/C]` tags)
   *  for the same criterion, all alternatives in that group share the
   *  same groupId. The runner uses this to:
   *  - run alternatives in parallel
   *  - when the FIRST commits, mark the rest as `skipped — alternative
   *    landed`
   *  - serialize within group when alternatives' expectedFiles overlap
   *  Absent on regular (non-alternative) todos. */
  groupId?: string;
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
  /** 2026-05-02 (auto-rollback decision #1): planner-declared multi-
   *  criterion attribution. Stored on the queued todo so commit-time
   *  bookkeeping can attribute the resulting commits to ALL declared
   *  criteria (not just the first). */
  criteriaIds?: readonly string[];
  /** T-Item-3 (2026-05-04): in-flight parallel hypothesis grouping.
   *  See QueuedTodo.groupId for semantics. */
  groupId?: string;
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
      ...(input.criteriaIds && input.criteriaIds.length > 0
        ? { criteriaIds: input.criteriaIds.slice() }
        : {}),
      ...(input.expectedAnchors && input.expectedAnchors.length > 0
        ? { expectedAnchors: input.expectedAnchors.slice() }
        : {}),
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.command ? { command: input.command } : {}),
      ...(input.preferredTag ? { preferredTag: input.preferredTag } : {}),
      ...(input.groupId ? { groupId: input.groupId } : {}),
    });
    return id;
  }

  /** T-Item-3 (2026-05-04): list every todo in a hypothesis group.
   *  Defensive copies. Empty array when no group with that id exists. */
  listGroup(groupId: string): QueuedTodo[] {
    return this.todos
      .filter((t) => t.groupId === groupId)
      .map((t) => this.copyTodo(t));
  }

  /** T-Item-3 (2026-05-04): a hypothesis group has settled — one
   *  alternative successfully completed (the winner). Marks every
   *  OTHER non-terminal alternative as skipped with reason
   *  "alternative <winnerId> landed first". The winner itself is left
   *  untouched (caller already moved it to completed via complete()).
   *
   *  Returns the list of skipped todo ids so the caller can log /
   *  surface to the auditor. Idempotent: alternatives already in a
   *  terminal state (completed/failed/skipped) are skipped silently. */
  markGroupSettled(
    groupId: string,
    winnerId: string,
    ts: number = Date.now(),
  ): { skipped: string[] } {
    const skipped: string[] = [];
    for (const t of this.todos) {
      if (t.groupId !== groupId) continue;
      if (t.id === winnerId) continue;
      if (
        t.status === "completed" ||
        t.status === "failed" ||
        t.status === "skipped"
      ) {
        continue;
      }
      // Direct mutation rather than this.skip() because skip() throws
      // on completed (correct guard for caller-driven skips, but we're
      // settling a group and want idempotency).
      t.status = "skipped";
      t.endedAt = ts;
      t.reason = `alternative ${winnerId} landed first`;
      t.workerId = undefined;
      t.startedAt = undefined;
      skipped.push(t.id);
    }
    return { skipped };
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

  /** T-Item-StigBb (2026-05-04): dequeue by score function. Caller
   *  supplies a score function that runs over each pending todo; the
   *  HIGHEST-scoring todo is dequeued. Tie-break: lowest insertion
   *  order (oldest pending) wins. Returns null when no pending todos
   *  exist. Same in-progress stamping as plain dequeue.
   *
   *  Used by the stigmergy-on-blackboard lever to prefer pending todos
   *  whose expectedFiles haven't been touched yet — spreads the swarm
   *  across the repo rather than dogpiling one hot-spot.
   *
   *  When all pending todos score 0, behaves identically to FIFO
   *  dequeue (oldest wins). */
   dequeueByScore(
     workerId: string,
     /** SYNCHRONOUS and MUST NOT throw. Async scorers silently break
      *  this method (Promise > number is always false). Pure functions
      *  only — no I/O, no async, no side effects. */
     scoreFn: (todo: QueuedTodo) => number,
     ts: number = Date.now(),
   ): QueuedTodo | null {
    const pending = this.todos.filter((t) => t.status === "pending");
    if (pending.length === 0) return null;
    let best: QueuedTodo | undefined;
    let bestScore = -Infinity;
    for (const t of pending) {
      const s = scoreFn(t);
      if (s > bestScore) {
        bestScore = s;
        best = t;
      }
      // Tie-break: insertion order (oldest pending wins). Since we
      // iterate in insertion order + only replace on strict >, the
      // first-seen at the top score wins. No additional handling needed.
    }
    if (!best) return null;
    best.status = "in-progress";
    best.workerId = workerId;
    best.startedAt = ts;
    return this.copyTodo(best);
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
   *  Caller decides whether to re-enqueue (via reset()) or leave failed.
   *  Idempotent on already-failed todos (second fail just updates reason). */
  fail(id: string, reason: string, ts: number = Date.now()): void {
    const t = this.findOrThrow(id);
    if (t.status === "failed") {
      // Already failed — update reason and increment retries
      t.reason = reason;
      t.retries += 1;
      return;
    }
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
   *  are immutable scalars / strings. groupId is a scalar so the
   *  spread above already carries it. */
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
