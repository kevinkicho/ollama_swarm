// R6 (2026-05-04): drain-by-default stop policy.
//
// Today: clicking Stop hard-kills mid-turn. That throws away whatever
// the agent was about to land + leaves SSE streams hanging.
//
// New: first Stop = drain (finish current turn, then stop). Second
// Stop within 5s = hard kill (the user really means it).
//
// Pure: caller tracks the timestamp of the last stop click and passes
// it in. Helper returns the action.

export const DOUBLE_CLICK_WINDOW_MS = 5_000;

export type StopAction = "drain" | "kill";

export interface StopDecisionInput {
  /** Current wall-clock (ms). */
  now: number;
  /** Wall-clock of the previous Stop click on this run, or null
   *  when no prior click is recorded. */
  lastStopAt: number | null;
  /** Override the double-click window (mostly for tests). */
  windowMs?: number;
}

export interface StopDecision {
  action: StopAction;
  reason: string;
}

/** Decide whether the incoming Stop request should drain or hard-kill.
 *  - First click (lastStopAt == null) → drain
 *  - Second click within window → kill
 *  - Second click after window → drain again (treat as fresh) */
export function decideStopAction(input: StopDecisionInput): StopDecision {
  const { now, lastStopAt, windowMs = DOUBLE_CLICK_WINDOW_MS } = input;
  if (lastStopAt == null) {
    return {
      action: "drain",
      reason: "first stop click — drain to end-of-turn",
    };
  }
  const elapsed = now - lastStopAt;
  if (elapsed >= 0 && elapsed <= windowMs) {
    return {
      action: "kill",
      reason: `second stop click after ${elapsed}ms (within ${windowMs}ms window) — hard kill`,
    };
  }
  return {
    action: "drain",
    reason: `prior stop was ${elapsed}ms ago (outside ${windowMs}ms window) — treat as fresh, drain`,
  };
}
