/** Shared shapes + helpers for the Debug Log panel (mirrors server derive). */

export interface PhaseStep {
  phase: string;
  ts: number;
}

export interface StreamAnomalySummary {
  kind: string;
  pattern: string;
  detail: string;
  agentId?: string;
}

export interface DerivedRunState {
  runId?: string;
  preset?: string;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  finalPhase?: string;
  stopReason?: string;
  errors: string[];
  transcriptCount: number;
  agentStateUpdates: number;
  hasSummary: boolean;
  agentCount?: number;
  clonePath?: string;
  phaseTimeline: PhaseStep[];
  eventTypeCounts: Record<string, number>;
  modelShiftCount: number;
  brainFallbackCount: number;
  todoClaimed: number;
  todoFailed: number;
  todoReplanned: number;
  todoSkipped: number;
  streamingEventCount: number;
  streamingEndCount: number;
  amendmentCount: number;
  conformanceSampleCount: number;
  lastConformanceScore?: number;
  driftSampleCount: number;
  lastDriftSimilarity?: number;
  coldStartCount: number;
  maxColdStartMs?: number;
  streamAnomalies: StreamAnomalySummary[];
  anomalyFlags: string[];
  runIdInferred?: boolean;
}

export type EventCategory =
  | "lifecycle"
  | "agent"
  | "transcript"
  | "todo"
  | "brain"
  | "diag"
  | "usage"
  | "session"
  | "other";

export function guessEventCategory(type: string): EventCategory {
  if (type === "_session_started") return "session";
  if (type.startsWith("todo_") || type === "queue_state" || type.startsWith("board_")) return "todo";
  if (type.includes("brain") || type === "analysis" || type === "provision") return "brain";
  if (type === "transcript_append" || type.startsWith("agent_stream")) return "transcript";
  if (
    type === "agent_state" ||
    type === "agent_activity" ||
    type === "swarm_state" ||
    type === "run_started" ||
    type === "run_summary"
  ) {
    return "lifecycle";
  }
  if (type === "error" || type.includes("health") || type === "cold_start") return "diag";
  if (type.includes("token") || type.includes("cost")) return "usage";
  return "other";
}

export function eventOneLiner(ev: { type: string } & Record<string, unknown>): string {
  switch (ev.type) {
    case "swarm_state":
      return `phase → ${String(ev.phase)} (round ${String(ev.round ?? "?")})`;
    case "run_started":
      return `started · ${String(ev.preset ?? "?")} · ${String(ev.agentCount ?? "?")} agents`;
    case "run_summary": {
      const summary = ev.summary as { stopReason?: string } | undefined;
      return `summary · ${summary?.stopReason ?? "done"}`;
    }
    case "agent_state": {
      const agent = ev.agent as { id?: string; status?: string } | undefined;
      return `${agent?.id ?? "?"} → ${agent?.status ?? "?"}`;
    }
    case "agent_activity":
      return `${String(ev.agentId ?? "?")} activity → ${String(ev.phase ?? "?")}`;
    case "agent_streaming":
      return `${String(ev.agentId ?? "?")} streaming (+${String((ev.text as string)?.length ?? 0)} chars)`;
    case "agent_streaming_end":
      return `${String(ev.agentId ?? "?")} stream end`;
    case "transcript_append": {
      const entry = ev.entry as { kind?: string; agentId?: string } | undefined;
      return `transcript · ${entry?.kind ?? "entry"}${entry?.agentId ? ` · ${entry.agentId}` : ""}`;
    }
    case "error":
      return String(ev.message ?? "error").slice(0, 120);
    case "model_shift":
      return `${String(ev.agentId)}: ${String(ev.fromModel)} → ${String(ev.toModel)} (${String(ev.reason)})`;
    case "brain-fallback":
      return `${String(ev.agentId)}: ${String(ev.fromModel)} → ${String(ev.toModel)}`;
    case "todo_claimed":
      return `claimed ${String(ev.todoId)}`;
    case "todo_failed":
      return `failed ${String(ev.todoId)}: ${String(ev.reason).slice(0, 60)}`;
    case "todo_replanned":
      return `replanned ${String(ev.todoId)} (#${String(ev.replanCount)})`;
    case "directive_amended":
      return `amend: ${String(ev.text).slice(0, 80)}`;
    case "conformance_sample":
      return `conformance ${String(ev.score)} (smoothed ${String(ev.smoothedScore)})`;
    case "drift_sample":
      return `drift sim ${String(ev.similarity)}`;
    case "cold_start":
      return `cold start ${String(ev.agentId)} ${String(ev.elapsedMs)}ms`;
    case "_session_started":
      return "server session boot";
    default:
      return ev.type;
  }
}

