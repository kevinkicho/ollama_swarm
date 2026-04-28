// V2 Step 3: explicit run state machine, wired into BlackboardRunner.
//
// Originally shipped (2026-04-26) as parallel-track instrumentation
// that ran the V2 reducer alongside V1's flag-soup and recorded
// divergences. After 7/7 SDK-path presets validated with zero
// divergences (2026-04-27), the divergence-tracking telemetry was
// removed (2026-04-28, V2 cutover Phase 1a). The observer is now the
// thin wrapper around the pure reducer that BlackboardRunner uses to
// keep V2 state in sync as events flow through.
//
// What this DOESN'T do (yet):
// - Drive the UI / summary `phase` field. V1's `phase` flag is still
//   the source of truth for those. Phase 1b promotes V2 to drive UI;
//   that's a separate cutover step (UI behavior change — `paused`
//   becomes orthogonal, `cloning`/`seeding`/`stopping` collapse).
// - Replace V1's coordination flags (paused, draining, etc.) for
//   worker-claim and planner-fire decisions. V2's reducer is consulted
//   in summary writes only. Full promotion lands in Phase 3.

import {
  reduce,
  INITIAL_STATE,
  type RunState,
  type RunEvent,
  type RunContext,
} from "../../../../shared/src/runStateMachine.js";

export interface RunStateObserverOpts {
  /** Caller provides this snapshot at apply-time. The observer can't
   *  read board state directly without a coupling to BlackboardRunner. */
  getCtx: () => RunContext;
}

export class RunStateObserver {
  private state: RunState = INITIAL_STATE;
  private getCtx: () => RunContext;

  constructor(opts: RunStateObserverOpts) {
    this.getCtx = opts.getCtx;
  }

  /** Apply a V2 event. Returns the new V2 state. Pure pass-through to
   *  the reducer; no side effects. */
  apply(event: RunEvent): RunState {
    this.state = reduce(this.state, event, this.getCtx());
    return this.state;
  }

  getState(): RunState {
    return this.state;
  }

  reset(): void {
    this.state = INITIAL_STATE;
  }
}
