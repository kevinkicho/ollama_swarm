// R11 (2026-05-04): universal JSON repair retry.
//
// Several call sites (DebateJudgeRunner, transcriptSummary,
// ollamaProxy) each have their own ad-hoc lenient-JSON parser. Models
// routinely wrap JSON in ```json fences, prepend chatty prose, or omit
// trailing braces — and each call site re-derives the workarounds.
//
// This helper consolidates the strategies into one progressive
// pipeline:
//   1. raw JSON.parse (fast path)
//   2. strip ``` / ```json fences then parse
//   3. extract first {...} or [...] balanced span and parse
//   4. soft repairs: trailing-comma removal, smart-quote → ASCII quote,
//      missing closing brace, single-quoted strings → double-quoted
//
// Returns the parsed value on success or null. Pure: no I/O.

import { stripForJsonParse } from "@ollama-swarm/shared/stripAgentText";

export interface RepairAttempt {
  /** Strategy that produced the parsed value, for diagnostics. */
  strategy: string;
  /** The parsed value (any JSON type). */
  value: unknown;
}

/** Try to parse `text` as JSON, applying progressive repairs.
 *  Returns null when no strategy works. */
export function repairAndParseJson(text: string): RepairAttempt | null {
  if (typeof text !== "string" || text.length === 0) return null;
  // 0. Strip <think> / pseudo-tool XML first (run 9f449937: workers emitted
  // `<think>We …` and repair ran on raw, never saw the trailing JSON).
  const deThought = stripForJsonParse(text);
  const sources: Array<{ label: string; s: string }> = [
    { label: "strict", s: text.trim() },
  ];
  if (deThought && deThought !== text.trim()) {
    sources.unshift({ label: "strip-think", s: deThought });
  }

  for (const src of sources) {
    // Keep legacy strategy names for the raw path so existing diagnostics/tests hold;
    // prefix with strip-think only when we first de-thought the blob.
    const name = (base: string) =>
      src.label === "strip-think" ? `strip-think+${base}` : base === "strict" ? "strict" : base;

    const direct = tryParse(src.s);
    if (direct !== UNPARSEABLE) {
      return { strategy: name(src.label === "strip-think" ? "strict" : "strict"), value: direct };
    }

    const fenceStripped = stripFences(src.s);
    if (fenceStripped !== src.s) {
      const r = tryParse(fenceStripped);
      if (r !== UNPARSEABLE) return { strategy: name("fence-strip"), value: r };
    }
    const sliced = extractBalancedSpan(fenceStripped);
    if (sliced) {
      const r = tryParse(sliced);
      if (r !== UNPARSEABLE) return { strategy: name("balanced-span"), value: r };
    }
    const candidate = sliced ?? fenceStripped;
    const repaired = applySoftRepairs(candidate);
    if (repaired !== candidate) {
      const r = tryParse(repaired);
      if (r !== UNPARSEABLE) return { strategy: name("soft-repairs"), value: r };
    }
  }
  return null;
}

const UNPARSEABLE = Symbol("unparseable");
function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return UNPARSEABLE;
  }
}

/** Strip leading/trailing ``` or ```<lang> fences. */
export function stripFences(s: string): string {
  let out = s.trim();
  // Match ```lang\n ... ``` or ```\n ... ```
  const fenced = out.match(/^```(?:[a-zA-Z0-9_-]+)?\s*\n?([\s\S]*?)\n?```\s*$/);
  if (fenced) return fenced[1].trim();
  return out;
}

/** Find the first balanced {...} or [...] in `s`. Naive — counts
 *  brace depth without honoring strings, but works on most outputs
 *  models produce (proper JSON keys/values rarely have unbalanced
 *  braces inside strings). */
export function extractBalancedSpan(s: string): string | null {
  const start = findFirstBraceOrBracket(s);
  if (start === -1) return null;
  const open = s[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

function findFirstBraceOrBracket(s: string): number {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "{" || s[i] === "[") return i;
  }
  return -1;
}

/** Apply best-effort textual repairs that don't require a real
 *  parser:
 *    - trailing commas in objects/arrays
 *    - smart quotes → ASCII
 *    - single-quoted JSON keys/values → double-quoted
 *    - missing closing brace at end
 */
export function applySoftRepairs(s: string): string {
  let out = s;
  // Smart quotes.
  out = out.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
  // Single-quoted keys: { 'foo': → { "foo":
  out = out.replace(/([{,]\s*)'([^']+)'(\s*:)/g, '$1"$2"$3');
  // Single-quoted string values: : 'foo' → : "foo"  (best-effort, no
  // escapes inside)
  out = out.replace(/:\s*'([^'\n]*)'/g, ': "$1"');
  // Trailing commas before } or ].
  out = out.replace(/,(\s*[}\]])/g, "$1");
  // Missing trailing brace/bracket — count opens vs closes and append
  // the missing tail.
  out = balanceClosingBrackets(out);
  return out;
}

function balanceClosingBrackets(s: string): string {
  let curlyOpen = 0;
  let squareOpen = 0;
  let inString = false;
  let escape = false;
  for (const ch of s) {
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") curlyOpen += 1;
    else if (ch === "}") curlyOpen -= 1;
    else if (ch === "[") squareOpen += 1;
    else if (ch === "]") squareOpen -= 1;
  }
  let tail = "";
  while (squareOpen-- > 0) tail += "]";
  while (curlyOpen-- > 0) tail += "}";
  return tail ? s + tail : s;
}
