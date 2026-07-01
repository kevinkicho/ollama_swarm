// #92 deeper (2026-05-01): LLM-as-judge prompt for hunk voting tiebreak.
//
// When self-consistency voting produces no strict majority, the runner
// asks an LLM (auditor preferred, planner as fallback) to pick the
// best candidate. This module just builds the prompt — the dispatch
// + parse loop lives in BlackboardRunner.executeWorkerTodo.
//
// Pure module; testable without mocking provider.chat.

import type { JudgeCandidate } from "./hunkVoting.js";

export interface JudgePromptInput {
  todoDescription: string;
  expectedFiles: readonly string[];
  candidates: readonly JudgeCandidate[];
}

/** Build the prompt the LLM-judge sees. The model is asked to reply
 *  with strict JSON `{"winner": N}` where N is 1..candidates.length. */
export function buildJudgePrompt(input: JudgePromptInput): string {
  const parts: string[] = [];
  parts.push(
    "You are a code-review judge. Multiple workers each proposed a different patch for the same TODO. None had a clear majority. Pick the patch that best fixes the issue with the smallest, most-correct edit.",
  );
  parts.push("");
  parts.push(`TODO: ${input.todoDescription}`);
  parts.push(`Expected files: ${input.expectedFiles.join(", ")}`);
  parts.push("");
  parts.push(`${input.candidates.length} candidate patch(es):`);
  for (const [i, c] of input.candidates.entries()) {
    parts.push("");
    parts.push(`--- Candidate ${i + 1} (proposed by ${c.workerIds.length} worker(s): ${c.workerIds.join(", ")}) ---`);
    for (const [j, h] of c.hunks.entries()) {
      parts.push(`  Hunk ${j + 1}: op=${h.op} file=${h.file}`);
      if (h.op === "replace") {
        parts.push(`    SEARCH:`);
        for (const line of h.search.slice(0, 800).split("\n")) parts.push(`      ${line}`);
        parts.push(`    REPLACE:`);
        for (const line of h.replace.slice(0, 800).split("\n")) parts.push(`      ${line}`);
      } else if (h.op === "delete") {
        parts.push(`    (delete only — no content)`);
      } else {
        parts.push(`    CONTENT:`);
        for (const line of (h as { content: string }).content.slice(0, 800).split("\n")) parts.push(`      ${line}`);
      }
    }
  }
  parts.push("");
  parts.push(
    `Reply with ONLY this JSON: {"winner": N} where N is the number (1..${input.candidates.length}) of the best candidate. No prose, no markdown fences.`,
  );
  return parts.join("\n");
}
