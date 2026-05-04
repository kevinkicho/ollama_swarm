// R2 (2026-05-04): exponential quota-probe back-off.
//
// BlackboardRunner currently probes the upstream every 5 min flat
// (PAUSE_PROBE_INTERVAL_MS). For brief blips that wastes ~5 min; for
// long walls (overnight quota reset) the constant churn adds noise to
// the transcript without helping.
//
// Switch to exponential: 1m, 2m, 4m, 8m, 16m, then capped at 30m. The
// caller passes the attempt count (0-indexed for first probe after
// pause) and gets back the delay to schedule.
//
// Pure: no I/O, no clocks. Caller wires it into setTimeout.

export const QUOTA_PROBE_BASE_MS = 60_000; // 1 min
export const QUOTA_PROBE_CAP_MS = 30 * 60_000; // 30 min
export const QUOTA_PROBE_FACTOR = 2;

/** Compute the delay (ms) to wait before the Nth probe (0-indexed).
 *  Sequence: 1m, 2m, 4m, 8m, 16m, 32m→capped at 30m, 30m, ... */
export function nextQuotaProbeDelayMs(attempt: number): number {
  if (!Number.isFinite(attempt) || attempt < 0) return QUOTA_PROBE_BASE_MS;
  const raw = QUOTA_PROBE_BASE_MS * Math.pow(QUOTA_PROBE_FACTOR, attempt);
  return Math.min(raw, QUOTA_PROBE_CAP_MS);
}

/** Pretty label for the transcript: "1 min", "30 min". */
export function formatProbeDelayLabel(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return `${minutes} min`;
}
