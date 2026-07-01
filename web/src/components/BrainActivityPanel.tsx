import { useState } from "react";

interface BrainActivity {
  timestamp: number;
  type: "analysis" | "proposal" | "patch" | "health" | "error";
  title: string;
  detail?: string;
  status?: "success" | "pending" | "failed";
}

interface BrainActivityPanelProps {
  activities?: BrainActivity[];
}

const typeConfig: Record<string, { color: string; icon: string }> = {
  analysis: { color: "text-violet-400", icon: "🧠" },
  proposal: { color: "text-blue-400", icon: "📝" },
  patch: { color: "text-amber-400", icon: "⚙" },
  health: { color: "text-emerald-400", icon: "💚" },
  error: { color: "text-red-400", icon: "⚠" },
};

export function BrainActivityPanel({ activities = [] }: BrainActivityPanelProps) {
  const [expanded, setExpanded] = useState(false);

  const recent = activities.slice(0, expanded ? activities.length : 5);

  return (
    <div className="rounded border border-violet-700/50 bg-violet-950/20 p-3 space-y-2">
      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center gap-2">
          <span className="text-violet-400 font-semibold">🧠 Brain Activity</span>
          <span className="text-ink-500">
            {activities.length > 0 ? `${activities.length} event${activities.length === 1 ? "" : "s"}` : "No activity"}
          </span>
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

function ActivityRow({ activity }: { activity: BrainActivity }) {
  const config = typeConfig[activity.type] ?? typeConfig.analysis;
  const time = new Date(activity.timestamp).toLocaleTimeString();

  return (
    <div className="flex items-start gap-2 text-xs">
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
