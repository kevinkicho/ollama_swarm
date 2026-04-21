// Phase 7: hard caps so a run always terminates. Pure decision function so it
// can be unit-tested without standing up the full runner. The runner calls
// checkCaps() on every worker-loop iteration and, if it returns a non-null
// reason, flags the run for cap-induced termination.
//
// Defaults are hard-coded for now — a runtime-configurable cap surface (per-
// run overrides via RunConfig or env vars) is deferred to the next cap
// iteration. Today's numbers are generous enough that no real run should
// bump into them; the caps are a safety valve, not a production tuning knob.

export const WALL_CLOCK_CAP_MS = 20 * 60_000;
export const COMMITS_CAP = 20;
export const TODOS_CAP = 30;

export interface CapState {
  /** ms-since-epoch when the run entered `executing`. */
  startedAt: number;
  /** Current ms-since-epoch; injected so tests can fake the clock. */
  now: number;
  /** Count of todos currently in `committed` state on the board. */
  committed: number;
  /** Total number of todos that have ever been posted (includes stale/skipped/etc.). */
  totalTodos: number;
}

export type CapReason =
  | "wall-clock cap reached"
  | "commits cap reached"
  | "todos cap reached";

/**
 * Returns a human-readable termination reason if any cap has been met or
 * exceeded, or null if the run may continue.
 *
 * Priority is deterministic: wall-clock → commits → todos. The first cap
 * that fires wins so the caller gets a single, stable reason string even if
 * multiple caps trip in the same tick.
 */
export function checkCaps(state: CapState): string | null {
  const { startedAt, now, committed, totalTodos } = state;
  const elapsed = now - startedAt;
  if (elapsed >= WALL_CLOCK_CAP_MS) {
    const minutes = Math.round(WALL_CLOCK_CAP_MS / 60_000);
    return `wall-clock cap reached (${minutes} min)`;
  }
  if (committed >= COMMITS_CAP) {
    return `commits cap reached (${COMMITS_CAP})`;
  }
  if (totalTodos >= TODOS_CAP) {
    return `todos cap reached (${TODOS_CAP})`;
  }
  return null;
}
