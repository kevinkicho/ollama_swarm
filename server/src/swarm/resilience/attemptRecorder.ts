// R10 attempt recording helper.
// Pluggable into any store — used by promptWithFailover for per-model attempt tracking.

import type { AttemptRecord } from "./types.js";
import { trimAttemptWindow } from "./healthTracker.js";

/** Push an attempt record + trim the window. Mutates the map. */
export function recordAttempt(
  store: Map<string, AttemptRecord[]>,
  model: string,
  record: AttemptRecord,
): void {
  const existing = store.get(model) ?? [];
  existing.push(record);
  store.set(model, trimAttemptWindow(existing));
}

/** Get recent attempts for a model. */
export function getRecentAttempts(
  store: Map<string, AttemptRecord[]>,
  model: string,
): AttemptRecord[] {
  return store.get(model) ?? [];
}

/** Clear all attempt history for a model. */
export function clearModelAttempts(
  store: Map<string, AttemptRecord[]>,
  model: string,
): void {
  store.delete(model);
}

/** Clear all attempt history. */
export function clearAllAttempts(
  store: Map<string, AttemptRecord[]>,
): void {
  store.clear();
}
