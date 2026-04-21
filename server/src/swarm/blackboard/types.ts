export type TodoStatus = "open" | "claimed" | "committed" | "stale" | "skipped";

export interface Todo {
  id: string;
  description: string;
  expectedFiles: string[];
  createdBy: string;
  createdAt: number;
  status: TodoStatus;
  staleReason?: string;
  skippedReason?: string;
  replanCount: number;
  claim?: Claim;
  committedAt?: number;
}

export interface Claim {
  todoId: string;
  agentId: string;
  // path -> SHA256 hex at claim time. Empty string means "file didn't exist".
  fileHashes: Record<string, string>;
  claimedAt: number;
  expiresAt: number;
}

export interface Finding {
  id: string;
  agentId: string;
  text: string;
  createdAt: number;
}

export interface BoardSnapshot {
  todos: Todo[];
  findings: Finding[];
}

export interface HashMismatch {
  path: string;
  expected: string;
  actual: string;
}

export type BoardEvent =
  | { type: "todo_posted"; todo: Todo }
  | { type: "todo_claimed"; todoId: string; claim: Claim }
  | { type: "todo_committed"; todoId: string }
  | { type: "todo_stale"; todoId: string; reason: string; replanCount: number }
  | { type: "todo_skipped"; todoId: string; reason: string }
  | {
      type: "todo_replanned";
      todoId: string;
      description: string;
      expectedFiles: string[];
      replanCount: number;
    }
  | { type: "finding_posted"; finding: Finding };
