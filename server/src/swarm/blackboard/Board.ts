import { randomUUID } from "node:crypto";
import type {
  BoardEvent,
  BoardSnapshot,
  Claim,
  Finding,
  HashMismatch,
  Todo,
} from "./types.js";

export interface BoardOpts {
  emit?: (ev: BoardEvent) => void;
  // Injectable ID generator so tests get deterministic IDs. Defaults to randomUUID.
  genId?: () => string;
}

type PostTodoInput = {
  description: string;
  expectedFiles: string[];
  createdBy: string;
  createdAt: number;
  criterionId?: string;
  // Unit 44b: optional anchor strings the planner expects to find in the
  // expectedFiles. Pre-resolved by the runner at worker-prompt build time
  // to inject ±25 lines of context around each match.
  expectedAnchors?: string[];
};

type ClaimInput = {
  todoId: string;
  agentId: string;
  fileHashes: Record<string, string>;
  claimedAt: number;
  expiresAt: number;
};

type CommitInput = {
  todoId: string;
  agentId: string;
  currentHashes: Record<string, string>;
  committedAt: number;
};

type CommitResult =
  | { ok: true; todo: Todo }
  | { ok: false; reason: "not_found" | "not_claimed" | "wrong_agent" }
  | { ok: false; reason: "stale"; mismatches: HashMismatch[] };

type ClaimResult =
  | { ok: true; todo: Todo }
  | { ok: false; reason: "not_found" | "not_open" };

type StaleResult =
  | { ok: true; todo: Todo }
  | { ok: false; reason: "not_found" | "not_claimable" };

type ReplanResult =
  | { ok: true; todo: Todo }
  | { ok: false; reason: "not_found" | "not_stale" };

type SkipResult = { ok: true; todo: Todo } | { ok: false; reason: "not_found" };

export interface BoardCounts {
  open: number;
  claimed: number;
  committed: number;
  stale: number;
  skipped: number;
  total: number;
}

// The Board is the single source of truth for blackboard state during a run.
// Every method is synchronous; JS's single-threaded event loop serializes them,
// which is the atomicity we need for CAS-style claim/commit. All timestamps
// come from the caller — no internal clock — so tests are deterministic.
export class Board {
  private readonly todos = new Map<string, Todo>();
  private readonly findings = new Map<string, Finding>();
  private readonly emit: (ev: BoardEvent) => void;
  private readonly genId: () => string;

  constructor(opts: BoardOpts = {}) {
    this.emit = opts.emit ?? (() => {});
    this.genId = opts.genId ?? (() => randomUUID());
  }

  postTodo(input: PostTodoInput): Todo {
    if (!input.description.trim()) throw new Error("description cannot be empty");
    if (!Array.isArray(input.expectedFiles)) throw new Error("expectedFiles must be an array");
    const todo: Todo = {
      id: this.genId(),
      description: input.description,
      expectedFiles: [...input.expectedFiles],
      createdBy: input.createdBy,
      createdAt: input.createdAt,
      status: "open",
      replanCount: 0,
      criterionId: input.criterionId,
      // Unit 44b: forward optional anchors. Empty array → undefined so
      // downstream "has anchors?" checks stay simple.
      expectedAnchors:
        input.expectedAnchors && input.expectedAnchors.length > 0
          ? [...input.expectedAnchors]
          : undefined,
    };
    this.todos.set(todo.id, todo);
    this.emit({ type: "todo_posted", todo: this.copyTodo(todo) });
    return this.copyTodo(todo);
  }

  listTodos(): Todo[] {
    return this.orderedTodos().map((t) => this.copyTodo(t));
  }

  findOpenTodo(): Todo | undefined {
    const found = this.orderedTodos().find((t) => t.status === "open");
    return found ? this.copyTodo(found) : undefined;
  }

  claimTodo(input: ClaimInput): ClaimResult {
    const todo = this.todos.get(input.todoId);
    if (!todo) return { ok: false, reason: "not_found" };
    if (todo.status !== "open") return { ok: false, reason: "not_open" };
    const claim: Claim = {
      todoId: todo.id,
      agentId: input.agentId,
      fileHashes: { ...input.fileHashes },
      claimedAt: input.claimedAt,
      expiresAt: input.expiresAt,
    };
    todo.status = "claimed";
    todo.claim = claim;
    this.emit({ type: "todo_claimed", todoId: todo.id, claim: this.copyClaim(claim) });
    return { ok: true, todo: this.copyTodo(todo) };
  }

