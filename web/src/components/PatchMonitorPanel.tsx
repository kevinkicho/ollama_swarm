import { useState } from "react";

interface PatchEntry {
  id: string;
  title: string;
  status: "pending" | "preparing" | "applying" | "applied" | "failed" | "rolled-back";
  priority: "high" | "medium" | "low";
  file?: string;
  error?: string;
  appliedAt?: number;
}

interface PatchMonitorPanelProps {
  patches?: PatchEntry[];
}

const statusConfig: Record<string, { color: string; icon: string }> = {
  pending: { color: "text-ink-400", icon: "○" },
  preparing: { color: "text-blue-400", icon: "◉" },
  applying: { color: "text-amber-400", icon: "⟳" },
  applied: { color: "text-emerald-400", icon: "✓" },
  failed: { color: "text-red-400", icon: "✗" },
  "rolled-back": { color: "text-amber-400", icon: "↺" },
};

export function PatchMonitorPanel({ patches = [] }: PatchMonitorPanelProps) {
  const [expanded, setExpanded] = useState(false);

  const pending = patches.filter((p) => p.status === "pending" || p.status === "preparing");
  const active = patches.filter((p) => p.status === "applying");
  const completed = patches.filter((p) => p.status === "applied" || p.status === "failed" || p.status === "rolled-back");

  return (
    <div className="rounded border border-amber-700/50 bg-amber-950/20 p-3 space-y-2">
      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center gap-2">
          <span className="text-amber-400 font-semibold">⚙ Patch Monitor</span>
          <span className="text-ink-500">
            {patches.length > 0 ? `${patches.length} patch${patches.length === 1 ? "" : "es"}` : "No patches"}
          </span>
        </div>
        {patches.length > 0 && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-[10px] text-ink-500 hover:text-ink-300"
          >
            {expanded ? "collapse" : "expand"}
          </button>
        )}
      </div>

      {patches.length === 0 ? (
        <div className="text-ink-500 text-[11px]">No patches pending or applied.</div>
      ) : (
        <>
          {/* Active patches */}
          {active.length > 0 && (
            <div className="space-y-1">
              {active.map((p) => (
                <PatchRow key={p.id} patch={p} />
              ))}
            </div>
          )}

          {/* Pending patches */}
          {pending.length > 0 && (
            <div className="space-y-1">
              {pending.map((p) => (
                <PatchRow key={p.id} patch={p} />
              ))}
            </div>
          )}

          {/* Completed patches (expanded only) */}
          {expanded && completed.length > 0 && (
            <div className="space-y-1 border-t border-amber-700/30 pt-2">
              <div className="text-[10px] text-ink-500">History</div>
              {completed.map((p) => (
                <PatchRow key={p.id} patch={p} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function PatchRow({ patch }: { patch: PatchEntry }) {
  const config = statusConfig[patch.status] ?? statusConfig.pending;

  return (
    <div className="flex items-center gap-2 text-xs py-1">
      <span className={`${config.color} w-4 text-center`}>{config.icon}</span>
      <span className="text-ink-300 truncate flex-1">{patch.title}</span>
      <span className="text-[10px] text-ink-500">{patch.file ?? "—"}</span>
      {patch.error && (
        <span className="text-[10px] text-red-400 truncate max-w-32" title={patch.error}>
          {patch.error}
        </span>
      )}
    </div>
  );
}
