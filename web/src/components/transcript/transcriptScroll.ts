// Scroll geometry helpers for Transcript — pure functions (no React).

export function scrollElementToBottom(el: HTMLElement | null): void {
  if (!el) return;
  el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
}

/** Whether the scroll container is near the bottom (messages end or full bottom). */
export function isNearBottom(
  el: HTMLElement,
  virtualTotalSize: number | undefined,
  opts?: { messageThreshold?: number; distanceThreshold?: number },
): boolean {
  const messageThreshold = opts?.messageThreshold ?? 30;
  const distanceThreshold = opts?.distanceThreshold ?? 80;
  const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
  const virtualH = virtualTotalSize ?? el.scrollHeight;
  const atMessagesBottom = el.scrollTop + el.clientHeight >= virtualH - messageThreshold;
  return distanceFromBottom < distanceThreshold || atMessagesBottom;
}

/** Sticky-bottom debounce delay: shorter when live, longer when historical. */
export function stickyBottomDebounceMs(isLive: boolean): number {
  return isLive ? 120 : 220;
}

/** Throttle window for auto-scroll-to-end (ms). */
export const SCROLL_TO_END_THROTTLE_MS = 80;

/** User-scroll gesture settle timeout (ms). */
export const USER_SCROLL_SETTLE_MS = 200;

/** After jump-to-latest on historical, keep userScrolling true briefly. */
export const JUMP_HISTORICAL_SETTLE_MS = 350;
