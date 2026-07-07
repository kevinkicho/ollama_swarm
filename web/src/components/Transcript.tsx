import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from '@tanstack/react-virtual';
import { useSwarm } from "../state/store";
// Transcript renders the full accumulated log. Filtering is client-side and optional ("all" is normal full view).
import { StreamingDock } from "./transcript/StreamingDock";
import { MessageBubble } from "./transcript/MessageBubble";
import { StreamingTranscriptCard } from "./transcript/StreamingTranscriptCard";
import { isActiveSwarmPhase, isTerminalSwarmPhase } from "../lib/swarmPhase";

/** Virtualization disabled — estimate drift caused hidden rows and wide gaps on stop. */
const ENABLE_TRANSCRIPT_VIRTUALIZATION = false;
const VIRTUALIZE_MIN_COUNT = 500;
const VIRTUAL_OVERSCAN = 40;
const VIRTUAL_OVERSCAN_HISTORY = 200;
const VIRTUAL_RANGE_EXTRA = 80;
const VIRTUAL_RANGE_EXTRA_HISTORY = 200;
const VIRTUAL_RANGE_SCROLL_PAD = 80;
const VIRTUAL_RANGE_SCROLL_PAD_HISTORY = 150;
const VIRTUAL_TOP_MEASURE_COUNT = 12;

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
  const virtualizerRef = useRef<any>(null);
  // For clean auto-bottom: track previous to only follow on *new* content
  const prevLenRef = useRef(0);
  const prevStreamingCountRef = useRef(0);
  const [stickyBottom, setStickyBottom] = useState(false);
  // Phase 10 + transcript normal view: default to "all" so the transcript shows the full unfiltered log
  // (planning + execution content, system messages, agent output, brain activity, etc.) like a normal chat.
  // "key" is still available via the bar for users who want high-signal only (avoids bombardment).
  // No more default "key" guard that hid most activity on live runs (including planning chatter).
  const [filter, setFilter] = useState<"all" | "key" | "system" | "agents" | "audit" | "issues">("all");

  // Single source for inter-item gap (used only in virtual wrapper for stability).
  // All child components must not introduce their own outer vertical margins.
  // Small consistent 6px gap for comfortable readability without feeling cramped or "massive".
  const ITEM_GAP_PX = 6;

  const streamingCount = useSwarm((s) => Object.keys(s.streaming).length);
  const streamingMeta = useSwarm((s) => s.streamingMeta);

  // Per-agent streaming timeout
  const clearStreaming = useSwarm((s) => s.clearStreaming);
  const STREAMING_TIMEOUT_MS = 90_000;
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
  }, [isLiveActivity]);

  // Track scroll position to flip sticky-bottom on/off.
  // jumpLock prevents onScroll from overriding stickyBottom right after
  // jumpToLatest() — even with instant 'auto' scroll, some events may fire;
  // the lock avoids incorrectly flipping sticky off during the jump.
  const jumpLockRef = useRef(false);
  // Start false: for historical/finished /runs/:id views we land at top and want free manual scroll.
  // onScroll will set correctly; live views will follow on new content when appropriate.
  const isAtBottomRef = useRef(false);
  const scrollEndTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevTotalSizeRef = useRef(0);
  const userScrollingRef = useRef(false);
  const userScrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isLiveRef = useRef(true);
  const initialSizeSettledRef = useRef(false);
  const lastMeasureRef = useRef(0);
  const measureRafRef = useRef<number | null>(null);
  const scrollRafRef = useRef<number | null>(null);
  const lastScrollAtRef = useRef(0);
  const prevFirstEntryIdRef = useRef<string | undefined>(undefined);
  const scrollHeightBeforePrependRef = useRef(0);
  const shouldVirtualizeRef = useRef(true);
  const filteredTranscriptRef = useRef<typeof transcript>([]);
  // Key by entry id (not index) so prepend/reorder at run start doesn't map
  // stale DOM nodes to wrong virtual positions.
  const mountedItemsRef = useRef(new Map<string, HTMLElement>());

  const scheduleMeasure = useCallback(() => {
    if (!shouldVirtualizeRef.current) return;
    if (measureRafRef.current != null) return;
    measureRafRef.current = requestAnimationFrame(() => {
      measureRafRef.current = null;
      const v = virtualizerRef.current;
      if (!v) return;
      const oldTotal = prevTotalSizeRef.current;
      mountedItemsRef.current.forEach((el) => {
        if (el.isConnected) {
          try { v.measureElement(el); } catch {}
        }
      });
      // Re-measure leading items so RUN-START / early pipeline lines don't drift
      // cumulative starts and push later items out of the rendered virtual range.
      const list = filteredTranscriptRef.current;
      const topN = Math.min(VIRTUAL_TOP_MEASURE_COUNT, list.length);
      for (let i = 0; i < topN; i++) {
        const entryId = list[i]?.id ?? `idx-${i}`;
        const el = mountedItemsRef.current.get(entryId);
        if (el?.isConnected) {
          try { v.measureElement(el); } catch {}
        }
      }
      v.measure();
      const newTotal = v.getTotalSize();
      const el = scrollRef.current;
      if (
        el && isLiveRef.current && !isAtBottomRef.current &&
        !userScrollingRef.current && oldTotal > 0 && newTotal < oldTotal
      ) {
        el.scrollTop = Math.max(0, el.scrollTop - (oldTotal - newTotal));
      }
      prevTotalSizeRef.current = newTotal;
      if (!isLiveRef.current && prevLenRef.current > 0) {
        initialSizeSettledRef.current = true;
      }
    });
  }, []);

  const scheduleScrollToEnd = useCallback(() => {
    const now = Date.now();
    if (now - lastScrollAtRef.current < 150) return;
    if (scrollRafRef.current != null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      lastScrollAtRef.current = Date.now();
      endRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
    });
  }, []);

  // compensateOrReanchor removed: all scroll compensation now inlined with live guards only.
  // For finished/historical transcripts we avoid ANY programmatic scrollTop changes or scrollIntoView
  // except explicit user "Latest" click. This eliminates autonomous upward push.

  const onScroll = () => {
    if (jumpLockRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const v = virtualizerRef.current;
    const virtualH = v ? v.getTotalSize() : el.scrollHeight;
    // Robust: at end of messages (virtualH) or full bottom.
    const atMessagesBottom = el.scrollTop + el.clientHeight >= virtualH - 30;
    const atBottom = distanceFromBottom < 80 || atMessagesBottom;
    isAtBottomRef.current = atBottom;

    // Track active user scrolling to skip compensation during gesture.
    userScrollingRef.current = true;
    if (userScrollTimeoutRef.current) clearTimeout(userScrollTimeoutRef.current);
    userScrollTimeoutRef.current = setTimeout(() => {
      userScrollingRef.current = false;
    }, 200);

    // Once the user starts interacting with scroll on a historical transcript, freeze sizes
    // forever for this view (prevents any stray measure from later bubbling up and pushing).
    if (!isLiveRef.current) {
      initialSizeSettledRef.current = true;
    }

    // Debounce the stickyBottom state update (used only for the "Latest" button)
    // Higher debounce on historical to reduce re-renders while user is dragging/wheeling.
    if (atBottom !== stickyBottom) {
      if (scrollEndTimerRef.current) clearTimeout(scrollEndTimerRef.current);
      const delay = isLiveRef.current ? 120 : 220;
      scrollEndTimerRef.current = setTimeout(() => {
        setStickyBottom(atBottom);
      }, delay);
    }

    // No measure() here — let measureElement + targeted measures handle sizing.
  };

  const jumpToLatest = () => {
    jumpLockRef.current = true;
    isAtBottomRef.current = true;
    setStickyBottom(true);
    const el = scrollRef.current;
    // Force to end of transcript messages (endRef now right after virtual list).
    if (el) {
      endRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
      requestAnimationFrame(() => {
        if (el) {
          el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
        }
        // Explicitly enable sticky after jump, even if no scroll event.
        isAtBottomRef.current = true;
        setStickyBottom(true);
      });
    }

    if (!isLiveRef.current) {
      userScrollingRef.current = true;
      initialSizeSettledRef.current = true;
      setTimeout(() => {
        userScrollingRef.current = false;
      }, 350);
    }

    setTimeout(() => { jumpLockRef.current = false; }, 50);
  };

  // Filter transcript entries (client-side only; all data is in the store).
  // "all" is the normal full view. "key" etc are optional to cut noise.
  const filteredTranscript = useMemo(() => transcript.filter((e) => {
    if (filter === "all") return true;
    if (filter === "system") return e.role === "system";
    if (filter === "agents") {
      // Transcript UI fix: hide "Worker skip" noise from the Agents view.
      // Skips are low-signal (usually "already present / no change") and were
      // flooding the transcript. They can still be seen under "All".
      if (e.summary?.kind === "worker_skip") return false;
      return e.role === "agent" || e.role === "agent-stream";
    }
    if (filter === "audit") {
      const text = e.text || "";
      return text.includes("audit") || text.includes("Audit") || text.includes("Gate");
    }
    if (filter === "issues") {
      const text = e.text || "";
      return text.includes("CONTRADICTION") || text.includes("PARTIAL") || text.includes("error") || text.includes("failed");
    }
    if (filter === "key") {
      // High-signal only (optional): synthesis, verdicts, run events, hunks, web results, major board actions.
      const k = e.summary?.kind;
      if (k === "worker_skip") return false;
      const text = (e.text || "").toLowerCase();
      const isKey = ["council_synthesis", "mapreduce_synthesis", "role_diff_synthesis", "stigmergy_report", "debate_verdict", "run_finished", "deliverable", "stretch_goals", "worker_hunks", "contract", "goals", "seed_announce", "agents_ready", "run_start"].includes(k || "") ||
        text.includes("synthesis") || text.includes("verdict") || text.includes("web_search") || text.includes("web_fetch") ||
        text.includes("findings") || text.includes("deliverable") || (k === "verifier_verdict");
      if (isKey) return true;
      // For "key" (optional reduced view): system messages with certain keywords + long streams + known key kinds.
      if (e.role === "system") {
        return text.includes("resuming") || text.includes("ready") || text.includes("seed") || text.includes("goal-generation") ||
          text.includes("contract") || text.includes("planner") || text.includes("memory") || text.includes("design memory") ||
          text.includes("directive") || text.includes("halted") || text.includes("failed") || text.includes("finished") ||
          text.includes("pipeline") || text.includes("council") || text.includes("blackboard") || text.includes("agents ready");
      }
      if (e.role === "agent-stream" && (e.text || "").length > 80) return true;
      return false;
    }
    return true;
  }), [transcript, filter]);

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
  const estimateSize = useCallback((index: number) => {
    const e = filteredTranscript[index];
    if (!e) return 80;
    // Over-estimate more aggressively to avoid initial under-placement that causes
    // overlap/stagger (items placed too high, stacking on previous). Measure will tighten.
    // This reduces "completely stacked" and subsequent jitter from fixes.
    // Gaps appear "massive" if under; over + measure keeps tight after settle.
    if (e.role === "agent-stream") {
      const tlen = (e.text || '').length;
      const lines = Math.max(4, Math.ceil(tlen / 24));
      return 100 + lines * 18 + (tlen > 1000 ? 500 : 0) + (tlen > 3000 ? 800 : 0) + (tlen > 6000 ? 1100 : 0);
    }
    const kind = e.summary?.kind || '';
    if (e.text && e.text.startsWith('▸▸RUN-START▸▸')) {
      // The rich divider renders multiple lines (New run + meta row + models + repo).
      // Over-estimate a bit so following items don't get shifted into wrong virtual range (wide gaps).
      return 140;
    }
    if (kind === "agents_ready") {
      // Agents ready can be small (closed) or tall (details table open). Over-estimate to avoid hiding/stagger.
      const n = (e.summary as any)?.agents?.length ?? 5;
      return 120 + n * 30;
    }
    if (kind === "worker_hunks") {
      // Hunks can be very tall when diffs shown; over-estimate to prevent overlap.
      const numHunks = (e.summary as any)?.hunks?.length ?? 3;
      return 400 + numHunks * 220;
    }
    if (kind.includes("synthesis") || kind === "stretch_goals") return 350;
    if (kind === "deliverable") return 280;
    if (kind === "run_finished") {
      const n = (e.summary as any)?.agents?.length ?? 4;
      const hasExtra = !!(e.summary as any)?.totalPromptTokens || !!(e.summary as any)?.totalResponseTokens;
      return 850 + n * 45 + (hasExtra ? 100 : 0);
    }
    if (kind === "seed_announce") {
      const count = (e.summary as any)?.topLevel?.length ?? 12;
      return 320 + Math.min(count, 12) * 32;
    }
    if (kind === ("run_start" as any)) return 220;

    const textLen = (e.text || '').length;
    if (textLen > 0) {
      // Special tight estimate for system messages (the ones the user sees "hiding" in blanks:
      // "5/5 agents ready...", "deriving tier 1 contract from directive...", pipeline details, etc.).
      // These use very compact styling: border-l + py-0.5 + text-[11px] mono + small header.
      // A long line typically renders as 2-4 lines tall (~30-60px).
      // Using full or high estimate causes cumulative start positions to be wrong for following items,
      // pushing them out of the rendered virtual range (they never get into the DOM = "hiding" / blanks).
      // Resize triggers re-calc + measure, revealing them temporarily.
      // Conservative small estimate here + immediate measure() keeps positions accurate and items drawn.
      if (e.role === 'system') {
        // Slightly more generous for system to avoid under-estimate causing stagger/overlap on long wrapped lines.
        // RUN-START divider and short [Pipeline] lines are ~1-3 lines; give headroom so following items' positions
        // don't start too low (source of "wide gaps" where content exists but virtual items are placed off-range).
        const approxLines = Math.min(6, Math.max(1, Math.ceil(textLen / 38)));
        return 36 + approxLines * 15;
      }
      const lines = Math.max(2, Math.ceil(textLen / 22));
      const base = 55;
      let size = base + lines * 18;
      if (e.thoughts && e.thoughts.length > 0) size += 40;
      if (e.toolCalls && e.toolCalls.length > 0) size += 40;
      if (textLen > 800) size += 200;
      if (textLen > 2500) size += 400;
      if (textLen > 5000) size += 700;
      return size;
    }
    return 70;
  }, [filteredTranscript]);

  const virtualizer = useVirtualizer({
    count: filteredTranscript.length,
    getScrollElement,
    getItemKey,
    estimateSize,
    overscan: virtualOverscan,
    // Wider range on historical views prevents "hidden until resize" when estimates drift.
    // Live runs use the plain list (shouldVirtualize=false) so these values rarely apply live.
    rangeExtractor: (range) => {
      let start = Math.max(0, range.startIndex - virtualRangeExtra);
      let end = Math.min(filteredTranscript.length - 1, range.endIndex + virtualRangeExtra);

      const sc = scrollRef.current;
      const avg = 42;
      if (sc) {
        const approxStart = Math.max(0, Math.floor(sc.scrollTop / avg) - virtualRangeScrollPad);
        const approxEnd = Math.min(
          filteredTranscript.length - 1,
          Math.floor((sc.scrollTop + sc.clientHeight) / avg) + virtualRangeScrollPad,
        );
        start = Math.min(start, approxStart);
        end = Math.max(end, approxEnd);
      }

      if (sc && sc.scrollTop < 400) {
        start = 0;
      }

      const tail = Math.max(0, filteredTranscript.length - virtualRangeExtra);
      start = Math.min(start, tail);
      end = Math.max(end, filteredTranscript.length - 1);

      return Array.from({ length: end - start + 1 }, (_, i) => start + i);
    },
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

    const hadNewContent = currentLen > prevLenRef.current || currentStream > prevStreamingCountRef.current;
    if (currentLen === 0) {
      initialSizeSettledRef.current = false;
      mountedItemsRef.current.clear();
    }
    prevLenRef.current = currentLen;
    prevStreamingCountRef.current = currentStream;

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
  }, [filteredTranscript.length, streamingCount, scheduleMeasure, scheduleScrollToEnd]);

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

  return (
    <div className="h-full flex flex-col relative">
      {/* Filter bar — fixed, never scrolls */}
      <div className="flex items-center gap-2 px-4 py-2 bg-ink-800/50 border-b border-ink-700/50 shrink-0">
        <span className="text-[10px] text-ink-500">Filter:</span>
        {(["all", "key", "system", "agents", "audit", "issues"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-2 py-0.5 text-[10px] rounded ${
              filter === f
                ? "bg-ink-600 text-ink-200"
                : "text-ink-400 hover:text-ink-200 hover:bg-ink-700"
            }`}
            title={f === "key" ? "Optional: high-signal items only" : undefined}
          >
            {f === "key" ? "Key" : f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
        <span className="text-[10px] text-ink-500 ml-auto">
          {filteredTranscript.length} / {transcript.length} entries
        </span>
        {runId && phase !== "completed" && phase !== "stopped" && phase !== "failed" && (
          <button
            onClick={async () => {
              setSuggesting(true);
              try {
                const res = await fetch("/api/swarm/brain/suggest", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    runId,
                    title: "Quick suggestion from transcript",
                    text: "Review the current todos/board state and recent transcript. Suggest an amend or next focus area if needed.",
                    category: "recommendation",
                  }),
                });
                // Success is indicated by the injected transcript entry appearing (via WS)
                // We just reset after a short delay for UX.
                setTimeout(() => setSuggesting(false), 1200);
              } catch {
                setSuggesting(false);
              }
            }}
            disabled={suggesting}
            className="ml-2 px-1.5 py-px text-[9px] rounded bg-amber-800/50 hover:bg-amber-700/70 text-amber-200 border border-amber-800/60 disabled:opacity-50"
            title="Ask Brain for a proactive suggestion (injects a special 🧠 Brain suggestion entry into the live transcript)"
          >
            {suggesting ? "💡 suggesting…" : "💡 suggest"}
          </button>
        )}
      </div>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 min-h-0 overflow-y-auto p-1 bg-ink-900 transcript-scroll"
      >
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

        <div ref={endRef} />

        {/* Task #173: per-agent streaming dock with collapse-by-default
            + smooth fade-out on completion. The authoritative live UI.
            Removed previous duplicate inline map (tiny divs) that contributed to jitter/growth during massive streaming. */}
        <StreamingDock
          streaming={streaming}
          streamingMeta={streamingMeta}
          agents={agents}
        />
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

