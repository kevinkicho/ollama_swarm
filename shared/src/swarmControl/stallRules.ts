import type { StallBoardSnapshot, StallGateVerdict, StallRuleClass } from "./types.js";

export type { StallRuleClass };

const QUOTA_RE = /HTTP 429|session usage limit|rate limit exceeded/i;
const ALREADY_DONE_RE = /already (done|complete|exist)|completed by another|work appears to have been/i;
const OUT_OF_SCOPE_RE = /out of scope|not needed for|tests? not needed|not the current objective/i;

/** Storm classes that get a free rule verdict; arbitrator may escalate after stuckCycles. */
const STORM_CLASSES: readonly StallRuleClass[] = [
  "replanner-skip-storm",
  "skip-storm",
  "reject-storm",
];

export function classifyStallRules(snap: StallBoardSnapshot): StallRuleClass {
  if (snap.providerStall && QUOTA_RE.test(snap.providerStall)) {
    return "transient-quota";
  }
  if (snap.unmetCriteria > 0 && snap.recentReplannerSkips.length >= 3) {
    return "replanner-skip-storm";
  }
  if (snap.unmetCriteria > 0 && snap.skipped >= 5 && snap.committed === 0) {
    return "skip-storm";
  }
  if (snap.stale >= 3 && snap.committed === 0 && snap.open === 0) {
    return "reject-storm";
  }
  if (snap.total === 0 && snap.committed === 0) {
    return "no-activity";
  }
  // Zombie open board: todos open/claimed but nothing commits and criteria remain.
  // Do not treat as healthy once stuckCycles have accumulated.
  if (
    snap.open > 0
    && snap.committed === 0
    && snap.unmetCriteria > 0
    && snap.stuckCycles >= 2
  ) {
    return "ambiguous";
  }
  if (snap.open > 0 || snap.committed > 0) {
    return "healthy";
  }
  return "ambiguous";
}

/** Zero-token fast path before optional LLM arbitrator. */
export function ruleStallVerdict(
  snap: StallBoardSnapshot,
  ruleClass: StallRuleClass,
): StallGateVerdict | null {
  switch (ruleClass) {
    case "transient-quota":
      return {
        action: "backoff",
        source: "rule",
        rationale: "Provider quota/transport stall — wait before counting as stuck.",
        backoffMs: 120_000,
        confidence: "high",
      };
    case "replanner-skip-storm":
      return {
        action: "retry",
        source: "rule",
        rationale:
          "Replanner skipped multiple todos while criteria remain unmet — require disk-grounded revise, not skip.",
        plannerHint:
          "Several replanner skips were rejected: verify files on disk with read/glob before skip. "
          + "Do not waive test files or claim work is done without evidence.",
        confidence: "high",
      };
    case "skip-storm":
      return {
        action: "retry",
        source: "rule",
        rationale: "High skip count with zero commits and unmet criteria — re-scope todos smaller.",
        plannerHint:
          "Board shows many skips and no commits. Post smaller, file-specific todos grounded in repo layout.",
        confidence: "medium",
      };
    case "reject-storm":
      return {
        action: "retry",
        source: "rule",
        rationale: "Stale backlog without commits — workers likely failing JSON/hunk apply; use emit-first replans.",
        plannerHint:
          "Workers are staling without commits. Prefer single-file todos, smaller hunks, and build-kind for shell steps.",
        confidence: "medium",
      };
    case "no-activity":
      return {
        action: "retry",
        source: "rule",
        rationale:
          "No board activity (no todos / no commits) while the run is blocked — seed concrete file-level work.",
        plannerHint:
          "Board is empty. Post 1–3 small, grounded todos (real paths from REPO FILE LIST) targeting unmet criteria. "
          + "Avoid read-only or vague todos.",
        confidence: "medium",
      };
    case "healthy":
      return null;
    case "ambiguous":
      // Prefer arbitrator when allowed; rule fallback if arb unavailable.
      if (snap.stuckCycles >= 1) {
        return {
          action: "retry",
          source: "rule",
          rationale:
            "Board state is ambiguous after stuck cycle(s) — re-seed smaller todos before hard-stop floor.",
          plannerHint:
            "Stall gate ambiguous: re-read contract + board. Post fewer, single-file todos for remaining unmet criteria.",
          confidence: "low",
        };
      }
      return null;
    default:
      return null;
  }
}

/**
 * Whether to call the LLM arbitrator.
 * - Never for quota/healthy.
 * - Early for ambiguous / no-activity once stuckCycles >= 1 (avoid silent null).
 * - Escalate storms after stuckCycles >= 2 so rule templates can be overridden.
 */
export function shouldInvokeStallArbitrator(
  snap: StallBoardSnapshot,
  ruleClass: StallRuleClass,
  arbitratorCallsUsed: number,
  maxCalls: number,
): boolean {
  if (arbitratorCallsUsed >= maxCalls) return false;
  if (ruleClass === "transient-quota" || ruleClass === "healthy") return false;

  if (ruleClass === "ambiguous" || ruleClass === "no-activity") {
    return snap.stuckCycles >= 1;
  }

  if ((STORM_CLASSES as readonly string[]).includes(ruleClass)) {
    // First hit: free rule verdict only. Repeated stuck: escalate to arbitrator.
    return snap.stuckCycles >= 2;
  }

  return snap.stuckCycles >= 2;
}

export function summarizeStallForPrompt(snap: StallBoardSnapshot, ruleClass: StallRuleClass): string {
  const lines = [
    `ruleClass=${ruleClass}`,
    `board: open=${snap.open} stale=${snap.stale} skipped=${snap.skipped} committed=${snap.committed} total=${snap.total}`,
    `criteria: unmet=${snap.unmetCriteria}/${snap.totalCriteria}`,
    `stuckCycles=${snap.stuckCycles}`,
  ];
  if (snap.providerStall) lines.push(`providerStall=${snap.providerStall.slice(0, 200)}`);
  if (snap.recentStaleReasons.length) {
    lines.push("recentStale:", ...snap.recentStaleReasons.slice(0, 5).map((r) => `  - ${r.slice(0, 120)}`));
  }
  if (snap.recentSkipReasons.length) {
    lines.push("recentSkip:", ...snap.recentSkipReasons.slice(0, 5).map((r) => `  - ${r.slice(0, 120)}`));
  }
  if (snap.recentReplannerSkips.length) {
    lines.push(
      "recentReplannerSkip:",
      ...snap.recentReplannerSkips.slice(0, 5).map((r) => `  - ${r.slice(0, 120)}`),
    );
  }
  return lines.join("\n");
}

export function isQuotaOrTransport(msg: string): boolean {
  return QUOTA_RE.test(msg);
}

export function looksLikeAlreadyDoneSkip(reason: string): boolean {
  return ALREADY_DONE_RE.test(reason);
}

export function looksLikeOutOfScopeSkip(reason: string): boolean {
  return OUT_OF_SCOPE_RE.test(reason);
}
