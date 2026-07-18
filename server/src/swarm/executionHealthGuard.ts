/**
 * Execution-quality circuit for multi-cycle council/blackboard runs.
 *
 * Empty-execution guard only catches "0 todos enqueued". Runs like
 * 4de10651 still mint todos each cycle but thrash apply_miss / json_parse
 * at ~50%+ fail rate for hours — this guard stops that.
 */

/** Consecutive high-fail cycles before hard stop. */
export const HIGH_FAIL_CYCLE_STREAK_LIMIT = 3;

/** Min settled todos (done+failed) in one cycle to use rate-based judgment. */
export const MIN_SETTLED_FOR_RATE = 3;

/** Cumulative settled todos before whole-run fail-rate circuit can fire. */
export const MIN_CUMULATIVE_SETTLED = 12;

/** Fail rate (failed / settled) that counts as thrash. */
export const HIGH_FAIL_RATE = 0.5;

export interface CycleExecutionCounts {
  done: number;
  failed: number;
  skipped?: number;
}

export function isHighFailCycle(counts: CycleExecutionCounts): boolean {
  const done = Math.max(0, counts.done | 0);
  const failed = Math.max(0, counts.failed | 0);
  const settled = done + failed;
  if (settled === 0) return false;
  // Zero productive completions with repeated fails.
  if (done === 0 && failed >= 2) return true;
  if (settled < MIN_SETTLED_FOR_RATE) return false;
  return failed >= done && failed / settled >= HIGH_FAIL_RATE;
}

export function updateHighFailStreak(
  prev: number,
  highFail: boolean,
  limit: number = HIGH_FAIL_CYCLE_STREAK_LIMIT,
): { streak: number; shouldStop: boolean } {
  if (!highFail) return { streak: 0, shouldStop: false };
  const streak = prev + 1;
  return { streak, shouldStop: streak >= limit };
}

/** Whole-run cumulative thrash after enough samples. */
export function shouldStopOnCumulativeFailRate(
  cumulative: CycleExecutionCounts,
  minSettled: number = MIN_CUMULATIVE_SETTLED,
  rate: number = HIGH_FAIL_RATE,
): boolean {
  const done = Math.max(0, cumulative.done | 0);
  const failed = Math.max(0, cumulative.failed | 0);
  const settled = done + failed;
  if (settled < minSettled) return false;
  return failed / settled >= rate && failed > done;
}

export function formatHighFailCycleReason(streak: number, counts: CycleExecutionCounts): string {
  return (
    `execution-thrash: ${streak} consecutive high-fail cycle(s) ` +
    `(last: ${counts.done} done / ${counts.failed} failed ≥${Math.round(HIGH_FAIL_RATE * 100)}% fail)`
  );
}

export function formatCumulativeFailRateReason(cumulative: CycleExecutionCounts): string {
  const settled = cumulative.done + cumulative.failed;
  const pct = settled > 0 ? Math.round((cumulative.failed / settled) * 100) : 0;
  return (
    `execution-thrash: cumulative fail rate ${pct}% ` +
    `(${cumulative.failed} failed / ${settled} settled, done=${cumulative.done}) — stopping autonomous thrash`
  );
}

/** Parse `[execution] Complete: N done, M failed, K skipped` system lines. */
export function parseExecutionCompleteLine(
  text: string,
): CycleExecutionCounts | null {
  const m = text.match(
    /\[execution\]\s*Complete:\s*(\d+)\s*done,\s*(\d+)\s*failed,\s*(\d+)\s*skipped/i,
  );
  if (!m) return null;
  return {
    done: Number(m[1]),
    failed: Number(m[2]),
    skipped: Number(m[3]),
  };
}
