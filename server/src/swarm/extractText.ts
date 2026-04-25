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
    if (texts.length) return stripToolCallLeak(texts.join("\n"));
  }
  const fallback = any?.data?.text;
  return typeof fallback === "string" ? stripToolCallLeak(fallback) : fallback;
}

// Task #117: response-side breakdown for latency RCA. Counts text
// parts vs tool-call parts so callers can correlate prompt elapsedMs
// with whether the time was spent generating prose or invoking tools.
// Falls back gracefully when the SDK shape is unfamiliar.
//
// Task #118: also surface the FULL part-type histogram so we can
// detect cases where the SDK uses an unexpected type name for tool
// calls (the type-name check below could be incomplete). The
// histogram lets analysis distinguish "agent did 0 tool calls" from
// "tool calls happened under an unrecognized type-name".
export interface ResponseBreakdown {
  textChars: number;
  textPartCount: number;
  toolCallCount: number;
  otherPartCount: number;
  /** Map of every part-type seen → count. Includes types we already
   *  classified (text/tool/etc) so the histogram is self-contained. */
  partTypeHistogram: Record<string, number>;
}
const TOOL_PART_TYPES = new Set(["tool", "tool_call", "tool_use", "tool-invocation"]);
export function extractResponseBreakdown(res: unknown): ResponseBreakdown {
  const any = res as OpenCodeResponse;
  const parts = any?.data?.parts ?? any?.data?.info?.parts;
  let textChars = 0;
  let textPartCount = 0;
  let toolCallCount = 0;
  let otherPartCount = 0;
  const partTypeHistogram: Record<string, number> = {};
  if (Array.isArray(parts)) {
    for (const p of parts) {
      const t = (p?.type ?? "<missing>") as string;
      partTypeHistogram[t] = (partTypeHistogram[t] ?? 0) + 1;
      if (t === "text" && typeof p.text === "string") {
        textChars += p.text.length;
        textPartCount += 1;
      } else if (TOOL_PART_TYPES.has(t)) {
        toolCallCount += 1;
      } else {
        otherPartCount += 1;
      }
    }
  } else if (typeof any?.data?.text === "string") {
    textChars = (any.data.text as string).length;
    textPartCount = 1;
    partTypeHistogram["<data.text fallback>"] = 1;
  }
  return { textChars, textPartCount, toolCallCount, otherPartCount, partTypeHistogram };
}

