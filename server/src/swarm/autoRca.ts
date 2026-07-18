// R15 (2026-05-04): auto-RCA on non-clean stop.
//
// When a run terminates without commits (or hits a wall before its
// natural end), the user shouldn't have to grep the transcript to
// figure out why. This helper takes:
//   - the final phase
//   - the structured terminationReason
//   - the list of ClassifiedError records the run accumulated
//   - the commits + tier counts
// and produces a 1–3 paragraph RCA: primary cause + suggested next
// action.
//
// Pure: no I/O. Caller pipes the RCA into the swarm-summary file.

import {
  type ClassifiedError,
  type ErrorCategory,
  aggregateByCategory,
} from "./errorTaxonomy.js";

export interface RcaInput {
  /** Phase at termination (e.g. "executing", "paused", "completed"). */
  finalPhase: string;
  /** stopReason / terminationReason as recorded by the runner. */
  terminationReason: string | null | undefined;
  /** Every classified error the run produced. Empty when no failures. */
  errors: readonly ClassifiedError[];
  /** Commits actually landed (used to detect "ran but produced nothing"). */
  commitsLanded: number;
  /** Tier achieved by the verifier (0 = nothing useful). */
  tier: number;
  /** Wall-clock duration in ms (used to flag "died too fast"). */
  durationMs: number;
}

export interface RcaReport {
  /** True when the run was *not* a clean success (worth surfacing). */
  needsAttention: boolean;
  /** The single most-load-bearing cause string. */
  primaryCause: string;
  /** Other notable contributors (max 3). */
  secondaryCauses: string[];
  /** Concrete next-step recommendation. */
  recommendation: string;
  /** Pre-rendered markdown for direct injection into summary file. */
  markdown: string;
}

const FAST_DEATH_MS = 30_000;

export function generateRca(input: RcaInput): RcaReport {
  const {
    finalPhase,
    terminationReason,
    errors,
    commitsLanded,
    tier,
    durationMs,
  } = input;
  const cleanSuccess =
    finalPhase === "completed" && commitsLanded > 0 && tier > 0;
  if (cleanSuccess) {
    return {
      needsAttention: false,
      primaryCause: "clean success",
      secondaryCauses: [],
      recommendation: "no action needed",
      markdown: "",
    };
  }
  const counts = aggregateByCategory(errors);
  const ranked = rankCategories(counts);
  // Primary cause selection
  let primaryCause: string;
  if (ranked.length > 0) {
    const [category, count] = ranked[0];
    primaryCause = `${describeCategory(category)} (${count} occurrence${count === 1 ? "" : "s"})`;
  } else if (terminationReason) {
    primaryCause = `Terminated by: ${terminationReason}`;
  } else if (durationMs < FAST_DEATH_MS) {
    primaryCause = `Run died after ${(durationMs / 1000).toFixed(1)}s — likely startup failure`;
  } else if (commitsLanded === 0) {
    primaryCause = `Run completed all turns but produced 0 commits`;
  } else if (
    /user|user-stop|stopped/i.test(String(terminationReason ?? finalPhase))
  ) {
    primaryCause =
      `User stop — phase=${finalPhase}, ${commitsLanded} commit(s), tier ${tier}` +
      (errors.length > 0
        ? ` (${errors.length} classified error(s) before stop)`
        : "");
  } else {
    primaryCause = `Incomplete run — phase=${finalPhase}, ${commitsLanded} commits, tier ${tier}`;
  }
  const secondaryCauses = ranked
    .slice(1, 4)
    .map(([cat, n]) => `${describeCategory(cat)} (${n}x)`);
  // Recommendation
  const recommendation = buildRecommendation({
    ranked,
    terminationReason,
    durationMs,
    commitsLanded,
    tier,
  });
  return {
    needsAttention: true,
    primaryCause,
    secondaryCauses,
    recommendation,
    markdown: renderMarkdown({
      finalPhase,
      terminationReason,
      commitsLanded,
      tier,
      durationMs,
      primaryCause,
      secondaryCauses,
      recommendation,
      counts,
    }),
  };
}

/** Sort error categories by count, ignoring zero-count entries. */
function rankCategories(
  counts: Record<ErrorCategory, number>,
): Array<[ErrorCategory, number]> {
  return (Object.entries(counts) as Array<[ErrorCategory, number]>)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
}

