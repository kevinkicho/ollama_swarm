import { memo, useEffect, useMemo, useState } from "react";
import {
  formatDuration,
  isInfraOnlySlice,
  topEventTypes,
  type DerivedRunState,
} from "../../lib/eventLogUi";
import { AnomalyBadges } from "./AnomalyBadges";
import {
  canDrillDown,
  displayPhase,
  isEmptyGridPlaceholder,
  phaseColor,
  runKindBadge,
  runSourceBadge,
} from "./format";
import type { DetailTarget, EventLogResponse, RunSliceSummary } from "./types";

const RUN_LIST_PAGE_SIZE = 5;

export function RunListView({
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
            {typeof data.total === "number" && data.total > display.length
              ? ` (of ${data.total})`
              : ""}
          </span>
          {data.hasMore ? (
            <>
              <span className="text-ink-700">·</span>
              <span className="text-amber-400/90" title="Server returned a limited page; refresh loads the latest window">
                more on server
              </span>
            </>
          ) : null}
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
