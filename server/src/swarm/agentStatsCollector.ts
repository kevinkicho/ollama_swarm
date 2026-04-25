// Unit 33: shared per-agent stats collector used by every non-blackboard
// runner (RoundRobin / Council / OrchestratorWorker / DebateJudge /
// MapReduce / Stigmergy). Mirrors the in-class Map<>s BlackboardRunner
// already maintains (`turnsPerAgent`, `attemptsPerAgent`,
// `retriesPerAgent`, `latenciesPerAgent`) but pulls them into a standalone
// object so we don't need seven duplicated copies of the wiring.
//
// Blackboard itself still uses its own in-class maps — folding it into
// this collector would be a larger refactor with a higher regression
// surface than cross-preset metrics warrants. A future unit may unify.
//
// Purely side-effect-free on the agent itself: the collector just records
// numbers the runner hands it. Reset-then-populate per run; the same
// instance can be reused across start/stop cycles.

import { computeLatencyStats, type PerAgentStat } from "./blackboard/summary.js";
import type { Agent } from "../services/AgentManager.js";

export class AgentStatsCollector {
  private turns = new Map<string, number>();
  private attempts = new Map<string, number>();
  private retries = new Map<string, number>();
  private latencies = new Map<string, number[]>();
  // Task #115: track consecutive post-retry junk responses per agent.
  // Resets to 0 on any non-junk turn. Crosses the JUNK_QUARANTINE_THRESHOLD
  // = the model is genuinely stuck (Pattern 8 / 89f3faa3 :thumbs_up:
  // case) — surfacing the count so runners + UI can react.
  private consecutiveJunk = new Map<string, number>();
  // Stashed at register-time so buildPerAgentStats still produces rows
  // even after AgentManager.killAll() cleared its own roster. Mirrors
  // BlackboardRunner.agentRoster (Unit 21).
  private roster: Array<{ id: string; index: number }> = [];

  /** Drop every counter + roster entry. Call at the start of each run. */
  reset(): void {
    this.turns.clear();
    this.attempts.clear();
    this.retries.clear();
    this.latencies.clear();
    this.consecutiveJunk.clear();
    this.roster = [];
  }

  /** Record which agents are in this run. Typically called once, right
   * after the spawn batch settles. */
  registerAgents(agents: readonly Agent[]): void {
    this.roster = agents.map((a) => ({ id: a.id, index: a.index }));
  }

  /** Bump the turn count for an agent. Turn = one call to the runner's
   * per-turn prompt function; retries inside promptWithRetry don't
   * count as separate turns. */
  countTurn(agentId: string): void {
    this.turns.set(agentId, (this.turns.get(agentId) ?? 0) + 1);
  }

  /** Wire into promptWithRetry's `onTiming` callback. Counts every
   * attempt (incl. retries); records latency only for successful attempts
   * — failed attempts are typically undici headers timeouts that don't
   * measure model speed. */
  onTiming(agentId: string, success: boolean, elapsedMs: number): void {
    this.attempts.set(agentId, (this.attempts.get(agentId) ?? 0) + 1);
    if (success) {
      const lats = this.latencies.get(agentId) ?? [];
      lats.push(elapsedMs);
      this.latencies.set(agentId, lats);
    }
  }

  /** Wire into promptWithRetry's `onRetry` callback. Counts every retry
   * firing. An agent that succeeds on attempt 2 contributes
   * attempts=2, retries=1. */
  onRetry(agentId: string): void {
    this.retries.set(agentId, (this.retries.get(agentId) ?? 0) + 1);
  }

  /**
   * Task #115: record whether this agent's post-retry text was still
   * junk. Returns the new consecutive-junk count for this agent
   * (0 = recovered, ≥1 = still junk). Caller can compare against
   * JUNK_QUARANTINE_THRESHOLD to decide whether to escalate.
   */
  recordJunkPostRetry(agentId: string, isStillJunk: boolean): number {
    if (isStillJunk) {
      const next = (this.consecutiveJunk.get(agentId) ?? 0) + 1;
      this.consecutiveJunk.set(agentId, next);
      return next;
    }
    this.consecutiveJunk.delete(agentId);
    return 0;
  }

  /** Read-only — current consecutive-junk count for an agent. */
  consecutiveJunkCount(agentId: string): number {
    return this.consecutiveJunk.get(agentId) ?? 0;
  }

  /** Produce the PerAgentStat rows for a summary. One row per registered
   * agent (sorted by index). Missing maps default to zero/null. */
  buildPerAgentStats(): PerAgentStat[] {
    return [...this.roster]
      .sort((a, b) => a.index - b.index)
      .map((a) => {
        const lats = this.latencies.get(a.id) ?? [];
        const stats = computeLatencyStats(lats);
        return {
          agentId: a.id,
          agentIndex: a.index,
          turnsTaken: this.turns.get(a.id) ?? 0,
          // OpenCode SDK response shape doesn't expose per-turn token
          // usage via the extractText path the runners use. Same nullness
          // as blackboard. Documented in summary.ts.
          tokensIn: null,
          tokensOut: null,
          totalAttempts: this.attempts.get(a.id) ?? 0,
          totalRetries: this.retries.get(a.id) ?? 0,
          successfulAttempts: lats.length,
          meanLatencyMs: stats.mean,
          p50LatencyMs: stats.p50,
          p95LatencyMs: stats.p95,
        };
      });
  }

  /** Read-only snapshot of the roster, for runners that want to iterate
   * the same agents the collector tracks. */
  rosterSnapshot(): ReadonlyArray<{ id: string; index: number }> {
    return [...this.roster];
  }
}
