/**
 * Apply / repair integrity aggregate for run summary.json.
 * Mirrors streamIntegrityReport: optional field, pure helpers, back-compat.
 *
 * Counters are live-mutated on apply + repair paths (council, blackboard,
 * wrap-up); snapshot at summary time. Older summary.json files omit the field.
 */

export interface ApplyIntegrityReport {
  /** Times applyHunks / applyAndCommit was attempted (real apply paths). */
  attempts: number;
  /** Successful applies (writes accepted / commit path ok). */
  applied: number;
  /** Counts of structured ApplyMissKind (and "other" when unclassified). */
  missByKind: Record<string, number>;
  /** Grounded hunk-repair re-prompts that produced applyable hunks. */
  repairSuccesses: number;
  /** Grounded hunk-repair attempts that still failed or could not parse. */
  repairFailures: number;
  /**
   * First-pass apply misses that later landed via deterministic uniqueCandidates
   * rewrite (not terminal failure). Optional for older summaries.
   */
  missRecoveredDet?: number;
  /** First-pass misses recovered via LLM grounded repair. */
  missRecoveredLlm?: number;
  /** Misses that remained after all recovery in that attempt (terminal). */
  missTerminal?: number;
}

/** Mutable run-scoped counters; runners pass this object or use the server registry. */
export type ApplyIntegrityCounters = {
  attempts: number;
  applied: number;
  missByKind: Record<string, number>;
  repairSuccesses: number;
  repairFailures: number;
  missRecoveredDet: number;
  missRecoveredLlm: number;
  missTerminal: number;
};

export function createApplyIntegrityCounters(): ApplyIntegrityCounters {
  return {
    attempts: 0,
    applied: 0,
    missByKind: Object.create(null) as Record<string, number>,
    repairSuccesses: 0,
    repairFailures: 0,
    missRecoveredDet: 0,
    missRecoveredLlm: 0,
    missTerminal: 0,
  };
}

export function recordApplyAttempt(c: ApplyIntegrityCounters): void {
  c.attempts += 1;
}

export function recordApplySuccess(c: ApplyIntegrityCounters): void {
  c.applied += 1;
}

export function recordApplyMiss(c: ApplyIntegrityCounters, kind: string): void {
  const k = kind && kind.trim() ? kind.trim() : "other";
  c.missByKind[k] = (c.missByKind[k] ?? 0) + 1;
}

export function recordRepairSuccess(c: ApplyIntegrityCounters): void {
  c.repairSuccesses += 1;
}

export function recordRepairFailure(c: ApplyIntegrityCounters): void {
  c.repairFailures += 1;
}

export function recordMissRecoveredDet(c: ApplyIntegrityCounters): void {
  c.missRecoveredDet += 1;
}

export function recordMissRecoveredLlm(c: ApplyIntegrityCounters): void {
  c.missRecoveredLlm += 1;
}

export function recordMissTerminal(c: ApplyIntegrityCounters): void {
  c.missTerminal += 1;
}

/**
 * Snapshot for summary.json. Returns undefined when nothing happened so the
 * optional field stays absent (back-compat with old consumers / clean runs).
 */
export function snapshotApplyIntegrity(
  c: ApplyIntegrityCounters | null | undefined,
): ApplyIntegrityReport | undefined {
  if (!c) return undefined;
  const missKeys = Object.keys(c.missByKind);
  const hasMiss = missKeys.some((k) => (c.missByKind[k] ?? 0) > 0);
  if (
    c.attempts === 0
    && c.applied === 0
    && !hasMiss
    && c.repairSuccesses === 0
    && c.repairFailures === 0
    && c.missRecoveredDet === 0
    && c.missRecoveredLlm === 0
    && c.missTerminal === 0
  ) {
    return undefined;
  }
  const missByKind: Record<string, number> = {};
  for (const k of missKeys) {
    const n = c.missByKind[k] ?? 0;
    if (n > 0) missByKind[k] = n;
  }
  return {
    attempts: c.attempts,
    applied: c.applied,
    missByKind,
    repairSuccesses: c.repairSuccesses,
    repairFailures: c.repairFailures,
    ...(c.missRecoveredDet > 0 ? { missRecoveredDet: c.missRecoveredDet } : {}),
    ...(c.missRecoveredLlm > 0 ? { missRecoveredLlm: c.missRecoveredLlm } : {}),
    ...(c.missTerminal > 0 ? { missTerminal: c.missTerminal } : {}),
  };
}
