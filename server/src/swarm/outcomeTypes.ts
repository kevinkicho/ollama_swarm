export type OutcomeVerdict = "ship-quality" | "needs-revision" | "fundamentally-flawed";

export interface OutcomeScoredEvent {
  runId: string;
  score: number;
  verdict: OutcomeVerdict;
  dimensions: Array<{ id: string; label: string; score: number; note: string }>;
}

export type OutcomeEmitter = (outcome: OutcomeScoredEvent) => void;

/** Creates an emitter that broadcasts outcome_scored events. Shared across all
 *  7 discussion presets + stigmergy to avoid duplicating the inline function. */
export function createOutcomeEmitter(
  emit: (event: { type: "outcome_scored"; runId: string; score: number; verdict: OutcomeVerdict; dimensions: OutcomeScoredEvent["dimensions"] }) => void,
): OutcomeEmitter {
  return (outcome) => {
    emit({ type: "outcome_scored" as const, runId: outcome.runId, score: outcome.score, verdict: outcome.verdict, dimensions: outcome.dimensions });
  };
}