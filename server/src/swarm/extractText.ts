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
// Routed through the runner's logDiag callback so the diagnostic
// lands in logs/current.jsonl alongside other per-prompt records,
// not just dev-server stderr. Caller passes its own this.opts.logDiag.
export function extractTextWithDiag(
  res: unknown,
  ctx: {
    runner: string;
    agentId: string;
    agentIndex?: number;
    logDiag?: (rec: Record<string, unknown>) => void;
  },
): string {
  const text = extractText(res);
  if (text !== undefined && text.length > 0) return text;

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

  return "(empty response)";
}
