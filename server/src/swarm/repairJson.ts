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
//   2. strip ``` / ```json fences then parse (incl. unclosed openers)
//   3. extract first {...} or [...] balanced span and parse
//   4. soft repairs: trailing-comma, smart quotes, bare keys, missing braces
//
// Soft repair primitives live in @ollama-swarm/shared/softJsonRepair so the
// primary parseJsonEnvelope path shares the same fixes (83dc5910 fence/bare-key).
//
// Returns the parsed value on success or null. Pure: no I/O.

import { stripForJsonParse } from "@ollama-swarm/shared/stripAgentText";
import {
  applySoftJsonRepairs,
  stripJsonFences,
} from "@ollama-swarm/shared/softJsonRepair";

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
    // Soft-repair the balanced span even when applySoftRepairs is identity
    // relative to candidate but tryParse failed earlier on bare keys that
    // need the new shared rules (applySoftRepairs always re-runs now).
    if (sliced) {
      const r2 = tryParse(applySoftRepairs(sliced));
      if (r2 !== UNPARSEABLE) return { strategy: name("soft-repairs"), value: r2 };
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

/** Strip leading/trailing ``` or ```<lang> fences (incl. unclosed openers). */
export function stripFences(s: string): string {
  return stripJsonFences(s);
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

/** Apply best-effort textual repairs (delegates to shared softJsonRepair). */
export function applySoftRepairs(s: string): string {
  return applySoftJsonRepairs(s);
}
