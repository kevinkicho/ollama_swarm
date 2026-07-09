/** True when a stop/drain request is in flight for this run (not another concurrent run). */
export function isStopActionBusy(
  stopActionRunId: string | null | undefined,
  viewRunId: string | undefined,
): boolean {
  if (!stopActionRunId || !viewRunId) return false;
  return stopActionRunId === viewRunId;
}

export function stopControlsDisabled(
  stopActionRunId: string | null,
  viewRunId: string | undefined,
  canStop: boolean,
): boolean {
  return isStopActionBusy(stopActionRunId, viewRunId) || !canStop;
}