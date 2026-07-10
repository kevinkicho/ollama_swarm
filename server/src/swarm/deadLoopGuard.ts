// 2026-05-03 (Phase B of shared-layer refactor): dead-loop guard.
// Pre-extraction state (the audit's Pattern 2b):
//   - Council, Debate-judge, MapReduce, Stigmergy: tracked
//     "consecutive rounds where all new entries were empty/junk"
//   - OW, OW-Deep: tracked "consecutive cycles where the lead/orchestrator
//     produced no parseable plan assignments"
//   - Historical runners used EMPTY_*_BREAK_THRESHOLD = 2; shared default
//     is now 3 (one extra empty iteration before halt — intentional).
//   - Each runner had a bespoke earlyStopDetail format string —
//     `${role}-silenced (${n} consecutive empty ${unit}s|plans)`
//
// The two variants don't merge cleanly (different signal — output text
// vs plan structure), so this module exposes TWO classes. The shared
// part is the consecutive-counter + threshold + format-string template.
//
// IMPORTANT: Trips only when new turns are empty or looksLikeJunk.
// Shared vocabulary / log re-reads leave this guard idle. Primary
// empty-output gate; see docs/decisions.md 2026-07-10.

import { looksLikeJunk } from "./extractText.js";
import type { TranscriptEntry } from "../types.js";

/** Consecutive empty/junk iterations before halt (was 2 in older runners). */
const DEFAULT_THRESHOLD = 3;

export interface DeadLoopHit {
  /** True when consecutive count has reached the threshold. */
  tripped: boolean;
  /** Current count of consecutive empty events. */
  consecutive: number;
  /** When tripped, the human-readable detail to assign to
   *  `this.earlyStopDetail`. Format mirrors existing per-runner copy. */
  earlyStopDetail?: string;
}

/** Output-empty dead-loop guard. Used by Council, Debate-judge,
 *  MapReduce, Stigmergy: every iteration produces one or more agent
 *  turns; this guard counts the iterations where EVERY new turn was
 *  empty/junk. Once the count hits the threshold, the loop should
 *  break with the returned earlyStopDetail. */
export class OutputEmptyDeadLoopGuard {
  private consecutive = 0;
  constructor(
    private readonly opts: {
      /** Plural noun for the agents that fell silent. e.g. "drafters",
       *  "mappers", "explorers". Used in the earlyStopDetail string. */
      roleLabel: string;
      /** Loop noun. "round" for council/RR/stigmergy/debate; "cycle"
       *  for map-reduce. */
      unit: "round" | "cycle";
      /** Threshold of consecutive empty iterations before tripping.
       *  Defaults to 3 (shared DEFAULT_THRESHOLD). */
      threshold?: number;
    },
  ) {}

  /** Call after each iteration, passing the entries that landed in the
   *  transcript THIS iteration. Returns the current state. When
   *  result.tripped=true, the runner should set earlyStopDetail and break. */
  recordIteration(newEntries: readonly TranscriptEntry[]): DeadLoopHit {
    const threshold = this.opts.threshold ?? DEFAULT_THRESHOLD;
    // Match existing per-runner predicate verbatim: only count when
    // there are NEW entries AND every one is empty or junk. An empty
    // newEntries array (e.g. user pressed stop) doesn't count.
    const allEmpty =
      newEntries.length > 0 &&
      newEntries.every(
        (e) => (e.text || "") === "(empty response)" || looksLikeJunk(e.text || ""),
      );
    if (!allEmpty) {
      this.consecutive = 0;
      return { tripped: false, consecutive: 0 };
    }
    this.consecutive += 1;
    if (this.consecutive >= threshold) {
      const unitPlural = `${this.opts.unit}s`;
      return {
        tripped: true,
        consecutive: this.consecutive,
        earlyStopDetail: `${this.opts.roleLabel}-silenced (${this.consecutive} consecutive empty ${unitPlural})`,
      };
    }
    return { tripped: false, consecutive: this.consecutive };
  }

  /** Reset counter — call from the runner's start() before the loop. */
  reset(): void {
    this.consecutive = 0;
  }
}

/** Plan-empty dead-loop guard. Used by OW + OW-Deep: each cycle's
 *  lead/orchestrator emits a JSON plan; this guard counts the cycles
 *  where the parsed plan had zero assignments. Once the count hits
 *  the threshold, the loop should break. */
export class PlanEmptyDeadLoopGuard {
  private consecutive = 0;
  constructor(
    private readonly opts: {
      /** Singular role noun for the plan emitter. e.g. "lead",
       *  "orchestrator". Used in the earlyStopDetail string. */
      roleLabel: string;
      /** Threshold of consecutive empty plans before tripping.
       *  Defaults to 3 (shared DEFAULT_THRESHOLD). */
      threshold?: number;
    },
  ) {}

  /** Call after each cycle's plan parse. Returns the current state.
   *  When result.tripped=true, the runner should set earlyStopDetail
   *  and break. */
  recordCycle(planAssignments: readonly unknown[]): DeadLoopHit {
    const threshold = this.opts.threshold ?? DEFAULT_THRESHOLD;
    if (planAssignments.length > 0) {
      this.consecutive = 0;
      return { tripped: false, consecutive: 0 };
    }
    this.consecutive += 1;
    if (this.consecutive >= threshold) {
      return {
        tripped: true,
        consecutive: this.consecutive,
        earlyStopDetail: `${this.opts.roleLabel}-silenced (${this.consecutive} consecutive empty plans)`,
      };
    }
    return { tripped: false, consecutive: this.consecutive };
  }

  /** Reset counter — call from the runner's start() before the loop. */
  reset(): void {
    this.consecutive = 0;
  }
}
