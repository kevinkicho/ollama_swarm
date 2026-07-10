// Debug Log — developer flight recorder over logs/current.jsonl.
// Rich derived cards + per-run event timeline drill-down.

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { useTopbarDropdown } from "../../lib/topbarDropdown";
import { normalizeDerived, type EventCategory } from "../../lib/eventLogUi";
import { apiFetch } from "../../lib/apiFetch";
import { EmptyLogState } from "./EmptyLogState";
import { RunDetailView } from "./RunDetailView";
import { RunListView } from "./RunListView";
import type { DetailTarget, EventLogResponse, RunDetailResponse } from "./types";

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
    apiFetch("/api/v2/event-log/runs", { signal: ctrl.signal })
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
    apiFetch(url, { signal: ctrl.signal })
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
