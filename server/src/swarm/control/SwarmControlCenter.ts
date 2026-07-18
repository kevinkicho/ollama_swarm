import type { Agent, AgentManager } from "../../services/AgentManager.js";
import type { SwarmEvent } from "../../types.js";
import type { ExitContract, Todo } from "../blackboard/types.js";
import type { InteractionTracker } from "../blackboard/brainOverseer/interactionTracker.js";
import type { ExceptionCollector } from "../blackboard/brainOverseer/exceptionCollector.js";
import type { SwarmControlAdviceRecord } from "@ollama-swarm/shared/swarmControl/controlAdvice";
import type { StallBoardSnapshot, StallGateVerdict } from "@ollama-swarm/shared/swarmControl/types";
import {
  classifyStallRules,
  ruleStallVerdict,
  shouldInvokeStallArbitrator,
} from "@ollama-swarm/shared/swarmControl/stallRules";
import { ToolFailureTracker } from "@ollama-swarm/shared/swarmControl/toolFailureTrack";
import { readPatternCache } from "../blackboard/brainOverseer/patternCache.js";
import { runStallArbitrator } from "./stallArbitrator.js";
import {
  runToolFailureCoach,
  TOOL_COACH_MAX_CALLS_PER_RUN,
  TOOL_COACH_THRESHOLD,
} from "./toolFailureCoach.js";
import { deterministicToolCoachHint } from "./deterministicToolCoach.js";
import { recordDeliberationAsync } from "../deliberation/deliberationLog.js";
import {
  buildDeliberationSeed,
  formatDeliberationForControlPrompt,
} from "../deliberation/deliberationSeed.js";

export const STALL_ARBITRATOR_MAX_CALLS = 6;

export interface SwarmControlEmit {
  (event: SwarmEvent): void;
}

export interface StallGateInput {
  board: { open: number; stale: number; skipped: number; committed: number; total: number };
  contract?: ExitContract;
  stuckCycles: number;
  providerStall?: string;
  todos: readonly Todo[];
  coachAgent: Agent;
  clonePath?: string;
  runId?: string;
  interactionTracker?: InteractionTracker;
  exceptionCollector?: ExceptionCollector | null;
  appendSystem: (msg: string) => void;
  emit?: SwarmControlEmit;
  manager?: AgentManager;
}

export class SwarmControlCenter {
  private readonly toolFailures = new ToolFailureTracker();
  private readonly agentHints = new Map<string, string>();
  private sessionPlannerHint?: string;
  private priorPatterns: string[] = [];
  private stallArbitratorCalls = 0;
  private toolCoachCalls = 0;
  private readonly coachedFingerprints = new Set<string>();
  private readonly adviceHistory: SwarmControlAdviceRecord[] = [];
  /** Cached prior-deliberation summary for stall arbitrator (per run). */
  private deliberationControlSummary = "";

  reset(): void {
    this.toolFailures.resetAll();
    this.agentHints.clear();
    this.sessionPlannerHint = undefined;
    this.priorPatterns = [];
    this.stallArbitratorCalls = 0;
    this.toolCoachCalls = 0;
    this.coachedFingerprints.clear();
    this.adviceHistory.length = 0;
    this.deliberationControlSummary = "";
  }

  getAdviceHistory(): readonly SwarmControlAdviceRecord[] {
    return this.adviceHistory;
  }

  private recordAdvice(advice: SwarmControlAdviceRecord): void {
    this.adviceHistory.push(advice);
    if (this.adviceHistory.length > 40) this.adviceHistory.shift();
  }

  /** Load recurring patterns from prior runs (.swarm-improvements/pattern-cache.json). */
  async loadPriorPatterns(clonePath: string): Promise<void> {
    const cache = await readPatternCache(clonePath);
    this.priorPatterns = Object.values(cache.patterns)
      .filter((p) => p.count >= 2 && (p.rootCause || p.proposal?.description))
      .sort((a, b) => b.count - a.count)
      .slice(0, 12)
      .map((p) => {
        const parts = [`${p.fingerprint} (${p.count}x)`];
        if (p.rootCause) parts.push(`cause: ${p.rootCause}`);
        if (p.proposal?.description) parts.push(`fix: ${p.proposal.description}`);
        return parts.join(" — ");
      });
    // Also cache deliberation deny/approve lessons for the stall arbitrator.
    try {
      const seed = await buildDeliberationSeed(clonePath);
      this.deliberationControlSummary = formatDeliberationForControlPrompt(seed);
    } catch {
      this.deliberationControlSummary = "";
    }
  }

