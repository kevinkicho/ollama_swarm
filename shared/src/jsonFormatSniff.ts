/**
 * Early-format sniff for JSON-expecting prompts (workers, auditors, …).
 *
 * Thinking models (deepseek-v4, etc.) stream long <think>…</think> preambles
 * before JSON. Sniffing raw cumulative text for `{`/`[` false-negatives on
 * healthy turns and never aborts pure-think loops (run eee6718f: 12×
 * primary failed on `<think>We …` with no JSON after strip).
 *
 * This helper is pure: text in → ok | fail reason. Callers abort the stream.
 */

import { extractThinkTags } from "./extractThinkTags.js";
import { stripForJsonParse } from "./stripAgentText.js";

export const JSON_FORMAT_SNIFF_MIN_CHARS = 8_192;
/** If we are still think-only past this, treat as wrong-format / stuck. */
export const JSON_FORMAT_THINK_ONLY_MAX_CHARS = 16_000;

export type JsonFormatSniffResult =
  | { ok: true; phase: "thinking" | "has_json" | "too_short" }
  | { ok: false; reason: string };

function hasJsonMarker(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  if (t.includes("{") || t.includes("[")) return true;
  if (/```(?:json)?/i.test(t)) return true;
  return false;
}

/**
 * @param cumulativeRaw Full stream including think tags.
 * @param minChars Don't fail before this many raw chars (default 8k).
 */
export function sniffJsonFormatStream(
  cumulativeRaw: string,
  opts: { minChars?: number; thinkOnlyMax?: number } = {},
): JsonFormatSniffResult {
  const minChars = opts.minChars ?? JSON_FORMAT_SNIFF_MIN_CHARS;
  const thinkOnlyMax = opts.thinkOnlyMax ?? JSON_FORMAT_THINK_ONLY_MAX_CHARS;
  const raw = cumulativeRaw ?? "";
  if (raw.length < minChars) return { ok: true, phase: "too_short" };

  const { thoughts, finalText } = extractThinkTags(raw);
  const thinkLen = thoughts.trim().length;
  const post = finalText.trim();

  // Prefer body after think strip; also try stripForJsonParse for pseudo-tools.
  const body = post.length > 0 ? post : stripForJsonParse(raw);
  if (hasJsonMarker(body) || hasJsonMarker(post)) {
    return { ok: true, phase: "has_json" };
  }

  // Still entirely inside a think block (or fallback emptied final to raw).
  const thinkOnly =
    thinkLen > 0
    && (post.length === 0 || post === raw.trim() || (!hasJsonMarker(post) && thinkLen > post.length));

  if (thinkOnly && thinkLen >= thinkOnlyMax) {
    return {
      ok: false,
      reason:
        `json format sniff: think-only stream ${thinkLen.toLocaleString()} chars with no JSON markers ` +
        `(expected { or [ after thinking)`,
    };
  }

  if (!thinkOnly && raw.length >= minChars && !hasJsonMarker(body)) {
    return {
      ok: false,
      reason:
        `json format sniff: ${raw.length.toLocaleString()} chars streamed without JSON markers ` +
        `(expected { or [ or \`\`\`json)`,
    };
  }

  return { ok: true, phase: thinkOnly ? "thinking" : "too_short" };
}
