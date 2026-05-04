// R9 extended (2026-05-04): intra-stream loop detector.
//
// The turn-level R9 semanticLoopDetector (which fires at TURN boundaries)
// cannot catch a model spinning DURING a single streaming turn. The
// 2026-05-04 all-presets sweep surfaced this failure mode: nemotron-3-super
// emitted the same JSON tool-call envelope 132 times in ONE streaming turn
// before the 90s SSE-idle watchdog finally fired.
//
// This detector runs inside the per-chunk callback that promptWithRetry
// already registers with the provider. It tracks a sliding window of
// recent chunks and aborts the prompt when ≥80% of the last K chunks
// are byte-identical, indicating the model is stuck in a loop.

export interface IntraStreamLoopResult {
  /** Whether a loop was detected. */
  detected: boolean;
  /** Human-readable reason for the detection (empty string if not detected). */
  reason: string;
  /** Number of consecutive identical chunks at detection time. */
  repeatCount: number;
}

export interface IntraStreamLoopDetector {
  /** Call on every chunk. Returns detection result. */
  onChunk(cumulativeText: string): IntraStreamLoopResult;
  /** Reset state for a new prompt attempt (called between retries). */
  reset(): void;
  /** How many chunks have been received so far. */
  chunkCount: number;
}

export interface IntraStreamLoopDetectorOpts {
  /** Sliding window size. Default 10. */
  windowSize?: number;
  /** Fraction of window that must be identical to trigger detection.
   *  Default 0.8 (80%). Must be > 0.5 and ≤ 1.0. */
  threshold?: number;
  /** Minimum cumulative text length before detection starts. Prevents
   *  false positives on very short responses where the model is still
   *  warming up. Default 200 chars. */
  minLengthBeforeCheck?: number;
  /** Minimum number of chunks before detection starts. Prevents
   *  false positives on the first few chunks which may naturally
   *  be similar (e.g. JSON opening brackets). Default 5. */
  minChunksBeforeCheck?: number;
}

/**
 * Creates an intra-stream loop detector. The detector examines chunks
 * by tracking the cumulative text length at each chunk arrival and
 * checking whether the last K length-deltas are identical (meaning the
 * same number of bytes arrived for K consecutive chunks — a strong
 * signal the model is emitting the same repeated block).
 *
 * It also checks for exact substring repetition: if the last N characters
 * of cumulative text appear verbatim 3+ times in a row at the end, that's
 * a loop regardless of chunk boundaries.
 */
export function createIntraStreamLoopDetector(
  opts?: IntraStreamLoopDetectorOpts,
): IntraStreamLoopDetector {
  const windowSize = opts?.windowSize ?? 10;
  const threshold = opts?.threshold ?? 0.8;
  const minLength = opts?.minLengthBeforeCheck ?? 200;
  const minChunks = opts?.minChunksBeforeCheck ?? 5;

  // Track cumulative text lengths at each chunk boundary
  let lengths: number[] = [];
  // Track the last few suffixes for substring-repeat detection
  let lastSuffix: string = "";
  let lastSuffixRepeatCount: number = 0;
  let totalChunks = 0;

  return {
    get chunkCount() {
      return totalChunks;
    },

    onChunk(cumulativeText: string): IntraStreamLoopResult {
      totalChunks++;
      const currentLength = cumulativeText.length;
      lengths.push(currentLength);

      // Keep only the last windowSize+1 lengths (we need +1 to compute deltas)
      if (lengths.length > windowSize + 1) {
        lengths = lengths.slice(-windowSize - 1);
      }

      // Don't check until we have enough data
      if (totalChunks < minChunks || currentLength < minLength) {
        return { detected: false, reason: "", repeatCount: 0 };
      }

      // Compute deltas (bytes per chunk) for the last windowSize chunks
      const deltas: number[] = [];
      for (let i = 1; i < lengths.length; i++) {
        deltas.push(lengths[i] - lengths[i - 1]);
      }

      // Check 1: identical deltas. If ≥threshold of recent chunks had
      // the exact same byte count, the model is emitting uniform blocks.
      if (deltas.length >= 3) {
        const lastDelta = deltas[deltas.length - 1];
        if (lastDelta > 0) {
          const identicalCount = deltas.filter((d) => d === lastDelta).length;
          if (identicalCount / deltas.length >= threshold) {
            return {
              detected: true,
              reason: `intra-stream loop: ${identicalCount}/${deltas.length} recent chunks had identical delta=${lastDelta} bytes`,
              repeatCount: identicalCount,
            };
          }
        }
      }

      // Check 2: trailing substring repetition. If the tail of the
      // cumulative text repeats verbatim 3+ times, that's a loop
      // regardless of chunk boundaries. Try a range of candidate
      // repeat lengths from 20 to min(200, currentLength/3), stepping
      // by 1 for tighter coverage. This catches blocks of any size.
      if (currentLength >= 60) {
        const maxRepeatLen = Math.min(200, Math.floor(currentLength / 3));
        for (let rLen = 20; rLen <= maxRepeatLen; rLen++) {
          const tail = cumulativeText.slice(-rLen);
          let count = 0;
          let pos = cumulativeText.length;
          while (pos >= rLen && cumulativeText.slice(pos - rLen, pos) === tail) {
            count++;
            pos -= rLen;
          }
          if (count >= 3) {
            return {
              detected: true,
              reason: `intra-stream loop: suffix of ${rLen} chars repeated ${count} times at end of ${currentLength}-char response`,
              repeatCount: count,
            };
          }
        }
      }

      // Check 3: zero-delta (no new text) streak. If the last N chunks
      // all had 0 bytes added, the model is stuck emitting nothing.
      if (deltas.length >= 3) {
        const zeroStreak = deltas.filter((d) => d === 0).length;
        if (zeroStreak >= 5) {
          return {
            detected: true,
            reason: `intra-stream loop: ${zeroStreak} consecutive zero-byte chunks`,
            repeatCount: zeroStreak,
          };
        }
      }

      return { detected: false, reason: "", repeatCount: 0 };
    },

    reset(): void {
      lengths = [];
      lastSuffix = "";
      lastSuffixRepeatCount = 0;
      totalChunks = 0;
    },
  };
}