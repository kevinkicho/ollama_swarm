// R10 (2026-05-04): proactive model-health tracker.
//
// R1 reacts to ONE failure (swap on quota wall, retry on network). R10
// reacts to a TREND: when a model's last-N attempts show <threshold
// success rate, swap before the next attempt — even if the latest
// attempt didn't itself trigger a failover. Catches "this model is
// quietly broken today" cases (e.g., truncated outputs, malformed
// JSON, timeouts) that R1 would shrug off individually.
//
// Pure: caller maintains the rolling window per model; helper computes
// the verdict and (optionally) picks the next model.

const DEFAULT_WINDOW_SIZE = 10;
const DEFAULT_MIN_SAMPLES = 5;
const DEFAULT_SUCCESS_THRESHOLD = 0.5;

export interface AttemptRecord {
  /** True when the attempt produced a usable response. */
  success: boolean;
  /** Wall-clock when the attempt finished (ms). Used for trimming. */
  ts: number;
}

export interface ModelHealthInput {
  /** Model that just produced an attempt. */
  model: string;
  /** Rolling window of recent attempts for THIS model, oldest → newest. */
  recentAttempts: readonly AttemptRecord[];
  /** Window size — only the last N count toward the verdict. */
  windowSize?: number;
  /** Minimum samples before we'll report `degraded=true`. Default 5. */
  minSamples?: number;
  /** Success rate below this → degraded. Default 0.5. */
  successThreshold?: number;
}

export interface ModelHealthVerdict {
  /** Model evaluated. */
  model: string;
  /** Successes / total in the window. */
  successRate: number;
  /** Number of samples actually used (capped at windowSize). */
  sampleCount: number;
  /** True when sampleCount ≥ minSamples AND successRate < threshold. */
  degraded: boolean;
  /** Plain-English explanation. */
  reason: string;
}

/** Pure verdict: is this model degraded right now? */
export function evaluateModelHealth(
  input: ModelHealthInput,
): ModelHealthVerdict {
  const {
    model,
    recentAttempts,
    windowSize = DEFAULT_WINDOW_SIZE,
    minSamples = DEFAULT_MIN_SAMPLES,
    successThreshold = DEFAULT_SUCCESS_THRESHOLD,
  } = input;
  const slice = recentAttempts.slice(-windowSize);
  const sampleCount = slice.length;
  if (sampleCount === 0) {
    return {
      model,
      successRate: 1,
      sampleCount: 0,
      degraded: false,
      reason: "no attempts recorded yet",
    };
  }
  const successes = slice.filter((a) => a.success).length;
  const successRate = successes / sampleCount;
  if (sampleCount < minSamples) {
    return {
      model,
      successRate,
      sampleCount,
      degraded: false,
      reason: `only ${sampleCount} samples (need ≥${minSamples} to declare degraded)`,
    };
  }
  const degraded = successRate < successThreshold;
  return {
    model,
    successRate,
    sampleCount,
    degraded,
    reason: degraded
      ? `${successes}/${sampleCount} success (${(successRate * 100).toFixed(0)}%) below ${(successThreshold * 100).toFixed(0)}% — degraded`
      : `${successes}/${sampleCount} success (${(successRate * 100).toFixed(0)}%) ≥ ${(successThreshold * 100).toFixed(0)}% — healthy`,
  };
}

/** Trim a window to the most recent `windowSize` records — the
 *  caller's storage helper. Pure. */
export function trimAttemptWindow(
  records: readonly AttemptRecord[],
  windowSize: number = DEFAULT_WINDOW_SIZE,
): AttemptRecord[] {
  if (records.length <= windowSize) return [...records];
  return records.slice(-windowSize);
}
