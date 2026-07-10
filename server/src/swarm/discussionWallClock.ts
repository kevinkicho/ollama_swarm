// Sleep-safe wall-clock watchdog for discussion presets.
// Reuses blackboard tick-accumulator so laptop sleep leaves the cap intact.
// Pure resource gate (active elapsed wall-clock).

import {
  createTickAccumulator,
  advanceTickAccumulator,
  type TickAccumulator,
} from "./blackboard/caps.js";
import { notifyGuardTrip } from "./guardNotify.js";

export interface DiscussionWallClockHost {
  getStartedAt: () => number | undefined;
  getWallClockCapMs: () => number | undefined;
  getStopping: () => boolean;
  appendSystem: (msg: string, summary?: import("../types.js").TranscriptEntrySummary) => void;
  /** Called once when cap fires — should trigger stop(). */
  onCapReached: () => void;
  getRunId?: () => string | undefined;
  getBrainService?: () =>
    | { injectSuggestion?: (runId: string, s: { title: string; text: string; category?: string }) => void }
    | null
    | undefined;
}

/**
 * Start a 10s-interval wall-clock watchdog. Uses clamped tick deltas so
 * host sleep does not instantly exhaust the cap (mirrors Blackboard).
 * Returns a stop function (clear interval).
 */
export function startDiscussionWallClockWatchdog(
  host: DiscussionWallClockHost,
  checkIntervalMs = 10_000,
): () => void {
  let ticks: TickAccumulator | undefined;
  const timer = setInterval(() => {
    if (host.getStopping()) return;
    const capMs = host.getWallClockCapMs();
    const startedAt = host.getStartedAt();
    if (!capMs || capMs <= 0 || startedAt == null) return;

    const now = Date.now();
    if (!ticks) {
      ticks = createTickAccumulator(startedAt);
      // Catch up from start to now in clamped steps so first tick is honest.
      ticks = advanceTickAccumulator(ticks, now).next;
    } else {
      ticks = advanceTickAccumulator(ticks, now).next;
    }

    if (ticks.activeElapsedMs >= capMs) {
      const detail = `wall-clock cap reached (${Math.round(capMs / 60_000)} min active)`;
      host.appendSystem(`[cap] ${detail} — stopping.`);
      notifyGuardTrip({
        kind: "wall-clock",
        detail,
        runId: host.getRunId?.(),
        appendSystem: (t, s) => host.appendSystem(t, s),
        getBrainService: host.getBrainService,
      });
      host.onCapReached();
    }
  }, checkIntervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