export const ANOMALY_FLAG_LABELS: Record<string, { label: string; color: string }> = {
  no_summary: { label: "no summary", color: "text-amber-300 bg-amber-950/50 border-amber-800/60" },
  activity_gap: { label: "activity gap", color: "text-orange-300 bg-orange-950/50 border-orange-800/60" },
  errors: { label: "errors", color: "text-rose-300 bg-rose-950/50 border-rose-800/60" },
  stream_loop: { label: "stream loop", color: "text-fuchsia-300 bg-fuchsia-950/50 border-fuchsia-800/60" },
  model_failover: { label: "model failover", color: "text-violet-300 bg-violet-950/50 border-violet-800/60" },
  todo_failures: { label: "todo failures", color: "text-red-300 bg-red-950/50 border-red-800/60" },
  in_flight: { label: "in flight", color: "text-blue-300 bg-blue-950/50 border-blue-800/60" },
};

export function formatDuration(ms: number | undefined): string {
  if (ms == null || ms < 0) return "—";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

export function normalizeDerived(d: Partial<DerivedRunState> | undefined): DerivedRunState {
  return {
    errors: d?.errors ?? [],
    transcriptCount: d?.transcriptCount ?? 0,
    agentStateUpdates: d?.agentStateUpdates ?? 0,
    hasSummary: d?.hasSummary ?? false,
    phaseTimeline: d?.phaseTimeline ?? [],
    eventTypeCounts: d?.eventTypeCounts ?? {},
    modelShiftCount: d?.modelShiftCount ?? 0,
    brainFallbackCount: d?.brainFallbackCount ?? 0,
    todoClaimed: d?.todoClaimed ?? 0,
    todoFailed: d?.todoFailed ?? 0,
    todoReplanned: d?.todoReplanned ?? 0,
    todoSkipped: d?.todoSkipped ?? 0,
    streamingEventCount: d?.streamingEventCount ?? 0,
    streamingEndCount: d?.streamingEndCount ?? 0,
    amendmentCount: d?.amendmentCount ?? 0,
    conformanceSampleCount: d?.conformanceSampleCount ?? 0,
    driftSampleCount: d?.driftSampleCount ?? 0,
    coldStartCount: d?.coldStartCount ?? 0,
    streamAnomalies: d?.streamAnomalies ?? [],
    anomalyFlags: d?.anomalyFlags ?? [],
    runId: d?.runId,
    preset: d?.preset,
    startedAt: d?.startedAt,
    finishedAt: d?.finishedAt,
    durationMs: d?.durationMs,
    finalPhase: d?.finalPhase,
    stopReason: d?.stopReason,
    agentCount: d?.agentCount,
    clonePath: d?.clonePath,
    lastConformanceScore: d?.lastConformanceScore,
    lastDriftSimilarity: d?.lastDriftSimilarity,
    maxColdStartMs: d?.maxColdStartMs,
    runIdInferred: d?.runIdInferred,
  };
}

/** Boot-only slices: one _session_started line, no swarm activity. */
export function isInfraOnlySlice(s: {
  recordCount: number;
  isSessionBoundary: boolean;
  derived: DerivedRunState;
}): boolean {
  const d = normalizeDerived(s.derived);
  if (s.recordCount <= 1 && (d.eventTypeCounts["_session_started"] ?? 0) >= 1) return true;
  return (
    s.isSessionBoundary &&
    !d.runId &&
    d.transcriptCount === 0 &&
    d.agentStateUpdates === 0 &&
    d.streamingEventCount === 0
  );
}

export function topEventTypes(counts: Record<string, number>, limit = 3): Array<[string, number]> {
  return Object.entries(counts)
    .filter(([t]) => t !== "_session_started")
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
}