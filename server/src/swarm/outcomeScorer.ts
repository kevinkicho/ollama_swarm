// Direction 1 Phase 1: run outcome scoring.
//
// After a run completes, a judge model scores the output against a
// multi-dimensional rubric. The result is a RunOutcome with a 0-1
// composite score + per-dimension breakdown. Outcomes are persisted
// to both the run summary and an append-only JSONL history so the
// preset recommender (Phase 2) can learn from past performance.
//
// Builds on the existing rubricGrading module (Q13) — this module
// adds the LLM call, the composite score computation, and the
// outcome-history JSONL writer.
//
// Scoring dimensions:
//   - completeness (0-10): did the run address the full directive?
//   - correctness (0-10): are the findings/suggestions accurate?
//   - specificity (0-10): concrete file paths, line numbers, code?
//   - actionability (0-10): can a reader act without re-asking?
//   - format (0-10): does output match expected shape?
//   Plus per-preset extras (verify-pass for blackboard, etc.)
//
// The composite is a simple average of rubric scores, normalized
// to 0-1. The per-dimension scores stay on the 0-10 scale.

import { promises as fs } from "node:fs";
import path from "node:path";

import type { Agent } from "../services/AgentManager.js";
import type { PresetId, RunConfig } from "./SwarmRunner.js";
import { chatOnce } from "./chatOnce.js";
import { extractText } from "./extractText.js";
import {
  buildRubricGradingPrompt,
  defaultRubricForPreset,
  parseRubricGrade,
  rubricToMarkdownTable,
  type RubricGrade,
  type RubricItem,
} from "./rubricGrading.js";
import type { RunSummary } from "./blackboard/summary.js";

export interface RunOutcomeDimension {
  id: string;
  label: string;
  score: number;
  note: string;
}

/** Full outcome record persisted to outcome-history.jsonl. */
export interface RunOutcome {
  runId: string;
  preset: PresetId;
  agentCount: number;
  rounds: number;
  wallClockMs: number;
  costUsd: number;
  tokenUsage: { prompt: number; completion: number };
  score: number;
  verdict: RubricGrade["verdict"];
  dimensions: RunOutcomeDimension[];
  userRating?: number;
  ts: number;
}

/** Lightweight outcome shape stored in RunSummary.outcome.
 *  No token/cost data — that lives in the full RunOutcome on disk. */
export interface RunOutcomeSummary {
  score: number;
  verdict: RubricGrade["verdict"];
  dimensions: RunOutcomeDimension[];
  userRating?: number;
}

export interface OutcomeScorerContext {
  agent: Agent;
  preset: PresetId;
  runId: string;
  clonePath: string;
  userDirective: string;
  runOutput: string;
  agentCount: number;
  rounds: number;
  wallClockMs: number;
  totalPromptTokens: number;
  totalResponseTokens: number;
  log?: (msg: string) => void;
}

function costFromTokens(prompt: number, completion: number): number {
  const PROMPT_RATE = 0.000003;
  const COMPLETION_RATE = 0.000015;
  return prompt * PROMPT_RATE + completion * COMPLETION_RATE;
}

export async function scoreRun(ctx: OutcomeScorerContext): Promise<RunOutcome | null> {
  const rubric = defaultRubricForPreset(ctx.preset);
  const prompt = buildRubricGradingPrompt({
    directive: ctx.userDirective,
    runOutput: ctx.runOutput,
    preset: ctx.preset,
    rubric,
  });

  let responseText: string;
  try {
    const res = await chatOnce(ctx.agent, {
      agentName: "swarm-outcome-scorer",
      promptText: prompt,
    });
    responseText = extractText(res) ?? "";
  } catch (err) {
    ctx.log?.(
      `Outcome scoring prompt failed (${err instanceof Error ? err.message : String(err)}).`,
    );
    return null;
  }

  if (!responseText) {
    ctx.log?.("Outcome scoring: model returned empty.");
    return null;
  }

  const grade = parseRubricGrade(responseText, rubric);
  if (!grade) {
    ctx.log?.("Outcome scoring: response did not parse as a rubric grade.");
    return null;
  }

  const dimensions: RunOutcomeDimension[] = rubric.map((item) => ({
    id: item.id,
    label: item.label,
    score: grade.scores[item.id] ?? 0,
    note: grade.notes[item.id] ?? "",
  }));

  const costUsd = costFromTokens(ctx.totalPromptTokens, ctx.totalResponseTokens);

  const outcome: RunOutcome = {
    runId: ctx.runId,
    preset: ctx.preset,
    agentCount: ctx.agentCount,
    rounds: ctx.rounds,
    wallClockMs: ctx.wallClockMs,
    costUsd,
    tokenUsage: {
      prompt: ctx.totalPromptTokens,
      completion: ctx.totalResponseTokens,
    },
    score: grade.overall / 10,
    verdict: grade.verdict,
    dimensions,
    ts: Date.now(),
  };

  ctx.log?.(
    `Outcome scoring: ${grade.verdict} · overall ${grade.overall.toFixed(1)}/10${rubricToMarkdownTable({ grade, rubric }).split("\n").length > 3 ? " — dimensions scored." : ""}`,
  );

  return outcome;
}

export function outcomeToMarkdown(outcome: RunOutcome): string {
  const lines: string[] = [
    `**Run Outcome:** ${outcome.verdict.toUpperCase()} · Score: ${(outcome.score * 10).toFixed(1)}/10`,
    "",
    "| Dimension | Score | Note |",
    "| --- | ---: | --- |",
  ];
  for (const d of outcome.dimensions) {
    lines.push(`| ${d.label} | ${d.score}/10 | ${d.note.replace(/\n/g, " ")} |`);
  }
  lines.push("");
  lines.push(
    `Agents: ${outcome.agentCount} · Rounds: ${outcome.rounds} · ` +
      `Wall clock: ${Math.round(outcome.wallClockMs / 1000)}s · ` +
      `Cost: $${outcome.costUsd.toFixed(4)} · ` +
      `Tokens: ${outcome.tokenUsage.prompt.toLocaleString()}↑ ${outcome.tokenUsage.completion.toLocaleString()}↓`,
  );
  return lines.join("\n");
}

const OUTCOME_HISTORY_FILE = "outcome-history.jsonl";

export async function appendOutcomeHistory(
  clonePath: string,
  outcome: RunOutcome,
): Promise<void> {
  const dir = path.join(clonePath, ".swarm-data");
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, OUTCOME_HISTORY_FILE);
  const line = JSON.stringify(outcome) + "\n";
  await fs.appendFile(filePath, line, "utf8");
}

export async function readOutcomeHistory(
  clonePath: string,
): Promise<RunOutcome[]> {
  const filePath = path.join(clonePath, ".swarm-data", OUTCOME_HISTORY_FILE);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return [];
  }
  const outcomes: RunOutcome[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && typeof parsed.score === "number") {
        outcomes.push(parsed as RunOutcome);
      }
    } catch {
      // skip malformed lines
    }
  }
  return outcomes;
}

export function attachOutcomeToSummary(
  summary: RunSummary,
  outcome: RunOutcome,
): RunSummary {
  return {
    ...summary,
    outcome: {
      score: outcome.score,
      verdict: outcome.verdict,
      dimensions: outcome.dimensions,
      userRating: outcome.userRating,
    },
  };
}