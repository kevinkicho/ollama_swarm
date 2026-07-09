import type { StallBoardSnapshot, StallGateVerdict, StallRuleClass } from "./types.js";

export type { StallRuleClass };

const QUOTA_RE = /HTTP 429|session usage limit|rate limit exceeded/i;
const ALREADY_DONE_RE = /already (done|complete|exist)|completed by another|work appears to have been/i;
const OUT_OF_SCOPE_RE = /out of scope|not needed for|tests? not needed|not the current objective/i;

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
    case "healthy":
      return null;
    default:
      return null;
  }
}

export function shouldInvokeStallArbitrator(
  snap: StallBoardSnapshot,
  ruleClass: StallRuleClass,
  arbitratorCallsUsed: number,
  maxCalls: number,
): boolean {
  if (arbitratorCallsUsed >= maxCalls) return false;
  if (ruleClass === "transient-quota" || ruleClass === "healthy") return false;
  if (snap.stuckCycles >= 2) return true;
  return ruleClass === "ambiguous" || ruleClass === "replanner-skip-storm";
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