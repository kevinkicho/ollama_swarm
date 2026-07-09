import type { RunSummaryDigest } from "../types";

const FAILURE_STOP_REASONS = new Set([
  "user",
  "crash",
  "crashed",
  "cap:quota",
  "no-progress",
]);

/** Whether the run queue row should show live styling + Stop (server flag only is not enough — endedAt=0 is common on crash). */
export function runQueueIsActive(run: RunSummaryDigest): boolean {
  if (run.stopReason) return false;
  if (typeof run.endedAt === "number" && run.endedAt > 0) return false;
  return run.isActive === true;
}

export function runQueueStatusLabel(run: RunSummaryDigest, isActive: boolean): string {
  if (run.stopReason) return run.stopReason;
  if (isActive) return "active";
  if (typeof run.endedAt === "number" && run.endedAt > 0) return "done";
  return "ended";
}

export function runQueueStatusClass(
  run: RunSummaryDigest,
  isActive: boolean,
): string {
  if (run.stopReason === "completed") {
    return "bg-emerald-900/40 text-emerald-300 border-emerald-800/50";
  }
  if (run.stopReason && FAILURE_STOP_REASONS.has(run.stopReason)) {
    return "bg-rose-900/40 text-rose-300 border-rose-800/50";
  }
  if (isActive) {
    return "bg-blue-900/30 text-blue-300 border-blue-800/40";
  }
  return "bg-ink-700/50 text-ink-400 border-ink-700/50";
}