function describeCategory(c: ErrorCategory): string {
  switch (c) {
    case "quota":
      return "Provider quota walls";
    case "network":
      return "Transient network failures";
    case "timeout":
      return "Request timeouts";
    case "model-output":
      return "Malformed / empty model outputs";
    case "auth":
      return "Authentication failures";
    case "disk":
      return "Disk / filesystem errors";
    case "oom":
      return "Out-of-memory";
    case "runner-bug":
      return "Internal invariant failures";
    case "user-stop":
      return "User-initiated stops";
    case "cap":
      return "Hard caps (wall-clock / commits / todos)";
    case "git":
      return "Git operation failures";
    case "unknown":
      return "Unclassified failures";
  }
}

function buildRecommendation(input: {
  ranked: Array<[ErrorCategory, number]>;
  terminationReason: string | null | undefined;
  durationMs: number;
  commitsLanded: number;
  tier: number;
}): string {
  const top = input.ranked[0]?.[0];
  switch (top) {
    case "quota":
      return "Configure a provider failover chain (cfg.providerFailover) or schedule the run after the quota window resets.";
    case "auth":
      return "Verify API keys in .env are still valid for the configured provider.";
    case "network":
    case "timeout":
      return "Likely transient. Re-run; if it recurs, check the provider's status page or DNS.";
    case "model-output":
      return "Switch to a stronger model or enable cfg.universalJsonRepair to recover from malformed outputs.";
    case "disk":
      return "Free up disk space at the clone parent; preflight check refuses runs below 2 GB.";
    case "oom":
      return "Restart with --max-old-space-size=4096 (or higher) and consider cfg.memoryBackpressure.";
    case "runner-bug":
      return "File a bug — the run hit an internal invariant. Include the transcript + run-state.json.";
    case "cap":
      return "Increase the relevant cap in cfg or shorten the directive so the swarm fits inside it.";
    case "git":
      return "Inspect the clone's git status manually; the swarm hit a state we can't recover from.";
  }
  if (input.commitsLanded === 0 && input.tier === 0 && input.durationMs > 60_000) {
    return "Run finished without producing artifacts — try a smaller, more concrete directive or raise the rounds cap.";
  }
  if (/user|user-stop/i.test(String(input.terminationReason ?? ""))) {
    return (
      "User stopped the run — check pending-commit drain, skipped todos (tool-loop / pure-think), " +
      "and whether autoApprove shipped unreviewed hunks. Resume with a focused re-run on unmet criteria."
    );
  }
  if (input.terminationReason) {
    return `Termination reason was "${input.terminationReason}" — review the transcript for context.`;
  }
  if (input.ranked.some(([c]) => c === "model-output")) {
    return "Malformed/empty model outputs dominated — switch worker models or enable sibling failover for pure-think failures.";
  }
  return "Review skipped todos and stream/transcript-cap events in the run summary; re-run with a narrower directive if needed.";
}

function renderMarkdown(input: {
  finalPhase: string;
  terminationReason: string | null | undefined;
  commitsLanded: number;
  tier: number;
  durationMs: number;
  primaryCause: string;
  secondaryCauses: string[];
  recommendation: string;
  counts: Record<ErrorCategory, number>;
}): string {
  const lines: string[] = [];
  lines.push("## Auto-RCA");
  lines.push("");
  lines.push(`**Primary cause:** ${input.primaryCause}`);
  if (input.secondaryCauses.length > 0) {
    lines.push("");
    lines.push("**Other contributors:**");
    for (const s of input.secondaryCauses) lines.push(`- ${s}`);
  }
  lines.push("");
  lines.push(`**Recommendation:** ${input.recommendation}`);
  lines.push("");
  lines.push(
    `**Run metadata:** phase=${input.finalPhase}, commits=${input.commitsLanded}, tier=${input.tier}, duration=${(input.durationMs / 1000).toFixed(1)}s`,
  );
  if (input.terminationReason) {
    lines.push(`**Termination reason:** ${input.terminationReason}`);
  }
  const errorTable = (Object.entries(input.counts) as Array<[string, number]>)
    .filter(([, n]) => n > 0)
    .map(([cat, n]) => `- ${cat}: ${n}`);
  if (errorTable.length > 0) {
    lines.push("");
    lines.push("**Error counts by category:**");
    lines.push(...errorTable);
  }
  return lines.join("\n");
}