  getPriorPatterns(): readonly string[] {
    return this.priorPatterns;
  }

  consumeAgentHint(agentId: string): string | undefined {
    const hint = this.agentHints.get(agentId);
    if (hint) this.agentHints.delete(agentId);
    return hint;
  }

  consumeSessionPlannerHint(): string | undefined {
    const h = this.sessionPlannerHint;
    this.sessionPlannerHint = undefined;
    return h;
  }

  getSessionPlannerHint(): string | undefined {
    return this.sessionPlannerHint;
  }

  buildBoardSnapshot(input: StallGateInput): StallBoardSnapshot {
    const criteria = input.contract?.criteria ?? [];
    const unmet = criteria.filter((c) => c.status === "unmet").length;
    const staleReasons = input.todos
      .filter((t) => t.status === "stale" && t.staleReason)
      .map((t) => t.staleReason!)
      .slice(-8);
    const skipReasons = input.todos
      .filter((t) => t.status === "skipped" && t.skippedReason)
      .map((t) => t.skippedReason!)
      .slice(-8);
    const replannerSkips = skipReasons.filter((r) => r.includes("replanner decided to skip"));
    return {
      ...input.board,
      unmetCriteria: unmet,
      totalCriteria: criteria.length,
      stuckCycles: input.stuckCycles,
      recentStaleReasons: staleReasons,
      recentSkipReasons: skipReasons,
      recentReplannerSkips: replannerSkips,
      providerStall: input.providerStall,
    };
  }

  private summarizeInteractions(tracker?: InteractionTracker): string {
    if (!tracker) return "";
    const chains = tracker.getChains().slice(-6);
    return chains
      .map((c) => `${c.todoId}: ${c.events.map((e) => e.type).join(" → ")}`)
      .join("\n");
  }

  async evaluateStallGate(input: StallGateInput): Promise<StallGateVerdict | null> {
    const snap = this.buildBoardSnapshot(input);
    const ruleClass = classifyStallRules(snap);
    const ruleVerdict = ruleStallVerdict(snap, ruleClass);

    // Prefer arbitrator when eligible (escalation / ambiguous) so rule
    // storms are not a permanent short-circuit of contextual stop/backoff.
    const wantArb = shouldInvokeStallArbitrator(
      snap,
      ruleClass,
      this.stallArbitratorCalls,
      STALL_ARBITRATOR_MAX_CALLS,
    );

    if (wantArb) {
      const inRunPatterns =
        input.exceptionCollector?.getPatternSummary().recurringPatterns
          .slice(0, 8)
          .map((p) => `${p.pattern} (${p.count}x)`) ?? [];
      const patterns = [...new Set([...this.priorPatterns.slice(0, 6), ...inRunPatterns])].slice(0, 12);

      this.stallArbitratorCalls++;
      input.appendSystem(
        `[control] Stall arbitrator invoked (${this.stallArbitratorCalls}/${STALL_ARBITRATOR_MAX_CALLS}) — class=${ruleClass}.`,
      );

      // Lazy-load deliberation summary if loadPriorPatterns was not called.
      if (!this.deliberationControlSummary && input.clonePath) {
        try {
          const seed = await buildDeliberationSeed(input.clonePath);
          this.deliberationControlSummary = formatDeliberationForControlPrompt(seed);
        } catch {
          /* ignore */
        }
      }

      const arb = await runStallArbitrator(snap, ruleClass, {
        agent: input.coachAgent,
        clonePath: input.clonePath,
        runId: input.runId,
        manager: input.manager,
        recurringPatterns: patterns,
        interactionSummary: this.summarizeInteractions(input.interactionTracker),
        deliberationSummary: this.deliberationControlSummary || undefined,
      });
      if (arb) {
        this.applyVerdictSideEffects(arb, input);
        return arb;
      }
      // Parse/LLM failure: fall through to rule verdict if any.
    }

    if (ruleVerdict) {
      this.applyVerdictSideEffects(ruleVerdict, input);
      return ruleVerdict;
    }
    return null;
  }

