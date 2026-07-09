import { z } from "zod";
import type { Agent } from "../../services/AgentManager.js";
import { chatOnce } from "../chatOnce.js";
import type { StallBoardSnapshot, StallGateVerdict } from "@ollama-swarm/shared/swarmControl/types";
import {
  summarizeStallForPrompt,
  type StallRuleClass,
} from "@ollama-swarm/shared/swarmControl/stallRules";

const VerdictSchema = z.object({
  action: z.enum(["backoff", "retry", "stop"]),
  rationale: z.string().trim().min(1).max(600),
  backoffMs: z.number().int().min(5_000).max(600_000).optional(),
  plannerHint: z.string().trim().max(800).optional(),
  confidence: z.enum(["high", "medium", "low"]).optional(),
});

export interface StallArbitratorDeps {
  agent: Agent;
  clonePath?: string;
  runId?: string;
  recurringPatterns?: string[];
  interactionSummary?: string;
}

export async function runStallArbitrator(
  snap: StallBoardSnapshot,
  ruleClass: StallRuleClass,
  deps: StallArbitratorDeps,
): Promise<StallGateVerdict | null> {
  const prompt = [
    "You are the swarm CONTROL arbitrator at a macro phase gate.",
    "Workers drained but auditor+planner produced no new todos while criteria remain unmet.",
    "Choose ONE action — do not propose open-ended chat.",
    "",
    "Actions:",
    "- backoff: transient infra/quota issue — wait and retry (set backoffMs 60000-300000)",
    "- retry: systemic fixable issue — inject plannerHint for next planner/replanner pass",
    "- stop: genuine deadlock after reasonable effort",
    "",
    summarizeStallForPrompt(snap, ruleClass),
    deps.recurringPatterns?.length
      ? `\nrecurringPatterns:\n${deps.recurringPatterns.slice(0, 8).map((p) => `  - ${p}`).join("\n")}`
      : "",
    deps.interactionSummary
      ? `\ninteractionChains:\n${deps.interactionSummary.slice(0, 2000)}`
      : "",
    "",
    'Respond JSON only: {"action":"backoff|retry|stop","rationale":"...","backoffMs":120000,"plannerHint":"...","confidence":"high|medium|low"}',
  ].join("\n");

  try {
    const res = await chatOnce(deps.agent, {
      agentName: "swarm-read",
      promptText: prompt,
      clonePath: deps.clonePath,
      runId: deps.runId,
      format: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["backoff", "retry", "stop"] },
          rationale: { type: "string" },
          backoffMs: { type: "number" },
          plannerHint: { type: "string" },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
        },
        required: ["action", "rationale"],
      },
    });
    const text =
      (res as { data?: { parts?: Array<{ text?: string }> } })?.data?.parts?.[0]?.text ?? "";
    const parsed = VerdictSchema.safeParse(JSON.parse(text));
    if (!parsed.success) return null;
    const v = parsed.data;
    return {
      action: v.action,
      source: "arbitrator",
      rationale: v.rationale,
      backoffMs: v.backoffMs,
      plannerHint: v.plannerHint,
      confidence: v.confidence,
    };
  } catch {
    return null;
  }
}