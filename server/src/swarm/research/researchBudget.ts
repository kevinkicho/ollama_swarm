/**
 * Shared literature/research blackout + integrity counters (RR-C).
 * Used by council + blackboard literature pre-passes.
 */

export const LITERATURE_BLACKOUT_AFTER = 3;
/** Soft process budget: failed web literature attempts per run. */
export const RESEARCH_FAIL_BUDGET_PER_RUN = 12;

export interface ResearchIntegrityReport {
  searchAttempts: number;
  searchSuccesses: number;
  failByBackend: Record<string, number>;
  http403Count: number;
  catalogInjects: number;
  blackoutActive: boolean;
  usableBriefs: number;
  unusableBriefs: number;
  budgetExhausted: boolean;
  consecutiveFailures: number;
}

interface ResearchBudgetState {
  consecutiveFailures: number;
  blackoutActive: boolean;
  lastReason?: string;
  searchAttempts: number;
  searchSuccesses: number;
  failByBackend: Record<string, number>;
  http403Count: number;
  catalogInjects: number;
  usableBriefs: number;
  unusableBriefs: number;
  failedSearches: number;
}

const byRun = new Map<string, ResearchBudgetState>();
let lastRunId: string | null = null;

function fresh(): ResearchBudgetState {
  return {
    consecutiveFailures: 0,
    blackoutActive: false,
    searchAttempts: 0,
    searchSuccesses: 0,
    failByBackend: {},
    http403Count: 0,
    catalogInjects: 0,
    usableBriefs: 0,
    unusableBriefs: 0,
    failedSearches: 0,
  };
}

function resolve(runId?: string | null): ResearchBudgetState {
  const id = (runId ?? lastRunId ?? "").trim() || "_default";
  let s = byRun.get(id);
  if (!s) {
    s = fresh();
    byRun.set(id, s);
  }
  return s;
}

export function startResearchBudget(runId?: string | null): void {
  const id = (runId ?? "").trim() || "_default";
  lastRunId = id;
  byRun.set(id, fresh());
}

export function isResearchBlackout(runId?: string | null): boolean {
  const s = resolve(runId);
  return s.blackoutActive || s.failedSearches >= RESEARCH_FAIL_BUDGET_PER_RUN;
}

export function getResearchBlackoutReason(runId?: string | null): string | undefined {
  return resolve(runId).lastReason;
}

export function noteResearchAttempt(runId?: string | null): void {
  resolve(runId).searchAttempts += 1;
}

export function noteResearchSuccess(runId?: string | null): void {
  const s = resolve(runId);
  s.searchSuccesses += 1;
  s.usableBriefs += 1;
  s.consecutiveFailures = 0;
}

export function noteResearchFailure(
  reason: string,
  runId?: string | null,
  opts?: { backend?: string; http403?: boolean },
): { blackoutJustActivated: boolean } {
  const s = resolve(runId);
  s.consecutiveFailures += 1;
  s.failedSearches += 1;
  s.unusableBriefs += 1;
  s.lastReason = reason.slice(0, 160);
  if (opts?.backend) {
    s.failByBackend[opts.backend] = (s.failByBackend[opts.backend] ?? 0) + 1;
  }
  if (opts?.http403 || /403/.test(reason)) {
    s.http403Count += 1;
  }
  let blackoutJustActivated = false;
  if (
    !s.blackoutActive &&
    (s.consecutiveFailures >= LITERATURE_BLACKOUT_AFTER ||
      s.failedSearches >= RESEARCH_FAIL_BUDGET_PER_RUN)
  ) {
    s.blackoutActive = true;
    blackoutJustActivated = true;
  }
  return { blackoutJustActivated };
}

export function noteCatalogInject(runId?: string | null): void {
  resolve(runId).catalogInjects += 1;
}

export function snapshotResearchIntegrity(
  runId?: string | null,
): ResearchIntegrityReport | undefined {
  const id = (runId ?? lastRunId ?? "").trim() || "_default";
  const s = byRun.get(id);
  if (!s) return undefined;
  if (
    s.searchAttempts === 0 &&
    s.catalogInjects === 0 &&
    s.usableBriefs === 0 &&
    s.unusableBriefs === 0 &&
    !s.blackoutActive
  ) {
    return undefined;
  }
  return {
    searchAttempts: s.searchAttempts,
    searchSuccesses: s.searchSuccesses,
    failByBackend: { ...s.failByBackend },
    http403Count: s.http403Count,
    catalogInjects: s.catalogInjects,
    blackoutActive: s.blackoutActive,
    usableBriefs: s.usableBriefs,
    unusableBriefs: s.unusableBriefs,
    budgetExhausted: s.failedSearches >= RESEARCH_FAIL_BUDGET_PER_RUN,
    consecutiveFailures: s.consecutiveFailures,
  };
}

/** Drop budget after summary so long-lived servers don't accumulate run keys. */
export function clearResearchBudget(runId?: string | null): void {
  if (runId?.trim()) {
    const id = runId.trim();
    byRun.delete(id);
    if (lastRunId === id) lastRunId = null;
    return;
  }
  byRun.clear();
  lastRunId = null;
}