  commitTodo(input: CommitInput): CommitResult {
    const todo = this.todos.get(input.todoId);
    if (!todo) return { ok: false, reason: "not_found" };
    if (todo.status !== "claimed" || !todo.claim) return { ok: false, reason: "not_claimed" };
    if (todo.claim.agentId !== input.agentId) return { ok: false, reason: "wrong_agent" };

    const mismatches: HashMismatch[] = [];
    for (const [path, expected] of Object.entries(todo.claim.fileHashes)) {
      const actual = input.currentHashes[path] ?? "";
      if (actual !== expected) mismatches.push({ path, expected, actual });
    }
    if (mismatches.length > 0) {
      // CAS failure: do NOT mutate the todo. The caller decides whether to
      // mark it stale (the usual case) or try to re-read + retry.
      return { ok: false, reason: "stale", mismatches };
    }

    todo.status = "committed";
    todo.committedAt = input.committedAt;
    this.emit({ type: "todo_committed", todoId: todo.id });
    return { ok: true, todo: this.copyTodo(todo) };
  }

  markStale(todoId: string, reason: string): StaleResult {
    const todo = this.todos.get(todoId);
    if (!todo) return { ok: false, reason: "not_found" };
    if (todo.status !== "claimed" && todo.status !== "open") {
      return { ok: false, reason: "not_claimable" };
    }
    todo.status = "stale";
    todo.staleReason = reason;
    todo.claim = undefined;
    this.emit({ type: "todo_stale", todoId, reason, replanCount: todo.replanCount });
    return { ok: true, todo: this.copyTodo(todo) };
  }

  replan(
    todoId: string,
    input: { description: string; expectedFiles: string[]; expectedAnchors?: string[] },
  ): ReplanResult {
    const todo = this.todos.get(todoId);
    if (!todo) return { ok: false, reason: "not_found" };
    if (todo.status !== "stale") return { ok: false, reason: "not_stale" };
    if (!input.description.trim()) throw new Error("description cannot be empty");
    todo.description = input.description;
    todo.expectedFiles = [...input.expectedFiles];
    // Unit 44b: replan may revise anchors. Explicit empty array clears
    // them; undefined leaves the prior set in place.
    if (input.expectedAnchors !== undefined) {
      todo.expectedAnchors =
        input.expectedAnchors.length > 0 ? [...input.expectedAnchors] : undefined;
    }
    todo.status = "open";
    todo.replanCount += 1;
    todo.staleReason = undefined;
    this.emit({
      type: "todo_replanned",
      todoId,
      description: todo.description,
      expectedFiles: [...todo.expectedFiles],
      replanCount: todo.replanCount,
      expectedAnchors: todo.expectedAnchors ? [...todo.expectedAnchors] : undefined,
    });
    return { ok: true, todo: this.copyTodo(todo) };
  }

  skip(todoId: string, reason: string): SkipResult {
    const todo = this.todos.get(todoId);
    if (!todo) return { ok: false, reason: "not_found" };
    todo.status = "skipped";
    todo.skippedReason = reason;
    todo.claim = undefined;
    this.emit({ type: "todo_skipped", todoId, reason });
    return { ok: true, todo: this.copyTodo(todo) };
  }

  // Called periodically by the runner. Returns the IDs that were expired so
  // callers can schedule replan prompts or log them.
  expireClaims(now: number): string[] {
    const expired: string[] = [];
    for (const todo of this.todos.values()) {
      if (todo.status === "claimed" && todo.claim && todo.claim.expiresAt <= now) {
        expired.push(todo.id);
      }
    }
    for (const id of expired) {
      this.markStale(id, "claim expired");
    }
    return expired;
  }

  postFinding(input: { agentId: string; text: string; createdAt: number }): Finding {
    if (!input.text.trim()) throw new Error("finding text cannot be empty");
    const finding: Finding = {
      id: this.genId(),
      agentId: input.agentId,
      text: input.text,
      createdAt: input.createdAt,
    };
    this.findings.set(finding.id, finding);
    this.emit({ type: "finding_posted", finding: { ...finding } });
    return { ...finding };
  }

  listFindings(): Finding[] {
    return [...this.findings.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((f) => ({ ...f }));
  }

  snapshot(): BoardSnapshot {
    return { todos: this.listTodos(), findings: this.listFindings() };
  }

  counts(): BoardCounts {
    let open = 0;
    let claimed = 0;
    let committed = 0;
    let stale = 0;
    let skipped = 0;
    for (const t of this.todos.values()) {
      if (t.status === "open") open++;
      else if (t.status === "claimed") claimed++;
      else if (t.status === "committed") committed++;
      else if (t.status === "stale") stale++;
      else if (t.status === "skipped") skipped++;
    }
    return { open, claimed, committed, stale, skipped, total: this.todos.size };
  }

  private orderedTodos(): Todo[] {
    return [...this.todos.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  private copyTodo(todo: Todo): Todo {
    return {
      ...todo,
      expectedFiles: [...todo.expectedFiles],
      expectedAnchors: todo.expectedAnchors ? [...todo.expectedAnchors] : undefined,
      claim: todo.claim ? this.copyClaim(todo.claim) : undefined,
    };
  }

  private copyClaim(claim: Claim): Claim {
    return { ...claim, fileHashes: { ...claim.fileHashes } };
  }
}
