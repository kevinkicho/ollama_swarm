import { useState } from "react";
import { useSwarm } from "../state/store";

interface BrainProposal {
  id?: string;
  title: string;
  description: string;
  affectedComponent: string;
  priority: "high" | "medium" | "low";
  suggestedHunks?: Array<{file: string; search: string; replace: string}>;
}

interface BrainProposalsPanelProps {
  proposals: BrainProposal[];
  onApply?: (proposal: BrainProposal, index: number) => void;
  onReject?: (proposal: BrainProposal, index: number) => void;
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

  const handleApply = (p: BrainProposal, index: number) => {
    setApplied((prev) => new Set([...prev, index]));
    onApply?.(p, index);
  };

  const handleReject = (p: BrainProposal, index: number) => {
    setRejected((prev) => new Set([...prev, index]));
    onReject?.(p, index);
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
                {p.suggestedHunks && p.suggestedHunks.length > 0 && (
                  <div className="mt-1 text-[8px]">
                    <div className="text-emerald-400/70 mb-0.5">Suggested patches ({p.suggestedHunks.length}):</div>
                    {p.suggestedHunks.slice(0, 2).map((h, hi) => (
                      <div key={hi} className="bg-ink-900/50 p-1 mb-0.5 font-mono overflow-hidden">
                        <div className="text-amber-400">--- {h.file}</div>
                        <div className="text-emerald-400">+++ {h.file}</div>
                        <div className="text-rose-400 truncate">- {h.search?.slice(0,60)}{h.search && h.search.length>60?'...':''}</div>
                        <div className="text-emerald-400 truncate">+ {h.replace?.slice(0,60)}{h.replace && h.replace.length>60?'...':''}</div>
                      </div>
                    ))}
                    {p.suggestedHunks.length > 2 && <div className="text-ink-500">... +{p.suggestedHunks.length-2} more</div>}
                  </div>
                )}
                {!isApplied && !isRejected && (
                  <div className="flex gap-2 mt-2">
                    <button
                      onClick={() => handleApply(p, i)}
                      className="text-[10px] px-2 py-0.5 rounded bg-emerald-700 hover:bg-emerald-600 text-emerald-100"
                    >
                      Apply
                    </button>
                    <button
                      onClick={() => handleReject(p, i)}
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
