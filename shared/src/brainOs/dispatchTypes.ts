/**
 * Brain OS — agentic dispatch contracts (run-layer agency).
 * @see docs/design/brain-os-agentic-dispatch.md
 */

export type BrainConflictKind =
  | "tool_block"
  | "apply_miss"
  | "worker_decline"
  | "parse_fail"
  | "progress_stuck"
  | "contract_stuck"
  | "open";

export type HelperPrivilege =
  | "observer"
  | "repairer"
  | "runner"
  | "board_officer"
  | "arbiter";

export type BrainDispatchStatus =
  | "resolved"
  | "partial"
  | "blocked"
  | "needs_human";

export interface BrainDispatchBudget {
  maxWallMs: number;
  maxTokens?: number;
  maxToolTurns: number;
  maxSubAgents: number;
  maxDepth: number;
}

export interface BrainBoardSnapshot {
  pending: number;
  inProgress: number;
  pendingCommit: number;
  completed: number;
  skipped: number;
  total?: number;
}

export interface BrainDispatchContext {
  phase?: string;
  todoId?: string;
  criterionIds?: string[];
  lastErrors?: string[];
  transcriptExcerpt?: string;
  boardSnapshot?: BrainBoardSnapshot;
  relevantFiles?: string[];
  autoApprove?: boolean;
  host?: "win32" | "darwin" | "linux";
  /** Working-tree git diff excerpt when available. */
  gitDiffExcerpt?: string;
}

export interface BrainDispatchRequest {
  runId: string;
  kind: BrainConflictKind;
  hints?: string[];
  context: BrainDispatchContext;
  privileges: HelperPrivilege;
  budget: BrainDispatchBudget;
  depth: number;
  parentDispatchId?: string;
  /** Absolute clone path for tools. */
  clonePath: string;
  helperModel?: string;
}

export type BrainEffect =
  | { type: "board_complete"; todoId: string; reason: string }
  | { type: "board_skip"; todoId: string; reason: string }
  | { type: "board_reopen"; todoId: string; reason?: string }
  | {
      type: "board_post_todos";
      todos: Array<{ description: string; expectedFiles: string[] }>;
    }
  | {
      type: "propose_hunks";
      todoId: string;
      hunks: unknown[];
      files: string[];
    }
  | { type: "request_apply"; todoId?: string }
  | { type: "append_system"; text: string }
  | { type: "recommend_drain" }
  | { type: "recommend_stop"; reason: string }
  | { type: "none" };

export interface BrainDispatchResult {
  dispatchId: string;
  status: BrainDispatchStatus;
  summary: string;
  effects: BrainEffect[];
  followUpDispatches?: number;
  usage?: { tokensIn?: number; tokensOut?: number; wallMs: number };
}

export interface BrainOsRunMetrics {
  dispatches: number;
  resolved: number;
  partial: number;
  blocked: number;
  needsHuman: number;
  helpersSpawned: number;
  childDispatches: number;
  tokensIn: number;
  tokensOut: number;
  wallMs: number;
  effectsApplied: number;
  effectsRejected: number;
}

export function emptyBrainOsMetrics(): BrainOsRunMetrics {
  return {
    dispatches: 0,
    resolved: 0,
    partial: 0,
    blocked: 0,
    needsHuman: 0,
    helpersSpawned: 0,
    childDispatches: 0,
    tokensIn: 0,
    tokensOut: 0,
    wallMs: 0,
    effectsApplied: 0,
    effectsRejected: 0,
  };
}

/** Default budget for a single top-level dispatch. */
export function defaultBrainDispatchBudget(
  overrides?: Partial<BrainDispatchBudget>,
): BrainDispatchBudget {
  return {
    maxWallMs: 600_000,
    maxToolTurns: 30,
    maxSubAgents: 2,
    maxDepth: 2,
    ...overrides,
  };
}
