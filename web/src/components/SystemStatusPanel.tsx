import { useCallback, useEffect, useState } from "react";
import type { ProviderProbeStatus, ProvidersApiResponse } from "../types";

interface HealthData {
  ok: boolean;
  defaultModel?: string;
  ollamaUrl?: string;
  ollamaProbe?: {
    status: ProviderProbeStatus;
    lastProbeAt?: number;
    lastProbeMs?: number;
    lastError?: string;
    modelCount?: number;
  };
}

interface SystemStatusPanelProps {
  className?: string;
}

const PROVIDER_ORDER = ["ollama", "ollama-cloud", "anthropic", "openai", "opencode"] as const;

export function SystemStatusPanel({ className = "" }: SystemStatusPanelProps) {
  const [health, setHealth] = useState<HealthData | null>(null);
  const [providers, setProviders] = useState<ProvidersApiResponse | null>(null);
  const [proxyPressure, setProxyPressure] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const [healthRes, providersRes, usageRes] = await Promise.all([
        fetch("/api/health"),
        fetch("/api/providers"),
        fetch("/api/usage"),
      ]);
      const data: HealthData = await healthRes.json();
      setHealth(data);
      if (providersRes.ok) {
        setProviders((await providersRes.json()) as ProvidersApiResponse);
      }
      if (usageRes.ok) {
        const usage = await usageRes.json();
        setProxyPressure(usage.proxyPressure || null);
      }
    } catch {
      setHealth(null);
      setProviders(null);
      setProxyPressure(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchStatus();
    const interval = setInterval(() => {
      void fetchStatus();
    }, 30_000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  const retest = async () => {
    setProbing(true);
    setProbeError(null);
    try {
      const res = await fetch("/api/providers/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force: true }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `probe failed (${res.status})`);
      }
      await fetchStatus();
    } catch (err) {
      setProbeError(err instanceof Error ? err.message : String(err));
    } finally {
      setProbing(false);
    }
  };

  const ollamaStatus = health?.ollamaProbe?.status ?? "idle";
  const ollamaLabel = probeStatusLabel(ollamaStatus);
  const ollamaColor = probeStatusColor(ollamaStatus, health?.ok ?? false);

  return (
    <div className={`rounded border border-ink-700 bg-ink-800 p-3 space-y-2 ${className}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] uppercase tracking-wider text-ink-500 font-semibold">
          System Status
        </div>
        <button
          type="button"
          onClick={() => void retest()}
          disabled={probing || loading}
          className="text-[10px] px-1.5 py-0.5 rounded border border-ink-600 text-ink-300 hover:text-ink-100 hover:border-ink-500 disabled:opacity-40"
          title="Re-run live provider probes"
        >
          {probing ? "Testing…" : "Retest"}
        </button>
      </div>
      {probeError ? (
        <div className="text-[10px] text-rose-300">{probeError}</div>
      ) : null}
      {loading ? (
        <div className="text-ink-400 text-xs">Loading...</div>
      ) : health ? (
        <div className="space-y-1.5">
          <StatusRow
            label="Ollama"
            value={ollamaLabel}
            color={ollamaColor.text}
            dot={ollamaColor.dot}
            title={formatOllamaTooltip(health)}
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
          {proxyPressure && (
            <StatusRow
              label="Proxy"
              value={`${proxyPressure.recordCount} recs ${proxyPressure.atLimit ? "⚠" : ""}`}
              color={proxyPressure.atLimit ? "text-amber-400" : "text-ink-400"}
            />
          )}
          {providers ? (
            <div className="pt-1 space-y-1">
              <div className="text-[10px] uppercase tracking-wider text-ink-500 font-semibold">
                Providers
              </div>
              <div className="flex flex-wrap gap-1">
                {PROVIDER_ORDER.map((id) => {
                  const entry = providers[id];
                  if (!entry) return null;
                  const chip = chipStyle(entry.health.probeStatus, entry.hasKey, entry.runtime);
                  return (
                    <span
                      key={id}
                      title={formatChipTooltip(id, entry)}
                      className={`text-[10px] px-1.5 py-0.5 rounded font-mono border ${chip.className}`}
                    >
                      {id}
                      {entry.runtime.queueDepth > 0 ? ` ·q${entry.runtime.queueDepth}` : ""}
                    </span>
                  );
                })}
              </div>
              <div className="text-[9px] text-ink-500 leading-snug pt-0.5">
                <span className="inline-block w-2 h-2 rounded-full bg-emerald-400/80 mr-1 align-middle" />
                ok
                <span className="inline-block w-2 h-2 rounded-full bg-amber-400/80 mx-1 align-middle" />
                degraded / queue
                <span className="inline-block w-2 h-2 rounded-full bg-red-400/80 mx-1 align-middle" />
                down
                <span className="inline-block w-2 h-2 rounded-full bg-ink-500 mx-1 align-middle" />
                no key
              </div>
              {providers.meta?.nextProbeAt ? (
                <div className="text-[9px] text-ink-600">
                  Next auto-probe {formatRelative(providers.meta.nextProbeAt)}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="text-red-400 text-xs">Cannot reach server</div>
      )}
    </div>
  );
}

function probeStatusLabel(status: ProviderProbeStatus): string {
  switch (status) {
    case "ok":
      return "Healthy";
    case "degraded":
      return "Degraded";
    case "rate_limited":
      return "Rate limited";
    case "down":
      return "Down";
    case "unconfigured":
      return "Unconfigured";
    case "idle":
    default:
      return "Probing…";
  }
}

function probeStatusColor(
  status: ProviderProbeStatus,
  fallbackOk: boolean,
): { text: string; dot: boolean } {
  if (status === "ok") return { text: "text-emerald-400", dot: true };
  if (status === "degraded" || status === "rate_limited" || status === "idle") {
    return { text: "text-amber-400", dot: false };
  }
  if (status === "down") return { text: "text-red-400", dot: false };
  if (status === "unconfigured") return { text: "text-ink-400", dot: false };
  return fallbackOk
    ? { text: "text-emerald-400", dot: true }
    : { text: "text-red-400", dot: false };
}

function chipStyle(
  probeStatus: ProviderProbeStatus,
  hasKey: boolean,
  runtime: { circuit: string; queueDepth: number },
): { className: string } {
  if (!hasKey && probeStatus === "unconfigured") {
    return {
      className: "bg-ink-900/60 text-ink-500 border-ink-700/60",
    };
  }
  if (probeStatus === "down" || runtime.circuit === "open") {
    return {
      className: "bg-red-900/40 text-red-300 border-red-700/50",
    };
  }
  if (
    probeStatus === "degraded" ||
    probeStatus === "rate_limited" ||
    probeStatus === "idle" ||
    runtime.queueDepth > 0
  ) {
    return {
      className: "bg-amber-900/30 text-amber-200 border-amber-700/40",
    };
  }
  if (probeStatus === "ok") {
    return {
      className: "bg-emerald-900/30 text-emerald-200 border-emerald-700/40",
    };
  }
  return {
    className: "bg-ink-900/50 text-ink-400 border-ink-700/50",
  };
}

function formatOllamaTooltip(health: HealthData): string {
  const p = health.ollamaProbe;
  if (!p) return "Ollama reachability probe";
  const parts = [`probe=${p.status}`];
  if (p.modelCount !== undefined) parts.push(`models=${p.modelCount}`);
  if (p.lastProbeMs !== undefined) parts.push(`${p.lastProbeMs}ms`);
  if (p.lastProbeAt) parts.push(formatAge(p.lastProbeAt));
  if (p.lastError) parts.push(p.lastError);
  return parts.join(" · ");
}

function formatChipTooltip(
  id: string,
  entry: NonNullable<ProvidersApiResponse["ollama"]>,
): string {
  const h = entry.health;
  const r = entry.runtime;
  const parts = [
    `probe=${h.probeStatus}`,
    `key=${entry.hasKey ? "yes" : "no"}`,
    `circuit=${r.circuit}`,
    `headroom=${r.headroom}`,
    `queue=${r.queueDepth}`,
  ];
  if (h.lastProbeMs !== undefined) parts.push(`${h.lastProbeMs}ms`);
  if (h.lastProbeAt) parts.push(formatAge(h.lastProbeAt));
  if (h.modelCount !== undefined) parts.push(`models=${h.modelCount}`);
  if (h.lastError) parts.push(h.lastError);
  if (h.envVars.length > 0) parts.push(`env: ${h.envVars.join(", ")}`);
  return `${id}: ${parts.join(" · ")}`;
}

function formatAge(ts: number): string {
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  return `${Math.round(min / 60)}h ago`;
}

function formatRelative(ts: number): string {
  const delta = ts - Date.now();
  if (delta <= 0) return "soon";
  const min = Math.round(delta / 60_000);
  if (min < 60) return `in ${min}m`;
  return `in ${Math.round(min / 60)}h`;
}

function StatusRow({
  label,
  value,
  color,
  dot,
  truncate,
  title,
}: {
  label: string;
  value: string;
  color: string;
  dot?: boolean;
  truncate?: boolean;
  title?: string;
}) {
  return (
    <div className="flex items-center gap-2 text-xs" title={title}>
      {dot !== undefined && (
        <span
          className={`inline-block w-1.5 h-1.5 rounded-full ${
            dot ? "bg-emerald-400" : "bg-amber-400"
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