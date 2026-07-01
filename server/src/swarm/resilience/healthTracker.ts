// R10: proactive model-health tracker.
// Pure: caller maintains rolling window per model; helper computes verdict.

import type { AttemptRecord, ModelHealthInput, ModelHealthVerdict } from "./types.js";

const DEFAULT_WINDOW_SIZE = 10;
const DEFAULT_MIN_SAMPLES = 5;
const DEFAULT_SUCCESS_THRESHOLD = 0.5;

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

/** Trim a window to the most recent `windowSize` records. Pure. */
export function trimAttemptWindow(
  records: readonly AttemptRecord[],
  windowSize: number = DEFAULT_WINDOW_SIZE,
): AttemptRecord[] {
  if (records.length <= windowSize) return [...records];
  return records.slice(-windowSize);
}