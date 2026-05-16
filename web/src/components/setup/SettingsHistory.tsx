import { useState } from "react";
import type { SwarmSettings } from "../../hooks/useSwarmSettings";

interface SettingsHistoryProps {
  entries: SwarmSettings[];
  onSelect: (entry: SwarmSettings) => void;
  onDelete: (id: string) => void;
  onDeleteAll: () => void;
}

const PRESET_LABELS: Record<string, string> = {
  "round-robin": "Round Robin",
  blackboard: "Blackboard",
  "role-diff": "Role Diff",
  council: "Council",
  "orchestrator-worker": "OW",
  "orchestrator-worker-deep": "OW Deep",
  "debate-judge": "Debate",
  "map-reduce": "MapReduce",
  stigmergy: "Stigmergy",
  moa: "MoA",
  pipeline: "Pipeline",
};

function fmtDate(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function SettingsHistory({ entries, onSelect, onDelete, onDeleteAll }: SettingsHistoryProps) {
  const [expanded, setExpanded] = useState(false);
  if (entries.length === 0) return null;

  return (
    <div className="border border-ink-700 rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-3 py-2 text-sm text-ink-400 hover:bg-ink-900/50 transition-colors"
      >
        <span>Saved configurations ({entries.length})</span>
        <span className="text-[10px]">{expanded ? "▲" : "▼"}</span>
      </button>

      {expanded && (
        <div className="border-t border-ink-700">
          <div className="max-h-64 overflow-y-auto">
            {entries.map((entry) => (
              <div
                key={entry.id}
                className="flex items-center gap-2 px-3 py-2 text-xs border-b border-ink-800 last:border-0 hover:bg-ink-900/30 cursor-pointer group"
                onClick={() => onSelect(entry)}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-ink-200 truncate font-medium">
                      {entry.label || entry.repoUrl.slice(-30)}
                    </span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-ink-800 text-ink-400 shrink-0">
                      {PRESET_LABELS[entry.preset] || entry.preset}
                    </span>
                  </div>
                  <div className="text-ink-500 mt-0.5 flex gap-3">
                    <span>{entry.model}</span>
                    <span>{entry.agentCount} agents</span>
                    <span>{entry.rounds === 0 ? "∞" : entry.rounds} rounds</span>
                  </div>
                  <div className="text-ink-600 mt-0.5">
                    Used {entry.useCount}× · last {fmtDate(entry.lastUsedAt)}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onDelete(entry.id); }}
                  className="text-ink-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity text-lg shrink-0"
                  title="Delete"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          <div className="border-t border-ink-700 px-3 py-1.5 flex justify-end">
            <button
              type="button"
              onClick={onDeleteAll}
              className="text-[10px] text-ink-500 hover:text-red-400 transition-colors"
            >
              Delete all
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
