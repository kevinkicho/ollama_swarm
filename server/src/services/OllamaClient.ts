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
  /** The Ollama model id, e.g. "glm-5.1:cloud" or "gemma4:31b-cloud". */
  model: string;
  /** Conversation history. Last entry is typically the new user prompt. */
  messages: ChatMessage[];
  /** Cancel the in-flight call. The fetch is aborted; the iterator stops. */
  signal: AbortSignal;
  /** Maximum ms with no body data before we abort the read.
   *  Default 60_000 (60s). The Ollama-direct path doesn't need the
   *  90s + probe + reconnect dance — if the read goes idle for this
   *  long, the model is dead and we abort. */
  idleTimeoutMs?: number;
  /** Optional callback fired on every chunk with the cumulative
   *  text so far. Lets callers stream into UI without buffering. */
  onChunk?: (cumulativeText: string) => void;
  /** Optional callback fired once the call settles, with token counts
   *  parsed from the final JSONL line. May be undefined if Ollama
   *  didn't include them (older models). */
  onTokens?: (counts: { promptTokens: number; responseTokens: number }) => void;
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
  // Strip any /v1 suffix the caller may have included — the OpenAI-
  // compat path doesn't support our streaming protocol.
  const baseUrl = opts.baseUrl.replace(/\/v1\/?$/, "");
  const url = `${baseUrl}/api/chat`;
  const body = JSON.stringify({
    model: opts.model,
    messages: opts.messages,
    stream: true,
  });

  // Compose the caller's signal with our idle-timeout signal so the
  // fetch aborts on whichever fires first.
  const idleAbort = new AbortController();
  let lastByteAt = Date.now();
  const idleTimer = setInterval(() => {
    if (Date.now() - lastByteAt > idleTimeoutMs) {
      idleAbort.abort(new Error(`Ollama idle timeout: no body data for ${idleTimeoutMs}ms`));
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
