import { useMemo, useState } from "react";
import { copyText } from "../../utils/copyText";
import {
  eventOneLiner,
  formatDuration,
  guessEventCategory,
  type EventCategory,
} from "../../lib/eventLogUi";
import { AnomalyBadges } from "./AnomalyBadges";
import { displayPhase, formatBytes, phaseColor } from "./format";
import { CATEGORY_TABS, type RunDetailResponse } from "./types";

export function RunDetailView({
  detail,
  loading,
  loadingOlder,
  error,
  categoryFilter,
  onCategoryFilter,
  logDir,
  onViewRun,
  onLoadOlder,
}: {
  detail: RunDetailResponse | null;
  loading: boolean;
  loadingOlder?: boolean;
  error: string | null;
  categoryFilter: "all" | EventCategory;
  onCategoryFilter: (c: "all" | EventCategory) => void;
  logDir?: string;
  onViewRun?: (runId: string) => void;
  onLoadOlder?: () => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);

  const topTypes = useMemo(() => {
    if (!detail) return [];
    const entries = Object.entries(detail.derived.eventTypeCounts);
    return entries.sort((a, b) => b[1] - a[1]).slice(0, 10);
  }, [detail]);

  const filteredRecords = useMemo(() => {
    if (!detail) return [];
    const recs = detail.records.filter((r) => r.event.type !== "_session_started");
    if (categoryFilter === "all") return recs;
    return recs.filter((r) => guessEventCategory(r.event.type) === categoryFilter);
  }, [detail, categoryFilter]);

  const handleCopy = async (label: string, value: string) => {
    const ok = await copyText(value);
    if (ok) {
      setCopied(label);
      setTimeout(() => setCopied(null), 1500);
    }
  };

  if (loading) return <div className="text-ink-400 text-sm italic">Loading run…</div>;
  if (error) return <div className="text-rose-300 text-sm">Error: {error}</div>;
  if (!detail) return null;

  const d = detail.derived;
  const debugPath =
    detail.debugLog && logDir
      ? `${logDir.replace(/\\/g, "/")}/${detail.debugLog.relativePath}`
      : null;

  return (
    <div className="space-y-3 text-[11px]">
      <div className="rounded border border-ink-700 bg-ink-800/50 p-2.5 space-y-2">
        <div className="flex items-baseline justify-between gap-2 min-w-0">
          <div className="flex flex-wrap gap-2 items-baseline min-w-0">
            <span className={`font-mono font-semibold ${phaseColor(displayPhase(d))}`}>
              {displayPhase(d)}
            </span>
            {d.stopReason ? (
              <span className="text-ink-500">stop: {d.stopReason}</span>
            ) : null}
            <span className="text-ink-500">{formatDuration(d.durationMs)}</span>
            {detail.runId ? (
              <span className="text-ink-600 font-mono">
                {detail.runId}
                {d.runIdInferred ? " (inferred)" : ""}
              </span>
            ) : (
              <span className="text-ink-600">segment {detail.sliceIndex ?? "?"}</span>
            )}
          </div>
          {detail.runId && onViewRun ? (
            <button
              type="button"
              onClick={() => onViewRun(detail.runId!)}
              className="shrink-0 text-[10px] text-sky-400 hover:text-sky-300 underline underline-offset-2 decoration-sky-500/50 hover:decoration-sky-300"
              title={`Open ${detail.runId} in main view`}
            >
              view
            </button>
          ) : null}
        </div>
        <AnomalyBadges flags={d.anomalyFlags} />
        <div className="grid grid-cols-3 gap-2 text-[10px] text-ink-400">
          <Stat label="transcript" value={d.transcriptCount} />
          <Stat label="agent state" value={d.agentStateUpdates} />
          <Stat label="activity" value={d.agentActivityEvents ?? 0} />
          <Stat label="streaming ends" value={d.streamingEndCount} />
          <Stat label="model shifts" value={d.modelShiftCount} />
          <Stat label="todo failed" value={d.todoFailed} />
          <Stat label="amendments" value={d.amendmentCount} />
          <Stat label="conformance" value={d.conformanceSampleCount} />
          <Stat label="cold starts" value={d.coldStartCount} />
          <Stat
            label="max cold ms"
            value={d.maxColdStartMs != null ? String(d.maxColdStartMs) : "—"}
          />
        </div>
        {(d.activityTimeline?.length ?? 0) > 0 ? (
          <div className="space-y-1">
            <div className="text-[9px] uppercase tracking-wider text-sky-400 font-semibold">
              Activity timeline ({d.activityTimeline!.length})
            </div>
            <ol className="max-h-[140px] overflow-y-auto space-y-0.5 font-mono text-[10px] border border-ink-800 rounded p-1.5 bg-ink-950/40">
              {d.activityTimeline!.slice(-40).map((step, i) => (
                <li
                  key={`${step.ts}-${step.agentId}-${i}`}
                  className="flex gap-2 py-0.5 border-b border-ink-900/70 last:border-0"
                >
                  <span className="text-ink-600 shrink-0 w-[52px]">
                    {new Date(step.ts).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    })}
                  </span>
                  <span className="text-sky-400/90 shrink-0 w-[64px] truncate">
                    {step.agentId.replace(/^agent-/, "a")}
                  </span>
                  <span className="text-amber-300/90 shrink-0 w-[64px]">{step.phase}</span>
                  <span className="text-ink-400 truncate flex-1">
                    {step.label ?? step.kind ?? "—"}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        ) : null}
        {d.lastConformanceScore != null ? (
          <p className="text-[10px] text-ink-500">
            last conformance {d.lastConformanceScore}
            {d.lastDriftSimilarity != null ? ` · drift ${d.lastDriftSimilarity.toFixed(3)}` : ""}
          </p>
        ) : null}
        {d.streamAnomalies.length > 0 ? (
          <div className="space-y-1">
            <div className="text-[9px] uppercase tracking-wider text-fuchsia-400 font-semibold">
              Stream anomalies
            </div>
            {d.streamAnomalies.map((a, i) => (
              <div key={i} className="text-[10px] text-fuchsia-200/90 leading-snug">
                {a.agentId ? `${a.agentId}: ` : ""}
                {a.detail}
              </div>
            ))}
          </div>
        ) : null}
        {d.errors.length > 0 ? (
          <div className="space-y-0.5">
            <div className="text-[9px] uppercase tracking-wider text-rose-400 font-semibold">
              Errors ({d.errors.length})
            </div>
            {d.errors.slice(-5).map((e, i) => (
              <div key={i} className="text-[10px] text-rose-300 break-words">
                {e}
              </div>
            ))}
          </div>
        ) : null}
        <div className="flex flex-wrap gap-1.5 pt-1">
          {detail.runId ? (
            <button
              type="button"
              onClick={() => void handleCopy("runId", detail.runId!)}
              className="text-[9px] px-1.5 py-0.5 rounded border border-ink-600 bg-ink-800 text-ink-400 hover:text-ink-200"
            >
              {copied === "runId" ? "copied" : "copy run id"}
            </button>
          ) : null}
          {debugPath ? (
            <button
              type="button"
              onClick={() => void handleCopy("debug", debugPath)}
              className="text-[9px] px-1.5 py-0.5 rounded border border-ink-600 bg-ink-800 text-ink-400 hover:text-ink-200"
              title={debugPath}
            >
              {copied === "debug"
                ? "copied"
                : `debug.jsonl (${formatBytes(detail.debugLog!.bytes)})`}
            </button>
          ) : null}
        </div>
      </div>

      {topTypes.length > 0 ? (
        <div>
          <div className="text-[9px] uppercase tracking-wider text-ink-500 font-semibold mb-1">
            Event types
          </div>
          <div className="flex flex-wrap gap-1">
            {topTypes.map(([type, count]) => (
              <span
                key={type}
                className="text-[9px] font-mono px-1 py-0 rounded bg-ink-800 border border-ink-700 text-ink-400"
              >
                {type} <span className="text-ink-500">{count}</span>
              </span>
            ))}
          </div>
        </div>
      ) : null}

      <div>
        <div className="flex flex-wrap gap-1 mb-1.5">
          {CATEGORY_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => onCategoryFilter(tab.id)}
              className={`text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded border transition ${
                categoryFilter === tab.id
                  ? "bg-ink-700 border-ink-500 text-ink-200"
                  : "bg-ink-900 border-ink-700 text-ink-500 hover:text-ink-300"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[10px] text-ink-500 mb-1">
          <span>
            {filteredRecords.length} events
            {typeof detail.totalRecords === "number" && detail.totalRecords > detail.records.length
              ? ` (loaded ${detail.records.length} of ${detail.totalRecords})`
              : ""}
            {categoryFilter !== "all" ? ` (${categoryFilter})` : ""}
          </span>
          {onLoadOlder ? (
            <button
              type="button"
              disabled={loadingOlder}
              onClick={onLoadOlder}
              className="text-[9px] px-1.5 py-0.5 rounded border border-ink-600 bg-ink-800 text-sky-300/90 hover:text-sky-200 disabled:opacity-50"
            >
              {loadingOlder ? "loading…" : "load older"}
            </button>
          ) : null}
        </div>
        <ol className="space-y-0.5 max-h-[280px] overflow-y-auto font-mono text-[10px] border border-ink-800 rounded p-1.5 bg-ink-950/50">
          {filteredRecords.length === 0 ? (
            <li className="text-ink-600 italic py-2">No events in this filter.</li>
          ) : (
            filteredRecords.map((r, i) => (
              <li
                key={`${r.ts}-${i}`}
                className="flex gap-2 py-0.5 border-b border-ink-900/80 last:border-0"
              >
                <span className="text-ink-600 shrink-0 w-[52px]">
                  {new Date(r.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                </span>
                <span className="text-sky-400/90 shrink-0 w-[120px] truncate">{r.event.type}</span>
                <span className="text-ink-400 truncate flex-1">{eventOneLiner(r.event)}</span>
              </li>
            ))
          )}
        </ol>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <span className="text-ink-600">{label}</span>{" "}
      <span className="text-ink-300">{value}</span>
    </div>
  );
}
