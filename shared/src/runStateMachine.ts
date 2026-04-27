// V2 Step 3a: explicit run state machine.
//
// Replaces the implicit coordination across {phase, board.counts.open,
// board.counts.claimed, board.counts.stale, replanPending.size,
// replanRunning, draining, paused, stopping} in BlackboardRunner.
//
// In V1 the worker exit-condition is "ALL of {open=0, claimed=0,
// stale=0, replanPending=0, !replanRunning} must be true". One stuck
// flag = whole runner wedges (we hit this multiple times — see #215,
// #219, #222 diag noise). The bug isn't in any individual flag but in
// the coordination model: too many implicit invariants.
//
// V2 model: a single discriminated-union state. Transitions are
// explicit functions returning the next state. Workers can NEVER wedge
// because there are no hidden coordination invariants to satisfy —
// the state IS the truth.
//
// This module is the V2 substrate for Step 3. Initial integration will
// keep V1's flag-soup running in parallel, comparing the V2 derived
// state to V1's actual phase to catch divergence. Once stable, V1
// flags are removed.

export type RunPhase =
  | "idle"
  | "spawning"
  | "planning"
  | "executing"
  | "auditing"
  | "tier-up"
  | "draining"
  | "completed"
  | "stopped"
  | "failed";

export interface RunState {
  /** Current high-level phase. */
  phase: RunPhase;
  /** ISO timestamp of when this state was entered. Used for timeouts
   *  and UI elapsed-time display. */
  enteredAt: number;
  /** Why we're stopped/failed/completed. Empty for in-progress phases. */
  detail?: string;
  /** Token budget remaining (continuous mode). When undefined, no
   *  budget cap. */
  tokensRemaining?: number;
  /** Wall-clock cap remaining ms (continuous mode). */
  wallClockRemainingMs?: number;
  /** Pause reason (Ollama quota wall). When set, the state machine is
   *  in a paused-side branch — workers don't claim, planner doesn't
   *  fire. Probe loop polls every 5min until this clears. */
  pausedReason?: string;
}

/** Discriminated input event the state machine reacts to. Every
 *  external interaction (user start/stop, board mutation, planner
 *  return, auditor verdict) lands here as a typed event. The reducer
 *  decides the next state. No "fire then check" — every transition
 *  is a single function call. */
export type RunEvent =
  | { type: "start"; ts: number }
  | { type: "spawned"; ts: number; agentCount: number }
  | { type: "contract-built"; ts: number; criteriaCount: number }
  | { type: "todos-posted"; ts: number; count: number }
  | { type: "todo-committed"; ts: number; remainingTodos: number }
  | { type: "todo-skipped"; ts: number; remainingTodos: number }
  | { type: "auditor-fired"; ts: number }
  | { type: "auditor-returned"; ts: number; allCriteriaResolved: boolean; newTodosCount: number }
  | { type: "tier-up-decision"; ts: number; promoted: boolean }
  | { type: "drain-requested"; ts: number }
  | { type: "stop-requested"; ts: number }
  | { type: "pause-on-quota"; ts: number; reason: string }
  | { type: "resume-from-quota"; ts: number }
  | { type: "fatal-error"; ts: number; message: string };

/** Context that the reducer needs to make transition decisions but
 *  isn't part of the state itself. Caller passes current snapshot. */
export interface RunContext {
  /** Live counts from the TODO queue. */
  openTodos: number;
  claimedTodos: number;
  staleTodos: number;
  /** Number of times the auditor has been invoked this run. Caps to
   *  prevent runaway audit-replan cycles. */
  auditInvocations: number;
  maxAuditInvocations: number;
  /** Tier ratchet state. */
  currentTier: number;
  maxTiers: number;
  /** True if all criteria have a terminal verdict (met/wont-do). */
  allCriteriaResolved: boolean;
}

export const INITIAL_STATE: RunState = {
  phase: "idle",
  enteredAt: 0,
};

/** Pure reducer: (state, event, context) → next state. Never mutates
 *  state — returns a new object. Never has side effects. Caller
 *  applies the returned state and triggers downstream actions
 *  (start auditor, post todos, etc.) based on the phase transition. */
