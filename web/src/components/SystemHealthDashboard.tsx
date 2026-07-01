import React, { useState, useEffect } from 'react';

interface HealthMetrics {
  cpu: number;
  memory: number;
  activeRuns: number;
  errorRate: number;
  status: 'healthy' | 'degraded' | 'down';
}

const SystemHealthDashboard: React.FC = () => {
  const [metrics, setMetrics] = useState<HealthMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchHealth = async () => {
    try {
      const response = await fetch('/api/health');
      if (!response.ok) throw new Error('Failed to fetch health data');
      const data: HealthMetrics = await response.json();
      setMetrics(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchHealth();
    const interval = setInterval(fetchHealth, 10000);
    return () => clearInterval(interval);
  }, []);

  if (loading) return <div>Loading system health...</div>;
  if (error) return <div>Error: {error}</div>;
  if (!metrics) return null;

  const statusColor = metrics.status === 'healthy' ? 'green' : metrics.status === 'degraded' ? 'orange' : 'red';

  return (
    <div className="system-health-dashboard">
      <h2>System Health</h2>
      <div className="health-indicator" style={{ color: statusColor }}>
        <span className="status-dot" style={{ backgroundColor: statusColor }} />
        {metrics.status.toUpperCase()}
      </div>
      <ul>
        <li>CPU: {metrics.cpu}%</li>
        <li>Memory: {metrics.memory}%</li>
        <li>Active Runs: {metrics.activeRuns}</li>
        <li>Error Rate: {metrics.errorRate}%</li>
      </ul>
    </div>
  );
};

export default SystemHealthDashboard;
