import type { AgentState } from "../types";

const STATUS_COLOR: Record<AgentState["status"], string> = {
  spawning: "bg-amber-400",
  ready: "bg-emerald-400",
  thinking: "bg-blue-400 animate-pulse",
  failed: "bg-red-500",
  stopped: "bg-ink-400",
};

export function AgentPanel({ agent }: { agent: AgentState }) {
  return (
    <div className="border border-ink-700 rounded-md p-3 bg-ink-800">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`inline-block h-2 w-2 rounded-full ${STATUS_COLOR[agent.status]}`} />
          <span className="font-medium">Agent {agent.index}</span>
        </div>
        <span className="text-xs font-mono text-ink-400">:{agent.port}</span>
      </div>
      <div className="mt-1 text-xs text-ink-400 font-mono">{agent.status}</div>
      {agent.error ? <div className="mt-2 text-xs text-red-300">{agent.error}</div> : null}
    </div>
  );
}
