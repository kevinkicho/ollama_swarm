import { useEffect, useState } from "react";
import type { AgentState } from "../types";

const STATUS_COLOR: Record<AgentState["status"], string> = {
  spawning: "bg-amber-400",
  ready: "bg-emerald-400",
  thinking: "bg-blue-400 animate-pulse",
  retrying: "bg-amber-400 animate-pulse",
  failed: "bg-red-500",
  stopped: "bg-ink-400",
};

// Unit 39: format a wall-clock ms duration as "3m54s" / "45s" / "1h12m".
// Keep it terse so it fits inside an agent card. Sub-second is clamped
// to "0s" so the ticker doesn't start at "-12ms".
function formatElapsed(ms: number): string {
  const secs = Math.max(0, Math.floor(ms / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  if (mins < 60) return `${mins}m${rem.toString().padStart(2, "0")}s`;
  const hours = Math.floor(mins / 60);
  const mrem = mins % 60;
  return `${hours}h${mrem.toString().padStart(2, "0")}m`;
}

// Unit 39: tick at 1 s resolution while the agent is thinking so the
// UI shows "thinking 3m54s" climbing. Only mounts a timer while we're
// actually thinking AND we have a thinkingSince — otherwise returns
// null and no interval fires.
function useElapsedTicker(thinkingSince: number | undefined, active: boolean): string | null {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active || thinkingSince === undefined) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [active, thinkingSince]);
  if (!active || thinkingSince === undefined) return null;
  return formatElapsed(Date.now() - thinkingSince);
}

export function AgentPanel({ agent }: { agent: AgentState }) {
  const elapsed = useElapsedTicker(agent.thinkingSince, agent.status === "thinking");
  const retryLabel =
    agent.status === "retrying" && agent.retryAttempt && agent.retryMax
      ? `retrying ${agent.retryAttempt}/${agent.retryMax}${agent.retryReason ? ` · ${agent.retryReason}` : ""}`
      : null;
  // Unit 39: while "thinking" and we have a timestamp, show the ticker;
  // otherwise fall back to status / retry label as before.
  const thinkingLabel =
    agent.status === "thinking" && elapsed
      ? `thinking ${elapsed}`
      : null;
  const primaryLine = retryLabel ?? thinkingLabel ?? agent.status;
  return (
    <div className="border border-ink-700 rounded-md p-3 bg-ink-800">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`inline-block h-2 w-2 rounded-full ${STATUS_COLOR[agent.status]}`} />
          <span className="font-medium">Agent {agent.index}</span>
        </div>
        <span className="text-xs font-mono text-ink-400">:{agent.port}</span>
      </div>
      <div
        className="mt-1 text-xs text-ink-400 font-mono"
        title={
          agent.status === "thinking" && agent.thinkingSince
            ? `Agent has been thinking since ${new Date(agent.thinkingSince).toLocaleTimeString()}. This is normal — the cloud cold-start tail can take several minutes. If it passes ~5 min the client will give up and retry.`
            : undefined
        }
      >
        {primaryLine}
      </div>
      {agent.error ? <div className="mt-2 text-xs text-red-300">{agent.error}</div> : null}
    </div>
  );
}
