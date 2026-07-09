import { useState } from "react";
import type { SwarmPhase } from "../types";

interface QuickNavPanelProps {
  /** Run id currently loaded in this view (may be terminal). */
  focusedRunId?: string;
  /** True only while the focused run is still executing. */
  focusedRunLive?: boolean;
  /** Terminal stop reason or phase label when not live. */
  focusedRunStatus?: string;
  phase?: SwarmPhase;
  parentPath?: string;
  clonePath?: string;
  onSwitchRun?: (runId: string) => void;
  onNewRun?: () => void;
}

export function QuickNavPanel({
  focusedRunId,
  focusedRunLive = false,
  focusedRunStatus,
  phase,
  parentPath,
  clonePath,
  onSwitchRun,
  onNewRun,
}: QuickNavPanelProps) {
  const [section, setSection] = useState<"runs" | "system" | "brain">("runs");
  const statusHint =
    focusedRunStatus ??
    (phase && phase !== "idle" ? phase : focusedRunLive ? "active" : "ended");

  return (
    <div className="rounded border border-ink-700 bg-ink-800 p-3 space-y-2">
      <div className="text-[9px] uppercase tracking-wider text-ink-400 font-semibold px-0.5">
        Quick Nav
      </div>
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
          {focusedRunId ? (
            focusedRunLive ? (
              <div className="text-[10px] text-emerald-400 flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                Active: {focusedRunId.slice(0, 8)}
              </div>
            ) : (
              <div
                className="text-[10px] text-ink-500 flex items-center gap-1"
                title={`Run ended (${statusHint})`}
              >
                <span className="w-1.5 h-1.5 rounded-full bg-ink-500" />
                Last: {focusedRunId.slice(0, 8)}
                <span className="text-ink-600 truncate">({statusHint})</span>
              </div>
            )
          ) : null}
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
