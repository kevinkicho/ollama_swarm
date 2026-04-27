// V2 Step 3b: parallel-track instrumentation that runs the V2 state
// machine alongside V1's flag-soup. When BlackboardRunner enters a
// new V1 phase or fires a domain event (todos posted, todo committed,
// auditor returned, etc.), this observer feeds the event to the
// reducer and checks whether the resulting V2 phase is consistent
// with V1's phase.
//
// Default behavior: pure telemetry. Diverging transitions emit a
// callback (typically a console.warn) but DO NOT alter V1 behavior.
// After 1+ stable validation runs with no divergences logged, V1
// flag-soup can be replaced by V2's RunState. See ARCHITECTURE-V2.md
// section 2 ("Single state machine, not flag soup").

import {
  reduce,
  INITIAL_STATE,
  type RunState,
  type RunEvent,
  type RunContext,
} from "../../../../shared/src/runStateMachine.js";
import type { SwarmPhase } from "../../types.js";

export interface RunStateObserverDivergence {
  v1Phase: SwarmPhase;
  v2Phase: string;
  expectedV2Phases: string;
  ts: number;
  trigger: string;
}

// Acceptable V2 phases for each V1 phase. V2's model is coarser
// than V1's (no separate cloning/seeding/discussing — those collapse
// into spawning/planning) and treats pause as orthogonal rather than
// a phase. The mapping below encodes "if V1 says X, V2 should be one
// of these"; anything else is divergence.
const PHASE_MAPPING: Record<SwarmPhase, string[]> = {
  idle: ["idle"],
  cloning: ["spawning", "idle"],
  spawning: ["spawning", "idle"],
  seeding: ["spawning", "planning"],
  // discussing isn't used by blackboard but other presets may surface
  // it; map to planning so the observer doesn't fire false positives
  // when someone reuses this module from a non-blackboard runner.
  discussing: ["planning"],
  planning: ["planning"],
  executing: ["executing"],
  // Pause is orthogonal in V2 — the underlying phase persists. Any
  // active phase is acceptable when V1 says paused.
  paused: ["planning", "executing", "auditing", "tier-up", "spawning"],
  draining: ["draining"],
  // V1 has stopping → stopped as a 2-step; V2 collapses to stopped.
  stopping: ["stopped"],
  stopped: ["stopped"],
  completed: ["completed"],
  failed: ["failed"],
};

export interface RunStateObserverOpts {
  /** Caller provides this snapshot at apply-time. The observer can't
   *  read board state directly without a coupling to BlackboardRunner. */
  getCtx: () => RunContext;
  /** Called when a V1 phase doesn't map to the resulting V2 phase.
   *  Default no-op. Production wiring should at minimum console.warn. */
  onDivergence?: (d: RunStateObserverDivergence) => void;
}

export class RunStateObserver {
  private state: RunState = INITIAL_STATE;
  private divergences: RunStateObserverDivergence[] = [];
  private getCtx: () => RunContext;
  private onDivergence: (d: RunStateObserverDivergence) => void;

  constructor(opts: RunStateObserverOpts) {
    this.getCtx = opts.getCtx;
    this.onDivergence = opts.onDivergence ?? (() => {});
  }

  /** Apply a V2 event. Returns the new V2 state. Pure pass-through to
   *  the reducer; side effects only via the optional onDivergence. */
  apply(event: RunEvent): RunState {
    this.state = reduce(this.state, event, this.getCtx());
    return this.state;
  }

  /** Verify a V1 phase transition is compatible with the current V2
   *  state. Records divergence (and fires callback) when not. Returns
   *  true on agreement, false on divergence. */
  checkPhase(v1Phase: SwarmPhase, ts: number, trigger: string): boolean {
    const allowed = PHASE_MAPPING[v1Phase];
    if (!allowed) return true; // unknown V1 phase — silent skip
    if (allowed.includes(this.state.phase)) return true;
    const div: RunStateObserverDivergence = {
      v1Phase,
      v2Phase: this.state.phase,
      expectedV2Phases: allowed.join("|"),
      ts,
      trigger,
    };
    this.divergences.push(div);
    this.onDivergence(div);
    return false;
  }

  getState(): RunState {
    return this.state;
  }

  /** All divergences since last reset. Useful for end-of-run
   *  telemetry: if zero, V2 reducer agrees with V1 across the entire
   *  run — promotion-ready. */
  getDivergences(): readonly RunStateObserverDivergence[] {
    return this.divergences;
  }

  reset(): void {
    this.state = INITIAL_STATE;
    this.divergences = [];
  }
}
