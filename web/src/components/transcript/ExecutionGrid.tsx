// ExecutionGrid.tsx — Compact grid showing execution results
// Aggregates consecutive execution messages into a visual grid.

interface ExecutionEntry {
  agentIndex?: number;
  status: "success" | "skip" | "failed" | "working";
  message: string;
  ts: number;
}

interface ExecutionGridProps {
  entries: ExecutionEntry[];
}

const STATUS_CONFIG = {
  success: { icon: "✓", color: "text-emerald-400", bg: "bg-emerald-950/40" },
  skip: { icon: "⏭", color: "text-amber-400", bg: "bg-amber-950/40" },
  failed: { icon: "✗", color: "text-rose-400", bg: "bg-rose-950/40" },
  working: { icon: "⏳", color: "text-ink-400", bg: "bg-ink-800/40" },
};

export function ExecutionGrid({ entries }: ExecutionGridProps) {
  if (entries.length === 0) return null;

  return (
    <div className="rounded-lg border border-ink-600/50 bg-ink-900/50 p-3">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-sm">⚡</span>
        <span className="text-xs font-medium text-ink-300">Execution Results</span>
        <span className="text-[10px] text-ink-500">
          · {entries.filter((e) => e.status === "success").length} succeeded
          · {entries.filter((e) => e.status === "skip").length} skipped
          · {entries.filter((e) => e.status === "failed").length} failed
        </span>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
        {entries.map((entry, i) => {
          const config = STATUS_CONFIG[entry.status];
          return (
            <div
              key={i}
              className={`flex items-center gap-2 rounded px-2 py-1.5 ${config.bg} border border-ink-700/30`}
            >
              <span className={`text-sm ${config.color}`}>{config.icon}</span>
              <div className="min-w-0 flex-1">
                <div className="text-[10px] text-ink-400 truncate">
                  Agent {entry.agentIndex ?? "?"}
                </div>
                <div className="text-[10px] text-ink-300 truncate">
                  {entry.message.slice(0, 60)}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Parse execution results from consecutive system messages.
 */
export function parseExecutionResults(messages: string[]): ExecutionEntry[] {
  const entries: ExecutionEntry[] = [];

  for (const msg of messages) {
    const agentMatch = msg.match(/\[agent-(\d+)\]/);
    const agentIndex = agentMatch ? parseInt(agentMatch[1]) : undefined;

    if (msg.includes("✓ applied")) {
      const fileMatch = msg.match(/applied (\d+) file/);
      entries.push({
        agentIndex,
        status: "success",
        message: fileMatch ? `${fileMatch[1]} file(s)` : "applied",
        ts: Date.now(),
      });
    } else if (msg.includes("skipped")) {
      const reasonMatch = msg.match(/skipped: (.+)/);
      entries.push({
        agentIndex,
        status: "skip",
        message: reasonMatch?.[1]?.slice(0, 60) ?? "skipped",
        ts: Date.now(),
      });
    } else if (msg.includes("✗") || msg.includes("failed")) {
      const reasonMatch = msg.match(/(?:failed|✗): (.+)/);
      entries.push({
        agentIndex,
        status: "failed",
        message: reasonMatch?.[1]?.slice(0, 60) ?? "failed",
        ts: Date.now(),
      });
    } else if (msg.includes("working on")) {
      const todoMatch = msg.match(/working on: (.+)/);
      entries.push({
        agentIndex,
        status: "working",
        message: todoMatch?.[1]?.slice(0, 60) ?? "working",
        ts: Date.now(),
      });
    }
  }

  return entries;
}
