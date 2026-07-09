import { useState } from "react";

interface QuickNavPanelProps {
  activeRunId?: string;
  parentPath?: string;
  clonePath?: string;
  onSwitchRun?: (runId: string) => void;
  onNewRun?: () => void;
}

export function QuickNavPanel({ activeRunId, parentPath, clonePath, onSwitchRun, onNewRun }: QuickNavPanelProps) {
  const [section, setSection] = useState<"runs" | "system" | "brain">("runs");

  return (
    <div className="rounded border border-ink-700 bg-ink-800 p-3 space-y-2">
      <div className="flex gap-1">
        {(["runs", "system", "brain"] as const).map((s) => (
          <button
            key={s}
            onClick={() => setSection(s)}
            className={`text-[10px] px-2 py-0.5 rounded transition-colors ${
              section === s
                ? "bg-ink-600 text-ink-200"
                : "text-ink-500 hover:text-ink-300"
            }`}
          >
            {s === "runs" ? "Runs" : s === "system" ? "System" : "Brain"}
          </button>
        ))}
      </div>

      {section === "runs" && (
        <div className="space-y-1">
          {activeRunId && (
            <div className="text-[10px] text-emerald-400 flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              Active: {activeRunId.slice(0, 8)}
            </div>
          )}
          <button
            onClick={onNewRun}
            className="w-full text-left text-[10px] px-2 py-1 rounded bg-emerald-900/30 hover:bg-emerald-800/40 text-emerald-300 border border-emerald-700/30"
          >
            + New Run
          </button>
          <button
            onClick={() => onSwitchRun?.("history")}
            className="w-full text-left text-[10px] px-2 py-1 rounded hover:bg-ink-700 text-ink-400"
          >
            History
          </button>
          {(clonePath || parentPath) ? (
            <a
              href={`/growth?path=${encodeURIComponent(clonePath || parentPath || "")}`}
              className="block w-full text-left text-[10px] px-2 py-1 rounded hover:bg-ink-700 text-sky-300/90"
            >
              Project growth
            </a>
          ) : null}
        </div>
      )}

      {section === "system" && (
        <div className="space-y-1 text-[10px] text-ink-400">
          <div>Health: ✓</div>
          <div>Model: deepseek-v4-flash</div>
          <div>Runs: 0 active</div>
        </div>
      )}

      {section === "brain" && (
        <div className="space-y-1 text-[10px] text-ink-400">
          <div>Status: Idle</div>
          <div>Proposals: 0</div>
          <div>Last analysis: —</div>
        </div>
      )}
    </div>
  );
}
