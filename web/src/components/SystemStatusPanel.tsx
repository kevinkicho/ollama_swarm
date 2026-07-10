import { useCallback, useEffect, useState } from "react";
import type { Provider } from "@ollama-swarm/shared/providers";
import { useProviders } from "../hooks/useProviders";
import { useSystemLayerModel } from "../hooks/useSystemLayerModel";
import type { ProviderProbeStatus } from "../types";
import { InfoTip } from "./setup/InfoTip";
import { ProviderTabs } from "./setup/ProviderTabs";
import { ModelSelect } from "./setup/ModelSelect";
import { SystemProbeTipContent } from "./SystemProbeTip";
import { apiFetch } from "../lib/apiFetch";

interface HealthData {
  ok: boolean;
  model?: string;
  provider?: Provider;
  toolsEnabled?: boolean;
  probe?: {
    status: ProviderProbeStatus;
    lastProbeAt?: number;
    lastProbeMs?: number;
    lastError?: string;
    modelCount?: number;
  };
  ollamaUrl?: string;
}

interface SystemStatusPanelProps {
  className?: string;
  /** Active project clone or parent path — enables project-logs prune UI. */
  projectPath?: string;
}

const PROVIDER_LABELS: Record<Provider, string> = {
  ollama: "Ollama",
  "ollama-cloud": "Ollama Cloud",
  anthropic: "Anthropic",
  openai: "OpenAI",
  opencode: "OpenCode",
};

interface ProjectLogsStatus {
  root: string;
  logsRunDirCount: number;
  summaryFileCount: number;
  logsNeedsPrune: boolean;
  logsRunDirWarnThreshold: number;
  totalBytesApprox?: number;
}

interface MaintenanceStatus {
  logsRunDirCount: number;
  logsRunDirWarnThreshold: number;
  logsNeedsPrune: boolean;
  runsEntryCount: number;
  project?: ProjectLogsStatus;
}

interface PruneApiResult {
  apply: boolean;
  summary: string;
  deletedCount: number;
  logsRunDirsRemaining?: number;
}

type PruneScope = "app" | "project";

