// PhaseDivider.tsx — Visual separator between council phases and cycles
// Renders a styled horizontal rule with phase name, icon, and cycle number.

import { memo } from "react";

interface PhaseDividerProps {
  phase: string;
  ts: number;
  cycle?: number;
}

const PHASE_CONFIG: Record<string, { icon: string; label: string; color: string }> = {
  discussing: { icon: "💬", label: "Analysis Phase", color: "border-blue-500/50 bg-blue-950/20" },
  executing: { icon: "⚡", label: "Execution Phase", color: "border-amber-500/50 bg-amber-950/20" },
  auditing: { icon: "🔍", label: "Audit Phase", color: "border-violet-500/50 bg-violet-950/20" },
  seeding: { icon: "🌱", label: "Seeding", color: "border-emerald-500/50 bg-emerald-950/20" },
  stopping: { icon: "⏹", label: "Stopping", color: "border-rose-500/50 bg-rose-950/20" },
  cycle: { icon: "🔄", label: "Cycle", color: "border-cyan-500/50 bg-cyan-950/20" },
};

export const PhaseDivider = memo(function PhaseDivider({ phase, ts, cycle }: PhaseDividerProps) {
  const config = PHASE_CONFIG[phase] ?? { icon: "▶", label: phase, color: "border-ink-600 bg-ink-800/40" };
  const time = new Date(ts).toLocaleTimeString();
  const cycleLabel = cycle ? ` · Cycle ${cycle}` : "";

  return (
    <div className={`flex items-center gap-3 mt-4 px-3 py-2 rounded-md border ${config.color}`}>
      <span className="text-lg">{config.icon}</span>
      <span className="text-sm font-medium text-ink-200">{config.label}{cycleLabel}</span>
      <span className="text-xs text-ink-500">· {time}</span>
      <div className="flex-1 border-t border-ink-700/50" />
    </div>
  );
});

/**
 * Detect phase transitions from system messages.
 * Returns the phase name if the message is a phase transition, null otherwise.
 * Also extracts cycle number when present.
 */
export function detectPhaseTransition(text: string): { phase: string; cycle?: number } | null {
  // Check for cycle markers first
  const cycleMatch = text.match(/═══ Council cycle (\d+)/);
  if (cycleMatch) {
    return { phase: "cycle", cycle: parseInt(cycleMatch[1]) };
  }

  // Only match the FIRST occurrence of each phase transition
  // [Phase 1] Analysis — round 3
  // [Phase 2] Execution (not present in council, but handle it)
  // [Phase 3] Audit — each agent independently reviews the work
  // These are the actual phase transition messages, not content within them
  if (text.startsWith("[Phase 1]")) return { phase: "discussing" };
  if (text.startsWith("[Phase 2]")) return { phase: "executing" };
  if (text.startsWith("[Phase 3]")) return { phase: "auditing" };
  if (text.includes("Council execution phase:")) return { phase: "executing" };
  if (text.includes("Council audit synthesis")) return { phase: "auditing" };
  if (text.startsWith("Rubric derived")) return { phase: "seeding" };
  return null;
}
