import { useEffect, useState } from "react";

interface HealthData {
  ok: boolean;
  defaultModel?: string;
  ollamaUrl?: string;
}

interface SystemStatusPanelProps {
  className?: string;
}

export function SystemStatusPanel({ className = "" }: SystemStatusPanelProps) {
  const [health, setHealth] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchHealth = async () => {
      try {
        const res = await fetch("/api/health");
        const data: HealthData = await res.json();
        setHealth(data);
      } catch {
        setHealth(null);
      } finally {
        setLoading(false);
      }
    };
    fetchHealth();
    const interval = setInterval(fetchHealth, 30_000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className={`rounded border border-ink-700 bg-ink-800 p-3 space-y-2 ${className}`}>
      <div className="text-[10px] uppercase tracking-wider text-ink-500 font-semibold">
        System Status
      </div>
      {loading ? (
        <div className="text-ink-400 text-xs">Loading...</div>
      ) : health ? (
        <div className="space-y-1.5">
          <StatusRow
            label="Ollama"
            value={health.ok ? "Healthy" : "Down"}
            color={health.ok ? "text-emerald-400" : "text-red-400"}
            dot={health.ok}
          />
          <StatusRow
            label="Model"
            value={health.defaultModel ?? "unknown"}
            color="text-ink-300"
          />
          <StatusRow
            label="Endpoint"
            value={health.ollamaUrl ?? "unknown"}
            color="text-ink-400"
            truncate
          />
        </div>
      ) : (
        <div className="text-red-400 text-xs">Cannot reach server</div>
      )}
    </div>
  );
}

function StatusRow({
  label,
  value,
  color,
  dot,
  truncate,
}: {
  label: string;
  value: string;
  color: string;
  dot?: boolean;
  truncate?: boolean;
}) {
  return (
    <div className="flex items-center gap-2 text-xs">
      {dot !== undefined && (
        <span
          className={`inline-block w-1.5 h-1.5 rounded-full ${
            dot ? "bg-emerald-400" : "bg-red-400"
          }`}
        />
      )}
      <span className="text-ink-500 w-16">{label}</span>
      <span className={`${color} ${truncate ? "truncate" : ""}`}>
        {value}
      </span>
    </div>
  );
}
