/**
 * Multi-layer deliberation: peer discussion + hierarchy validation.
 *
 * Mental model (operator-facing):
 *   - **hierarchy** — blackboard/orchestrator layer (planner seed, auditor
 *     approve/deny commits, stall control). Higher-up validates worker claims.
 *   - **peer** — council/discussion layer (drafters challenge, vote, present
 *     reasons; peers validate reasons).
 *   - **control** — swarm control plane (stall gate, tool coach) as machine
 *     "votes" with rationales.
 *
 * Every decision is a durable transaction: claim → validation → approve|deny
 * with reasons, recorded for later dissemination (JSONL + transcript + WS).
 */

export type DeliberationLayer = "hierarchy" | "peer" | "control";

/** Outcome of a validation step (or a claim still pending validation). */
export type DeliberationVerdict =
  | "claim" // proposer stated a reason (not yet validated)
  | "challenge" // peer disputed a claim
  | "validate" // peer/validator accepted the reason as sound (not final ship)
  | "approve" // hierarchy ships / peer majority accepts
  | "deny" // hierarchy rejects / peer majority rejects
  | "abstain"; // no valid ballot

export interface DeliberationTransaction {
  /** Stable id for this decision row. */
  id: string;
  ts: number;
  runId: string;
  /** Which governance layer produced this row. */
  layer: DeliberationLayer;
  /** Optional preset id (council, blackboard, …). */
  preset?: string;
  /** What is being decided (todo, draft, criterion, vote, …). */
  subject: string;
  /** The reason / claim under discussion. */
  claim: string;
  /** Who advanced the claim (agent-1, worker, synthesizer, …). */
  proposer: string;
  /** Who validated / voted (auditor, agent-2, stall-arbitrator, …). */
  validator?: string;
  verdict: DeliberationVerdict;
  /** Why approve/deny/challenge (validation rationale). */
  validationReason?: string;
  /** Optional evidence pointers (files, criterion ids, quote hashes). */
  evidence?: string[];
  /** Related board / cycle identifiers. */
  related?: {
    todoId?: string;
    criterionId?: string;
    cycle?: number;
    agentIndex?: number;
    votedForIndex?: number | null;
  };
  /** Schema for future exporters. */
  schemaVersion: 1;
}

export interface DeliberationSink {
  /** Project clone path — writes `<clone>/logs/<runId>/deliberation.jsonl`. */
  clonePath?: string;
  runId?: string;
  /** Live transcript line. */
  appendSystem?: (msg: string) => void;
  /** WS / event hub. */
  emit?: (event: {
    type: "deliberation_transaction";
    transaction: DeliberationTransaction;
  }) => void;
  /** Structured debug log. */
  logDiag?: (entry: Record<string, unknown>) => void;
}
