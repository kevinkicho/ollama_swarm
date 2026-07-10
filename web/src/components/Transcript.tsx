import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from '@tanstack/react-virtual';
import { useSwarm } from "../state/store";
// Transcript renders the full accumulated log. Filtering is client-side and optional ("all" is normal full view).
import { StreamingDock } from "./transcript/StreamingDock";
import { MessageBubble } from "./transcript/MessageBubble";
import { StreamingTranscriptCard } from "./transcript/StreamingTranscriptCard";
import { isActiveSwarmPhase, isTerminalSwarmPhase } from "../lib/swarmPhase";
import { prepareTranscriptForDisplay } from "../state/transcriptDisplayFilter";
import { apiFetch } from "../lib/apiFetch";
import {
  ENABLE_TRANSCRIPT_VIRTUALIZATION,
  VIRTUALIZE_MIN_COUNT,
  VIRTUAL_OVERSCAN,
  VIRTUAL_OVERSCAN_HISTORY,
  VIRTUAL_RANGE_EXTRA,
  VIRTUAL_RANGE_EXTRA_HISTORY,
  VIRTUAL_RANGE_SCROLL_PAD,
  VIRTUAL_RANGE_SCROLL_PAD_HISTORY,
  TRANSCRIPT_ITEM_GAP_PX,
  STREAMING_TIMEOUT_MS,
} from "./transcript/transcriptVirtual";
import {
  filterTranscriptEntries,
  type TranscriptFilterId,
} from "./transcript/transcriptFilter";
import { estimateTranscriptEntrySize } from "./transcript/transcriptEstimateSize";
import { extractTranscriptVirtualRange } from "./transcript/transcriptRangeExtractor";
import { useTranscriptScroll } from "./transcript/useTranscriptScroll";
import { TranscriptFilterBar } from "./transcript/TranscriptFilterBar";

