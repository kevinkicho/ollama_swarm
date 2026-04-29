// #299 (2026-04-28): mid-run directive amendments.
//
// User submits an addendum to the directive while a run is in flight
// (typically when the #295 conformance gauge shows drift). The
// orchestrator stores them per-runId; each runner reads via
// getAmendments() and weaves them into the next prompt's context.
//
// Why a dedicated buffer (not just a string field on the runner):
//   - Runners shouldn't have to know about the HTTP-side endpoint
//   - Multiple amendments can stack ("focus on X" then "also Y")
//   - The buffer survives runner instance changes (theoretical
//     future: same run resumes after a transient crash)
//   - Clear lifecycle: created on run-start, dropped on run-end
//
// Pure in-memory; no persistence. Mid-run amendments are point-in-
// time intent; persisting them across runner restarts isn't a
// requirement of the feature.

export interface Amendment {
  /** ms-since-epoch when the user submitted. */
  ts: number;
  /** The user's addendum text (trimmed, ≤ MAX_AMENDMENT_CHARS). */
  text: string;
}

const MAX_AMENDMENT_CHARS = 1000;
const MAX_AMENDMENTS_PER_RUN = 20;

export class AmendmentsBuffer {
  private byRunId = new Map<string, Amendment[]>();

  /** Begin tracking amendments for a new run. Idempotent — calling
   *  twice for the same runId resets the buffer (caller should only
   *  hit this on run start). */
  open(runId: string): void {
    this.byRunId.set(runId, []);
  }

  /** Drop the buffer for a finished run. Called on stop / completion. */
  close(runId: string): void {
    this.byRunId.delete(runId);
  }

  /** Append an amendment to a run's buffer. Returns the amendment
   *  that was actually stored (post-trim/clamp), or null when the
   *  runId isn't open or the text is empty after trimming. */
  add(runId: string, rawText: string): Amendment | null {
    const text = (rawText ?? "").trim().slice(0, MAX_AMENDMENT_CHARS);
    if (text.length === 0) return null;
    const buf = this.byRunId.get(runId);
    if (!buf) return null;
    const amendment: Amendment = { ts: Date.now(), text };
    buf.push(amendment);
    if (buf.length > MAX_AMENDMENTS_PER_RUN) {
      // Drop oldest to keep the prompt context bounded — same LRU
      // pattern as knownParents and other rolling buffers.
      buf.splice(0, buf.length - MAX_AMENDMENTS_PER_RUN);
    }
    return amendment;
  }

  /** Read all amendments for a run, oldest first. Returns a
   *  defensive copy so callers can't mutate buffer state. */
  list(runId: string): Amendment[] {
    return (this.byRunId.get(runId) ?? []).slice();
  }

  /** True iff a buffer is open for this runId. */
  isOpen(runId: string): boolean {
    return this.byRunId.has(runId);
  }
}
