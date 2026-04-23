// Phase 7: hard caps so a run always terminates. Pure decision function so it
// can be unit-tested without standing up the full runner. The runner calls
// checkCaps() on every worker-loop iteration and, if it returns a non-null
// reason, flags the run for cap-induced termination.
//
// Defaults are hard-coded for now — a runtime-configurable cap surface (per-
// run overrides via RunConfig or env vars) is deferred to the next cap
// iteration. Today's numbers are generous enough that no real run should
// bump into them; the caps are a safety valve, not a production tuning knob.

// Bumped 2026-04-22 (Unit 23) to support multi-hour overnight runs.
// Original numbers (20 min / 20 commits / 30 todos) were sized for a
// 20-minute "smoke" budget and tripped early on substantive runs — the
// kyahoofinance032926 overnight test landed 20 commits in ~20 minutes
// and got cut off mid-work. New numbers target an ~8-hour budget while
// keeping all three caps as runaway-prevention backstops.
//
// Concretely: 8 h × 60 min = 480 min wall-clock; commits/todos bumped
// 10× to 200 / 300 respectively, since they scale with productivity not
// with time. A pathological planner-emits-infinite-todos failure mode
// still terminates eventually under the 300-todo cap.
export const WALL_CLOCK_CAP_MS = 480 * 60_000;
export const COMMITS_CAP = 200;
export const TODOS_CAP = 300;

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