export const Transcript = memo(function Transcript() {
  // Ultra-narrow selectors where possible (perf: avoid re-renders on unrelated store changes).
  // Full transcript needed for list, but others narrowed.
  const transcript = useSwarm((s) => s.transcript);
  const streaming = useSwarm((s) => s.streaming);
  const agents = useSwarm((s) => s.agents);
  const runId = useSwarm((s) => s.runId);
  const phase = useSwarm((s) => s.phase);
  const plainListLatched = useSwarm((s) => s.transcriptPlainListLatched);
  const latchPlainList = useSwarm((s) => s.latchTranscriptPlainList);
  // Full transcript passed from store; UI filter controls visibility.
  const [suggesting, setSuggesting] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const virtualizerRef = useRef<any>(null);
  // For clean auto-bottom: track previous to only follow on *new* content
  const prevLenRef = useRef(0);
  const prevStreamingCountRef = useRef(0);
  const prevStreamingTextLenRef = useRef(0);
  // Phase 10 + transcript normal view: default to "all" so the transcript shows the full unfiltered log.
  const [filter, setFilter] = useState<TranscriptFilterId>("all");

  const ITEM_GAP_PX = TRANSCRIPT_ITEM_GAP_PX;

  const streamingCount = useSwarm((s) => Object.keys(s.streaming).length);
  const streamingMeta = useSwarm((s) => s.streamingMeta);
  const agentActivity = useSwarm((s) => s.agentActivity);
  const streamingTextLen = useSwarm((s) =>
    Object.values(s.streaming).reduce((n, t) => n + t.length, 0),
  );

  // Per-agent streaming timeout
  const clearStreaming = useSwarm((s) => s.clearStreaming);
  useEffect(() => {
    const stuck = Object.entries(streamingMeta).filter(
      ([, m]) => {
        if (m.status === "live" && Date.now() - m.lastTextAt > STREAMING_TIMEOUT_MS) return true;
        if (m.status === "done" && m.endedAt && Date.now() - m.endedAt > STREAMING_TIMEOUT_MS) return true;
        return false;
      },
    );
    if (stuck.length === 0) return;
    for (const [id] of stuck) clearStreaming(id);
  }, [streamingMeta, clearStreaming]);

  // Live vs historical for scroll behavior guards. We keep a ref for closures (RO, RAFs).
  const isLiveActivity = streamingCount > 0 || isActiveSwarmPhase(phase);
  const isTerminalPhase = isTerminalSwarmPhase(phase);
  const isLiveRef = useRef(true);
  const prevFirstEntryIdRef = useRef<string | undefined>(undefined);
  const scrollHeightBeforePrependRef = useRef(0);
  const shouldVirtualizeRef = useRef(true);
  const filteredTranscriptRef = useRef<typeof transcript>([]);
  // Key by entry id (not index) so prepend/reorder at run start doesn't map
  // stale DOM nodes to wrong virtual positions.
  const mountedItemsRef = useRef(new Map<string, HTMLElement>());

  const {
    stickyBottom,
    setStickyBottom,
    jumpLockRef,
    isAtBottomRef,
    userScrollingRef,
    initialSizeSettledRef,
    lastMeasureRef,
    scheduleMeasure,
    scrollContainerToBottom,
    scheduleScrollToEnd,
    onScroll,
    jumpToLatest,
  } = useTranscriptScroll({
    scrollRef,
    virtualizerRef,
    shouldVirtualizeRef,
    filteredTranscriptRef,
    mountedItemsRef,
    isLiveRef,
    prevLenRef,
  });

  // Latch in store (survives remounts / Strict Mode) before paint when live.
  useLayoutEffect(() => {
    if (isLiveActivity) {
      latchPlainList();
    }
  }, [isLiveActivity, latchPlainList]);
  useEffect(() => {
    isLiveRef.current = isLiveActivity;
    // When becoming live (or on fresh data), allow future measurements again.
    if (isLiveActivity) {
      initialSizeSettledRef.current = false;
    }
  }, [isLiveActivity, initialSizeSettledRef]);

  // Filter transcript entries (client-side only; all data is in the store).
  // "all" is the normal full view. "key" etc are optional to cut noise.
  const displayTranscript = useMemo(
    () => prepareTranscriptForDisplay(transcript),
    [transcript],
  );

  const filteredTranscript = useMemo(
    () => filterTranscriptEntries(displayTranscript, filter),
    [displayTranscript, filter],
  );

  filteredTranscriptRef.current = filteredTranscript;
  const shouldVirtualize =
    ENABLE_TRANSCRIPT_VIRTUALIZATION &&
    !plainListLatched &&
    !isLiveActivity &&
    !isTerminalPhase &&
    filteredTranscript.length >= VIRTUALIZE_MIN_COUNT;
  shouldVirtualizeRef.current = shouldVirtualize;
  const virtualOverscan = isLiveActivity ? VIRTUAL_OVERSCAN : VIRTUAL_OVERSCAN_HISTORY;
  const virtualRangeExtra = isLiveActivity ? VIRTUAL_RANGE_EXTRA : VIRTUAL_RANGE_EXTRA_HISTORY;
  const virtualRangeScrollPad = isLiveActivity
    ? VIRTUAL_RANGE_SCROLL_PAD
    : VIRTUAL_RANGE_SCROLL_PAD_HISTORY;

  // RUN-START divider prepends shift indices — drop stale DOM refs and preserve
  // scroll anchor when the user has scrolled up (not pinned to bottom).
  useLayoutEffect(() => {
    const firstId = filteredTranscript[0]?.id;
    const prevFirst = prevFirstEntryIdRef.current;
    const el = scrollRef.current;
    if (prevFirst && firstId && prevFirst !== firstId) {
      mountedItemsRef.current.clear();
      if (
        el &&
        !isAtBottomRef.current &&
        !userScrollingRef.current &&
        scrollHeightBeforePrependRef.current > 0
      ) {
        const delta = el.scrollHeight - scrollHeightBeforePrependRef.current;
        if (delta > 0) el.scrollTop += delta;
      }
    }
    prevFirstEntryIdRef.current = firstId;
    if (el) scrollHeightBeforePrependRef.current = el.scrollHeight;
  }, [filteredTranscript]);

  useEffect(() => {
    scheduleMeasure();
  }, [filteredTranscript.length, filter, scheduleMeasure]);

  // Virtualization for the *entire* filtered transcript list.
  // We virtualize everything uniformly (no more prefix/tail split) to ensure
  // consistent layout, spacing, and measurement for all items.
  // 
  // Analysis of related objects:
  // - useVirtualizer: from @tanstack/react-virtual. We rely on:
  //   - count (full filtered length)
  //   - getItemKey (by stable id to preserve size cache across filters/reorders)
  //   - estimateSize (heuristic per kind + text length; improved over time but still approx)
  //   - overscan (40 — tuned down from 300 to cut DOM churn at run start)
  //   - measureElement (on the inner content div to get accurate rendered height)
  // - makeItemRef + ResizeObserver: attached to each item's content wrapper.
  //   Observes post-mount resizes (e.g. long text wrap, tables in run_finished, collapsibles)
  //   and calls measure() to update virtualizer's size cache. This reduces "stagger"
  //   when items enter view or content settles.
  // - virtualizer.getTotalSize() / getVirtualItems(): drive the relative container height
  //   and absolute positioned items with translateY(start).
  // - The scroll container (below): overflow-auto p-4, contains the virtual div + live streaming UI.
  // - filteredTranscript: derived list; changes on filter or appends trigger re-virtualization.
  // - estimateSize + measure: the core of accurate positioning. Bad estimates cause initial
  //   wrong starts (big gaps or overlaps) until measured. We measure on mount, resize, filter,
  //   scroll, and length changes.
  // - Streaming inline + StreamingDock + endRef: rendered *after* the virtual list in flow.
  //   They affect total scroll height but are "live" additions, not part of the transcript list.
  //   Auto-scroll targets endRef (after everything) when appropriate.
  // Uniform virtualization of the filtered list (no prefix/tail splits).
  // - getScrollElement: passed to virtualizer for scroll measurements.
  //
  // This keeps the list performant for long transcripts while making layout/spacing
  // consistent across filters and appends.

  const getScrollElement = useCallback(() => scrollRef.current, []);
  const getItemKey = useCallback((index: number) => filteredTranscript[index]?.id ?? index, [filteredTranscript]);
  const estimateSize = useCallback(
    (index: number) => estimateTranscriptEntrySize(filteredTranscript[index]),
    [filteredTranscript],
  );

  const virtualizer = useVirtualizer({
    count: filteredTranscript.length,
    getScrollElement,
    getItemKey,
    estimateSize,
    overscan: virtualOverscan,
    // Wider range on historical views prevents "hidden until resize" when estimates drift.
    rangeExtractor: (range) =>
      extractTranscriptVirtualRange(range, {
        listLength: filteredTranscript.length,
        scrollEl: scrollRef.current,
        virtualRangeExtra,
        virtualRangeScrollPad,
      }),
  });
  virtualizerRef.current = virtualizer;

  // Settle sizes after hydration / run-start burst (single coalesced pass).
  useEffect(() => {
    scheduleMeasure();
    const t = setTimeout(scheduleMeasure, 80);
    return () => clearTimeout(t);
  }, [filteredTranscript.length, scheduleMeasure]);

  useEffect(() => {
    scheduleMeasure();
  }, [filter, scheduleMeasure]);

  // One-time post-layout computation of actual atBottom (handles initial top position for
  // finished transcripts + short content cases). Avoids stale initial state/ref.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const compute = () => {
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
      const v2 = virtualizerRef.current;
      const vH = v2 ? v2.getTotalSize() : el.scrollHeight;
      const atMsg = el.scrollTop + el.clientHeight >= vH - 30;
      const atB = dist < 80 || atMsg;
      isAtBottomRef.current = atB;
      if (atB !== stickyBottom) setStickyBottom(atB);
    };
    const raf = requestAnimationFrame(compute);
    // Also after a tick in case virtual totalSize settled
    const t = setTimeout(compute, 120);
    return () => { cancelAnimationFrame(raf); clearTimeout(t); };
  }, []);

  // Per-item ref + ResizeObserver for accurate dynamic sizing.
  // IMPORTANT: On finished/historical views (most common for /runs/:id), we attach NO ResizeObserver.
  // We do a one-time measureElement on first mount of the item. This prevents late size
  // discoveries (from grids, collapsibles, text reflow etc.) from changing totalSize *while the
  // user is manually scrolling or has scrolled*, which was causing the "pushed upward" effect
  // (items above viewport get re-measured → virtual translateY of lower items shift → at fixed
  // scrollTop the viewport shows earlier content).
  const renderEntry = useCallback((e: (typeof filteredTranscript)[number]) => {
    if (e.role === "agent-stream") {
      return <StreamingTranscriptCard entry={e} />;
    }
    return <MessageBubble entry={e} />;
  }, []);

  const makeItemRef = useCallback((vItem: any) => (el: HTMLElement | null) => {
    if (!shouldVirtualizeRef.current) return;
    const entryId = filteredTranscript[vItem.index]?.id ?? `idx-${vItem.index}`;
    if (!el) {
      mountedItemsRef.current.delete(entryId);
      return;
    }
    mountedItemsRef.current.set(entryId, el);
    const already = (el as any)._measured;
    if (!already) {
      virtualizer.measureElement(el);
      (el as any)._measured = true;
    }
    if (!isLiveRef.current) return;
    if (!(el as any)._ro) {
      let roTimer: ReturnType<typeof setTimeout> | null = null;
      const ro = new ResizeObserver(() => {
        if (roTimer) return;
        roTimer = setTimeout(() => {
          roTimer = null;
          scheduleMeasure();
        }, 80);
      });
      ro.observe(el);
      (el as any)._ro = ro;
    }
  }, [virtualizer, filteredTranscript, scheduleMeasure]);

  // Auto-scroll / sticky-bottom logic.
  // 
  // Goals:
  // - If user at bottom on live run, new content auto-follows.
  // - User scroll up disables follow (sticky=false) until they return to bottom.
  // - No auto on finished/historical views at all (free manual scroll only).
  // - All programmatic scrolls use 'auto' (no easing).
  // - "Latest" button always available for explicit jump.
  //
  // Related objects analyzed (updated for full virtualization):
  // - stickyBottom + onScroll (user intent source of truth)
  // - jumpLockRef + jumpToLatest (only for manual button)
  // - endRef / scrollRef (target for full end, after virtual list + live UI)
  // - filteredTranscript.length + streamingCount (content change signals)
  // - phase (to decide "live" vs history viewing)
  // - virtualizer (now counts the full list; scroll via endRef for the overall view bottom)
  // - streaming sweeper / other effects (can cause re-renders but now guarded by prev* refs)
  // - Parent scroll in SwarmView (nested but Transcript owns its scroller)
  //
  // This eliminates repeated scrollIntoView on stable data or idle views.

  useEffect(() => {
    const currentLen = filteredTranscript.length;
    const currentStream = streamingCount;
    const currentStreamTextLen = streamingTextLen;

    const hadNewContent =
      currentLen > prevLenRef.current ||
      currentStream > prevStreamingCountRef.current ||
      currentStreamTextLen > prevStreamingTextLenRef.current;
    if (currentLen === 0) {
      initialSizeSettledRef.current = false;
      mountedItemsRef.current.clear();
    }
    prevLenRef.current = currentLen;
    prevStreamingCountRef.current = currentStream;
    prevStreamingTextLenRef.current = currentStreamTextLen;

    const live = isLiveRef.current;
    if (live || !initialSizeSettledRef.current) {
      const now = Date.now();
      if (now - (lastMeasureRef.current || 0) > 80) {
        lastMeasureRef.current = now;
        scheduleMeasure();
      }
    }

    if (!isAtBottomRef.current || !live || !hadNewContent) return;
    scheduleScrollToEnd();
  }, [filteredTranscript.length, streamingCount, streamingTextLen, scheduleMeasure, scheduleScrollToEnd]);

  // When pinned to bottom, follow any layout growth (streaming bubbles expanding
  // token-by-token, wrapped text reflow, dock height changes) even if entry count
  // is unchanged.
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    let raf: number | null = null;
    const ro = new ResizeObserver(() => {
      if (!isAtBottomRef.current || !isLiveRef.current || userScrollingRef.current || jumpLockRef.current) {
        return;
      }
      if (raf != null) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        raf = null;
        scrollContainerToBottom();
      });
    });
    ro.observe(content);
    return () => {
      ro.disconnect();
      if (raf != null) cancelAnimationFrame(raf);
    };
  }, [scrollContainerToBottom]);

  useLayoutEffect(() => {
    scheduleMeasure();
  }, [filter, scheduleMeasure]);

  // Resize handler + container RO: force re-measure when viewport size changes.
  // Critical for the "hiding until resize" symptom: when browser width changes, wrapped text in system/agent bubbles
  // changes height; without immediate measure the virtual positions stay wrong and items stay out of rendered range.
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const onResize = () => {
      clearTimeout(t);
      t = setTimeout(scheduleMeasure, 100);
    };
    window.addEventListener('resize', onResize);

    // Direct observer on the scroller catches size changes even if window event is delayed or not fired in some embeds.
    const ro = new ResizeObserver(() => scheduleMeasure());
    if (scrollRef.current) ro.observe(scrollRef.current);

    return () => {
      window.removeEventListener('resize', onResize);
      ro.disconnect();
      clearTimeout(t);
    };
  }, [scheduleMeasure]);

  const onSuggest = useCallback(async () => {
    setSuggesting(true);
    try {
      await apiFetch("/api/swarm/brain/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          runId,
          title: "Quick suggestion from transcript",
          text: "Review the current todos/board state and recent transcript. Suggest an amend or next focus area if needed.",
          category: "recommendation",
        }),
      });
      setTimeout(() => setSuggesting(false), 1200);
    } catch {
      setSuggesting(false);
    }
  }, [runId]);

  return (
    <div className="h-full flex flex-col relative">
      <TranscriptFilterBar
        filter={filter}
        onFilterChange={setFilter}
        filteredCount={filteredTranscript.length}
        totalCount={transcript.length}
        runId={runId}
        phase={phase}
        suggesting={suggesting}
        onSuggest={onSuggest}
      />

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 min-h-0 overflow-y-auto p-1 bg-ink-900 transcript-scroll"
      >
        <div ref={contentRef}>
        {transcript.length === 0 && streamingCount === 0 && phase !== "completed" && phase !== "stopped" && phase !== "failed" ? (
          <div className="text-ink-400 text-sm">Waiting for agents…</div>
        ) : null}

        {/* Fully virtualized list of transcript entries (uniform, no prefix/tail split).
           All items use the same rendering path for consistent spacing.
           The paddingBottom (ITEM_GAP_PX) on the measured inner wrapper provides the
           sole inter-item gap for predictable heights across filters. 6px for subtle comfortable separation.
           - estimateSize (heuristic) + measureElement + per-item ResizeObserver
             keep the virtualizer's size cache accurate for variable bubble heights.
           - Live UI (inline streams + StreamingDock) is rendered after the virtual
             container; endRef after that is the "true bottom" target for auto-scroll. */}
        {shouldVirtualize ? (
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: "100%",
              position: "relative",
            }}
          >
            {virtualizer.getVirtualItems().map((virtualItem) => {
              const e = filteredTranscript[virtualItem.index];
              if (!e) return null;
              return (
                <div
                  key={e.id}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${virtualItem.start}px)`,
                  }}
                >
                  <div
                    ref={makeItemRef(virtualItem)}
                    data-index={virtualItem.index}
                    className="virtual-item"
                    style={{
                      margin: 0,
                      paddingBottom: `${ITEM_GAP_PX}px`,
                      boxSizing: "border-box",
                      contain: "layout style",
                      minHeight: "20px",
                    }}
                  >
                    {renderEntry(e)}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="transcript-plain-list">
            {filteredTranscript.map((e) => (
              <div
                key={e.id}
                className="virtual-item"
                style={{
                  margin: 0,
                  paddingBottom: `${ITEM_GAP_PX}px`,
                  boxSizing: "border-box",
                }}
              >
                {renderEntry(e)}
              </div>
            ))}
          </div>
        )}

        {/* Task #173: per-agent streaming dock with collapse-by-default
            + smooth fade-out on completion. The authoritative live UI.
            Removed previous duplicate inline map (tiny divs) that contributed to jitter/growth during massive streaming. */}
        <StreamingDock
          streaming={streaming}
          streamingMeta={streamingMeta}
          agents={agents}
          agentActivity={agentActivity}
        />

        {/* Anchor after streaming dock so scroll targets the true bottom. */}
        <div ref={endRef} aria-hidden="true" />
        </div>
      </div>
      {!stickyBottom ? (
        <button
          onClick={jumpToLatest}
          aria-label="Jump to latest"
          className="absolute bottom-4 right-4 z-10 px-3 py-2 rounded-full bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold shadow-lg shadow-black/50 flex items-center gap-1"
        >
          <span>↓</span>
          <span>Latest</span>
        </button>
      ) : null}
    </div>
  );
});

