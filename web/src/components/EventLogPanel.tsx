// Debug Log — developer flight recorder over logs/current.jsonl.
// Rich derived cards + per-run event timeline drill-down.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { useTopbarDropdown } from "../lib/topbarDropdown";
import { copyText } from "../utils/copyText";
import {
  ANOMALY_FLAG_LABELS,
  eventOneLiner,
  formatDuration,
  guessEventCategory,
  isInfraOnlySlice,
  normalizeDerived,
  topEventTypes,
  type DerivedRunState,
  type EventCategory,
} from "../lib/eventLogUi";

interface RunSliceSummary {
  sliceIndex: number;
  derived: DerivedRunState;
  recordCount: number;
  isSessionBoundary: boolean;
  source?: "global" | "per-run-debug" | "archive-index";
}

type DetailTarget = { runId?: string; sliceIndex: number };

interface EventLogResponse {
  runs: RunSliceSummary[];
  malformed: number;
  sources: string[];
  totalRecords: number;
  logDir?: string;
  eventLogPath?: string;
  archivesTotal?: number;
  archivesRead?: number;
  perRunDebugCount?: number;
}

interface LoggedRecord {
  ts: number;
  event: { type: string } & Record<string, unknown>;
}

interface RunDetailResponse {
  runId: string | null;
  sliceIndex?: number;
  derived: DerivedRunState;
  records: LoggedRecord[];
  isSessionBoundary: boolean;
  malformed: number;
  sources: string[];
  logDir?: string;
  debugLog?: { relativePath: string; bytes: number } | null;
}

const CATEGORY_TABS: Array<{ id: "all" | EventCategory; label: string }> = [
  { id: "all", label: "all" },
  { id: "lifecycle", label: "lifecycle" },
  { id: "agent", label: "agent" },
  { id: "transcript", label: "transcript" },
  { id: "todo", label: "todo" },
  { id: "diag", label: "diag" },
  { id: "other", label: "other" },
];

function displayPhase(d: DerivedRunState): string {
  let phase = d.finalPhase ?? "?";
  if (d.hasSummary && phase === "executing") phase = "completed";
  return phase;
}

function phaseColor(phase: string): string {
  if (phase === "completed") return "text-emerald-300";
  if (phase === "failed") return "text-rose-300";
  if (phase === "stopped") return "text-amber-300";
  if (phase === "executing" || phase === "active") return "text-blue-300";
  if (phase === "archived") return "text-ink-400";
  return "text-ink-300";
}

