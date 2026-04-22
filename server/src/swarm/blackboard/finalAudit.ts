// Decides whether to fire one last auditor invocation after the main loop
// exits. Pure function — trivially unit-testable without spinning up the
// whole runner.
//
// Background: a cap:wall-clock run used to end with every unresolved
// criterion stuck at "unmet" by default, even when the committed work
// actually satisfied some of them or when shell-execution criteria should
// have been "wont-do". One final audit pass against the real committed/
// skipped state fixes that so the summary reflects reality.
//
// We only fire on cap trips. Natural completion already ran its audits
// in the loop; crashes and user stops skip it by design (see field docs).

export interface FinalAuditInput {
  /** Runner caught an exception during the audited-execution loop. */
  errored: boolean;
  /** First-pass contract was successfully emitted and has criteria. */
  hasContract: boolean;
  /** Every criterion already has a terminal status (met or wont-do). */
  allCriteriaResolved: boolean;
  /** terminationReason set by checkAndApplyCaps (cap:wall-clock etc.). */
  terminationReason: string | undefined;
  /** How many auditor invocations have already fired in the main loop. */
  auditInvocations: number;
  /** Hard cap on total invocations (runner constant). */
  maxInvocations: number;
  /** True when the stop came from the user, not a cap. */
  userStopped: boolean;
}

export function shouldRunFinalAudit(input: FinalAuditInput): boolean {
  // Crash path: the run already broke. A final audit would likely break
  // the same way and just delay the crash snapshot + summary.
  if (input.errored) return false;
  // No contract → nothing to audit. Pre-Phase-11b runs + runs where the
  // first-pass contract emission failed both land here.
  if (!input.hasContract) return false;
  // Everything already decided — final audit would be a no-op.
  if (input.allCriteriaResolved) return false;
  // Respect the hard cap. If the loop already spent every slot, the final
  // audit would push us above the runner's published max.
  if (input.auditInvocations >= input.maxInvocations) return false;
  // User stop is an explicit "end now" signal. Don't add another prompt
  // that might take up to 2 minutes — the user wanted out.
  if (input.userStopped) return false;
  // Natural "all-met" completion has no terminationReason; it also doesn't
  // need an audit (the last in-loop audit was what made it all-met).
  // Only cap trips produce a terminationReason AND leave criteria unmet.
  if (!input.terminationReason) return false;
  return true;
}
