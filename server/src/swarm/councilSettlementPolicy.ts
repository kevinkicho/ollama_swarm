/**
 * Autonomous / multi-cycle council settlement policy.
 *
 * Cycle results:
 *  - "retry" — more productive work remains (tier-up, new todos, stretch, stall backoff)
 *  - "stop"  — hard terminal (ambition-complete, audit-stuck, caps, planner-empty, gate stop)
 *  - "done"  — soft settlement (no contract / audit said done)
 *
 * Soft "done" is a **real** terminal. The outer loop must not clear
 * earlyStopDetail and spin empty cycles on autonomous runs — that made
 * "done" meaningless and hid true settlement reasons.
 */

export type CouncilCycleResult = "done" | "retry" | "stop";

export type CouncilLoopDecision =
  | { action: "continue"; delayMs: number }
  | { action: "break"; kind: "hard-stop" | "soft-done" | "resume-complete" | "closing" };

export interface CouncilSettlementContext {
  isAutonomous: boolean;
  executionOnlyResume: boolean;
  closingRequested: boolean;
  /** Present when a prior gate set a durable stop reason. Never clear on soft-done. */
  earlyStopDetail?: string;
}

/**
 * Decide outer-loop behavior after one council cycle.
 *
 * Autonomous open-endedness is expressed by audit/execution returning **"retry"**
 * when there is real work (stretch todos, tier promotion, unmet criteria).
 * It is **not** expressed by ignoring soft "done".
 */
export function decideCouncilLoopAfterCycle(
  result: CouncilCycleResult,
  ctx: CouncilSettlementContext,
): CouncilLoopDecision {
  if (result === "stop") {
    return { action: "break", kind: "hard-stop" };
  }
  if (result === "retry") {
    return { action: "continue", delayMs: 1000 };
  }
  // result === "done"
  if (ctx.executionOnlyResume) {
    return { action: "break", kind: "resume-complete" };
  }
  if (ctx.closingRequested) {
    return { action: "break", kind: "closing" };
  }
  // Soft settlement is terminal for finite AND autonomous runs.
  // (Autonomous used to continue forever here and wipe earlyStopDetail.)
  return { action: "break", kind: "soft-done" };
}

/** True when soft-done should mark the run completed (no early-stop chip). */
export function softDoneIsSuccessfulCompletion(earlyStopDetail: string | undefined): boolean {
  return !earlyStopDetail;
}
