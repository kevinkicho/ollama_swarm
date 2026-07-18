/**
 * Shared agent-response JSON extraction — council + blackboard parse path.
 * Strips thinking / pseudo-tool XML, then extracts the first balanced JSON
 * envelope before JSON.parse (same strategy as extractJsonFromText).
 */

import { extractJsonFromText } from "./extractJson.js";
import { stripForJsonParse } from "./stripAgentText.js";
import {
  applySoftJsonRepairs,
  stripJsonFences,
} from "./softJsonRepair.js";

export type JsonExtractTier = "direct" | "normalized" | "extracted" | "soft-repaired";

export interface JsonExtractResult {
  json: string;
  tier: JsonExtractTier;
}

/**
 * Try fence-strip + soft textual repairs until JSON.parse succeeds.
 * Used only after a direct parse of the same blob already failed.
 */
function tryParseOrSoft(s: string): JsonExtractResult | null {
  const unfenced = stripJsonFences(s);
  const candidates = unfenced === s ? [s] : [unfenced, s];
  for (const c of candidates) {
    try {
      JSON.parse(c);
      // Unfenced form parsed (e.g. leading ```json without closer).
      return { json: c, tier: "soft-repaired" };
    } catch {
      /* continue */
    }
    const repaired = applySoftJsonRepairs(c);
    try {
      JSON.parse(repaired);
      return { json: repaired, tier: "soft-repaired" };
    } catch {
      /* continue */
    }
  }
  return null;
}

/** Best-effort JSON string candidate from an agentic response blob. */
export function extractJsonCandidate(raw: string): JsonExtractResult | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    JSON.parse(trimmed);
    return { json: trimmed, tier: "direct" };
  } catch {
    // continue
  }

  // Prefer strip-first so `<think>…</think>{"hunks":…}` never hits the raw path
  // with a leading '<' (run 9f449937 worker failures).
  const normalized = stripForJsonParse(raw);
  if (normalized.length > 0) {
    try {
      JSON.parse(normalized);
      return { json: normalized, tier: "normalized" };
    } catch {
      // continue
    }
    const softNorm = tryParseOrSoft(normalized);
    if (softNorm) return softNorm;
    const fromNorm = extractJsonFromText(normalized);
    if (fromNorm) {
      try {
        JSON.parse(fromNorm);
        return { json: fromNorm, tier: "extracted" };
      } catch {
        const softExt = tryParseOrSoft(fromNorm);
        if (softExt) return softExt;
      }
    }
  }

  const extracted = extractJsonFromText(raw);
  if (extracted) {
    try {
      JSON.parse(extracted);
      return { json: extracted, tier: "extracted" };
    } catch {
      const softExt = tryParseOrSoft(extracted);
      if (softExt) return softExt;
    }
  }

  // Last chance: soft-repair the raw / stripped blob without balanced extract.
  const softRaw = tryParseOrSoft(normalized || trimmed);
  if (softRaw) return softRaw;

  return null;
}

export type ParseJsonEnvelopeResult =
  | { ok: true; value: unknown; tier: JsonExtractTier }
  | { ok: false; reason: string };

/**
 * True when the blob is (almost) pure thinking with no JSON body after strip.
 * Run 2964afe8 / eee6718f: DeepSeek emits `<think>…` under format:json.
 * Callers treat this as format/provider failure (failover candidate).
 */
export function isPureThinkNoJson(raw: string): boolean {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return false;
  const hasThink =
    /<think\b/i.test(trimmed)
    || /<\/think>/i.test(trimmed)
    || /<thinking\b/i.test(trimmed);
  if (!hasThink) return false;
  const normalized = stripForJsonParse(raw);
  if (!normalized || normalized.trim().length < 2) return true;
  // Residual body still has no JSON markers
  const body = normalized.trim();
  if (!body.includes("{") && !body.includes("[") && !/```(?:json)?/i.test(body)) {
    return true;
  }
  return false;
}

/** Parse top-level JSON from agent output after think/tool stripping. */
export function parseJsonEnvelope(raw: string): ParseJsonEnvelopeResult {
  const candidate = extractJsonCandidate(raw);
  if (!candidate) {
    const trimmed = raw.trim();
    if (!trimmed) {
      return {
        ok: false,
        reason: "empty response — model produced no output after stripping thinking tags",
      };
    }
    if (isPureThinkNoJson(raw)) {
      return {
        ok: false,
        reason:
          "format/provider: pure <think> response with no JSON envelope (failover candidate)",
      };
    }
    try {
      JSON.parse(trimmed);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Leading '<' from unstripped think is the classic pure-think failure mode
      if (/^unexpected token\s*['"]?</i.test(msg) && /<think/i.test(trimmed)) {
        return {
          ok: false,
          reason:
            "format/provider: pure <think> response with no JSON envelope (failover candidate)",
        };
      }
      return { ok: false, reason: `JSON parse failed: ${msg}` };
    }
    return {
      ok: false,
      reason: "no JSON object found after stripping thinking tags and pseudo-tool markers",
    };
  }
  try {
    return { ok: true, value: JSON.parse(candidate.json), tier: candidate.tier };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `JSON parse failed: ${msg}` };
  }
}

/** Log-friendly tier label for system messages. */
export function formatParseTier(tier: JsonExtractTier): string {
  switch (tier) {
    case "direct":
      return "direct";
    case "normalized":
      return "strip";
    case "extracted":
      return "balanced-extract";
    case "soft-repaired":
      return "soft-repair";
  }
}