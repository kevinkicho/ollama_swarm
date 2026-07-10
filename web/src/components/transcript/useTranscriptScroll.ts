// Scroll / sticky-bottom / measure scheduling for Transcript — extracted from Transcript.tsx.

import { useCallback, useRef, useState, type MutableRefObject, type RefObject } from "react";
import {
  scrollElementToBottom,
  isNearBottom,
  stickyBottomDebounceMs,
  SCROLL_TO_END_THROTTLE_MS,
  USER_SCROLL_SETTLE_MS,
  JUMP_HISTORICAL_SETTLE_MS,
} from "./transcriptScroll";
import { VIRTUAL_TOP_MEASURE_COUNT } from "./transcriptVirtual";

export type TranscriptVirtualizerLike = {
  measureElement: (el: HTMLElement) => void;
  measure: () => void;
  getTotalSize: () => number;
};

export function useTranscriptScroll(opts: {
  scrollRef: RefObject<HTMLDivElement | null>;
  virtualizerRef: MutableRefObject<TranscriptVirtualizerLike | null>;
  shouldVirtualizeRef: MutableRefObject<boolean>;
  filteredTranscriptRef: MutableRefObject<Array<{ id?: string }>>;
  mountedItemsRef: MutableRefObject<Map<string, HTMLElement>>;
  isLiveRef: MutableRefObject<boolean>;
  prevLenRef: MutableRefObject<number>;
}) {
  const {
    scrollRef,
    virtualizerRef,
    shouldVirtualizeRef,
    filteredTranscriptRef,
    mountedItemsRef,
    isLiveRef,
    prevLenRef,
  } = opts;

  const [stickyBottom, setStickyBottom] = useState(false);
  const jumpLockRef = useRef(false);
  const isAtBottomRef = useRef(false);
  const scrollEndTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevTotalSizeRef = useRef(0);
  const userScrollingRef = useRef(false);
  const userScrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialSizeSettledRef = useRef(false);
  const lastMeasureRef = useRef(0);
  const measureRafRef = useRef<number | null>(null);
  const scrollRafRef = useRef<number | null>(null);
  const lastScrollAtRef = useRef(0);

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
          try {
            v.measureElement(el);
          } catch {
            /* ignore */
          }
        }
      });
      const list = filteredTranscriptRef.current;
      const topN = Math.min(VIRTUAL_TOP_MEASURE_COUNT, list.length);
      for (let i = 0; i < topN; i++) {
        const entryId = list[i]?.id ?? `idx-${i}`;
        const el = mountedItemsRef.current.get(entryId);
        if (el?.isConnected) {
          try {
            v.measureElement(el);
          } catch {
            /* ignore */
          }
        }
      }
      v.measure();
      const newTotal = v.getTotalSize();
      const el = scrollRef.current;
      if (
        el &&
        isLiveRef.current &&
        !isAtBottomRef.current &&
        !userScrollingRef.current &&
        oldTotal > 0 &&
        newTotal < oldTotal
      ) {
        el.scrollTop = Math.max(0, el.scrollTop - (oldTotal - newTotal));
      }
      prevTotalSizeRef.current = newTotal;
      if (!isLiveRef.current && prevLenRef.current > 0) {
        initialSizeSettledRef.current = true;
      }
    });
  }, [
    scrollRef,
    virtualizerRef,
    shouldVirtualizeRef,
    filteredTranscriptRef,
    mountedItemsRef,
    isLiveRef,
    prevLenRef,
  ]);

  const scrollContainerToBottom = useCallback(() => {
    scrollElementToBottom(scrollRef.current);
  }, [scrollRef]);

  const scheduleScrollToEnd = useCallback(() => {
    const now = Date.now();
    if (now - lastScrollAtRef.current < SCROLL_TO_END_THROTTLE_MS) return;
    if (scrollRafRef.current != null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      lastScrollAtRef.current = Date.now();
      scrollContainerToBottom();
    });
  }, [scrollContainerToBottom]);

  const onScroll = useCallback(() => {
    if (jumpLockRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    const v = virtualizerRef.current;
    const atBottom = isNearBottom(el, v ? v.getTotalSize() : undefined);
    isAtBottomRef.current = atBottom;

    userScrollingRef.current = true;
    if (userScrollTimeoutRef.current) clearTimeout(userScrollTimeoutRef.current);
    userScrollTimeoutRef.current = setTimeout(() => {
      userScrollingRef.current = false;
    }, USER_SCROLL_SETTLE_MS);

    if (!isLiveRef.current) {
      initialSizeSettledRef.current = true;
    }

    if (atBottom !== stickyBottom) {
      if (scrollEndTimerRef.current) clearTimeout(scrollEndTimerRef.current);
      scrollEndTimerRef.current = setTimeout(() => {
        setStickyBottom(atBottom);
      }, stickyBottomDebounceMs(isLiveRef.current));
    }
  }, [scrollRef, virtualizerRef, isLiveRef, stickyBottom]);

  const jumpToLatest = useCallback(() => {
    jumpLockRef.current = true;
    isAtBottomRef.current = true;
    setStickyBottom(true);
    scrollContainerToBottom();
    requestAnimationFrame(() => {
      scrollContainerToBottom();
      requestAnimationFrame(() => {
        scrollContainerToBottom();
        isAtBottomRef.current = true;
        setStickyBottom(true);
        jumpLockRef.current = false;
      });
    });

    if (!isLiveRef.current) {
      userScrollingRef.current = true;
      initialSizeSettledRef.current = true;
      setTimeout(() => {
        userScrollingRef.current = false;
      }, JUMP_HISTORICAL_SETTLE_MS);
    }
  }, [scrollContainerToBottom, isLiveRef]);

  return {
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
  };
}
