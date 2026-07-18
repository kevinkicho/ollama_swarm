/**
 * Shared "was this cycle productive?" signal for autonomous settlement.
 * Used by council audit and blackboard tier stuck gates.
 *
 * Durable progress (resets zero-progress streak / justifies open-ended continue):
 *   - commits this cycle
 *   - criteria met flips that are NOT skip-only promotions
 *   - ambition tier promotion installed
 *
 * Non-durable activity (does NOT reset streak):
 *   - new todos enqueued alone (auditor/stretch/planner can thrash forever)
 *   - skip→met promotions without commits (disk may still be wrong)
 */

export interface ProductiveCycleSignals {
  /** Criteria that flipped unmet → met this cycle (all sources). */
  metFlips: number;
  /** Ledger / git commits that advanced work this cycle. */
  commitsThisCycle: number;
  /**
   * New todos enqueued this cycle. Counted for logging / activity only —
   * does **not** count as durable progress (prevents stretch/audit spin).
   */
  newTodos: number;
  /** Ambition tier promotion succeeded. */
  tierPromoted?: boolean;
  /**
   * Subset of metFlips that came only from worker skip reconciliation
   * ("already done") without a commit. Subtracted from durable met flips.
   */
  skipOnlyMetFlips?: number;
}

/** Met flips that represent real settlement (not skip-only promotion). */
export function durableMetFlips(s: ProductiveCycleSignals): number {
  return Math.max(0, (s.metFlips ?? 0) - (s.skipOnlyMetFlips ?? 0));
}

/**
 * True when the cycle made durable progress worth resetting the autonomous
 * zero-progress streak. Board thrash (new todos / skip-met only) is not enough.
 */
export function isDurableProgress(s: ProductiveCycleSignals): boolean {
  return (
    durableMetFlips(s) > 0
    || (s.commitsThisCycle ?? 0) > 0
    || s.tierPromoted === true
  );
}

/**
 * Alias used by call sites: autonomous gates treat "productive" as durable.
 * Prefer isDurableProgress in new code.
 */
export function isProductiveCycle(s: ProductiveCycleSignals): boolean {
  return isDurableProgress(s);
}

/** True when the cycle did *something* (for logs only). */
export function isActiveCycle(s: ProductiveCycleSignals): boolean {
  return (
    isDurableProgress(s)
    || (s.newTodos ?? 0) > 0
    || (s.skipOnlyMetFlips ?? 0) > 0
  );
}

/** Default consecutive zero-progress cycles before autonomous hard-stop. */
export const DEFAULT_ZERO_PROGRESS_LIMIT = 3;

/**
 * Update a zero-progress streak.
 * Returns the new streak and whether the run should stop.
 */
export function updateZeroProgressStreak(
  prev: number,
  productive: boolean,
  limit: number = DEFAULT_ZERO_PROGRESS_LIMIT,
): { streak: number; shouldStop: boolean } {
  if (productive) return { streak: 0, shouldStop: false };
  const streak = prev + 1;
  return { streak, shouldStop: streak >= limit };
}

export function formatNoProductiveProgressReason(streak: number): string {
  return (
    `no-productive-progress: ${streak} cycle(s) without commits, durable met flips, or tier promotion`
  );
}

/**
 * Max open-ended stretch waves per autonomous council run.
 * Raised from 1 → 3 so long directive runs (e.g. 120b2044: 2h+ of real
 * commits then planner-empty) can keep progressing instead of hard-stopping.
 */
export const MAX_STRETCH_WAVES_PER_RUN = 3;

/**
 * Max deterministic "criterion progress" seed waves when audit + planner
 * both return empty but unmet criteria remain. Affirmative recovery path —
 * keeps the run moving with grounded file-level work.
 */
export const MAX_CRITERION_PROGRESS_WAVES_PER_RUN = 5;

export interface UnmetCriterionSeed {
  id?: string;
  description: string;
  expectedFiles: string[];
}

export interface CriterionProgressTodo {
  description: string;
  expectedFiles: string[];
  criterionId?: string;
  createdBy: "criterion-progress";
}

/**
 * Deterministically mint concrete todos from unmet criteria so the run can
 * continue without waiting for another LLM invent cycle (120b2044 early-stop).
 * Prefer criteria with expectedFiles; skip empty/file-less shells.
 */
export function mintProgressTodosFromUnmetCriteria(
  unmet: readonly UnmetCriterionSeed[],
  opts?: {
    maxTodos?: number;
    /** Descriptions/file signatures of todos already permanent-skipped. */
    avoidSignatures?: ReadonlySet<string>;
    /** Extra files to attach when a criterion lists none. */
    fallbackFiles?: readonly string[];
  },
): CriterionProgressTodo[] {
  const maxTodos = Math.max(1, Math.min(12, opts?.maxTodos ?? 8));
  const avoid = opts?.avoidSignatures ?? new Set<string>();
  const out: CriterionProgressTodo[] = [];

  for (const c of unmet) {
    if (out.length >= maxTodos) break;
    let files = (c.expectedFiles ?? [])
      .map((f) => String(f).replace(/\\/g, "/").trim())
      .filter(Boolean)
      .slice(0, 2);
    if (files.length === 0 && opts?.fallbackFiles?.length) {
      files = opts.fallbackFiles.slice(0, 2).map((f) => f.replace(/\\/g, "/"));
    }
    if (files.length === 0) continue;

    const descCore = (c.description || "unmet criterion").trim().slice(0, 360);
    const description =
      `Progress on unmet criterion${c.id ? ` (${c.id})` : ""}: ${descCore}. ` +
      `Land a concrete, verifiable edit in the listed file(s) — expand content, fix gaps, ` +
      `or finish the remaining requirement (do not only re-read).`;
    const sig = todoProgressSignature(description, files);
    if (avoid.has(sig)) continue;
    // Also skip if any avoid entry shares the same file set + short desc head
    const fileKey = files.join("|");
    let blocked = false;
    for (const a of avoid) {
      if (a.includes(fileKey) && a.includes(descCore.slice(0, 40))) {
        blocked = true;
        break;
      }
    }
    if (blocked) continue;

    out.push({
      description,
      expectedFiles: files,
      ...(c.id ? { criterionId: c.id } : {}),
      createdBy: "criterion-progress",
    });
  }
  return out;
}

export function todoProgressSignature(
  description: string,
  expectedFiles: readonly string[],
): string {
  const d = description.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 120);
  const f = expectedFiles
    .map((x) => x.replace(/\\/g, "/").toLowerCase())
    .sort()
    .join(",");
  return `${d}::${f}`;
}
