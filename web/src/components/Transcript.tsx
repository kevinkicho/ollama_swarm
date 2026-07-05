import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from '@tanstack/react-virtual';
import { useSwarm } from "../state/store";
import { StreamingDock } from "./transcript/StreamingDock";
import { MessageBubble } from "./transcript/MessageBubble";
import { StreamingTranscriptCard } from "./transcript/StreamingTranscriptCard";

export const Transcript = memo(function Transcript() {
  // Ultra-narrow selectors where possible (perf: avoid re-renders on unrelated store changes).
  // Full transcript needed for list, but others narrowed.
  const transcript = useSwarm((s) => s.transcript);
  const streaming = useSwarm((s) => s.streaming);
  const agents = useSwarm((s) => s.agents);
  const runId = useSwarm((s) => s.runId);
  const phase = useSwarm((s) => s.phase);
  const cfgForHybrid = useSwarm((s) => s.runConfig);
  const allTx = [...(transcript || []), ...(((useSwarm.getState().summary as any)?.transcript) || [])];
  const transcriptHasHybridMarker = allTx.some((e: any) => {
    const t = String(e?.text || e || "");
    return /council\s*→\s*blackboard/i.test(t) || (/council/i.test(t) && /blackboard/i.test(t) && /phase/i.test(t));
  });
  const isHybrid = !!(cfgForHybrid?.useHybridPlanning || cfgForHybrid?.planningPreset || (cfgForHybrid as any)?.pipeline || transcriptHasHybridMarker);
  const [suggesting, setSuggesting] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizerRef = useRef<any>(null);
  // For clean auto-bottom: track previous to only follow on *new* content
  const prevLenRef = useRef(0);
  const prevStreamingCountRef = useRef(0);
  const [stickyBottom, setStickyBottom] = useState(false);
  const [filter, setFilter] = useState<"all" | "key" | "system" | "agents" | "audit" | "issues">(() => {
    // Initial: for review/finished (terminal phase or summary with stopReason), default to "all" so review views and finished transcripts are not empty.
    const st = useSwarm.getState();
    const terminal = st.phase === "completed" || st.phase === "stopped" || st.phase === "failed" || !!st.summary?.stopReason;
    return terminal ? "all" : "key";
  });
  // Auto switch to "all" if it becomes terminal later (e.g. live run finishes while viewing).
  useEffect(() => {
    const terminal = phase === "completed" || phase === "stopped" || phase === "failed" || !!useSwarm.getState().summary?.stopReason;
    if (terminal && filter === "key") {
      setFilter("all");
    }
  }, [phase]);

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
  const isLiveActivity = streamingCount > 0 || (phase !== 'idle' && phase !== 'stopped' && phase !== 'completed' && phase !== 'failed');
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
  // Track all mounted item elements so we can force re-measure on updates/resize
  // to ensure no items stay "hidden" due to stale estimates. This helps with
  // the "not drawn until resize" symptom.
  const mountedItemsRef = useRef(new Map<number, HTMLElement>());

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

  // Filter transcript entries.
  // Stability note (Phase 4): "key" filter selects mostly high-signal structured entries
  // (synthesis, run_finished, deliverable, etc.) which have taller fixed estimates.
  // Result: lower item count but higher average height per item vs "all".
  // Combined with kind-specific estimates + one-time measures on filter, this keeps
  // virtual layout solid without pop or stagger on toggle.
  const filteredTranscript = useMemo(() => transcript.filter((e) => {
    // For hybrid runs (moa/council planning + exec), suppress brain (index 0) and any agent-0
    // bubbles that leak from planning sub-phases. Sidebar already filters these; transcript should too
    // so user never sees "agent 0".
    if (isHybrid) {
      const idx = (e as any).agentIndex ?? (e as any).index ?? (e as any).agent?.index;
      const aid = (e as any).agentId || (e as any).id || '';
      if (idx === 0 || aid === 'brain' || /^agent-0$/.test(String(aid))) return false;
    }
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
      // High-signal only: synthesis, verdicts, run events, hunks (high level), web results, major board actions.
      // Also include blackboard early progress and system housekeeping for visibility.
      const k = e.summary?.kind;
      // Transcript UI fix: explicitly drop worker_skip (repetitive "already present" etc.)
      // from the clean "key" view. These were polluting the transcript even on non-"all" filters.
      if (k === "worker_skip") return false;
      const text = (e.text || "").toLowerCase();
      const isKey = ["council_synthesis", "mapreduce_synthesis", "role_diff_synthesis", "stigmergy_report", "debate_verdict", "run_finished", "deliverable", "stretch_goals", "worker_hunks", "contract", "goals", "seed_announce", "agents_ready", "run_start"].includes(k || "") ||
        text.includes("synthesis") || text.includes("verdict") || text.includes("web_search") || text.includes("web_fetch") ||
        text.includes("findings") || text.includes("deliverable") || (k === "verifier_verdict");
      if (isKey) return true;
      // Include key blackboard startup and progress system messages even in "key" filter
      if (e.role === "system") {
        return text.includes("resuming") || text.includes("ready") || text.includes("seed") || text.includes("goal-generation") ||
          text.includes("contract") || text.includes("planner") || text.includes("memory") || text.includes("design memory") ||
          text.includes("directive") || text.includes("halted") || text.includes("failed") || text.includes("finished") ||
          text.includes("pipeline") || text.includes("council") || text.includes("blackboard") || text.includes("agents ready");
      }
      // Keep substantial agent-stream entries (the persisted streamed plan/hunk outputs) visible even in "key" so they
      // do not disappear after streaming_end when live dock clears. Long outputs from council planning or blackboard execution are high signal.
      if (e.role === "agent-stream" && (e.text || "").length > 80) return true;
      return false;
    }
    return true;
  }), [transcript, filter]);

  // Virtualization for the *entire* filtered transcript list.
  // We virtualize everything uniformly (no more prefix/tail split) to ensure
  // consistent layout, spacing, and measurement for all items.
  // 
  // Analysis of related objects:
  // - useVirtualizer: from @tanstack/react-virtual. We rely on:
  //   - count (full filtered length)
  //   - getItemKey (by stable id to preserve size cache across filters/reorders)
  //   - estimateSize (heuristic per kind + text length; improved over time but still approx)
  //   - overscan (50 for pre-measuring upcoming items)
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
  // - Why no tail split anymore: The previous hybrid (virtual prefix + flow tail for last 20)
  //   led to inconsistent rendering paths (absolute vs flow), height mismatches when
  //   virtual sizes updated, and contributed to spacing changes and "movement".
  //   Uniform virtual + good measurement + step 1 scroll logic should suffice.
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
        const approxLines = Math.min(8, Math.max(1, Math.ceil(textLen / 45)));
        return 30 + approxLines * 14;
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
    overscan: 150,
    // Force a much wider render range around the current view.
    // This guarantees that items whose positions are temporarily off (due to estimate variance on dynamic content)
    // are still rendered in the DOM instead of being culled as "offscreen".
    // Combined with the direct measure calls, this stops messages from "hiding" in blanks until a resize.
    rangeExtractor: (range) => {
      // Aggressively include items around the computed range + around the actual scroll position (using rough avg size)
      // + last N items. This guarantees "in between" messages get their DOM nodes created and measured,
      // even if estimates are temporarily wrong (causing library range to miss them).
      // This is the main fix for "not drawn until resize" (resize changes scroll/client dims, forcing re-calc that includes them).
      const extra = 200;
      let start = Math.max(0, range.startIndex - extra);
      let end = Math.min(filteredTranscript.length - 1, range.endIndex + extra);

      // Approximate visible indices from current scroll (to catch cases where estimate error made the library's range wrong).
      const sc = scrollRef.current;
      const avg = 50; // rough avg item height
      if (sc) {
        const approxStart = Math.max(0, Math.floor(sc.scrollTop / avg) - 100);
        const approxEnd = Math.min(filteredTranscript.length - 1, Math.floor((sc.scrollTop + sc.clientHeight) / avg) + 100);
        start = Math.min(start, approxStart);
        end = Math.max(end, approxEnd);
      }

      // Always include the most recent items (live chat growth, new system messages, hunks).
      const tail = Math.max(0, filteredTranscript.length - 50);
      start = Math.min(start, tail);
      end = Math.max(end, filteredTranscript.length - 1);

      return Array.from({ length: end - start + 1 }, (_, i) => start + i);
    },
  });
  virtualizerRef.current = virtualizer;

  // Force early measurement on mount (and after hydration populates) to get accurate sizes quickly.
  // For historical/finished runs we want this to happen *before* or while the user starts scrolling,
  // and then we freeze (see initialSizeSettledRef + guards in other effects).
  // No scrollTop writes here.
  useEffect(() => {
    const v = virtualizerRef.current;
    if (!v) return;

    const doMeasure = () => {
      v.measure();
      prevTotalSizeRef.current = v.getTotalSize();
    };

    requestAnimationFrame(doMeasure);
    // Multiple passes + force on any already-mounted items (in case of dynamic appends during initial load).
    const t1 = setTimeout(() => {
      doMeasure();
      mountedItemsRef.current.forEach((el) => virtualizer.measureElement(el));
    }, 80);
    const t2 = setTimeout(() => {
      doMeasure();
      mountedItemsRef.current.forEach((el) => virtualizer.measureElement(el));
    }, 220);
    const t3 = setTimeout(() => {
      doMeasure();
      mountedItemsRef.current.forEach((el) => virtualizer.measureElement(el));
    }, 480);

    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
  }, []);

  // Re-measure when filter changes (different subset of items with potentially different
  // height profiles; prevents stale size cache causing gaps or staggered layout in agents/key filters).
  useEffect(() => {
    const v = virtualizerRef.current;
    if (v) {
      requestAnimationFrame(() => v.measure());
      mountedItemsRef.current.forEach((el) => v.measureElement(el));
      // Re-measure twice for filter (different items may have very different heights).
      setTimeout(() => {
        v.measure();
        mountedItemsRef.current.forEach((el) => v.measureElement(el));
      }, 50);
    }
  }, [filter]);

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
  const makeItemRef = useCallback((vItem: any) => (el: HTMLElement | null) => {
    if (!el) {
      mountedItemsRef.current.delete(vItem.index);
      return;
    }
    mountedItemsRef.current.set(vItem.index, el);
    // For historical: measureElement only the first time this item mounts.
    // Repeated calls on re-renders (caused by sticky state, etc.) would otherwise keep
    // updating the size cache and potentially shifting positions of other virtual items.
    const already = (el as any)._measured;
    if (!already) {
      virtualizer.measureElement(el);
      (el as any)._measured = true;
    }
    // Only attach live observers for active runs.
    if (!isLiveRef.current) return;
    if (!(el as any)._ro) {
      const ro = new ResizeObserver(() => {
        const v = virtualizerRef.current;
        if (v) {
          const oldTotal = prevTotalSizeRef.current;
          requestAnimationFrame(() => {
            v.measure();
            const newTotal = v.getTotalSize();
            const sc = scrollRef.current;
            if (sc && isLiveRef.current && !isAtBottomRef.current && !userScrollingRef.current && oldTotal > 0 && newTotal < oldTotal) {
              const delta = oldTotal - newTotal;
              sc.scrollTop = Math.max(0, sc.scrollTop - delta);
            }
            prevTotalSizeRef.current = newTotal;
          });
        }
      });
      ro.observe(el);
      (el as any)._ro = ro;
    }
  }, [virtualizer]);

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
    // If transcript was cleared (new run), allow re-settling sizes.
    if (currentLen === 0) initialSizeSettledRef.current = false;
    prevLenRef.current = currentLen;
    prevStreamingCountRef.current = currentStream;

    const v = virtualizerRef.current;
    const el = scrollRef.current;

    const live = isLiveRef.current;

    // Only measure dynamically on live runs, or during the very first population of a
    // historical transcript (while initialSizeSettledRef is false). After that, freeze
    // sizes to give the user completely free manual scrolling with no app-driven layout shifts.
    if (v && (live || !initialSizeSettledRef.current)) {
      requestAnimationFrame(() => {
        const oldTotal = prevTotalSizeRef.current;
        v.measure();
        const newTotal = v.getTotalSize();
        // Compensation *only* for live; historical never adjusts scrollTop here.
        if (el && live && !isAtBottomRef.current && !userScrollingRef.current && oldTotal > 0 && newTotal < oldTotal) {
          const delta = oldTotal - newTotal;
          el.scrollTop = Math.max(0, el.scrollTop - delta);
        }
        prevTotalSizeRef.current = newTotal;

        // For historical: after we have real content and have measured at least once,
        // mark settled so future appends (if any) or re-renders don't trigger more measures.
        if (!live && currentLen > 0) {
          initialSizeSettledRef.current = true;
        }
      });
    }

    // Always re-measure on new content for live to prevent estimate error accumulation over time
    // (which causes big gaps or staggering/stacking as more messages arrive).
    // Extra passes + timeouts to force measurement of items that might otherwise stay "hidden"
    // due to initial estimate error (revealed only on resize/redraw).
    if (live && v) {
      // Force broad measurement on live content changes (appends from streaming, new system messages, hunks).
      // Multiple passes because complex content (JSON diffs, tables, wrapped text) takes time to lay out.
      requestAnimationFrame(() => v.measure());
      mountedItemsRef.current.forEach((el) => {
        v.measureElement(el);
        requestAnimationFrame(() => v.measureElement(el));
      });
      // Extra delayed passes to catch reflows.
      setTimeout(() => {
        v.measure();
        mountedItemsRef.current.forEach((el) => v.measureElement(el));
      }, 30);
      setTimeout(() => {
        v.measure();
        mountedItemsRef.current.forEach((el) => v.measureElement(el));
      }, 120);
      setTimeout(() => {
        v.measure();
        mountedItemsRef.current.forEach((el) => v.measureElement(el));
      }, 350);
    }

    // Use the ref for at-bottom check (updated live in onScroll without causing re-renders).
    // This prevents the effect from reacting to sticky state changes during scroll.
    if (!isAtBottomRef.current) return;

    // Only auto-scroll to bottom for live activity.
    // For finished/history views (like /runs/:id), completely suppress.
    // Full manual control; "Latest" for explicit end jump only.
    if (!live) return;

    // For live: follow on new content (hadNewContent will be true for arrivals)
    if (hadNewContent) {
      requestAnimationFrame(() => {
        endRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
      });
    }
  }, [filteredTranscript.length, streamingCount, phase]);

  // After filter change re-measure for the new set of items (different heights).
  // This is user-initiated so a one-time layout adjustment on filter is acceptable.
  // No scrollToOffset. We still avoid it on passive length changes for history.
  useEffect(() => {
    const t = setTimeout(() => {
      const v = virtualizerRef.current;
      if (v) {
        v.measure();
        requestAnimationFrame(() => v.measure());
      }
    }, 40);
    return () => clearTimeout(t);
  }, [filter]);

  // Re-measure on filter for layout accuracy (no scroll side effects).
  // Filter change is explicit user action, so measuring the new arrangement is fine.
  useLayoutEffect(() => {
    const raf = requestAnimationFrame(() => {
      virtualizer.measure();
      requestAnimationFrame(() => virtualizer.measure());
    });
    return () => cancelAnimationFrame(raf);
  }, [filter, virtualizer]);

  // Resize handler + container RO: force re-measure when viewport size changes.
  // Critical for the "hiding until resize" symptom: when browser width changes, wrapped text in system/agent bubbles
  // changes height; without immediate measure the virtual positions stay wrong and items stay out of rendered range.
  useEffect(() => {
    let t: any;
    const doMeasure = () => {
      const v = virtualizerRef.current;
      if (v) {
        v.measure();
        // Force all mounted items on resize (width change affects wrap heights in code/JSON/system text).
        mountedItemsRef.current.forEach((el) => v.measureElement(el));
        requestAnimationFrame(() => v.measure());
        setTimeout(() => v.measure(), 40);
      }
    };
    const onResize = () => {
      clearTimeout(t);
      t = setTimeout(doMeasure, 80);
    };
    window.addEventListener('resize', onResize);

    // Direct observer on the scroller catches size changes even if window event is delayed or not fired in some embeds.
    const ro = new ResizeObserver(doMeasure);
    if (scrollRef.current) ro.observe(scrollRef.current);

    return () => {
      window.removeEventListener('resize', onResize);
      ro.disconnect();
      clearTimeout(t);
    };
  }, []);

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
            title={f === "key" ? "High-signal items only (synthesis, verdicts, run events, web results, major actions)" : undefined}
          >
            {f === "key" ? "Key" : f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
        <span className="text-[10px] text-ink-500 ml-auto">
          {filteredTranscript.length} / {transcript.length} entries
        </span>
        {runId && phase !== "completed" && phase !== "stopped" && phase !== "failed" && !isHybrid && (
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
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            width: '100%',
            position: 'relative',
          }}
        >
          {virtualizer.getVirtualItems().map((virtualItem) => {
            const e = filteredTranscript[virtualItem.index];
            if (!e) return null;
            return (
              <div
                key={e.id}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${virtualItem.start}px)`,
                  willChange: 'transform',
                }}
              >
                <div
                  ref={makeItemRef(virtualItem)}
                  data-index={virtualItem.index}
                  className="virtual-item"
                  style={{ 
                    margin: 0,
                    paddingBottom: `${ITEM_GAP_PX}px`,
                    boxSizing: 'border-box',
                    contain: 'layout style',
                    minHeight: '20px',
                  }}
                >
                  {e.role === "agent-stream" ? (
                    <StreamingTranscriptCard entry={e} />
                  ) : (
                    <MessageBubble entry={e} />
                  )}
                </div>
              </div>
            );
          })}
        </div>

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