export function reduce(state: RunState, event: RunEvent, ctx: RunContext): RunState {
  // Fatal errors short-circuit any phase.
  if (event.type === "fatal-error") {
    return { ...state, phase: "failed", detail: event.message, enteredAt: event.ts };
  }
  // Stop requests transition to "stopped" from any non-terminal phase.
  if (event.type === "stop-requested" && !isTerminal(state.phase)) {
    return { ...state, phase: "stopped", detail: "user-stop", enteredAt: event.ts };
  }
  // Drain requests transition non-draining/non-terminal to draining.
  if (event.type === "drain-requested" && state.phase !== "draining" && !isTerminal(state.phase)) {
    return { ...state, phase: "draining", detail: "drain-requested", enteredAt: event.ts };
  }
  // Pause/resume on quota wall — orthogonal to phase, just sets the
  // pausedReason marker. Workers/planner check it and idle while set.
  if (event.type === "pause-on-quota") {
    return { ...state, pausedReason: event.reason };
  }
  if (event.type === "resume-from-quota") {
    return { ...state, pausedReason: undefined };
  }

  switch (state.phase) {
    case "idle":
      if (event.type === "start") return { phase: "spawning", enteredAt: event.ts };
      return state;

    case "spawning":
      if (event.type === "spawned") return { phase: "planning", enteredAt: event.ts };
      return state;

    case "planning":
      if (event.type === "contract-built") {
        // Contract empty (0 criteria) → completed; otherwise wait for todos.
        if (event.criteriaCount === 0) {
          return { phase: "completed", detail: "contract has 0 criteria", enteredAt: event.ts };
        }
        return state; // stay in planning until todos posted
      }
      if (event.type === "todos-posted" && event.count > 0) {
        return { phase: "executing", enteredAt: event.ts };
      }
      if (event.type === "todos-posted" && event.count === 0) {
        // Planner returned no todos — auditor decides next.
        return { phase: "auditing", enteredAt: event.ts };
      }
      return state;

    case "executing":
      if (
        (event.type === "todo-committed" || event.type === "todo-skipped") &&
        event.remainingTodos === 0 &&
        ctx.openTodos === 0 &&
        ctx.claimedTodos === 0 &&
        ctx.staleTodos === 0
      ) {
        // All work drained → audit cycle.
        return { phase: "auditing", enteredAt: event.ts };
      }
      return state;

    case "auditing":
      if (event.type === "auditor-returned") {
        if (event.allCriteriaResolved || ctx.allCriteriaResolved) {
          // All resolved — tier-up if ratchet allows, else complete.
          if (ctx.currentTier < ctx.maxTiers) {
            return { phase: "tier-up", enteredAt: event.ts };
          }
          return { phase: "completed", detail: "all criteria resolved", enteredAt: event.ts };
        }
        if (ctx.auditInvocations >= ctx.maxAuditInvocations) {
          return {
            phase: "completed",
            detail: `auditor invocation cap (${ctx.maxAuditInvocations}) reached`,
            enteredAt: event.ts,
          };
        }
        if (event.newTodosCount > 0) {
          // Auditor produced more work — back to executing.
          return { phase: "executing", enteredAt: event.ts };
        }
        // Auditor produced nothing AND not all resolved AND cap not hit
        // → the wedge case. State machine refuses to spin forever.
        return {
          phase: "completed",
          detail: "auditor produced no new work; ending",
          enteredAt: event.ts,
        };
      }
      return state;

    case "tier-up":
      if (event.type === "tier-up-decision") {
        if (event.promoted) {
          return { phase: "planning", enteredAt: event.ts };
        }
        return { phase: "completed", detail: "tier-up failed; ending", enteredAt: event.ts };
      }
      return state;

    case "draining":
      // Once all in-flight work completes, transition to stopped.
      if (
        (event.type === "todo-committed" || event.type === "todo-skipped") &&
        ctx.claimedTodos === 0
      ) {
        return { phase: "stopped", detail: "drain-completed", enteredAt: event.ts };
      }
      return state;

    case "completed":
    case "stopped":
    case "failed":
      // Terminal — ignore further events.
      return state;
  }
}

export function isTerminal(phase: RunPhase): boolean {
  return phase === "completed" || phase === "stopped" || phase === "failed";
}

/** Whether the planner should be active (firing prompts) in this state. */
export function plannerShouldFire(state: RunState): boolean {
  if (state.pausedReason) return false;
  return state.phase === "planning" || state.phase === "auditing" || state.phase === "tier-up";
}

/** Whether workers should claim new todos in this state. */
export function workersShouldClaim(state: RunState): boolean {
  if (state.pausedReason) return false;
  return state.phase === "executing";
}

/** Whether the run is over (no further work, terminal state reached). */
export function runFinished(state: RunState): boolean {
  return isTerminal(state.phase);
}
