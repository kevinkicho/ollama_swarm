/** Swarm control center — stall gates, tool coaching, skip grounding. */

export type StallRuleClass =
  | "transient-quota"
  | "skip-storm"
  | "reject-storm"
  | "replanner-skip-storm"
  | "no-activity"
  | "healthy"
  | "ambiguous";

export interface StallBoardSnapshot {
  open: number;
  stale: number;
  skipped: number;
  committed: number;
  total: number;
  unmetCriteria: number;
  totalCriteria: number;
  stuckCycles: number;
  recentStaleReasons: string[];
  recentSkipReasons: string[];
  recentReplannerSkips: string[];
  providerStall?: string;
}

export type StallGateAction = "backoff" | "retry" | "stop";

export interface StallGateVerdict {
  action: StallGateAction;
  source: "rule" | "arbitrator";
  rationale: string;
  backoffMs?: number;
  /** Injected into next planner/replanner pass (control center session). */
  plannerHint?: string;
  confidence?: "high" | "medium" | "low";
}

export interface ToolFailureRecord {
  tool: string;
  error: string;
  count: number;
  lastAt: number;
}

export interface ToolCoachHint {
  agentId: string;
  tool: string;
  hint: string;
  fingerprint: string;
  at: number;
}