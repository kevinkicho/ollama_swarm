// Shared JSON extractor — single source of truth used by both server
// and web. Previously duplicated as:
//   server/src/swarm/extractJson.ts (server-side prompt parsers)
//   web/src/components/extractJson.ts (client-side bubble + summary)
// Both copies were identical after V1 #221 fixes; consolidating here
// per the V2 architecture plan (docs/ARCHITECTURE-V2.md, Step 2).
//
// Strategy:
//   1. trim()
//   2. unwrap a top-level fenced code block (```json ... ``` or ``` ... ```)
//   3. find the FIRST balanced JSON object/array (depth-counted),
//      stopping at the matching close — NOT spanning to last `}`.
//
// Why first-balanced not span: models (gemma4 observed) auto-complete
// chat-template after a real response, producing multiple "fake next
// prompt + response" cycles. Span-to-last would include all
// hallucinated continuation as one giant invalid JSON.
// Balanced-extract correctly stops at the first complete object.

import { stripForJsonParse } from "./stripAgentText.js";

function extractJsonFromNormalized(normalized: string): string | null {
  const s = normalized.trim();
  if (!s) return null;
  // Strip XML pseudo-tool-call markers before JSON extraction.
  const stripped = s
    .replace(/<(?:read|list|grep|glob|edit|bash|propose_hunks)\b[^>]*\/>/g, "")
    .replace(/<(?:read|list|grep|glob|edit|bash|propose_hunks)\b[^>]*>[\s\S]*?<\/(?:read|list|grep|glob|edit|bash|propose_hunks)>/g, "")
    .trim();
  const fenceMatch = stripped.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  if (fenceMatch) return extractFirstBalanced(fenceMatch[1].trim()) ?? fenceMatch[1].trim();
  const innerFence = stripped.match(/```(?:json)?\s*\n([\s\S]*?)\n```/i);
  if (innerFence) return extractFirstBalanced(innerFence[1].trim()) ?? innerFence[1].trim();
  return extractFirstBalanced(stripped);
}

export function extractJsonFromText(raw: string): string | null {
  const fromStripped = extractJsonFromNormalized(stripForJsonParse(raw));
  if (fromStripped) return fromStripped;
  const fromRaw = extractJsonFromNormalized(raw.trim());
  if (fromRaw) return fromRaw;
  // Unclosed <think>: JSON may trail inside the think block (common with deepseek).
  const openIdx = raw.lastIndexOf("<think>");
  if (openIdx !== -1) {
    const afterThink = raw.slice(openIdx + "<think>".length);
    const fromThinkTail = extractJsonFromNormalized(stripForJsonParse(afterThink));
    if (fromThinkTail) return fromThinkTail;
    const fromThinkRaw = extractJsonFromNormalized(afterThink.trim());
    if (fromThinkRaw) return fromThinkRaw;
  }
  return null;
}

// Find the first balanced JSON object or array in `s`. Returns the
// substring including the outer braces, or null if no balanced pair
// exists. Naively counts braces/brackets — does NOT handle JSON-like
// substrings inside string literals, which is acceptable for our LLM
// response shape (well-formed JSON objects, no embedded {/} mismatches
// in string contents typical for hunks/contracts/verdicts).
export function extractFirstBalanced(s: string): string | null {
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

// Convenience alias matching the web-side name.
export const extractFirstBalancedJson = extractFirstBalanced;

/**
 * Extract a labeled JSON block, e.g. "RECOMMENDATION: { ... }" or
 * "CONFIG: { ... }". Uses the shared balanced extractor for robustness.
 * Returns the parsed object or null.
 */
export function extractLabeledJson(text: string, label: string): any | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${escaped}\\s*[:\\-]?\\s*(\\{[\\s\\S]*?\\})`, 'i');
  const match = text.match(re);
  if (!match) return null;
  const raw = match[1];
  const extracted = extractJsonFromText(raw);
  if (!extracted) return null;
  try {
    return JSON.parse(extracted);
  } catch {
    return null;
  }
}
