import type { ExitCriterion } from "./blackboard/types.js";
import type { CouncilProgressLedger } from "./councilProgressLedger.js";
import { skipCoversCriterionFiles } from "./councilSkipReconcile.js";

const EXECUTABLE_EXT = /\.(py|json|ts|js|mjs|cjs|tsx|jsx)$/i;
const EXECUTABLE_PATH = /^(tests?\/|scripts\/|run_pipeline)/i;

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Criterion expects runnable code, structured data, or integration tests — not docs-only. */
export function isExecutableCriterion(criterion: ExitCriterion): boolean {
  if (criterion.expectedFiles.length === 0) return false;
  const desc = criterion.description.toLowerCase();
  if (
    /\b(implement|function|script|test suite|integration test|unit test|ml model|retrain|pipeline|module)\b/.test(
      desc,
    )
  ) {
    return true;
  }
  return criterion.expectedFiles.some(
    (f) => EXECUTABLE_EXT.test(f) || EXECUTABLE_PATH.test(normalizePath(f)),
  );
}

/** Count ledger fail observations overlapping criterion files (recent cycles). */
export function ledgerFailCountForCriterion(
  ledger: CouncilProgressLedger,
  criterion: ExitCriterion,
  opts: { minCycle?: number } = {},
): number {
  const minCycle = opts.minCycle ?? 0;
  let n = 0;
  for (const o of ledger.observations) {
    if (o.kind !== "fail" || o.cycle < minCycle) continue;
    if (!o.files?.length) {
      if (criterion.expectedFiles.some((f) => o.text.includes(f))) n++;
      continue;
    }
    if (skipCoversCriterionFiles(o.files, criterion.expectedFiles)) n++;
  }
  return n;
}

/** True when ledger records a commit touching this criterion's expected files. */
export function ledgerHasCommitForCriterion(
  ledger: CouncilProgressLedger,
  criterion: ExitCriterion,
): boolean {
  return ledger.observations.some(
    (o) =>
      o.kind === "commit" &&
      o.files?.length &&
      skipCoversCriterionFiles(o.files, criterion.expectedFiles),
  );
}

/** Promote unmet criteria when execution ledger shows commits on their files. */
export function reconcileCriteriaFromLedger(
  ledger: CouncilProgressLedger,
  criteria: ExitCriterion[],
  committedFiles: readonly string[] = [],
): { criteria: ExitCriterion[]; promotedIds: string[] } {
  const committed = new Set(committedFiles.map(normalizePath));
  const promotedIds: string[] = [];

  const updated = criteria.map((c) => {
    if (c.status !== "unmet") return c;
    if (c.expectedFiles.length === 0) return c;

    const hasLedgerCommit = ledgerHasCommitForCriterion(ledger, c);
    const allCommitted = c.expectedFiles.every((f) => committed.has(normalizePath(f)));

    if (!hasLedgerCommit && !allCommitted) return c;

    if (isExecutableCriterion(c) && !hasLedgerCommit) return c;

    promotedIds.push(c.id);
    return {
      ...c,
      status: "met" as const,
      rationale: hasLedgerCommit
        ? "Ledger: worker commit on expected files"
        : "Committed files cover criterion",
    };
  });

  return { criteria: updated, promotedIds };
}

/** Stable signature of recent fail observations for unmet criteria (stuck detection). */
export function buildUnmetFailSignature(
  ledger: CouncilProgressLedger,
  unmetIds: ReadonlySet<string>,
  criteria: readonly ExitCriterion[],
  cycle: number,
): string {
  const targetFiles = new Set<string>();
  for (const c of criteria) {
    if (!unmetIds.has(c.id)) continue;
    for (const f of c.expectedFiles) targetFiles.add(normalizePath(f));
  }
  if (targetFiles.size === 0) return "";

  const parts: string[] = [];
  for (const o of ledger.observations) {
    if (o.kind !== "fail" || o.cycle < cycle - 1) continue;
    const overlaps =
      (o.files?.length &&
        o.files.some((f) => targetFiles.has(normalizePath(f)))) ||
      (!o.files?.length &&
        [...targetFiles].some((f) => o.text.includes(f)));
    if (overlaps) parts.push(o.text.slice(0, 100));
  }
  return parts.sort().join("|");
}

/** True when this cycle landed a commit touching still-unmet criterion files. */
export function hasCommitProgressOnUnmet(
  ledger: CouncilProgressLedger,
  unmetIds: ReadonlySet<string>,
  criteria: readonly ExitCriterion[],
  cycle: number,
): boolean {
  const targetFiles = new Set<string>();
  for (const c of criteria) {
    if (!unmetIds.has(c.id)) continue;
    for (const f of c.expectedFiles) targetFiles.add(normalizePath(f));
  }
  if (targetFiles.size === 0) return false;

  return ledger.observations.some(
    (o) =>
      o.kind === "commit" &&
      o.cycle === cycle &&
      o.files?.some((f) => targetFiles.has(normalizePath(f))),
  );
}

export interface FallbackMetDecision {
  met: boolean;
  reason: string;
}

/**
 * Whether fallback file-check may mark a criterion met (conservative).
 * Requires ledger commit for executable criteria; blocks when fails repeat.
 */
export function fallbackMayMarkMet(
  criterion: ExitCriterion,
  ledger: CouncilProgressLedger,
  hasPlaceholder: boolean,
): FallbackMetDecision {
  if (hasPlaceholder) {
    return { met: false, reason: "placeholder content in expected files" };
  }

  const failCount = ledgerFailCountForCriterion(ledger, criterion);
  if (failCount >= 1) {
    return { met: false, reason: `${failCount} ledger fail(s) on overlapping files` };
  }

  if (isExecutableCriterion(criterion)) {
    if (!ledgerHasCommitForCriterion(ledger, criterion)) {
      return { met: false, reason: "executable criterion requires ledger commit, not file-exists alone" };
    }
  }

  return { met: true, reason: "files present without placeholder signals" };
}