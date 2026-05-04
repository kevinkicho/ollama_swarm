// Q10 (2026-05-04): pre-flight verify dry-run for blackboard.
//
// Default behavior: workers commit hunks → auditor checks → if
// verify (cfg.verifyCommand) fails or auditor returns FALSE,
// auto-rollback wipes the commit. The cycle is "act first, check
// after" — efficient when commits usually pass, expensive when
// they often fail.
//
// This lever flips to "check first, act after": before committing,
// stage the hunk in a temporary git stash / branch, run
// cfg.verifyCommand against the staged state, and ONLY commit if
// verify passes. Catches breakage at the worker turn, not at the
// auditor turn or post-rollback.
//
// Pure helpers ship here:
//   - `decideDryRunOutcome` — given a verify result, pick commit | skip | replan
//   - `buildDryRunFailurePromptAddendum` — text for the worker's
//     re-prompt when verify fails (so they re-attempt with the
//     verify error in context)
//
// Tradeoffs:
//   - 2× wall-clock per todo (the verify runs once now + after-commit
//     verify still runs as a backstop).
//   - Only useful when cfg.verifyCommand is set; no-op otherwise.
//   - Doesn't interact with the existing auto-rollback — they're
//     defense-in-depth: pre-flight catches MOST breakages; auto-
//     rollback catches what slips through (e.g., test that fails
//     only when a sibling hunk lands later).

export type DryRunOutcome = "commit" | "skip" | "replan";

export interface DryRunVerifyResult {
  /** True when cfg.verifyCommand exited with code 0. */
  ok: boolean;
  /** Exit code from the verify command (NaN if it didn't run). */
  exitCode: number;
  /** Captured stderr (truncated by caller as needed). */
  stderr: string;
}

/** Decide what to do given the dry-run verify result. Pure. */
export function decideDryRunOutcome(args: {
  result: DryRunVerifyResult;
  /** Number of times this todo has been retried already. Capped to
   *  prevent re-prompt loops. */
  retriesSoFar: number;
  /** Cap before a verify-fail moves the todo to "skip" instead of
   *  another replan attempt. Default 2. */
  maxRetries?: number;
}): DryRunOutcome {
  if (args.result.ok) return "commit";
  const max = args.maxRetries ?? 2;
  if (args.retriesSoFar >= max) return "skip";
  return "replan";
}

/** Build the prompt addendum the worker sees on a re-attempt after a
 *  pre-flight verify failure. Includes the failing exit code + stderr
 *  so the model has the actual error in context, not just "verify
 *  failed". Pure. */
export function buildDryRunFailurePromptAddendum(args: {
  exitCode: number;
  stderr: string;
  retriesSoFar: number;
  maxRetries?: number;
}): string {
  const max = args.maxRetries ?? 2;
  const remaining = Math.max(0, max - args.retriesSoFar);
  const stderrLines = (args.stderr || "(no stderr captured)").trim().split("\n");
  const truncatedStderr =
    stderrLines.length > 30
      ? [...stderrLines.slice(0, 30), `… (${stderrLines.length - 30} more lines truncated)`]
      : stderrLines;
  return [
    "=== Pre-flight verify FAILED on your prior attempt ===",
    `The verify command (cfg.verifyCommand) exited with code ${args.exitCode}.`,
    `Retries remaining for this todo: ${remaining} (after ${args.retriesSoFar} failed attempts).`,
    "",
    "Verify stderr:",
    ...truncatedStderr.map((l) => `  ${l}`),
    "",
    "Re-emit hunks that ADDRESS the verify failure above. If the failure",
    "is genuinely outside this todo's scope (e.g., a pre-existing test",
    "failure that this todo was never going to fix), emit a `skip` envelope",
    "with `reason: pre-flight-verify-out-of-scope`.",
    "=== End pre-flight verify failure context ===",
  ].join("\n");
}
