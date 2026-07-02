import { useState } from "react";

interface BrainActivity {
  timestamp: number;
  type: "analysis" | "proposal" | "patch" | "health" | "error" | "provision";
  title: string;
  detail?: string;
  status?: "success" | "pending" | "failed";
}

interface BrainActivityPanelProps {
  activities?: BrainActivity[];
  brainHealth?: {
    status: string;
    lastAnalysis: number;
    proposalCount: number;
    errorCount: number;
  };
}

const typeConfig: Record<string, { color: string; icon: string; bg: string }> = {
  analysis: { color: "text-violet-400", icon: "🧠", bg: "bg-violet-900/30" },
  proposal: { color: "text-blue-400", icon: "📝", bg: "bg-blue-900/30" },
  patch: { color: "text-amber-400", icon: "⚙", bg: "bg-amber-900/30" },
  health: { color: "text-emerald-400", icon: "💚", bg: "bg-emerald-900/30" },
  error: { color: "text-red-400", icon: "⚠", bg: "bg-red-900/30" },
  provision: { color: "text-cyan-400", icon: "🚀", bg: "bg-cyan-900/30" },
};

export function BrainActivityPanel({ activities = [], brainHealth }: BrainActivityPanelProps) {
  const [expanded, setExpanded] = useState(false);

  const recent = activities.slice(0, expanded ? activities.length : 5);

  // Group patch/upgrade activities for history view
  const upgradeHistory = activities.filter(a => a.type === 'patch').slice(0, 5);

  return (
    <div className="rounded border border-violet-700/50 bg-violet-950/20 p-3 space-y-2">
      {/* Brain Health Header */}
      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center gap-2">
          <span className="text-violet-400 font-semibold">🧠 Brain</span>
          <HealthBadge status={brainHealth?.status ?? "unknown"} />
        </div>
        {activities.length > 5 && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-[10px] text-ink-500 hover:text-ink-300"
          >
            {expanded ? "show less" : `+${activities.length - 5} more`}
          </button>
        )}
      </div>

      {upgradeHistory.length > 0 && (
        <div className="text-[9px] mt-1">
          <div className="text-amber-400 font-medium mb-0.5">Recent Upgrades</div>
          {upgradeHistory.map((u, i) => (
            <div key={i} className="text-ink-400 truncate">• {u.title} {u.status === 'success' ? '✓' : ''}</div>
          ))}
        </div>
      )}

      {/* Brain Health Summary */}
      {brainHealth && (
        <div className="grid grid-cols-3 gap-1 text-[10px]">
          <div className="text-center">
            <div className="text-ink-400">Proposals</div>
            <div className="text-violet-300 font-mono">{brainHealth.proposalCount}</div>
          </div>
          <div className="text-center">
            <div className="text-ink-400">Errors</div>
            <div className={`font-mono ${brainHealth.errorCount > 0 ? "text-red-400" : "text-emerald-400"}`}>
              {brainHealth.errorCount}
            </div>
          </div>
          <div className="text-center">
            <div className="text-ink-400">Last</div>
            <div className="text-ink-300 font-mono">
              {brainHealth.lastAnalysis ? formatTime(brainHealth.lastAnalysis) : "—"}
            </div>
          </div>
        </div>
      )}

      {/* Activity Timeline */}
      {activities.length === 0 ? (
        <div className="text-ink-500 text-[11px]">No brain activity recorded.</div>
      ) : (
        <div className="space-y-1.5">
          {recent.map((a, i) => (
            <ActivityRow key={i} activity={a} />
          ))}
        </div>
      )}
    </div>
  );
}

function HealthBadge({ status }: { status: string }) {
  const config: Record<string, { color: string; label: string }> = {
    idle: { color: "bg-ink-600 text-ink-300", label: "Idle" },
    analyzing: { color: "bg-violet-900/50 text-violet-300", label: "Analyzing" },
    error: { color: "bg-red-900/50 text-red-300", label: "Error" },
    unknown: { color: "bg-ink-600 text-ink-400", label: "?" },
  };
  const c = config[status] ?? config.unknown;
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded ${c.color}`}>
      {c.label}
    </span>
  );
}

function ActivityRow({ activity }: { activity: BrainActivity }) {
  const config = typeConfig[activity.type] ?? typeConfig.analysis;
  const time = formatTime(activity.timestamp);

  return (
    <div className={`flex items-start gap-2 text-xs p-1.5 rounded ${config.bg}`}>
      <span className="text-sm mt-0.5">{config.icon}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className={`${config.color} font-medium`}>{activity.title}</span>
          {activity.status && (
            <span className={`text-[10px] ${
              activity.status === "success" ? "text-emerald-400" :
              activity.status === "failed" ? "text-red-400" :
              "text-ink-500"
            }`}>
              {activity.status === "success" ? "✓" : activity.status === "failed" ? "✗" : "○"}
            </span>
          )}
        </div>
        {activity.detail && (
          <div className="text-[10px] text-ink-500 truncate">{activity.detail}</div>
        )}
      </div>
      <span className="text-[10px] text-ink-600 shrink-0">{time}</span>
    </div>
  );
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
