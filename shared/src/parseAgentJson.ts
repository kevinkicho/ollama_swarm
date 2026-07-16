/**
 * Shared agent-response JSON extraction — council + blackboard parse path.
 * Strips thinking / pseudo-tool XML, then extracts the first balanced JSON
 * envelope before JSON.parse (same strategy as extractJsonFromText).
 */

import { extractJsonFromText } from "./extractJson.js";
import { stripForJsonParse } from "./stripAgentText.js";

export type JsonExtractTier = "direct" | "normalized" | "extracted";

export interface JsonExtractResult {
  json: string;
  tier: JsonExtractTier;
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
    const fromNorm = extractJsonFromText(normalized);
    if (fromNorm) {
      try {
        JSON.parse(fromNorm);
        return { json: fromNorm, tier: "extracted" };
      } catch {
        // continue
      }
    }
  }

  const extracted = extractJsonFromText(raw);
  if (extracted) {
    try {
      JSON.parse(extracted);
      return { json: extracted, tier: "extracted" };
    } catch {
      // continue
    }
  }

  return null;
}

export type ParseJsonEnvelopeResult =
  | { ok: true; value: unknown; tier: JsonExtractTier }
  | { ok: false; reason: string };

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
    try {
      JSON.parse(trimmed);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
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
  }
}