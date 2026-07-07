import { memo, useMemo } from "react";
import type { TranscriptEntry } from "../../types";
import { useSwarm } from "../../state/store";
import { isActiveSwarmPhase } from "../../lib/swarmPhase";
import { useElapsedSince } from "../../lib/elapsed";
import { AgentAvatar } from "./AgentAvatar";

function isWorkingLine(text: string): boolean {
  return /^\[execution\] agent-\d+ working on:/i.test(text);
}

function agentIndexFromExecution(text: string): number | null {
  const m = text.match(/^\[execution\] agent-(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

/** True when this entry is the latest in-flight "working on" line for its agent. */
function isLatestWorkingEntry(
  transcript: readonly TranscriptEntry[],
  entryId: string,
  agentIndex: number,
): boolean {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const e = transcript[i];
    if (!isWorkingLine(e.text)) continue;
    const idx = agentIndexFromExecution(e.text);
    if (idx !== agentIndex) continue;
    return e.id === entryId;
  }
  return false;
}

export const ExecutionStatusBubble = memo(function ExecutionStatusBubble({
  entry,
  ts,
}: {
  entry: TranscriptEntry;
  ts: string;
}) {
  const transcript = useSwarm((s) => s.transcript);
  const agents = useSwarm((s) => s.agents);
  const phase = useSwarm((s) => s.phase);

  const executionMatch = entry.text.match(/^\[execution\] agent-(\d+) (✓ applied|skipped|✗|working on)/);
  if (!executionMatch) return null;

  const agentIndex = parseInt(executionMatch[1], 10);
  const status = executionMatch[2];
  const isApply = status.includes("applied");
  const isSkip = status.includes("skipped");
  const isWork = status.includes("working");
  const agent = Object.values(agents).find((a) => a.index === agentIndex);

  const isLiveWork = useMemo(() => {
    if (!isWork || !isActiveSwarmPhase(phase)) return false;
    if (agent?.status !== "thinking") return false;
    return isLatestWorkingEntry(transcript, entry.id, agentIndex);
  }, [isWork, phase, agent?.status, transcript, entry.id, agentIndex]);

  const elapsed = useElapsedSince(entry.ts, isLiveWork);

  const icon = isApply ? "✓" : isSkip ? "⏭" : isWork ? "⏳" : "✗";
  const color = isApply
    ? "text-emerald-400"
    : isSkip
      ? "text-amber-400"
      : isLiveWork
        ? "text-blue-400"
        : isWork
          ? "text-ink-400"
          : "text-rose-400";
  const bg = isApply
    ? "bg-emerald-950/30"
    : isSkip
      ? "bg-amber-950/30"
      : isLiveWork
        ? "bg-blue-950/30 border-blue-700/40"
        : isWork
          ? "bg-ink-800/30"
          : "bg-rose-950/30";

  return (
    <div
      className={`flex items-center gap-2 rounded px-3 py-1.5 text-xs border border-ink-700/30 ${bg} ${isLiveWork ? "animate-pulse" : ""}`}
    >
      <AgentAvatar agentIndex={agentIndex} size="sm" />
      <span className={color}>{icon}</span>
      <span className="text-ink-300 min-w-0 flex-1 truncate">
        {entry.text.slice(entry.text.indexOf("]") + 2)}
      </span>
      {isLiveWork && elapsed ? (
        <span className="text-blue-300 font-mono shrink-0 tabular-nums">{elapsed}</span>
      ) : null}
      <span className="text-ink-500 shrink-0">{ts}</span>
    </div>
  );
});