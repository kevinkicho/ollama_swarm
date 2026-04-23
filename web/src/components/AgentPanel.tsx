import { useEffect, useState } from "react";
import { useSwarm } from "../state/store";
import type { AgentState, LatencySample } from "../types";

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

// Unit 40: render recent attempt latencies as a bar sparkline. Height
// encodes elapsed ms relative to the window's max, color encodes success
// (emerald) vs. failure (red). Oldest on the left, newest on the right
// so the rightmost bar is the "current-if-mid-flight or most-recent"
// comparison point.
function Sparkline({ samples }: { samples: LatencySample[] }) {
  if (samples.length === 0) return null;
  const maxMs = Math.max(...samples.map((s) => s.elapsedMs), 1);
  const barW = 6;
  const gap = 2;
  const h = 32;
  const w = samples.length * (barW + gap) - gap;
  return (
    <svg width={w} height={h} className="block">
      {samples.map((s, i) => {
        const barH = Math.max(2, Math.round((s.elapsedMs / maxMs) * h));
        const x = i * (barW + gap);
        const y = h - barH;
        const fill = s.success ? "#34d399" : "#f87171";
        return <rect key={`${s.ts}-${i}`} x={x} y={y} width={barW} height={barH} fill={fill} rx={1} />;
      })}
    </svg>
  );
}

function formatSampleMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const mins = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${mins}m${rem.toString().padStart(2, "0")}s`;
}

export function AgentPanel({ agent }: { agent: AgentState }) {
  const elapsed = useElapsedTicker(agent.thinkingSince, agent.status === "thinking");
  const samples = useSwarm((s) => s.latency[agent.id] ?? []);
  const [hover, setHover] = useState(false);
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
  const isThinking = agent.status === "thinking" && agent.thinkingSince !== undefined;
  const showPopover = hover && samples.length > 0;
  const last = samples.length > 0 ? samples[samples.length - 1] : null;
  const successCount = samples.filter((s) => s.success).length;
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
        className={`mt-1 text-xs text-ink-400 font-mono relative ${samples.length > 0 ? "cursor-help" : ""}`}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        title={
          !showPopover && isThinking
            ? `Agent has been thinking since ${new Date(agent.thinkingSince!).toLocaleTimeString()}. This is normal — the cloud cold-start tail can take several minutes. If it passes ~5 min the client will give up and retry.`
            : undefined
        }
      >
        {primaryLine}
        {showPopover ? (
          <div className="absolute z-10 bottom-full left-0 mb-1 bg-ink-900 border border-ink-600 rounded p-2 shadow-lg whitespace-nowrap">
            <div className="text-[10px] text-ink-300 mb-1">
              Recent {samples.length} attempt{samples.length === 1 ? "" : "s"} · {successCount} ok / {samples.length - successCount} fail
            </div>
            <Sparkline samples={samples} />
            {last ? (
              <div className="text-[10px] text-ink-400 mt-1">
                last: {formatSampleMs(last.elapsedMs)} {last.success ? "✓" : "✗"}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      {agent.error ? <div className="mt-2 text-xs text-red-300">{agent.error}</div> : null}
    </div>
  );
}
