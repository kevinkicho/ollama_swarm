// Lightweight progress signatures for stuck detection.
// Prefer board/ledger signals over text Jaccard (see docs/decisions.md 2026-07-10).

/**
 * Stable signature of "what progress looks like" for consecutive-cycle stuck checks.
 * Inputs should be already-normalized (sorted ids, counts).
 */
export function buildProgressSignature(parts: {
  /** Unmet criterion ids (sorted). */
  unmetIds?: readonly string[];
  /** Fail signature from ledger (optional). */
  failSignature?: string;
  /** Board open/stale/committed counts. */
  open?: number;
  stale?: number;
  committed?: number;
  /** Last commit sha or commit count. */
  commitMarker?: string;
}): string {
  const unmet = (parts.unmetIds ?? []).slice().sort().join(",");
  return [
    `u:${unmet}`,
    `f:${parts.failSignature ?? ""}`,
    `o:${parts.open ?? 0}`,
    `s:${parts.stale ?? 0}`,
    `c:${parts.committed ?? 0}`,
    `m:${parts.commitMarker ?? ""}`,
  ].join("|");
}

/**
 * Track consecutive identical signatures. Returns trips when threshold hit.
 */
export class ProgressStallTracker {
  private last = "";
  private consecutive = 0;

  constructor(private readonly threshold = 3) {}

  record(signature: string): { tripped: boolean; consecutive: number; signature: string } {
    if (!signature) {
      this.last = "";
      this.consecutive = 0;
      return { tripped: false, consecutive: 0, signature };
    }
    if (signature === this.last) {
      this.consecutive += 1;
    } else {
      this.last = signature;
      this.consecutive = 1;
    }
    return {
      tripped: this.consecutive >= this.threshold,
      consecutive: this.consecutive,
      signature,
    };
  }

  reset(): void {
    this.last = "";
    this.consecutive = 0;
  }
}
