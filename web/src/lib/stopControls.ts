/** Kind of in-flight control action for a run (scoped so concurrent runs stay independent). */
export type StopControlKind = "stop" | "drain" | "resume";

export interface PendingStopAction {
  runId: string;
  kind: StopControlKind;
}

/** True when a control request is in flight for this run (not another concurrent run). */
export function isStopActionBusy(
  stopActionRunId: string | null | undefined,
  viewRunId: string | undefined,
): boolean {
  if (!stopActionRunId || !viewRunId) return false;
  return stopActionRunId === viewRunId;
}

/**
 * Hard Stop is disabled only while a hard-stop request is in flight for this
 * run, or the run can no longer be stopped. Drain in flight / draining phase
 * leaves Stop enabled so the user can escalate to immediate kill.
 */
export function hardStopDisabled(
  pending: PendingStopAction | null,
  viewRunId: string | undefined,
  canStop: boolean,
): boolean {
  if (!canStop) return true;
  if (!pending || !viewRunId || pending.runId !== viewRunId) return false;
  return pending.kind === "stop";
}

/**
 * Drain is disabled while any stop/drain/resume is in flight for this run,
 * when drain is ineligible, or when canStop is false (terminal / hard-stopping).
 */
export function drainControlsDisabled(
  pending: PendingStopAction | null,
  viewRunId: string | undefined,
  canStop: boolean,
  drainEligible: boolean,
  phase: string | undefined,
): boolean {
  if (!canStop) return true;
  if (!drainEligible) return true;
  if (phase === "draining" || phase === "stopping") return true;
  if (!pending || !viewRunId) return false;
  return pending.runId === viewRunId;
}

/** @deprecated Prefer hardStopDisabled — kept for callers that only pass runId. */
export function stopControlsDisabled(
  stopActionRunId: string | null,
  viewRunId: string | undefined,
  canStop: boolean,
): boolean {
  return isStopActionBusy(stopActionRunId, viewRunId) || !canStop;
}
