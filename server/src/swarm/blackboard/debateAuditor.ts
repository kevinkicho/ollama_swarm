import type { Agent } from "../../services/AgentManager.js";
import type { ExitCriterion } from "./types.js";
import type { TranscriptEntry } from "../../types.js";
import type { AuditorContext } from "./auditorRunner.js";

export interface DebateAuditResult {
  verdict: {
    winner: "pro" | "con";
    confidence: "high" | "medium" | "low";
    nextAction: "advance" | "replan" | "retry";
  };
  proEvidence: string;
  conEvidence: string;
  roundsUsed: number;
}

const DEBATE_JUDGE_JSON_SCHEMA = {
  type: "object",
  properties: {
    winner: { type: "string", enum: ["pro", "con"] },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    reasoning: { type: "string" },
    nextAction: { type: "string", enum: ["advance", "replan", "retry"] },
  },
  required: ["winner", "confidence", "nextAction"],
} as const;

function buildProPrompt(criterion: ExitCriterion, transcript: readonly TranscriptEntry[], userDirective?: string): string {
  const recentWork = transcript
    .filter(e => e.role === "agent")
    .slice(-6)
    .map(e => `[${e.agentId ?? e.agentIndex}] ${e.text.slice(0, 300)}`)
    .join("\n");

  let prompt = `You are the PRO advocate. Argue that this exit criterion IS met. Cite specific code changes from the work transcript.\n\nCriterion: ${criterion.description}\nCriterion ID: ${criterion.id}\nExpected files: ${criterion.expectedFiles.join(", ")}\n\nRecent work transcript:\n${recentWork}`;
  if (userDirective) {
    prompt += `\n\nUser directive: ${userDirective}`;
  }
  prompt += `\n\nMake your case in under 200 words.`;
  return prompt;
}

function buildConPrompt(criterion: ExitCriterion, transcript: readonly TranscriptEntry[], userDirective?: string): string {
  const recentWork = transcript
    .filter(e => e.role === "agent")
    .slice(-6)
    .map(e => `[${e.agentId ?? e.agentIndex}] ${e.text.slice(0, 300)}`)
    .join("\n");

  let prompt = `You are the CON advocate. Argue that this exit criterion IS NOT met. Find gaps, unmet sub-criteria, or insufficient evidence.\n\nCriterion: ${criterion.description}\nCriterion ID: ${criterion.id}\nExpected files: ${criterion.expectedFiles.join(", ")}\n\nRecent work transcript:\n${recentWork}`;
  if (userDirective) {
    prompt += `\n\nUser directive: ${userDirective}`;
  }
  prompt += `\n\nMake your case in under 200 words.`;
  return prompt;
}

function buildJudgePrompt(criterion: ExitCriterion, proResponse: string, conResponse: string): string {
  return `You are the JUDGE. Review PRO's argument (criteria IS met) and CON's argument (criteria IS NOT met). Reach a verdict.\n\nCriterion: ${criterion.description}\n\nPRO's argument:\n${proResponse}\n\nCON's argument:\n${conResponse}\n\nRespond with EXACTLY this JSON shape:\n{"winner": "pro"|"con", "confidence": "high"|"medium"|"low", "reasoning": "<1-2 sentences>", "nextAction": "advance"|"replan"|"retry"}`;
}

function parseJudgeResponse(raw: string): { winner: "pro" | "con"; confidence: "high" | "medium" | "low"; reasoning?: string; nextAction: "advance" | "replan" | "retry" } | null {
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);
    if (!["pro", "con"].includes(parsed.winner)) return null;
    if (!["high", "medium", "low"].includes(parsed.confidence)) return null;
    if (!["advance", "replan", "retry"].includes(parsed.nextAction)) return null;
    return {
      winner: parsed.winner,
      confidence: parsed.confidence,
      reasoning: parsed.reasoning,
      nextAction: parsed.nextAction,
    };
  } catch {
    return null;
  }
}

export async function runDebateAudit(args: {
  pro: Agent;
  con: Agent;
  judge: Agent;
  criterion: ExitCriterion;
  workTranscript: readonly TranscriptEntry[];
  userDirective?: string;
  ctx: AuditorContext;
  maxRounds?: number;
}): Promise<DebateAuditResult> {
  const { pro, con, judge, criterion, workTranscript, ctx, maxRounds = 1 } = args;
  let roundsUsed = 0;
  let proEvidence = "";
  let conEvidence = "";

  const effectiveMaxRounds = Math.min(maxRounds, 2);

  for (let round = 0; round < effectiveMaxRounds; round++) {
    roundsUsed++;

    const proPrompt = buildProPrompt(criterion, workTranscript, args.userDirective);
    const conPrompt = buildConPrompt(criterion, workTranscript, args.userDirective);

    const { response: proResponse } = await ctx.promptPlannerSafely(pro, proPrompt, "swarm-read");
    ctx.appendAgent(pro, proResponse);
    proEvidence = proResponse;

    if (ctx.getStopping()) break;

    const { response: conResponse } = await ctx.promptPlannerSafely(con, conPrompt, "swarm-read");
    ctx.appendAgent(con, conResponse);
    conEvidence = conResponse;

    if (ctx.getStopping()) break;

    const judgePrompt = buildJudgePrompt(criterion, proResponse, conResponse);
    const { response: judgeResponse } = await ctx.promptPlannerSafely(
      judge,
      judgePrompt,
      "swarm-read",
      DEBATE_JUDGE_JSON_SCHEMA,
    );
    if (ctx.getStopping()) break;

    const parsed = parseJudgeResponse(judgeResponse);

    if (!parsed) {
      ctx.appendSystem("[Debate audit] Judge response did not parse. Defaulting to con/low/retry.");
      return {
        verdict: { winner: "con", confidence: "low", nextAction: "retry" },
        proEvidence,
        conEvidence,
        roundsUsed,
      };
    }

    ctx.appendSystem(
      `[Debate audit] Criterion ${criterion.id.slice(0, 8)}: ${parsed.winner} wins (${parsed.confidence} confidence). Next: ${parsed.nextAction}`,
    );

    if (round === 0 && parsed.confidence === "low" && effectiveMaxRounds > 1) {
      // Low confidence on first round — do one more round
      continue;
    }

    return {
      verdict: {
        winner: parsed.winner,
        confidence: parsed.confidence,
        nextAction: parsed.nextAction,
      },
      proEvidence,
      conEvidence,
      roundsUsed,
    };
  }

  // If we exited the loop without returning (e.g. getStopping), return conservative default
  return {
    verdict: { winner: "con", confidence: "low", nextAction: "retry" },
    proEvidence,
    conEvidence,
    roundsUsed,
  };
}