function canDrillDown(run: RunSliceSummary): boolean {
  return run.recordCount > 1;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export const EventLogPanel = memo(function EventLogPanel() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<EventLogResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [detailTarget, setDetailTarget] = useState<DetailTarget | null>(null);
  const [detail, setDetail] = useState<RunDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<"all" | EventCategory>("all");
  const anchorRef = useRef<HTMLDivElement>(null);
  const closeDropdown = useCallback(() => setOpen(false), []);
  const { panelRef, pos: panelPos, panelStyle } = useTopbarDropdown(open, anchorRef, 560, closeDropdown);

  useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    fetch("/api/v2/event-log/runs", { signal: ctrl.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as EventLogResponse;
      })
      .then((j) => {
        setData({
          ...j,
          runs: j.runs.map((r, i) => ({
            ...r,
            sliceIndex: r.sliceIndex ?? i,
            derived: normalizeDerived(r.derived),
          })),
        });
      })
      .catch((e) => {
        if (!ctrl.signal.aborted) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [open, refreshNonce]);

  useEffect(() => {
    if (!open || !detailTarget) {
      setDetail(null);
      setDetailError(null);
      return;
    }
    const ctrl = new AbortController();
    setDetailLoading(true);
    setDetailError(null);
    const url = detailTarget.runId
      ? `/api/v2/event-log/runs/${encodeURIComponent(detailTarget.runId)}`
      : `/api/v2/event-log/slices/${detailTarget.sliceIndex}`;
    fetch(url, { signal: ctrl.signal })
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error((body as { error?: string }).error ?? `HTTP ${r.status}`);
        }
        return (await r.json()) as RunDetailResponse;
      })
      .then((j) =>
        setDetail({
          ...j,
          derived: normalizeDerived(j.derived),
        }),
      )
      .catch((e) => {
        if (!ctrl.signal.aborted) setDetailError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setDetailLoading(false);
      });
    return () => ctrl.abort();
  }, [open, detailTarget, refreshNonce]);

  const closeDetail = useCallback(() => {
    setDetailTarget(null);
    setCategoryFilter("all");
  }, []);

  const openRunInMainView = useCallback(
    (runId: string) => {
      setOpen(false);
      closeDetail();
      navigate(`/runs/${encodeURIComponent(runId)}`);
    },
    [closeDetail, navigate],
  );

  const dropdownPanel =
    open && panelPos ? (
      <div
        ref={panelRef}
        className="fixed z-50 max-h-[70vh] overflow-hidden flex flex-col rounded border border-ink-600 bg-ink-900 shadow-xl shadow-black/50"
        style={panelStyle}
      >
          <div className="flex items-center gap-2 px-3 py-2 border-b border-ink-700/80 shrink-0">
            {detailTarget ? (
              <button
                onClick={closeDetail}
                className="text-[10px] text-ink-400 hover:text-ink-200"
              >
                ← back
              </button>
            ) : null}
            <span className="text-[11px] text-ink-300 font-semibold">
              {detailTarget?.runId
                ? `Run ${detailTarget.runId.slice(0, 8)}`
                : detailTarget
                  ? `Segment ${detailTarget.sliceIndex}`
                  : "⚙ Debug Log"}
            </span>
            <span className="text-[10px] text-ink-500 truncate">
              {detailTarget ? "event timeline" : "flight recorder · not Runs"}
            </span>
            <button
              type="button"
              onClick={() => setRefreshNonce((n) => n + 1)}
              disabled={loading || detailLoading}
              className="ml-auto text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-ink-800 hover:bg-ink-700 text-ink-400 hover:text-ink-200 disabled:opacity-50"
            >
              {loading || detailLoading ? "…" : "refresh"}
            </button>
          </div>

          <div className="overflow-y-auto flex-1 p-3">
            {detailTarget ? (
              <RunDetailView
                detail={detail}
                loading={detailLoading}
                error={detailError}
                categoryFilter={categoryFilter}
                onCategoryFilter={setCategoryFilter}
                logDir={detail?.logDir ?? data?.logDir}
                onViewRun={openRunInMainView}
              />
            ) : loading ? (
              <div className="text-ink-400 text-sm italic">Loading…</div>
            ) : error ? (
              <div className="text-rose-300 text-sm">Error: {error}</div>
            ) : data && data.totalRecords === 0 ? (
              <EmptyLogState logDir={data.logDir} eventLogPath={data.eventLogPath} />
            ) : data ? (
              <RunListView
                data={data}
                onOpenDetail={(target) => setDetailTarget(target)}
              />
            ) : null}
          </div>
        </div>
    ) : null;

  return (
    <div ref={anchorRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-[10px] uppercase tracking-wide px-2 py-1 rounded bg-ink-800/60 hover:bg-ink-700/60 text-ink-500 border border-ink-700/50 hover:border-ink-600/50 transition"
        title="Developer flight recorder: raw events from logs/current.jsonl"
      >
        ⚙ Debug Log
      </button>
      {dropdownPanel ? createPortal(dropdownPanel, document.body) : null}
    </div>
  );
});

function EmptyLogState({
  logDir,
  eventLogPath,
}: {
  logDir?: string;
  eventLogPath?: string;
}) {
  return (
    <div className="space-y-2.5 text-xs text-ink-400 leading-relaxed">
      <p className="text-ink-200 font-medium">No events recorded yet</p>
      <p>
        Start a run and events append to{" "}
        <code className="font-mono text-[10px] bg-ink-800 px-1 py-0.5 rounded text-ink-300">
          logs/current.jsonl
        </code>
        . This panel shows the raw broadcast stream — live runs appear here before{" "}
        <span className="text-ink-300">Runs</span> has a summary.
      </p>
      {eventLogPath ? (
        <p className="text-[10px] text-ink-500 font-mono break-all">path: {eventLogPath}</p>
      ) : logDir ? (
        <p className="text-[10px] text-ink-500 font-mono break-all">log dir: {logDir}</p>
      ) : null}
    </div>
  );
}

const RUN_LIST_PAGE_SIZE = 5;

