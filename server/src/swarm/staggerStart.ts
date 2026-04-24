// Task #53 (2026-04-24): stagger N parallel async calls by a small
// jittered delay so they don't all hit the cloud at the exact same
// millisecond.
//
// WHY: log analysis after the 2026-04-24 integrity sweep confirmed
// Pattern 3 — one of N agents in a parallel-fanout burst consistently
// loses the cloud queue race. Cold-start mean for agent-2 across 10
// runs today: 76.7s (p95 565s) vs agent-1's 8.4s. The pattern biased
// toward agent-2 across council + orchestrator-worker + map-reduce
// + stigmergy, because those are the four presets with true parallel
// Promise.allSettled(agents.map(…)) bursts.
//
// HOW: runners that want a parallel batch replace
//   Promise.allSettled(items.map(fn))
// with
//   staggerStart(items, fn)
// and each item's call to `fn` is delayed by an extra
// `(index * spacingMs)` ms before firing. Jitter (±25 %) prevents
// deterministic lockstep between runs.
//
// We deliberately keep this a SMALL stagger (default 150 ms) — too
// long and the slowest agent just becomes a bottleneck for the whole
// batch; too short and the cloud still sees N concurrent requests.
// 150 ms × 5 agents = 750 ms total extra wait; tolerable for the
// queue-race fix it buys.

export const DEFAULT_SPACING_MS = 150;
const JITTER_PCT = 0.25;

/**
 * Stagger the start of `fn(item, index)` calls by spacingMs × index
 * (with ±25% jitter) before awaiting them all via Promise.allSettled.
 *
 * Returns the same shape Promise.allSettled returns.
 *
 * For a batch of 4 items at spacingMs=150:
 *   - item[0] starts at t=0
 *   - item[1] starts at t=~150ms
 *   - item[2] starts at t=~300ms
 *   - item[3] starts at t=~450ms
 * All are then awaited; the returned array preserves input order.
 */
export async function staggerStart<T, R>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<R>,
  spacingMs: number = DEFAULT_SPACING_MS,
): Promise<PromiseSettledResult<R>[]> {
  const tasks = items.map(async (item, i) => {
    if (i > 0) {
      const jitter = 1 + (Math.random() - 0.5) * 2 * JITTER_PCT;
      const delay = Math.max(0, spacingMs * i * jitter);
      await new Promise((r) => setTimeout(r, delay));
    }
    return fn(item, i);
  });
  return Promise.allSettled(tasks);
}
