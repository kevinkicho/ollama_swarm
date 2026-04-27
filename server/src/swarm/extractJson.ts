// Task #204: shared "extract JSON from a possibly-fenced LLM response"
// helper. Previously duplicated in 6+ prompt parsers and DebateJudgeRunner
// + transcriptSummary, each with slight variants of the same logic.
//
// Strategy:
//   1. trim()
//   2. unwrap a top-level fenced code block (```json ... ``` or ``` ... ```)
//   3. find the FIRST balanced JSON object/array (depth-counted),
//      stopping at the matching close — NOT spanning to last `}`.
//
// 2026-04-26 fix: the previous "first `{` to last `}`" approach broke
// when models (gemma4 observed) auto-completed multiple fake "next
// prompt + response" cycles after a valid JSON. Span-to-last would
// include all the hallucinated continuation as one giant invalid JSON.
// Balanced-extract correctly stops at the first complete object.

export function extractJsonFromText(raw: string): string | null {
  const s = raw.trim();
  // Top-level fenced block.
  const fenceMatch = s.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  if (fenceMatch) return extractFirstBalanced(fenceMatch[1].trim()) ?? fenceMatch[1].trim();
  // Inner fenced block (preamble allowed before/after).
  const innerFence = s.match(/```(?:json)?\s*\n([\s\S]*?)\n```/i);
  if (innerFence) return extractFirstBalanced(innerFence[1].trim()) ?? innerFence[1].trim();
  // Raw braces fallback — find first balanced object/array.
  return extractFirstBalanced(s);
}

// Find the first balanced JSON object or array in `s`. Returns the
// substring including the outer braces, or null if no balanced pair
// exists. Naively counts braces/brackets — does NOT handle JSON-like
// substrings inside string literals, which is acceptable for our LLM
// response shape (well-formed JSON objects, no embedded {/} mismatches
// in string contents typical for hunks/contracts/verdicts).
function extractFirstBalanced(s: string): string | null {
  // Find first opening brace OR bracket — whichever comes first.
  let firstOpen = -1;
  let openChar = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    if (c === "{" || c === "[") {
      firstOpen = i;
      openChar = c;
      break;
    }
  }
  if (firstOpen < 0) return null;
  const closeChar = openChar === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  for (let i = firstOpen; i < s.length; i++) {
    const c = s.charAt(i);
    if (inString) {
      if (escapeNext) {
        escapeNext = false;
      } else if (c === "\\") {
        escapeNext = true;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === openChar) depth += 1;
    else if (c === closeChar) {
      depth -= 1;
      if (depth === 0) return s.slice(firstOpen, i + 1);
    }
  }
  return null;
}
