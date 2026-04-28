// V2 Step 1: direct Ollama chat client.
//
// Replaces the OpenCode-subprocess + SDK + SSE-event-stream layer with
// a single chunked-HTTP read against Ollama's native /api/chat endpoint.
// Eliminates ~600 LOC of subprocess management and the entire class of
// SSE-related bugs (#170, #194, #200, #220, #223).
//
// Ollama's streaming protocol is JSONL on the HTTP body — each line is
// a JSON object with `message.content` (incremental chars). The final
// line has `done: true` plus `prompt_eval_count` + `eval_count` for
// token telemetry. No SSE, no SDK, no subprocess.
//
// This module is the V1-replacement substrate. Initial integration
// will be gated behind a flag and validated preset-by-preset.

// Note: deliberately NOT importing config here so this module is unit-
// testable without the dev-server env (OPENCODE_SERVER_PASSWORD etc.).
// Caller passes baseUrl via opts; the integration site reads config
// once and threads it through.

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOpts {
  /** Base URL of Ollama (or our proxy). E.g. "http://127.0.0.1:11533".
   *  Caller is responsible for stripping any /v1 suffix; we always
   *  POST to `${baseUrl}/api/chat`. */
  baseUrl: string;
  /** Optional diagnostic logger — fires on call start + finish so the
   *  caller can count V2 path uses regardless of whether tokens
   *  arrived (idle-timeout aborts produce no done:true → onTokens
   *  never fires). */
  logDiag?: (record: unknown) => void;
  /** Optional agent identifier for diag log correlation. */
  agentId?: string;
  /** The Ollama model id, e.g. "glm-5.1:cloud" or "gemma4:31b-cloud". */
  model: string;
  /** Conversation history. Last entry is typically the new user prompt. */
  messages: ChatMessage[];
  /** Cancel the in-flight call. The fetch is aborted; the iterator stops. */
  signal: AbortSignal;
  /** Steady-state ms with no body data before we abort the read,
   *  measured AFTER the first chunk arrives. Default 60_000 (60s).
   *  After first chunk we know the model is alive, so a long pause
   *  with no further bytes is real death. */
  idleTimeoutMs?: number;
  /** Cold-start ms with no body data before abort, measured from t0
   *  to the FIRST body chunk. Default 180_000 (180s) — heavy cloud
   *  models (deepseek-v4-pro etc.) routinely take 60-180s to produce
   *  their first byte even when healthy. Pre-2026-04-27 we used the
   *  steady-state idleTimeoutMs (60s) for first-chunk too, which
   *  killed healthy cold-starts on every run. */
  firstChunkTimeoutMs?: number;
  /** Optional callback fired on every chunk with the cumulative
   *  text so far. Lets callers stream into UI without buffering. */
  onChunk?: (cumulativeText: string) => void;
  /** Optional callback fired once the call settles, with token counts
   *  parsed from the final JSONL line. May be undefined if Ollama
   *  didn't include them (older models). */
  onTokens?: (counts: { promptTokens: number; responseTokens: number }) => void;
  /** Task #233 (2026-04-27 evening): Ollama structured-output / JSON
   *  mode. Constrains the model's decoder to emit output matching the
   *  given schema (or just `"json"` for any valid JSON object). The
   *  model literally cannot emit text outside the schema — fixes the
   *  XML pseudo-tool-call marker leak (#231) at the source instead of
   *  stripping after-the-fact. Pass `"json"` for free-form JSON,
   *  pass a JSON Schema object for strict validation.
   *  See https://github.com/ollama/ollama/blob/main/docs/api.md#request-json-mode */
  format?: "json" | Record<string, unknown>;
}

export interface ChatResult {
  /** Full assistant text (concatenation of all `message.content` chunks). */
  text: string;
  /** Total elapsed wall-clock ms. */
  elapsedMs: number;
  /** Reason the call ended. "done" = Ollama signaled done:true.
   *  "aborted" = the AbortSignal fired. "idle-timeout" = no body
   *  data for idleTimeoutMs (call hung). */
  finishReason: "done" | "aborted" | "idle-timeout";
}

