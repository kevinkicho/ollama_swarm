import { memo, type ReactNode } from "react";
import type { TranscriptEntry } from "../../types";

export type CouncilCycleSummary = {
  kind: "council_cycle";
  cycle: number;
  executionOnly: boolean;
  pendingTodos?: number;
};

export type CouncilStageSummary = {
  kind: "council_stage";
  cycle: number;
  stage: "discussion" | "standup" | "synthesis" | "execution" | "audit";
  detail?: string;
};

const STAGE_META: Record<
  CouncilStageSummary["stage"],
  { label: string; color: string; bg: string; border: string }
> = {
  discussion: {
    label: "Discussion",
    color: "text-violet-200",
    bg: "bg-violet-950/40",
    border: "border-violet-700/60",
  },
  standup: {
    label: "Standup",
    color: "text-sky-200",
    bg: "bg-sky-950/40",
    border: "border-sky-700/60",
  },
  synthesis: {
    label: "Synthesis",
    color: "text-fuchsia-200",
    bg: "bg-fuchsia-950/40",
    border: "border-fuchsia-700/60",
  },
  execution: {
    label: "Execution",
    color: "text-emerald-200",
    bg: "bg-emerald-950/40",
    border: "border-emerald-700/60",
  },
  audit: {
    label: "Audit",
    color: "text-amber-200",
    bg: "bg-amber-950/40",
    border: "border-amber-700/60",
  },
};

/** Parse legacy plaintext cycle markers (pre-structured-summary runs). */
export function parseCouncilCycleText(text: string): CouncilCycleSummary | null {
  const m = text.match(/Council cycle\s+(\d+)(?:\s*[—–-]\s*draining\s+(\d+)\s+pending todo\(s\))?/i);
  if (!m) return null;
  const cycle = Number(m[1]);
  const pending = m[2] ? Number(m[2]) : undefined;
  return {
    kind: "council_cycle",
    cycle,
    executionOnly: pending != null && pending > 0,
    pendingTodos: pending,
  };
}

export function parseCouncilStageText(text: string, cycleFallback = 1): CouncilStageSummary | null {
  if (/^Analysis\s*[—–-]\s*\d+\s+round/i.test(text)) {
    const rounds = text.match(/(\d+)\s+round/)?.[1];
    return {
      kind: "council_stage",
      cycle: cycleFallback,
      stage: "discussion",
      detail: rounds ? `${rounds} rounds` : undefined,
    };
  }
  if (text.startsWith("[Standup]")) {
    return { kind: "council_stage", cycle: cycleFallback, stage: "standup", detail: text.replace(/^\[Standup\]\s*/, "").slice(0, 120) };
  }
  if (text.startsWith("Synthesizing council consensus")) {
    return { kind: "council_stage", cycle: cycleFallback, stage: "synthesis" };
  }
  if (/^\[execution\]\s+Starting\s+/i.test(text)) {
    return { kind: "council_stage", cycle: cycleFallback, stage: "execution", detail: text.replace(/^\[execution\]\s+Starting\s+/i, "") };
  }
  if (/^\[execution\]\s+Complete:/i.test(text)) {
    return { kind: "council_stage", cycle: cycleFallback, stage: "execution", detail: text.replace(/^\[execution\]\s+Complete:\s*/i, "") };
  }
  if (/^\[audit\]/i.test(text)) {
    return { kind: "council_stage", cycle: cycleFallback, stage: "audit", detail: text.replace(/^\[audit\]\s*/i, "").slice(0, 140) };
  }
  return null;
}

export const CouncilCycleDivider = memo(function CouncilCycleDivider({
  summary,
  ts,
}: {
  summary: CouncilCycleSummary;
  ts: number;
}) {
  const time = new Date(ts).toLocaleTimeString();
  return (
    <div className="my-4" role="separator" data-council-cycle={summary.cycle}>
      <div className="flex items-center gap-3">
        <div className="flex-1 h-px bg-violet-700/50" />
        <div className="shrink-0 text-center space-y-1">
          <div className="text-[11px] uppercase tracking-widest font-bold text-violet-300">
            Council · Cycle {summary.cycle}
          </div>
          {summary.executionOnly ? (
            <div className="text-[10px] text-amber-300/90 max-w-md">
              Execution only — discussion skipped ({summary.pendingTodos ?? 0} pending todo
              {(summary.pendingTodos ?? 0) === 1 ? "" : "s"} from prior audit)
            </div>
          ) : (
            <div className="text-[10px] text-ink-400">Discussion → execution → audit</div>
          )}
        </div>
        <div className="flex-1 h-px bg-violet-700/50" />
      </div>
      <div className="text-center text-[10px] text-ink-500 mt-1">{time}</div>
    </div>
  );
});

export const CouncilStageChip = memo(function CouncilStageChip({
  summary,
  ts,
}: {
  summary: CouncilStageSummary;
  ts: number;
}) {
  const meta = STAGE_META[summary.stage];
  const time = new Date(ts).toLocaleTimeString();
  return (
    <div
      className={`my-2 flex items-center gap-2 rounded-md border px-3 py-2 text-xs ${meta.bg} ${meta.border}`}
      data-council-stage={summary.stage}
      data-council-cycle={summary.cycle}
    >
      <span className={`font-semibold uppercase tracking-wider text-[10px] ${meta.color}`}>
        Cycle {summary.cycle} · {meta.label}
      </span>
      {summary.detail ? (
        <span className="text-ink-300 truncate flex-1">{summary.detail}</span>
      ) : (
        <span className="flex-1" />
      )}
      <span className="text-ink-500 shrink-0">{time}</span>
    </div>
  );
});

/** Resolve cycle/stage rendering for a system transcript entry. */
export function tryRenderCouncilMarkers(entry: TranscriptEntry): ReactNode | null {
  if (entry.summary?.kind === "council_cycle") {
    return <CouncilCycleDivider summary={entry.summary} ts={entry.ts} />;
  }
  if (entry.summary?.kind === "council_stage") {
    return <CouncilStageChip summary={entry.summary} ts={entry.ts} />;
  }
  const cycle = parseCouncilCycleText(entry.text);
  if (cycle) return <CouncilCycleDivider summary={cycle} ts={entry.ts} />;
  const stage = parseCouncilStageText(entry.text);
  if (stage) return <CouncilStageChip summary={stage} ts={entry.ts} />;
  return null;
}