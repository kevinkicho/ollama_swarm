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
  // Phase 11a: optional link back to an ExitContract criterion. When set, this
  // todo is the planner/auditor's concrete plan for satisfying that criterion.
  // Unused in Phase 11a behavior — only plumbed through postTodo so later phases
  // can wire the auditor without another type migration.
  criterionId?: string;
  // Unit 44b: optional anchor strings the planner expects to find in
  // expectedFiles. The runner pre-resolves them before each worker
  // claim and includes ±25 lines of context around each match in the
  // worker prompt seed. Solves the "windowed file middle row is
  // invisible" pattern where workers correctly skip with "rows are in
  // the omitted middle." Empty / absent → behaves like before
  // (head + tail only).
  expectedAnchors?: string[];
  // #237 (2026-04-28): build-style TODO discriminator. Default
  // "hunks" (unset = hunks). When "build", `command` is the shell
  // command the swarm-builder agent runs via opencode bash; runner
  // commits whatever changed in the working tree afterwards. Use for
  // doc generators, codegen, formatters, type-checkers — work that
  // can't be expressed as search/replace hunks.
  kind?: "hunks" | "build";
  command?: string;
  // Phase 5c of #243: optional planner-emitted hint to route this
  // todo to a worker with a matching topology tag (e.g. "tests-expert"
  // for test-touching work). The Board doesn't enforce — it just
  // records the hint. The runner's claim selector reads it and
  // prefers a matching worker over a generic one when multiple
  // candidates are open. Absent → no preference (any worker is fine).
  preferredTag?: string;
}

export type ExitCriterionStatus = "unmet" | "met" | "wont-do";

export interface ExitCriterion {
  id: string;
  description: string;
  expectedFiles: string[];
  status: ExitCriterionStatus;
  rationale?: string;
  addedAt: number;
}

export interface ExitContract {
  missionStatement: string;
  criteria: ExitCriterion[];
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

// Kept under the Board* name for wire-protocol parity (UI consumes
// these field names via queue_state events). After V2 cutover Phase
// 2c, the values come from the V2 TodoQueue translated by
// boardWireCompat — there's no V1 Board class anymore.
export interface BoardCounts {
  open: number;
  claimed: number;
  committed: number;
  stale: number;
  skipped: number;
  total: number;
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
      // Unit 44b: replan can revise anchors too. Optional — when absent
      // the existing anchors are kept.
      expectedAnchors?: string[];
    }
  | { type: "finding_posted"; finding: Finding };
