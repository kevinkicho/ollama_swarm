// Interaction chain tracker for the brain system overseer.
//
// Records structured interaction events when workers skip, replanner
// revises/skips, and auditor accepts/overrides. Links events into
// chains per todo so the brain can analyze the full lifecycle of a
// skip→replanner→auditor→result sequence.

export interface InteractionEvent {
  type: "worker_skip" | "replanner_revise" | "replanner_skip"
      | "auditor_override" | "auditor_accept" | "worker_retry_success"
      | "worker_retry_fail" | "criterion_resolved" | "criterion_stuck";
  todoId: string;
  criterionId?: string;
  agentId: string;
  reason: string;
  /** Wall-clock timestamp */
  timestamp: number;
}

export interface InteractionChain {
  todoId: string;
  events: InteractionEvent[];
}

export class InteractionTracker {
  private events: InteractionEvent[] = [];
  private chains: Map<string, InteractionEvent[]> = new Map();

  recordSkip(todoId: string, agentId: string, reason: string): void {
    const event: InteractionEvent = {
      type: "worker_skip",
      todoId,
      agentId,
      reason,
      timestamp: Date.now(),
    };
    this.events.push(event);
    this.getChain(todoId).push(event);
  }

  recordReplannerDecision(
    todoId: string,
    decision: "revise" | "skip",
    reason: string,
    agentId: string,
  ): void {
    const event: InteractionEvent = {
      type: decision === "skip" ? "replanner_skip" : "replanner_revise",
      todoId,
      agentId,
      reason,
      timestamp: Date.now(),
    };
    this.events.push(event);
    this.getChain(todoId).push(event);
  }

  recordAuditorVerdict(
    criterionId: string,
    todoId: string,
    verdict: "met" | "wont-do" | "unmet",
    reason: string,
    agentId: string,
  ): void {
    const event: InteractionEvent = {
      type: verdict === "met" ? "auditor_accept" : "auditor_override",
      todoId,
      criterionId,
      agentId,
      reason,
      timestamp: Date.now(),
    };
    this.events.push(event);
    // Don't add to todo chain — auditor verdicts are per-criterion
  }

  recordWorkerRetry(todoId: string, agentId: string, success: boolean, reason: string): void {
    const event: InteractionEvent = {
      type: success ? "worker_retry_success" : "worker_retry_fail",
      todoId,
      agentId,
      reason,
      timestamp: Date.now(),
    };
    this.events.push(event);
    this.getChain(todoId).push(event);
  }

  recordCriterionResolved(criterionId: string, agentId: string, reason: string): void {
    const event: InteractionEvent = {
      type: "criterion_resolved",
      todoId: "",
      criterionId,
      agentId,
      reason,
      timestamp: Date.now(),
    };
    this.events.push(event);
  }

  recordCriterionStuck(criterionId: string, agentId: string, reason: string): void {
    const event: InteractionEvent = {
      type: "criterion_stuck",
      todoId: "",
      criterionId,
      agentId,
      reason,
      timestamp: Date.now(),
    };
    this.events.push(event);
  }

  getChain(todoId: string): InteractionEvent[] {
    let chain = this.chains.get(todoId);
    if (!chain) {
      chain = [];
      this.chains.set(todoId, chain);
    }
    return chain;
  }

  getChains(): InteractionChain[] {
    return Array.from(this.chains.entries()).map(([todoId, events]) => ({
      todoId,
      events,
    }));
  }

  getAllEvents(): InteractionEvent[] {
    return [...this.events];
  }
}
