// R13 (2026-05-04): memory-pressure backpressure.
//
// Long blackboard runs accumulate transcript + amendments + per-agent
// stats in memory. If the heap creeps near Node's --max-old-space-size
// the next prompt allocation will OOM hard, taking the whole server
// with it. Cheaper option: pause new dispatch when heap is high, let
// the GC catch up + the in-flight turn drain, then resume.
//
// Two layers:
//   - sampleHeap(): thin wrapper over process.memoryUsage()
//   - evaluateMemoryPressure(usedBytes, heapLimitBytes, thresholds):
//     pure decision (returns "ok" / "throttle" / "pause")
//
// Caller decides what to do with the verdict.

export const DEFAULT_PAUSE_RATIO = 0.9; // 90%
export const DEFAULT_THROTTLE_RATIO = 0.75; // 75%

export type MemoryPressureLevel = "ok" | "throttle" | "pause";

export interface MemoryPressureVerdict {
  level: MemoryPressureLevel;
  usedBytes: number;
  limitBytes: number;
  ratio: number;
  reason: string;
}

export interface MemoryPressureInput {
  /** Bytes currently in use (heapUsed). */
  usedBytes: number;
  /** Heap size cap (heapTotal or --max-old-space-size in bytes). */
  limitBytes: number;
  /** ratio ≥ this → "pause". Default 0.9. */
  pauseRatio?: number;
  /** ratio ≥ this (but < pauseRatio) → "throttle". Default 0.75. */
  throttleRatio?: number;
}

export function evaluateMemoryPressure(
  input: MemoryPressureInput,
): MemoryPressureVerdict {
  const {
    usedBytes,
    limitBytes,
    pauseRatio = DEFAULT_PAUSE_RATIO,
    throttleRatio = DEFAULT_THROTTLE_RATIO,
  } = input;
  if (!Number.isFinite(usedBytes) || !Number.isFinite(limitBytes) || limitBytes <= 0) {
    return {
      level: "ok",
      usedBytes,
      limitBytes,
      ratio: 0,
      reason: "invalid memory readings — assuming OK",
    };
  }
  const ratio = usedBytes / limitBytes;
  let level: MemoryPressureLevel;
  let reason: string;
  if (ratio >= pauseRatio) {
    level = "pause";
    reason = `heap ${(ratio * 100).toFixed(0)}% (≥ ${(pauseRatio * 100).toFixed(0)}%) — pause new dispatch`;
  } else if (ratio >= throttleRatio) {
    level = "throttle";
    reason = `heap ${(ratio * 100).toFixed(0)}% (≥ ${(throttleRatio * 100).toFixed(0)}%) — throttle, wait for GC`;
  } else {
    level = "ok";
    reason = `heap ${(ratio * 100).toFixed(0)}% — OK`;
  }
  return { level, usedBytes, limitBytes, ratio, reason };
}

/** Sample current heap usage. Returns { usedBytes, limitBytes }. */
export function sampleHeap(): { usedBytes: number; limitBytes: number } {
  const m = process.memoryUsage();
  // heapTotal is the current cap; use that as the limit. (The runtime
  // can grow heapTotal up to --max-old-space-size, so this is a moving
  // target — but for "are we close to OOM" purposes the right signal
  // is heapUsed/heapTotal, since GC runs at heapTotal boundaries.)
  return { usedBytes: m.heapUsed, limitBytes: m.heapTotal };
}

/** End-to-end: sample heap + run the verdict. */
export function checkMemoryPressure(input: {
  pauseRatio?: number;
  throttleRatio?: number;
} = {}): MemoryPressureVerdict {
  const { usedBytes, limitBytes } = sampleHeap();
  return evaluateMemoryPressure({ usedBytes, limitBytes, ...input });
}
