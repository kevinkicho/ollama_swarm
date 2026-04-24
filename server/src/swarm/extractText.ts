// Shared response-text extractor for the 5 discussion runners
// (Council, MapReduce, OrchestratorWorker, DebateJudge, Stigmergy).
// Each previously had its own copy of extractText with identical
// behavior; consolidating here so the empty-response instrumentation
// (improvement #3 from the 2026-04-23 retro) lives in one place.
//
// The OpenCode SDK's session.prompt() resolves with one of two
// response shapes depending on SDK version:
//   - data.parts: Array<{ type: "text"|"tool"|..., text?: string }>
//   - data.info.parts: same shape (older SDK / stream-end variant)
// We accept either. A successful response has at least one part with
// `type === "text"` and a string `text` value. A degraded response
// (the "(empty response)" pattern Kevin saw on glm-5.1 fanout) has
// `parts: []` or only non-text parts.

interface OpenCodeResponse {
  data?: {
    parts?: Array<{ type?: string; text?: string }>;
    info?: { parts?: Array<{ type?: string; text?: string }> };
    text?: string;
  };
}

export function extractText(res: unknown): string | undefined {
  const any = res as OpenCodeResponse;
  const parts = any?.data?.parts ?? any?.data?.info?.parts;
  if (Array.isArray(parts)) {
    const texts = parts
      .filter((p) => p?.type === "text" && typeof p.text === "string")
      .map((p) => p.text as string);
    if (texts.length) return texts.join("\n");
  }
  return any?.data?.text;
}

// Diagnostic wrapper: extractText with empty-response logging.
// Call this from runners instead of bare extractText so we get
// structured visibility on the failure mode. Returns the extracted
// text OR the placeholder "(empty response)" — same contract the
// runners already had inline.
//
// Logged payload includes:
//   - partsLength: how many parts the response actually had (0 = no
//     parts at all; >0 = parts existed but none were text-typed)
//   - partTypes: the unique non-text part types present (e.g.
//     ["tool"] tells us the model only emitted tool calls)
//   - hasInfoParts: whether the older info.parts shape was used
//   - hasDataText: whether data.text fallback was empty too
//   - responseShape: a one-line summary the user can grep on
//
// Task #54 (2026-04-24): returns { text, isEmpty } instead of just
// text. Callers that want to retry on model silence (empty response
// despite successful SDK resolution) gate on isEmpty. Callers that
// don't care treat `text` as before — it still contains either the
// extracted text OR the "(empty response)" placeholder.
//
// Routed through the runner's logDiag callback so the diagnostic
// lands in logs/current.jsonl alongside other per-prompt records,
// not just dev-server stderr.
export function extractTextWithDiag(
  res: unknown,
  ctx: {
    runner: string;
    agentId: string;
    agentIndex?: number;
    logDiag?: (rec: Record<string, unknown>) => void;
  },
): { text: string; isEmpty: boolean } {
  const text = extractText(res);
  if (text !== undefined && text.length > 0) return { text, isEmpty: false };

  const any = res as OpenCodeResponse;
  const parts = any?.data?.parts ?? any?.data?.info?.parts;
  const partsLength = Array.isArray(parts) ? parts.length : -1;
  const partTypes = Array.isArray(parts)
    ? Array.from(
        new Set(
          parts
            .map((p) => p?.type)
            .filter((t): t is string => typeof t === "string"),
        ),
      )
    : [];
  const hasInfoParts = Boolean(any?.data?.info?.parts);
  const hasDataText = typeof any?.data?.text === "string" && (any.data.text as string).length > 0;

  ctx.logDiag?.({
    type: "empty_response",
    runner: ctx.runner,
    agentId: ctx.agentId,
    agentIndex: ctx.agentIndex,
    partsLength,
    partTypes,
    hasInfoParts,
    hasDataText,
    // Empty string text falls through to the placeholder too — note it.
    extractedEmptyString: text === "",
    ts: Date.now(),
  });

  return { text: "(empty response)", isEmpty: true };
}

// Task #54: suffix a clarifying message onto a prompt that's being
// retried after an empty response. Makes the retry intent explicit
// ("you returned nothing; please answer substantively") so the model
// has a clear signal to change behavior.
//
// Pattern 8 (2026-04-24): widened to also cover junk-short responses
// (single-token outputs like "4", a hex SHA, or a passwd-like string)
// — same recovery strategy applies. The suffix mentions both modes so
// the model knows what behavior to avoid regardless of which one
// triggered the retry.
export const EMPTY_RESPONSE_RETRY_SUFFIX =
  "\n\nNote: your previous response was degenerate — either it returned no text " +
  "(only tool calls or step markers) OR it was a single short token (a hash, a " +
  "single character, a path-like string) that does not answer the question. " +
  "Please respond now with a substantive multi-sentence plain-text answer — " +
  "no tool calls, no single-token replies, no empty completions.";

// Pattern 8 detector (2026-04-24): observed model-output failure mode where
// nemotron-3-super:cloud returns ultra-short non-language output for the
// council drafter prompt — examples seen on multi-agent-orchestrator runs:
//   - "4"                                          (single digit, agent-3)
//   - "7600262d45a782f6ef4b0f2cdc8a2311f0ef5b19"  (hex SHA shape, agent-1)
//   - ":47000000:47000000:1:::/usr/bin/bash"      (passwd-like, agent-2)
// Each came back from session.prompt with a real text part — so isEmpty
// from extractText is false — but the content is useless. Heuristic:
// short (≤80 chars) AND no internal whitespace = single token, which a
// real council/discussion response never is (those produce multi-sentence
// prose by design). Caller should treat true the same as isEmpty: fire
// retryEmptyResponse with the unified suffix above.
//
// False-positive risk: terse legit replies ("yes", "no") would trip this,
// but discussion presets all instruct ≥250-word responses so a one-token
// reply is wrong regardless. Reviewed: better to retry once than to keep
// degenerate output in the transcript.
export function looksLikeJunk(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false; // empty handled separately via isEmpty
  if (trimmed.length > 80) return false;
  // No internal whitespace = single token; council/orchestrator-worker/etc.
  // prompts always elicit multi-sentence prose, so single-token = failure.
  return !/\s/.test(trimmed);
}
