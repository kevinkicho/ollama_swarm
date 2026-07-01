// ProgressBar.tsx — Visual progress indicator for council runs
// Shows current phase, cycle, and completion status.

import { useEffect, useState } from "react";
import { useSwarm } from "../state/store";

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

export function ProgressBar() {
  const phase = useSwarm((s) => s.phase);
  const round = useSwarm((s) => s.round);
  const transcript = useSwarm((s) => s.transcript);
  const runStartedAt = useSwarm((s) => s.runStartedAt);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!runStartedAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [runStartedAt]);

  if (!phase || phase === "idle" || phase === "completed" || phase === "stopped") {
    return null;
  }

  // Count execution results
  const executionResults = transcript.filter((e) =>
    e.role === "system" && (
      e.text?.includes("✓ applied") ||
      e.text?.includes("skipped") ||
      e.text?.includes("working on")
    )
  );
  const completed = executionResults.filter((e) => e.text?.includes("✓ applied")).length;
  const skipped = executionResults.filter((e) => e.text?.includes("skipped")).length;
  const total = completed + skipped;

  // Detect current cycle from transcript
  let currentCycle = 0;
  for (const e of transcript) {
    if (e.role === "system" && e.text?.includes("═══ Council cycle")) {
      const match = e.text.match(/═══ Council cycle (\d+)/);
      if (match) currentCycle = parseInt(match[1]);
    }
  }

  // Get phase progress
  const phaseProgress: Record<string, { label: string; color: string; icon: string }> = {
    seeding: { label: "Seeding", color: "bg-emerald-500", icon: "🌱" },
    discussing: { label: "Analysis", color: "bg-blue-500", icon: "💬" },
    executing: { label: "Execution", color: "bg-amber-500", icon: "⚡" },
    auditing: { label: "Audit", color: "bg-violet-500", icon: "🔍" },
  };

  const current = phaseProgress[phase] ?? { label: phase, color: "bg-ink-500", icon: "▶" };
  const elapsed = runStartedAt ? formatElapsed(now - runStartedAt) : null;

  return (
    <div className="px-4 py-2 bg-ink-800/50 border-b border-ink-700/50">
      <div className="flex items-center gap-3">
        <span className="text-sm">{current.icon}</span>
        <span className="text-xs font-medium text-ink-300">{current.label}</span>
        {currentCycle > 0 && (
          <span className="text-[10px] text-ink-500">Cycle {currentCycle}</span>
        )}
        {round && (
          <span className="text-[10px] text-ink-500">Round {round}</span>
        )}
        {elapsed && (
          <span className="text-[10px] text-ink-500 font-mono">{elapsed}</span>
        )}
        {total > 0 && (
          <span className="text-[10px] text-ink-500">
            {completed} done · {skipped} skipped
          </span>
        )}
        <div className="flex-1 h-1.5 bg-ink-700 rounded-full overflow-hidden">
          <div
            className={`h-full ${current.color} rounded-full transition-all duration-500 ${completed < total ? "shimmer" : ""}`}
            style={{ width: `${Math.min(100, (total > 0 ? completed / total : 0) * 100)}%` }}
          />
        </div>
      </div>
    </div>
  );
}