  private applyVerdictSideEffects(verdict: StallGateVerdict, input: StallGateInput): void {
    const tag = verdict.source === "arbitrator" ? "arbitrator" : "rule";
    input.appendSystem(`[control] Stall gate (${tag}): ${verdict.action} — ${verdict.rationale}`);
    if (verdict.plannerHint) {
      this.sessionPlannerHint = verdict.plannerHint;
    }
    const advice: SwarmControlAdviceRecord = {
      ts: Date.now(),
      kind: "stall_gate",
      action: verdict.action,
      source: verdict.source,
      rationale: verdict.rationale,
      plannerHint: verdict.plannerHint,
    };
    this.recordAdvice(advice);
    input.emit?.({
      type: "swarm_control_advice",
      ...advice,
    });
    // Control-layer deliberation: machine approve/deny of continuing the run.
    const verdictMap =
      verdict.action === "stop"
        ? "deny"
        : verdict.action === "retry" || verdict.action === "backoff"
          ? "approve"
          : "validate";
    recordDeliberationAsync(
      {
        runId: input.runId ?? "unknown",
        layer: "control",
        subject: `stall-gate:${verdict.action}`,
        claim: verdict.rationale,
        proposer: "swarm-control",
        validator: tag,
        verdict: verdictMap,
        validationReason: verdict.plannerHint || verdict.rationale,
      },
      {
        clonePath: input.clonePath,
        runId: input.runId,
        appendSystem: input.appendSystem,
        emit: input.emit as any,
      },
    );
  }

  /**
   * Record a tool failure; may inject a deterministic coach hint or async LLM coach.
   * Known Windows/bash/grep thrash paths use zero-token deterministic hints first.
   */
  recordToolFailure(
    agentId: string,
    tool: string,
    error: string,
    preview: string,
    deps: ToolCoachRecordDeps,
  ): void {
    const record = this.toolFailures.record(agentId, tool, error);
    if (record.count < TOOL_COACH_THRESHOLD) return;
    const fp = `${agentId}|${tool}|${record.error.slice(0, 80)}`;
    if (this.coachedFingerprints.has(fp)) return;
    if (this.toolCoachCalls >= TOOL_COACH_MAX_CALLS_PER_RUN) return;

    this.coachedFingerprints.add(fp);
    this.toolCoachCalls++;

    const applyHint = (hint: string, source: "rule" | "llm") => {
      this.agentHints.set(agentId, hint);
      deps.appendSystem?.(
        `[control] Tool coach (${tool}, ${record.count}×${source === "rule" ? ", rule" : ""}): `
          + `${hint.slice(0, 200)}${hint.length > 200 ? "…" : ""}`,
      );
      const advice: SwarmControlAdviceRecord = {
        ts: Date.now(),
        kind: "tool_coach",
        agentId,
        tool,
        rationale: hint,
      };
      this.recordAdvice(advice);
      deps.emit?.({
        type: "swarm_control_advice",
        ...advice,
      });
      recordDeliberationAsync(
        {
          runId: deps.runId ?? "unknown",
          layer: "control",
          subject: `tool-coach:${tool}`,
          claim: error.slice(0, 400),
          proposer: agentId,
          validator: `tool-coach-${source}`,
          verdict: "challenge",
          validationReason: hint,
          evidence: [tool],
        },
        {
          clonePath: deps.clonePath,
          runId: deps.runId,
          appendSystem: deps.appendSystem,
          emit: deps.emit as any,
        },
      );
    };

    const ruleHint = deterministicToolCoachHint(tool, error);
    if (ruleHint) {
      applyHint(ruleHint, "rule");
    } else {
      void runToolFailureCoach(record, preview, {
        ...deps,
        priorPatterns: this.priorPatterns.slice(0, 6),
      }).then((hint) => {
        if (!hint) return;
        applyHint(hint, "llm");
      });
    }

    // Brain OS tool_block: after coach thrash, recruit a helper (async, non-blocking).
    void import("../brainOs/toolBlockDispatch.js").then(({ maybeDispatchToolBlock }) =>
      maybeDispatchToolBlock({
        runId: deps.runId,
        clonePath: deps.clonePath,
        autoApprove: deps.autoApprove,
        brainOs: deps.brainOs,
        helperModel: deps.helperModel,
        agentId,
        tool,
        error,
        count: record.count,
        appendSystem: deps.appendSystem,
        emit: deps.emit as ((e: unknown) => void) | undefined,
        coachAgent: deps.agent,
      }),
    );
  }
}

export interface ToolCoachRecordDeps {
  agent: Agent;
  clonePath?: string;
  runId?: string;
  appendSystem?: (msg: string) => void;
  emit?: SwarmControlEmit;
  manager?: AgentManager;
  /** When set, Brain OS may recruit a helper after coach thrash (tool_block). */
  autoApprove?: boolean;
  brainOs?: boolean | { enabled?: boolean; helperModel?: string };
  helperModel?: string;
}