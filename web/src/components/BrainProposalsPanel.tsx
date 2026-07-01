import { useState } from "react";
import { useSwarm } from "../state/store";

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
  const [applied, setApplied] = useState<Set<number>>(new Set());
  const [rejected, setRejected] = useState<Set<number>>(new Set());

  const handleApply = (index: number) => {
    setApplied((prev) => new Set([...prev, index]));
    onApply?.(index);
  };

  const handleReject = (index: number) => {
    setRejected((prev) => new Set([...prev, index]));
    onReject?.(index);
  };

  return (
    <div className="rounded border border-violet-700/50 bg-violet-950/20 p-3 space-y-2">
      <div className="flex items-center gap-2 text-xs">
        <span className="text-violet-400 font-semibold">🧠 Brain</span>
        <span className="text-ink-500">
          {proposals.length > 0 ? `${proposals.length} proposal${proposals.length === 1 ? "" : "s"}` : "No proposals"}
        </span>
      </div>
      {proposals.length === 0 ? (
        <div className="text-ink-500 text-[11px]">No improvement proposals yet.</div>
      ) : (
        <div className="space-y-2">
          {proposals.map((p, i) => {
            const isApplied = applied.has(i);
            const isRejected = rejected.has(i);
            return (
              <div
                key={i}
                className={`rounded border p-2 ${
                  isApplied
                    ? "border-emerald-700/50 bg-emerald-950/20"
                    : isRejected
                    ? "border-ink-700 bg-ink-800/30 opacity-50"
                    : "border-ink-700 bg-ink-800/50"
                }`}
              >
                <div className="flex items-center gap-2 text-xs mb-1">
                  <span className={`px-1.5 py-0.5 rounded border text-[10px] ${priorityColors[p.priority]}`}>
                    {p.priority}
                  </span>
                  <span className="text-ink-200 font-medium">{p.title}</span>
                  {isApplied && <span className="text-emerald-400 text-[10px]">✓ Applied</span>}
                  {isRejected && <span className="text-ink-500 text-[10px]">✗ Rejected</span>}
                </div>
                <div className="text-[11px] text-ink-400 mb-1">{p.description}</div>
                <div className="text-[10px] text-ink-500">Component: {p.affectedComponent}</div>
                {!isApplied && !isRejected && (
                  <div className="flex gap-2 mt-2">
                    <button
                      onClick={() => handleApply(i)}
                      className="text-[10px] px-2 py-0.5 rounded bg-emerald-700 hover:bg-emerald-600 text-emerald-100"
                    >
                      Apply
                    </button>
                    <button
                      onClick={() => handleReject(i)}
                      className="text-[10px] px-2 py-0.5 rounded bg-ink-700 hover:bg-ink-600 text-ink-300"
                    >
                      Reject
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