export async function chat(opts: ChatOpts): Promise<ChatResult> {
  const t0 = Date.now();
  const idleTimeoutMs = opts.idleTimeoutMs ?? 60_000;
  const firstChunkTimeoutMs = opts.firstChunkTimeoutMs ?? 180_000;
  // Strip any /v1 suffix the caller may have included — the OpenAI-
  // compat path doesn't support our streaming protocol.
  const baseUrl = opts.baseUrl.replace(/\/v1\/?$/, "");
  const url = `${baseUrl}/api/chat`;
  opts.logDiag?.({
    type: "_ollama_direct_call",
    agentId: opts.agentId,
    model: opts.model,
    promptChars: opts.messages.reduce((n, m) => n + m.content.length, 0),
    idleTimeoutMs,
    firstChunkTimeoutMs,
    ts: t0,
  });
  const body = JSON.stringify({
    model: opts.model,
    messages: opts.messages,
    stream: true,
    // #233: forward Ollama's `format` parameter when caller supplied
    // one. Ollama enforces it at the decoder level — model output is
    // grammar-constrained to match the schema, so XML markers and
    // other text-format hallucinations literally cannot be emitted
    // for parser-strict prompts.
    ...(opts.format !== undefined ? { format: opts.format } : {}),
  });

  // Compose the caller's signal with our idle-timeout signal so the
  // fetch aborts on whichever fires first. Two-phase timeout: until
  // the first chunk arrives, allow firstChunkTimeoutMs (default 180s
  // for cold-start tolerance — heavy cloud models need it). Once we've
  // seen any body, switch to idleTimeoutMs (default 60s steady-state).
  const idleAbort = new AbortController();
  let lastByteAt = Date.now();
  let firstChunkSeen = false;
  const idleTimer = setInterval(() => {
    const cap = firstChunkSeen ? idleTimeoutMs : firstChunkTimeoutMs;
    if (Date.now() - lastByteAt > cap) {
      const phase = firstChunkSeen ? "steady-state" : "cold-start";
      idleAbort.abort(
        new Error(`Ollama idle timeout: no body data for ${cap}ms (${phase})`),
      );
    }
  }, 1_000);

  const composed = AbortSignal.any([opts.signal, idleAbort.signal]);
  let finishReason: ChatResult["finishReason"] = "done";

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: composed,
    });
  } catch (err) {
    clearInterval(idleTimer);
    if (opts.signal.aborted) finishReason = "aborted";
    else if (idleAbort.signal.aborted) finishReason = "idle-timeout";
    throw err;
  }

  if (!response.ok) {
    clearInterval(idleTimer);
    const errText = await response.text().catch(() => "");
    throw new Error(`Ollama HTTP ${response.status}: ${errText.slice(0, 200)}`);
  }
  if (!response.body) {
    clearInterval(idleTimer);
    throw new Error("Ollama returned no body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let text = "";
  let promptTokens = 0;
  let responseTokens = 0;

  try {
    while (true) {
      let chunk: { done: boolean; value?: Uint8Array };
      try {
        chunk = await reader.read();
      } catch (err) {
        if (opts.signal.aborted) finishReason = "aborted";
        else if (idleAbort.signal.aborted) finishReason = "idle-timeout";
        throw err;
      }
      if (chunk.done) break;
      lastByteAt = Date.now();
      firstChunkSeen = true;
      buf += decoder.decode(chunk.value, { stream: true });
      // Process complete lines; keep partial line in buf.
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let parsed: {
          message?: { role?: string; content?: string };
          done?: boolean;
          prompt_eval_count?: number;
          eval_count?: number;
        };
        try {
          parsed = JSON.parse(line);
        } catch {
          // Skip malformed lines — Ollama sometimes emits empty lines
          // or partial frames mid-stream.
          continue;
        }
        if (parsed.message?.content) {
          text += parsed.message.content;
          opts.onChunk?.(text);
        }
        if (parsed.done) {
          if (typeof parsed.prompt_eval_count === "number") {
            promptTokens = parsed.prompt_eval_count;
          }
          if (typeof parsed.eval_count === "number") {
            responseTokens = parsed.eval_count;
          }
        }
      }
    }
  } finally {
    clearInterval(idleTimer);
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
  }

  if (opts.onTokens && (promptTokens > 0 || responseTokens > 0)) {
    opts.onTokens({ promptTokens, responseTokens });
  }
  return {
    text,
    elapsedMs: Date.now() - t0,
    finishReason,
  };
}