// Task #114: nemotron-3-super:cloud sometimes leaks raw OpenCode
// tool-call protocol tokens into its TEXT output (instead of going
// through the proper tool-call channel). Observed in role-diff
// synthesis run 890c05cb: response ended with 30+ repetitions of
//   `<|tool_call_begin|>bash{"command":"npm audit"}<|tool_end|>|4|`
// — the CONVERGENCE: line never appeared because the model was stuck.
//
// Strategy: once we see ANY of these markers, the model is in a
// degenerate loop and everything after the first marker is garbage.
// Truncate at the first marker. If the remaining prefix is empty
// (model started with the leak), keep an explicit marker so the
// downstream junk detector + transcript still see something.
//
// Task #134 (2026-04-25): widened to cover variants seen across
// other Ollama Cloud models that don't use the nemotron pipe-style
// markers — bare `<tool_call>`, `<tool_use>`, `<function_call>`,
// and the generic `<|*tool*|>` framing some 70b-class models emit.
// All branches still anchor on the first hit, so the strip behavior
// is unchanged for nemotron — just adds coverage.
const TOOL_CALL_LEAK_MARKERS: readonly RegExp[] = [
  // nemotron-style pipe-framed markers
  /<\|?tool_call_begin\|?>/i,
  /<\|?tool_end\|?>/i,
  /<\|?tool_call_end\|?>/i,
  /<\|?begin_of_tool\|?>/i,
  /<\|?end_of_tool\|?>/i,
  // bare-XML markers (GPT/Claude-flavored serialization)
  /<tool_call\b/i,
  /<\/tool_call>/i,
  /<tool_use\b/i,
  /<\/tool_use>/i,
  /<function_call\b/i,
  /<\/function_call>/i,
  /<\/tool>/i,
  // catch-all: any pipe-framed token that mentions "tool" or "function"
  // (covers `<|tool_xxx|>` / `<|fn_call|>` / etc.)
  /<\|[^|>]*(?:tool|function)[^|>]*\|>/i,
];
export function stripToolCallLeak(text: string): string {
  let earliest = -1;
  for (const re of TOOL_CALL_LEAK_MARKERS) {
    const m = re.exec(text);
    if (m && (earliest === -1 || m.index < earliest)) {
      earliest = m.index;
    }
  }
  if (earliest === -1) return text;
  const prefix = text.slice(0, earliest).trimEnd();
  if (prefix.length === 0) {
    return "(tool-call leak — model emitted protocol tokens as text)";
  }
  return prefix;
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
// Task #115: when an agent's post-retry text is still junk N times in
// a row, the model is stuck in Pattern 8 territory and won't recover.
// 3 consecutive failures is the threshold: less is normal noise, more
// is the run silently burning tokens on degenerate output. Runners
// surface a system-message warning at this point so users know.
export const JUNK_QUARANTINE_THRESHOLD = 3;

/**
 * Task #115 helper: call after the retry path completes. If the final
 * text still looks like junk, increments the per-agent consecutive-
 * junk counter and emits a loud warning to the transcript when the
 * count crosses JUNK_QUARANTINE_THRESHOLD. If the text recovered
 * (substantive prose), resets the counter.
 *
 * Returns the new consecutive-junk count for diagnostics.
 *
 * Doesn't auto-skip the agent — runner-specific logic. v1 just
 * surfaces visibility. Future v2 may extend with quarantine actions
 * (session restart, model swap, etc.).
 */
export interface JunkTrackerCtx {
  agentId: string;
  recordJunkPostRetry: (agentId: string, isStillJunk: boolean) => number;
  appendSystem: (text: string) => void;
}
export function trackPostRetryJunk(text: string, ctx: JunkTrackerCtx): number {
  const stillJunk = looksLikeJunk(text);
  const count = ctx.recordJunkPostRetry(ctx.agentId, stillJunk);
  if (stillJunk && count === JUNK_QUARANTINE_THRESHOLD) {
    ctx.appendSystem(
      `[${ctx.agentId}] STUCK: ${count} consecutive turns of degenerate output (Pattern 8) — retries are not recovering. The model may need a session restart or different prompt phrasing.`,
    );
  } else if (stillJunk && count > JUNK_QUARANTINE_THRESHOLD) {
    // Throttle: only warn at the threshold and every 5th turn after,
    // so a long-stuck agent doesn't flood the transcript.
    if ((count - JUNK_QUARANTINE_THRESHOLD) % 5 === 0) {
      ctx.appendSystem(
        `[${ctx.agentId}] still stuck — ${count} consecutive junk turns and counting.`,
      );
    }
  }
  return count;
}

// Task #112: known placeholder strings that mean "the model produced
// nothing useful" — either our own "(empty response)" fallback, or
// strings the model copied from instructions / SDK errors. Matched
// case-insensitively at the start of the trimmed response so a longer
// variant like "(empty response — server timeout)" still trips.
const KNOWN_PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /^\(empty response\b/i,
  /^\(content truncated\b/i,
  /^\(no response from model\b/i,
  /^\(no response\b/i,
  // Task #114: stripToolCallLeak's "model started with leak" marker
  /^\(tool-call leak\b/i,
];

export function looksLikeJunk(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false; // empty handled separately via isEmpty
  // Task #112: known-placeholder match — catches degenerate outputs
  // where length-based rules wouldn't (e.g. a longer "(empty response —
  // upstream 502)" string). Run before length checks so the diagnostic
  // is consistent across short and long placeholder variants.
  for (const re of KNOWN_PLACEHOLDER_PATTERNS) {
    if (re.test(trimmed)) return true;
  }
  // Single-token: very short, no whitespace at all (hex SHA, "4", passwd-like).
  // Council/orchestrator-worker/etc. prompts always elicit multi-sentence
  // prose, so single-token = failure regardless of length up to 80 chars.
  if (trimmed.length <= 80 && !/\s/.test(trimmed)) return true;
  // Trivially-short multi-word: 2026-04-24 OW run had agent-4 return
  // "MEXICAN PASSION FRUIT" (21 chars, 3 words) and similar non-sequiturs.
  // Discussion presets all request ≥250-word responses, so anything under
  // 30 chars total is definitionally inadequate even if grammatically valid.
  // False positives ("Yes, agreed.") are also degenerate in this context
  // — the prompts ask for multi-sentence analysis, not acknowledgements.
  if (trimmed.length <= 30) return true;
  return false;
}
