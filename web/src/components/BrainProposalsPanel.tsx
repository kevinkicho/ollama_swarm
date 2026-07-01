import { useState } from "react";

interface BrainProposal {
  title: string;
  description: string;
  affectedComponent: string;
  priority: "high" | "medium" | "low";
}

interface BrainProposalsPanelProps {
  proposals: BrainProposal[];
  onApply?: (index: number) => void;
  onReject?: (index: number) => void;
}

const priorityColors = {
  high: "text-red-400 bg-red-900/30 border-red-700/50",
  medium: "text-amber-400 bg-amber-900/30 border-amber-700/50",
  low: "text-emerald-400 bg-emerald-900/30 border-emerald-700/50",
};

export function BrainProposalsPanel({ proposals, onApply, onReject }: BrainProposalsPanelProps) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  if (proposals.length === 0) {
    return (
      <div className="rounded border border-ink-700 bg-ink-800 p-3 text-xs text-ink-400">
        No improvement proposals from the brain.
      </div>
    );
  }

  return (
    <div className="rounded border border-violet-700/50 bg-violet-950/20 p-3 space-y-2">
      <div className="flex items-center gap-2 text-xs">
        <span className="text-violet-400 font-semibold">🧠 Brain Proposals</span>
        <span className="text-ink-500">({proposals.length})</span>
      </div>
      {proposals.map((p, i) => (
        <div key={i} className="rounded border border-ink-700 bg-ink-800/50 p-2">
          <div className="flex items-center gap-2 text-xs mb-1">
            <span className={`px-1.5 py-0.5 rounded border text-[10px] ${priorityColors[p.priority]}`}>
              {p.priority}
            </span>
            <span className="text-ink-200 font-medium">{p.title}</span>
          </div>
          <div className="text-[11px] text-ink-400 mb-1">{p.description}</div>
          <div className="text-[10px] text-ink-500">Component: {p.affectedComponent}</div>
          {onApply && onReject && (
            <div className="flex gap-2 mt-2">
              <button
                onClick={() => onApply(i)}
                className="text-[10px] px-2 py-0.5 rounded bg-emerald-700 hover:bg-emerald-600 text-emerald-100"
              >
                Apply
              </button>
              <button
                onClick={() => onReject(i)}
                className="text-[10px] px-2 py-0.5 rounded bg-ink-700 hover:bg-ink-600 text-ink-300"
              >
                Reject
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