export function SystemStatusPanel({ className = "", projectPath }: SystemStatusPanelProps) {
  const providers = useProviders();
  const { model, provider, setModel, setProvider, toolsEnabled } = useSystemLayerModel();
  const [health, setHealth] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [retestNote, setRetestNote] = useState<string | null>(null);
  const [maint, setMaint] = useState<MaintenanceStatus | null>(null);
  const [pruneBusy, setPruneBusy] = useState(false);
  const [pruneNote, setPruneNote] = useState<string | null>(null);
  const [pruneConfirm, setPruneConfirm] = useState<null | { scope: PruneScope; mode: "prune" | "purge" }>(
    null,
  );

  const fetchStatus = useCallback(async () => {
    try {
      const maintQs = projectPath
        ? `?clonePath=${encodeURIComponent(projectPath)}`
        : "";
      const [healthRes, providersRes, maintRes] = await Promise.all([
        apiFetch("/api/health", { cache: "no-store" }),
        apiFetch("/api/providers", { cache: "no-store" }),
        apiFetch(`/api/swarm/maintenance/status${maintQs}`, { cache: "no-store" }),
      ]);
      if (!healthRes.ok) throw new Error(`health ${healthRes.status}`);
      const healthBody = (await healthRes.json()) as HealthData;
      if (providersRes.ok) {
        const providersBody = (await providersRes.json()) as Record<string, ProviderHealthEntry>;
        const entry = providersBody[provider];
        if (entry?.health) {
          healthBody.probe = {
            status: entry.health.probeStatus,
            lastProbeAt: entry.health.lastProbeAt,
            lastProbeMs: entry.health.lastProbeMs,
            lastError: entry.health.lastError,
            modelCount: entry.health.modelCount,
          };
        }
      }
      setHealth(healthBody);
      if (maintRes.ok) {
        setMaint((await maintRes.json()) as MaintenanceStatus);
      } else {
        // clonePath may be unknown until a run is tracked — fall back to app-only
        const fallback = await apiFetch("/api/swarm/maintenance/status", { cache: "no-store" });
        if (fallback.ok) setMaint((await fallback.json()) as MaintenanceStatus);
      }
    } catch {
      setHealth(null);
    } finally {
      setLoading(false);
    }
  }, [provider, projectPath]);

  useEffect(() => {
    void fetchStatus();
    const interval = setInterval(() => void fetchStatus(), 30_000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  useEffect(() => {
    if (!model) return;
    const t = setTimeout(() => void fetchStatus(), 400);
    return () => clearTimeout(t);
  }, [model, provider, fetchStatus]);

  useEffect(() => {
    if (!retestNote) return;
    const t = setTimeout(() => setRetestNote(null), 8000);
    return () => clearTimeout(t);
  }, [retestNote]);

  useEffect(() => {
    if (!pruneNote) return;
    const t = setTimeout(() => setPruneNote(null), 12_000);
    return () => clearTimeout(t);
  }, [pruneNote]);

  const runPrune = async (
    apply: boolean,
    scope: PruneScope,
    mode: "prune" | "purge" = "prune",
  ) => {
    setPruneBusy(true);
    setPruneNote(null);
    try {
      const payload: Record<string, unknown> =
        scope === "project"
          ? {
              target: "project-logs",
              clonePath: projectPath,
              mode,
              apply,
            }
          : { target: "logs", mode: "prune", apply };
      const res = await apiFetch("/api/swarm/maintenance/prune", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await res.json().catch(() => ({}))) as PruneApiResult & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `prune failed (${res.status})`);
      setPruneNote(body.summary ?? (apply ? "Pruned." : "Dry-run complete."));
      if (!apply && (body.deletedCount ?? 0) > 0) {
        setPruneConfirm({ scope, mode });
      } else {
        setPruneConfirm(null);
      }
      await fetchStatus();
    } catch (err) {
      setPruneNote(err instanceof Error ? err.message : String(err));
    } finally {
      setPruneBusy(false);
    }
  };

  const retest = async () => {
    setProbing(true);
    setProbeError(null);
    setRetestNote(null);
    try {
      const res = await apiFetch("/api/providers/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force: true, providers: [provider] }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `probe failed (${res.status})`);
      }
      const payload = (await res.json()) as ProbeApiPayload;
      const rec = payload.providers?.[provider];
      if (rec) {
        const label = probeStatusLabel(rec.probeStatus);
        const latency = rec.lastProbeMs != null ? `${rec.lastProbeMs}ms` : null;
        setHealth((prev) => ({
          ok:
            rec.probeStatus === "ok" ||
            rec.probeStatus === "degraded" ||
            rec.probeStatus === "idle",
          model,
          provider,
          toolsEnabled: toolsEnabled ?? prev?.toolsEnabled,
          ollamaUrl: prev?.ollamaUrl,
          probe: {
            status: rec.probeStatus,
            lastProbeAt: rec.lastProbeAt,
            lastProbeMs: rec.lastProbeMs,
            lastError: rec.lastError,
            modelCount: rec.modelCount,
          },
        }));
        setRetestNote(
          latency
            ? `Live check · ${label} · ${latency}`
            : `Live check · ${label}`,
        );
      }
      await fetchStatus();
    } catch (err) {
      setProbeError(err instanceof Error ? err.message : String(err));
    } finally {
      setProbing(false);
    }
  };

  const activeModel = model;
  const activeProvider = provider;
  const probeStatus = health?.probe?.status ?? "idle";
  const statusLabel = probing
    ? "Checking…"
    : formatStatusWithLatency(probeStatus, health?.probe?.lastProbeMs);
  const statusColor = probing
    ? { text: "text-amber-400", dot: false }
    : probeStatusColor(probeStatus);
  const showEndpoint = activeProvider === "ollama" || activeProvider === "ollama-cloud";
  const noTools = (toolsEnabled ?? health?.toolsEnabled) === false;

  return (
    <div
      className={`rounded border border-ink-700 bg-ink-800 p-2 space-y-2 min-w-0 max-w-full overflow-hidden ${className}`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] uppercase tracking-wider text-ink-500 font-semibold">
          System Status
        </div>
        <button
          type="button"
          onClick={() => void retest()}
          disabled={probing || loading}
          className="text-[10px] px-1.5 py-0.5 rounded border border-ink-600 text-ink-300 hover:text-ink-100 hover:border-ink-500 disabled:opacity-40"
          title="Run a live reachability check for the selected provider (not just cached status)"
        >
          {probing ? "Checking…" : "Retest"}
        </button>
      </div>

      <ProviderTabs
        value={provider}
        onChange={setProvider}
        status={providers}
        variant="compact"
      />
      <div className="min-w-0 max-w-full overflow-hidden">
        <ModelSelect
          value={model}
          onChange={setModel}
          provider={provider}
          ariaLabel="System model"
          compact
        />
      </div>

      {probeError ? <div className="text-[10px] text-rose-300">{probeError}</div> : null}
      {retestNote ? (
        <div className="text-[9px] text-emerald-400/90 whitespace-nowrap truncate">{retestNote}</div>
      ) : null}

      {loading ? (
        <div className="text-ink-400 text-xs">Loading...</div>
      ) : health ? (
        <div className="space-y-1 min-w-0">
          <InfoTip
            preferNoWrap
            showDelayMs={350}
            maxWidth={520}
            wrapperClassName="block w-full min-w-0"
            trigger={
              <div className="rounded hover:bg-ink-700/40 -mx-1 px-1 py-0.5 w-full cursor-help min-w-0">
                <StatusRow
                  label={PROVIDER_LABELS[activeProvider] ?? activeProvider}
                  value={statusLabel}
                  color={statusColor.text}
                  dot={statusColor.dot}
                  nowrap
                />
              </div>
            }
          >
            <SystemProbeTipContent
              details={{
                provider: activeProvider,
                model: activeModel,
                status: probeStatus,
                toolsEnabled: health.toolsEnabled,
                lastProbeAt: health.probe?.lastProbeAt,
                lastProbeMs: health.probe?.lastProbeMs,
                lastError: health.probe?.lastError,
                modelCount: health.probe?.modelCount,
                endpoint: showEndpoint ? health.ollamaUrl : undefined,
              }}
            />
          </InfoTip>
          <StatusRow label="Model" value={activeModel} color="text-ink-200" nowrap />
          {showEndpoint && health.ollamaUrl ? (
            <StatusRow label="Endpoint" value={health.ollamaUrl} color="text-ink-400" nowrap />
          ) : null}
          {noTools ? (
            <div className="text-[9px] text-amber-400/90 whitespace-nowrap truncate">
              No file tools on this provider
            </div>
          ) : null}
          {maint ? (
            <div className="pt-1 mt-1 border-t border-ink-700/80 space-y-1.5">
              <div
                className={`text-[9px] whitespace-nowrap truncate ${
                  maint.logsNeedsPrune ? "text-amber-400/90" : "text-ink-500"
                }`}
                title={`App server logs/ run dirs (warn > ${maint.logsRunDirWarnThreshold})`}
              >
                App logs · {maint.logsRunDirCount}
                {maint.logsNeedsPrune ? " · prune?" : ""}
              </div>
              {maint.project ? (
                <div
                  className={`text-[9px] whitespace-nowrap truncate ${
                    maint.project.logsNeedsPrune ? "text-amber-400/90" : "text-ink-500"
                  }`}
                  title={`Target repo ${maint.project.root}/logs — run summaries & dirs (warn > ${maint.project.logsRunDirWarnThreshold})`}
                >
                  Project · {maint.project.logsRunDirCount} dirs
                  {maint.project.summaryFileCount > 0
                    ? ` · ${maint.project.summaryFileCount} summaries`
                    : ""}
                  {maint.project.logsNeedsPrune ? " · prune?" : ""}
                </div>
              ) : projectPath ? (
                <div className="text-[9px] text-ink-600 truncate" title={projectPath}>
                  Project path set · no logs yet
                </div>
              ) : null}

              {!pruneConfirm ? (
                <div className="flex flex-col gap-0.5">
                  <button
                    type="button"
                    disabled={pruneBusy}
                    onClick={() => void runPrune(false, "app", "prune")}
                    className="text-[9px] px-1.5 py-0.5 rounded border border-ink-700 text-ink-500 hover:text-ink-300 hover:border-ink-500 disabled:opacity-40 w-full text-left"
                    title="Dry-run prune of ollama_swarm app logs/ (server cwd)"
                  >
                    {pruneBusy ? "…" : "Prune app logs…"}
                  </button>
                  {projectPath ? (
                    <>
                      <button
                        type="button"
                        disabled={pruneBusy}
                        onClick={() => void runPrune(false, "project", "prune")}
                        className="text-[9px] px-1.5 py-0.5 rounded border border-ink-700 text-ink-500 hover:text-ink-300 hover:border-ink-500 disabled:opacity-40 w-full text-left"
                        title="Dry-run prune of target repo logs/ (summary-*.json + old run dirs)"
                      >
                        {pruneBusy ? "…" : "Prune project logs…"}
                      </button>
                      <button
                        type="button"
                        disabled={pruneBusy}
                        onClick={() => void runPrune(false, "project", "purge")}
                        className="text-[9px] px-1.5 py-0.5 rounded border border-ink-700/80 text-ink-600 hover:text-amber-300/90 hover:border-amber-800/50 disabled:opacity-40 w-full text-left"
                        title="Dry-run purge: delete all project run logs except active runs"
                      >
                        {pruneBusy ? "…" : "Purge project logs…"}
                      </button>
                    </>
                  ) : null}
                </div>
              ) : (
                <div className="flex gap-1">
                  <button
                    type="button"
                    disabled={pruneBusy}
                    onClick={() =>
                      void runPrune(true, pruneConfirm.scope, pruneConfirm.mode)
                    }
                    className="text-[9px] px-1.5 py-0.5 rounded border border-amber-700/60 text-amber-300/90 hover:bg-amber-900/30 disabled:opacity-40 flex-1"
                    title="Delete items from the dry-run preview"
                  >
                    {pruneBusy ? "…" : "Delete"}
                  </button>
                  <button
                    type="button"
                    disabled={pruneBusy}
                    onClick={() => setPruneConfirm(null)}
                    className="text-[9px] px-1.5 py-0.5 rounded border border-ink-700 text-ink-500 hover:text-ink-300 disabled:opacity-40"
                  >
                    Cancel
                  </button>
                </div>
              )}
              {pruneNote ? (
                <div className="text-[8px] text-ink-400 leading-snug line-clamp-3" title={pruneNote}>
                  {pruneNote}
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

interface ProviderHealthEntry {
  health?: {
    probeStatus: ProviderProbeStatus;
    lastProbeAt?: number;
    lastProbeMs?: number;
    lastError?: string;
    modelCount?: number;
  };
}

interface ProbeApiPayload {
  providers?: Partial<
    Record<
      Provider,
      {
        probeStatus: ProviderProbeStatus;
        lastProbeAt?: number;
        lastProbeMs?: number;
        lastError?: string;
        modelCount?: number;
      }
    >
  >;
}

function formatStatusWithLatency(status: ProviderProbeStatus, ms?: number): string {
  const label = probeStatusLabel(status);
  return ms != null ? `${label} · ${ms}ms` : label;
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

function probeStatusColor(status: ProviderProbeStatus): { text: string; dot: boolean } {
  if (status === "ok") return { text: "text-emerald-400", dot: true };
  if (status === "degraded" || status === "rate_limited" || status === "idle") {
    return { text: "text-amber-400", dot: false };
  }
  if (status === "down") return { text: "text-red-400", dot: false };
  return { text: "text-ink-400", dot: false };
}

function StatusRow({
  label,
  value,
  color,
  dot,
  nowrap = false,
}: {
  label: string;
  value: string;
  color: string;
  dot?: boolean;
  nowrap?: boolean;
}) {
  const valueCls = nowrap
    ? "truncate whitespace-nowrap"
    : "break-all";
  return (
    <div className={`flex items-center gap-2 text-xs min-w-0 ${nowrap ? "flex-nowrap" : ""}`}>
      {dot !== undefined && (
        <span
          className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${
            dot ? "bg-emerald-400" : "bg-amber-400"
          }`}
        />
      )}
      <span className="text-ink-500 w-16 shrink-0">{label}</span>
      <span className={`${color} min-w-0 flex-1 ${valueCls}`}>{value}</span>
    </div>
  );
}