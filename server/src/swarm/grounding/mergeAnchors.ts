/**
 * Unified first-pass anchor merge (RR-B).
 * Combines planner expected anchors, description extract, and autoDetect.
 */

import { autoDetectAnchors, extractSectionKeywords } from "../blackboard/autoAnchor.js";
import { extractAnchorsFromTodoDescription } from "../blackboard/prompts/worker.js";

export interface MergeAnchorsInput {
  todoDescription: string;
  expectedAnchors?: string[] | undefined;
  /** Live file texts keyed by path (null = missing). */
  fileContents: Record<string, string | null>;
  expectedFiles: string[];
  maxAnchors?: number;
}

/**
 * Merge planner expected + description-extracted + auto-detected anchors.
 * Deduped, order preserved (planner first), capped.
 */
export function mergeAnchorsForTodo(input: MergeAnchorsInput): string[] {
  const max = Math.max(1, Math.min(input.maxAnchors ?? 12, 32));
  const out: string[] = [];
  const seen = new Set<string>();

  const push = (a: string | undefined) => {
    const t = (a ?? "").trim();
    if (!t || seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };

  for (const a of input.expectedAnchors ?? []) push(a);

  for (const a of extractAnchorsFromTodoDescription(input.todoDescription)) {
    push(a);
  }

  // Section keywords that appear in any expected file (not only large files)
  // still help when autoDetect skips small files.
  const keywords = extractSectionKeywords(input.todoDescription);
  for (const f of input.expectedFiles) {
    const content = input.fileContents[f];
    if (!content) continue;
    for (const kw of keywords) {
      if (content.includes(kw)) push(kw);
    }
  }

  for (const a of autoDetectAnchors(
    input.todoDescription,
    input.fileContents,
    input.expectedFiles,
  )) {
    push(a);
  }

  return out.slice(0, max);
}
