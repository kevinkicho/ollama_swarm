// Partial RunConfig fields — RunConfigThinkGuard
export interface RunConfigThinkGuard {
  /**
   * Think-stream referee checkpoint (design: docs/design/think-guard-referee-checkpoint.md).
   * When enabled, soft-tier think-only aborts trigger a cheap referee triage before discard.
   */
  thinkGuardRefereeEnabled?: boolean;
  thinkGuardRefereeModel?: string;
  thinkGuardRefereeMaxCallsPerRun?: number;
  thinkGuardRefereeMinThinkChars?: number;
  thinkGuardRefereeThinkTailMinChars?: number;
  thinkGuardRefereeThinkTailMaxChars?: number;
  thinkGuardRefereeMaxOutputTokens?: number;
  /** Runtime: referee calls consumed this run (mutable mid-run). */
  thinkGuardRefereeCallsUsed?: number;
}
