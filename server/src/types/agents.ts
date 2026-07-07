// Auto-extracted from types.ts (DF-4, 2026-05-09)
// Import from "./types.js" for backward compatibility — this file
// is re-exported from types.ts as a barrel.

export type AgentStatus =
  | "spawning"
  | "ready"
  | "thinking"
  | "retrying"
  | "failed"
  | "stopped"
  // T-Item-4 (2026-05-04): individual mid-run kill (vs whole-run stop).
  // Emitted by AgentManager.killAgent (called by the adaptive worker
  // pool when scaling down). UI store removes the panel on this event;
  // distinguishing it from "stopped" lets the UI explain *why* the
  // agent disappeared mid-run ("scaled down") vs end-of-run cleanup.
  | "killed";

export interface AgentState {
  id: string;
  index: number;
  sessionId?: string;
  /** Post-E3 Phase 5 removed per-agent opencode subprocesses; port was
   *  always 0. Kept optional for backward compat with callers. */
  port?: number;
  status: AgentStatus;
  lastMessageAt?: number;
  error?: string;
  // Current model this agent is using (reflects failover — updated when
  // the provider chain routes to a different model). Post-E3 Phase 5
  // removed per-agent opencode subprocesses; port was always 0 and has
  // been removed — model is the meaningful per-agent identifier.
  model?: string;
  // Unit 7: set only while status === "retrying" so the UI can render
  // "Agent N · retrying 2/3 · UND_ERR_HEADERS_TIMEOUT" instead of an
  // opaque "thinking" during the 5-15 min backoff window.
  retryAttempt?: number;
  retryMax?: number;
  retryReason?: string;
  // Unit 39: timestamp (ms since epoch) of when this agent flipped INTO
  // the current "thinking" state. The UI renders elapsed time ("thinking
  // 3m54s") by subtracting this from Date.now() in a 1 s interval while
  // status === "thinking". Unset for non-thinking states. This is the
  // honest user-facing display during the HEADERS_TIMEOUT window —
  // distinguishes "patiently waiting for a real response" from
  // "something broke" (which is only true after a retry actually fires).
  thinkingSince?: number;
  // Planner/worker activity label for sidebar debugging (e.g. "contract derivation attempt 2/8").
  activityKind?: string;
  activityLabel?: string;
  activityAttempt?: number;
  activityMaxAttempts?: number;
}
