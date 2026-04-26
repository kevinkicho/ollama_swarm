// Task #204: shared "extract JSON from a possibly-fenced LLM response"
// helper. Previously duplicated in 6+ prompt parsers and DebateJudgeRunner
// + transcriptSummary, each with slight variants of the same logic.
//
// Strategy:
//   1. trim()
//   2. unwrap a top-level fenced code block (```json ... ``` or ``` ... ```)
//   3. fall back to the substring between the first `{` and last `}`
//
// Returns the candidate JSON text (NOT parsed) so callers can run their
// own JSON.parse with their own error handling. Returns null when no
// candidate found.
//
// The first-brace check uses `>= 0` (not `> 0`) so raw responses that
// START with `{` are matched. The strict-parse path in callers usually
// handles the position-0 case before falling here, but allowing both
// keeps the helper's contract clean.

export function extractJsonFromText(raw: string): string | null {
  const s = raw.trim();
  // Top-level fenced block.
  const fenceMatch = s.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  if (fenceMatch) return fenceMatch[1].trim();
  // Inner fenced block (preamble allowed before/after).
  const innerFence = s.match(/```(?:json)?\s*\n([\s\S]*?)\n```/i);
  if (innerFence) return innerFence[1].trim();
  // Raw braces fallback.
  const firstBrace = s.indexOf("{");
  const lastBrace = s.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return s.slice(firstBrace, lastBrace + 1);
  }
  return null;
}