function RunListView({
  data,
  onOpenDetail,
}: {
  data: EventLogResponse;
  onOpenDetail: (target: DetailTarget) => void;
}) {
  const [page, setPage] = useState(0);
  const hiddenInfra = data.runs.filter(isInfraOnlySlice).length;
  const display = useMemo(() => {
    const visible = data.runs.filter((r) => !isInfraOnlySlice(r));
    const getTime = (d: DerivedRunState) => d.finishedAt ?? d.startedAt ?? 0;
    return [...visible].sort((a, b) => getTime(b.derived) - getTime(a.derived));
  }, [data.runs]);
  const totalPages = Math.max(1, Math.ceil(display.length / RUN_LIST_PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageStart = safePage * RUN_LIST_PAGE_SIZE;
  const pageItems = display.slice(pageStart, pageStart + RUN_LIST_PAGE_SIZE);

  useEffect(() => {
    setPage(0);
  }, [display.length, data.totalRecords]);

  useEffect(() => {
    if (page > totalPages - 1) setPage(Math.max(0, totalPages - 1));
  }, [page, totalPages]);

  return (
    <>
      <div className="text-[10px] text-ink-500 mb-2 leading-relaxed">
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
          <span className="text-ink-400">{data.totalRecords} log lines</span>
          <span className="text-ink-700">·</span>
          <span className="text-ink-400">
            {display.length} segment{display.length === 1 ? "" : "s"}
          </span>
          {data.malformed > 0 ? (
            <>
              <span className="text-ink-700">·</span>
              <span className="text-amber-400">{data.malformed} malformed</span>
            </>
          ) : null}
          {display.length > RUN_LIST_PAGE_SIZE ? (
            <>
              <span className="ml-auto flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  disabled={safePage === 0}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  className="px-1 py-0 rounded border border-ink-700 bg-ink-800 text-ink-400 hover:text-ink-200 disabled:opacity-40 disabled:hover:text-ink-400"
                >
                  ←
                </button>
                <span className="text-ink-500 tabular-nums whitespace-nowrap">
                  {safePage + 1}/{totalPages}
                </span>
                <button
                  type="button"
                  disabled={safePage >= totalPages - 1}
                  onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                  className="px-1 py-0 rounded border border-ink-700 bg-ink-800 text-ink-400 hover:text-ink-200 disabled:opacity-40 disabled:hover:text-ink-400"
                >
                  →
                </button>
              </span>
            </>
          ) : null}
        </div>
        {hiddenInfra > 0 ? (
          <div className="text-ink-600 mt-0.5">
            {hiddenInfra} boot line{hiddenInfra === 1 ? "" : "s"} hidden
          </div>
        ) : null}
        {data.archivesTotal != null && data.archivesTotal > 0 ? (
          <div className="text-ink-600 mt-0.5">
            {data.perRunDebugCount ?? 0} per-run debug
            {data.archivesTotal
              ? ` · ${data.archivesRead ?? 0}/${data.archivesTotal} archives scanned`
              : ""}
          </div>
        ) : null}
      </div>
      {display.length === 0 ? (
        <div className="text-ink-500 text-sm italic">No activity segments yet.</div>
      ) : (
        <>
          <ul className="space-y-1.5">
            {pageItems.map((r) => (
              <RunRow
                key={`slice-${r.sliceIndex}-${r.derived.runId ?? "x"}`}
                run={r}
                onOpen={
                  canDrillDown(r)
                    ? () =>
                        onOpenDetail({
                          sliceIndex: r.sliceIndex,
                          runId: r.derived.runId,
                        })
                    : undefined
                }
              />
            ))}
          </ul>
          {display.length > RUN_LIST_PAGE_SIZE ? (
            <div className="flex items-center justify-between mt-2 pt-1.5 border-t border-ink-800/80 text-[10px] text-ink-500">
              <button
                type="button"
                disabled={safePage === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                className="px-1.5 py-0.5 rounded border border-ink-700 bg-ink-800 text-ink-400 hover:text-ink-200 disabled:opacity-40"
              >
                ← prev
              </button>
              <span className="tabular-nums">
                {pageStart + 1}–{Math.min(pageStart + RUN_LIST_PAGE_SIZE, display.length)} of{" "}
                {display.length}
              </span>
              <button
                type="button"
                disabled={safePage >= totalPages - 1}
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                className="px-1.5 py-0.5 rounded border border-ink-700 bg-ink-800 text-ink-400 hover:text-ink-200 disabled:opacity-40"
              >
                next →
              </button>
            </div>
          ) : null}
        </>
      )}
    </>
  );
}

function runKindBadge(run: RunSliceSummary, d: DerivedRunState): { label: string; className: string } {
  if (run.isSessionBoundary && !d.runId) {
    return { label: "sess", className: "bg-ink-700 text-ink-400" };
  }
  if (run.isSessionBoundary && d.runId) {
    return { label: "sess·run", className: "bg-amber-900/40 text-amber-300" };
  }
  return { label: "run", className: "bg-emerald-900/50 text-emerald-300" };
}

function runSourceBadge(source: RunSliceSummary["source"]): { label: string; className: string } | null {
  if (source === "per-run-debug") {
    return { label: "debug", className: "text-sky-300 bg-sky-950/40 border-sky-800/50" };
  }
  if (source === "archive-index") {
    return { label: "archive", className: "text-ink-400 bg-ink-900 border-ink-700" };
  }
  if (source === "global") {
    return { label: "live", className: "text-ink-400 bg-ink-900 border-ink-700" };
  }
  return null;
}

function isEmptyGridPlaceholder(value: string | number): boolean {
  const s = String(value).trim();
  return s === "—" || s === "-" || s === "–" || s === "";
}

function RunGridCell({
  label,
  value,
  mono,
  accent,
}: {
  label: string;
  value: string | number;
  mono?: boolean;
  accent?: string;
}) {
  const placeholder = isEmptyGridPlaceholder(value);
  return (
    <div
      className="min-w-0 px-1.5 py-0.5 border-r border-ink-700/40 last:border-r-0 flex items-baseline justify-between gap-1.5 overflow-hidden"
      title={`${label}: ${value}`}
    >
      <span className="text-[8px] uppercase tracking-wide text-ink-600 shrink-0 text-left">{label}</span>
      <span
        className={`text-[10px] truncate tabular-nums min-w-0 text-right shrink ${mono ? "font-mono" : ""} ${
          placeholder ? "text-ink-500 opacity-10" : (accent ?? "text-ink-300")
        }`}
      >
        {value}
      </span>
    </div>
  );
}

const RunRow = memo(function RunRow({
  run,
  onOpen,
}: {
  run: RunSliceSummary;
  onOpen?: () => void;
}) {
  const d = run.derived;
  const phase = displayPhase(d);
  const kind = runKindBadge(run, d);
  const source = runSourceBadge(run.source);
  const topTypes = topEventTypes(d.eventTypeCounts, 4);
  const phaseTrail =
    d.phaseTimeline.length > 1
      ? d.phaseTimeline
          .slice(-6)
          .map((s) => s.phase)
          .join(" › ")
      : null;
  const startedStr = d.startedAt
    ? new Date(d.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "—";
  const finishedStr = d.finishedAt
    ? new Date(d.finishedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "—";
  const todoStr =
    d.todoClaimed > 0 || d.todoFailed > 0 || d.todoReplanned > 0
      ? `${d.todoClaimed}✓ ${d.todoFailed}✗`
      : "—";
  const streamStr =
    d.streamingEndCount > 0 || d.streamingEventCount > 0
      ? `${d.streamingEndCount}/${d.streamingEventCount}Δ`
      : "—";
  const confStr =
    d.lastConformanceScore != null
      ? `${d.lastConformanceScore}${d.lastDriftSimilarity != null ? ` · ${d.lastDriftSimilarity.toFixed(2)}` : ""}`
      : d.conformanceSampleCount > 0
        ? `${d.conformanceSampleCount} smp`
        : "—";
  const alert =
    d.errors.length > 0
      ? `err: ${d.errors[0]}`
      : d.streamAnomalies.length > 0
        ? `${d.streamAnomalies[0].agentId ? `${d.streamAnomalies[0].agentId}: ` : ""}${d.streamAnomalies[0].detail}`
        : null;

  return (
    <li
      className={`rounded border border-ink-700/90 bg-ink-800/50 text-[10px] leading-tight overflow-hidden ${
        onOpen ? "cursor-pointer hover:border-ink-500 hover:bg-ink-800/80 transition" : ""
      }`}
      onClick={onOpen}
      role={onOpen ? "button" : undefined}
      title={onOpen ? "Open event timeline" : undefined}
    >
      <div className="flex items-center gap-1.5 px-2 py-1 border-b border-ink-700/50 min-w-0 bg-ink-900/30">
        <span
          className={`shrink-0 text-[8px] uppercase tracking-wider px-0.5 rounded ${kind.className}`}
        >
          {kind.label}
        </span>
        <span className={`shrink-0 font-mono font-semibold ${phaseColor(phase)}`}>{phase}</span>
        {d.runId ? (
          <span className="font-mono text-ink-300 truncate min-w-0">
            {d.runId.slice(0, 8)}
            {d.runIdInferred ? (
              <span
                className="text-amber-500/80"
                title="run id inferred from event stamps (no run_started in log)"
              >
                ~
              </span>
            ) : null}
          </span>
        ) : (
          <span className="text-ink-500 shrink-0 font-mono">seg {run.sliceIndex}</span>
        )}
        {d.stopReason ? (
          <span className="text-ink-600 truncate min-w-0" title={`stop: ${d.stopReason}`}>
            · {d.stopReason}
          </span>
        ) : null}
        <span className="ml-auto shrink-0 text-ink-500 tabular-nums">{formatDuration(d.durationMs)}</span>
        <span className="shrink-0 text-ink-600 tabular-nums">{startedStr}</span>
        {source ? (
          <span className={`shrink-0 text-[8px] px-0.5 rounded border ${source.className}`}>
            {source.label}
          </span>
        ) : null}
      </div>

      <div className="grid grid-cols-4 border-b border-ink-700/40">
        <RunGridCell label="preset" value={d.preset ?? "—"} mono />
        <RunGridCell label="lines" value={run.recordCount} />
        <RunGridCell label="transcript" value={d.transcriptCount} />
        <RunGridCell label="agent st" value={d.agentStateUpdates} />
        <RunGridCell label="streams" value={streamStr} mono />
        <RunGridCell label="todos" value={todoStr} mono accent={d.todoFailed > 0 ? "text-rose-300" : undefined} />
        <RunGridCell label="shifts" value={d.modelShiftCount || "—"} />
        <RunGridCell label="agents" value={d.agentCount ?? "—"} />
        <RunGridCell label="conform" value={confStr} mono />
        <RunGridCell
          label="cold"
          value={d.coldStartCount > 0 ? `${d.coldStartCount}${d.maxColdStartMs != null ? `/${d.maxColdStartMs}ms` : ""}` : "—"}
        />
        <RunGridCell label="amend" value={d.amendmentCount || "—"} />
        <RunGridCell
          label="summary"
          value={d.hasSummary ? "yes" : "no"}
          accent={d.hasSummary ? "text-emerald-300" : "text-ink-500"}
        />
        <RunGridCell label="started" value={startedStr} mono />
        <RunGridCell label="ended" value={finishedStr} mono />
        <RunGridCell label="brain fb" value={d.brainFallbackCount || "—"} />
        <RunGridCell label="drift smp" value={d.driftSampleCount || "—"} />
      </div>

      {phaseTrail ? (
        <div className="px-2 py-0.5 text-[9px] text-ink-500 border-b border-ink-700/30 truncate" title={phaseTrail}>
          <span className="text-ink-600">phases</span> {phaseTrail}
        </div>
      ) : null}

      {topTypes.length > 0 ? (
        <div className="flex flex-wrap gap-0.5 px-2 py-0.5 border-b border-ink-700/30">
          {topTypes.map(([type, count]) => (
            <span
              key={type}
              className="text-[8px] font-mono px-0.5 rounded bg-ink-900/90 border border-ink-700/70 text-ink-400"
            >
              {type} <span className="text-ink-500">{count}</span>
            </span>
          ))}
        </div>
      ) : null}

      {(d.anomalyFlags.length > 0 || alert) && (
        <div className="flex items-center gap-0.5 px-2 py-0.5 min-w-0 flex-wrap">
          <AnomalyBadges flags={d.anomalyFlags} compact />
          {alert ? (
            <span
              className={`text-[9px] truncate min-w-0 flex-1 ${
                d.errors.length > 0 ? "text-rose-300" : "text-fuchsia-300/90"
              }`}
              title={alert}
            >
              {alert}
            </span>
          ) : null}
        </div>
      )}
    </li>
  );
});

function AnomalyBadges({ flags, compact = false }: { flags: string[]; compact?: boolean }) {
  if (flags.length === 0) return null;
  return (
    <>
      {flags.map((f) => {
        const meta = ANOMALY_FLAG_LABELS[f] ?? {
          label: f,
          color: "text-ink-300 bg-ink-800 border-ink-600",
        };
        return (
          <span
            key={f}
            className={`${compact ? "text-[8px] px-0.5" : "text-[9px] px-1"} py-0 rounded border ${meta.color}`}
          >
            {meta.label}
          </span>
        );
      })}
    </>
  );
}

function RunDetailView({
  detail,
  loading,
  error,
  categoryFilter,
  onCategoryFilter,
  logDir,
  onViewRun,
}: {
  detail: RunDetailResponse | null;
  loading: boolean;
  error: string | null;
  categoryFilter: "all" | EventCategory;
  onCategoryFilter: (c: "all" | EventCategory) => void;
  logDir?: string;
  onViewRun?: (runId: string) => void;
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
        <div className="text-[10px] text-ink-500 mb-1">
          {filteredRecords.length} events
          {categoryFilter !== "all" ? ` (${categoryFilter})` : ""}
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