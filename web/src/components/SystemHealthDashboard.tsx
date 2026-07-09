import { useState, useEffect } from 'react';

interface HealthData {
  ok: boolean;
  defaultModel?: string;
  ollamaUrl?: string;
}

const SystemHealthDashboard = () => {
  const [health, setHealth] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchHealth = async () => {
      try {
        const res = await fetch('/api/health');
        const data: HealthData = await res.json();
        setHealth(data);
      } catch {
        setHealth(null);
      } finally {
        setLoading(false);
      }
    };
    fetchHealth();
    const interval = setInterval(fetchHealth, 10000);
    return () => clearInterval(interval);
  }, []);

  if (loading) return <div className="text-ink-400 text-xs p-2">Loading system health...</div>;
  if (!health) return <div className="text-red-400 text-xs p-2">Health check failed</div>;

  return (
    <div className="rounded border border-ink-700 bg-ink-800 p-2 text-xs space-y-1 min-w-0 max-w-full overflow-hidden">
      <div className="font-medium text-ink-200">System Health</div>
      <div className="flex items-center gap-2">
        <span className={`inline-block w-2 h-2 rounded-full ${health.ok ? 'bg-emerald-400' : 'bg-red-400'}`} />
        <span className={health.ok ? 'text-emerald-400' : 'text-red-400'}>
          {health.ok ? 'Healthy' : 'Down'}
        </span>
      </div>
      {health.defaultModel && <div className="text-ink-400">Model: {health.defaultModel}</div>}
      {health.ollamaUrl && (
        <div className="text-ink-400 truncate" title={health.ollamaUrl}>
          Ollama: {health.ollamaUrl}
        </div>
      )}
    </div>
  );
};

export default SystemHealthDashboard;
