// R7 (2026-05-04): pause runs when no browser is watching.
//
// If the user closes the browser tab mid-run, today the swarm keeps
// burning quota / disk. We don't want it to die outright (cron/CLI
// callers also have no browser), but in the interactive case there's
// no point streaming output to nobody.
//
// Heuristic: pause new-turn dispatch when the WS subscriber count
// drops to 0; resume when it climbs back above 0. Per-run state — the
// caller maintains a `pausedDueToDisconnect` flag so we don't fight
// with quota-pause / explicit-user-pause.
//
// Pure: caller passes the prior + new subscriber counts; helper
// returns the action.

export type SubscriberAction = "no-change" | "pause" | "resume";

export interface SubscriberDecisionInput {
  /** Subscriber count BEFORE the connection event. */
  prevCount: number;
  /** Subscriber count AFTER the connection event. */
  newCount: number;
  /** True when the run is currently in pause-due-to-disconnect state. */
  pausedDueToDisconnect: boolean;
  /** True when the run is in some OTHER pause state (quota / user-pause). */
  pausedDueToOther: boolean;
}

export interface SubscriberDecision {
  action: SubscriberAction;
  reason: string;
}

export function decideSubscriberAction(
  input: SubscriberDecisionInput,
): SubscriberDecision {
  const { prevCount, newCount, pausedDueToDisconnect, pausedDueToOther } = input;
  // Last subscriber dropped → pause IF we're not already paused.
  if (prevCount > 0 && newCount === 0) {
    if (pausedDueToDisconnect) {
      return {
        action: "no-change",
        reason: "already paused-due-to-disconnect — no-op",
      };
    }
    return {
      action: "pause",
      reason: `last subscriber dropped (${prevCount} → 0) — pause new dispatch`,
    };
  }
  // First subscriber arrived → resume IF the only reason we paused
  // was disconnect. If quota/user paused us too, leave it paused.
  if (prevCount === 0 && newCount > 0) {
    if (!pausedDueToDisconnect) {
      return {
        action: "no-change",
        reason: "first subscriber but not paused-due-to-disconnect — no-op",
      };
    }
    if (pausedDueToOther) {
      return {
        action: "no-change",
        reason: "subscriber arrived but quota/user pause still in effect",
      };
    }
    return {
      action: "resume",
      reason: `subscriber arrived (0 → ${newCount}) — resume dispatch`,
    };
  }
  return {
    action: "no-change",
    reason: `subscriber transition ${prevCount} → ${newCount} doesn't cross threshold`,
  };
}
