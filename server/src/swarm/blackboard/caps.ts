// Phase 7: hard caps so a run always terminates. Pure decision function so it
// can be unit-tested without standing up the full runner. The runner calls
// checkCaps() on every worker-loop iteration and, if it returns a non-null
// reason, flags the run for cap-induced termination.
//
// T-Item-Caps (2026-05-04): wall-clock and commits caps are env-overridable via
// SWARM_WALL_CLOCK_CAP_MIN and SWARM_COMMITS_CAP (read from config). The exports
// below are re-evaluations of those env values at module-import time. Per-run
// overrides (RunConfig.wallClockCapMs) win in checkCaps for wall-clock.
//
// Review note (2026-07): for stricter isolation, future work should compute
// all three caps strictly from per-run config and remove direct use of the
// module-level exports outside of defaults.
import { config } from "../../config.js";
export const WALL_CLOCK_CAP_MS = config.SWARM_WALL_CLOCK_CAP_MIN * 60_000;
export const COMMITS_CAP = config.SWARM_COMMITS_CAP;

// Unit 27: host-sleep compensation. The wall-clock cap originally used
// `Date.now() - runStartedAt`, which silently counts suspended-host time
// against the run — documented by the phase11c-medium-v7 post-mortem
// (~8h 41m of elapsed labeled "20 min cap reached" because the user
// closed the laptop mid-run). The fix is a tick accumulator that
// advances only by clamped deltas between consecutive cap checks, so a
// multi-hour jump from host sleep contributes at most this constant
// per tick instead of the full suspended duration.
//
// 5 minutes is generous: the worker poll cycle is ~2.5 s, and even
// with a single worker blocked on a retry-laden prompt other workers
// (or the replan tick) still call checkAndApplyCaps regularly. A
// legitimate gap of 5 min between cap checks would mean every ticker
// in the system is simultaneously stuck, which ~never happens in
// practice. False positive cost: if it does happen, we under-count
// by up to 5 min per tick — the cap fires slightly late. False
// negative cost: if a sleep is < 5 min, we over-count by the sleep
// duration — the cap fires slightly early. Both are acceptable
// compared to today's "cap fires 8 hours late".
export const MAX_REASONABLE_TICK_DELTA_MS = 5 * 60_000;

export interface TickAccumulator {
  /** Clamped ms elapsed since the run entered `executing`. */
  activeElapsedMs: number;
  /** `Date.now()` at the previous advance; the delta to "now" is clamped. */
  lastTickAt: number;
}

/**
 * Seed a fresh tick accumulator at `now`. Use this at the moment the
 * run enters `executing` (alongside stamping `runStartedAt`).
 */
export function createTickAccumulator(now: number): TickAccumulator {
  return { activeElapsedMs: 0, lastTickAt: now };
}

/**
 * Advance a tick accumulator by the delta since its last tick, clamped
 * into `[0, MAX_REASONABLE_TICK_DELTA_MS]`. Returns the new accumulator
 * state AND the detected-jump magnitude (0 if the raw delta was within
 * the reasonable range). The caller can use `jumpMs` to log / surface
 * host-sleep detection without this helper needing a side-effect channel.
 *
 * Pure: given the same inputs always returns the same output.
 */
export function advanceTickAccumulator(
  prev: TickAccumulator,
  now: number,
): { next: TickAccumulator; jumpMs: number } {
  const rawDelta = now - prev.lastTickAt;
  const clampedDelta = Math.max(
    0,
    Math.min(rawDelta, MAX_REASONABLE_TICK_DELTA_MS),
  );
  const jumpMs = Math.max(0, rawDelta - clampedDelta);
  return {
    next: {
      activeElapsedMs: prev.activeElapsedMs + clampedDelta,
      lastTickAt: now,
    },
    jumpMs,
  };
}

export interface CapState {
  /** ms-since-epoch when the run entered `executing`. */
  startedAt: number;
  /** Current ms-since-epoch; injected so tests can fake the clock. */
  now: number;
  /** Count of todos currently in `committed` state on the board. */
  committed: number;
  /**
   * Unit 43: per-run wall-clock cap override (ms). When undefined, the
   * baked-in `WALL_CLOCK_CAP_MS` (8 h) applies. Commits cap remains a
   * global runaway-prevention backstop, not a per-run knob.
   */
  wallClockCapMs?: number;
}

export type CapReason =
  | "wall-clock cap reached"
  | "commits cap reached";

/**
 * Returns a human-readable termination reason if any cap has been met or
 * exceeded, or null if the run may continue.
 *
 * Priority is deterministic: wall-clock → commits. The first cap that fires
 * wins so the caller gets a single, stable reason string even if both trip
 * in the same tick.
 */
export function checkCaps(state: CapState): string | null {
  const { startedAt, now, committed, wallClockCapMs } = state;
  const elapsed = now - startedAt;
  // Unit 43: per-run override wins, baked-in default backs it up.
  const wallCap = wallClockCapMs ?? WALL_CLOCK_CAP_MS;
  if (elapsed >= wallCap) {
    const minutes = Math.round(wallCap / 60_000);
    return `wall-clock cap reached (${minutes} min)`;
  }
  if (committed >= COMMITS_CAP) {
    return `commits cap reached (${COMMITS_CAP})`;
  }
  return null;
}
