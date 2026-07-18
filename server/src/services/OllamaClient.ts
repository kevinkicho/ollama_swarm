// V2 Step 1: direct Ollama chat client.
//
// Replaces the OpenCode-subprocess + SDK + SSE-event-stream layer with
// a single chunked-HTTP read against Ollama's native /api/chat endpoint.
// Eliminates ~600 LOC of subprocess management and the entire class of
// SSE-related bugs (#170, #194, #200, #220, #223).
//
// Ollama's streaming protocol is JSONL on the HTTP body — each line is
// a full ChatResponse frame (ollama-js yields every parsed line). Fields
// we listen to: `message.content`, `message.thinking`, `message.tool_calls`,
// and `done` + token counts on the final frame. No SSE, no SDK, no subprocess.
//
// This module is the V1-replacement substrate. Initial integration
// will be gated behind a flag and validated preset-by-preset.

// Note: deliberately NOT importing config here so this module is unit-
// testable without the dev-server env (OPENCODE_SERVER_PASSWORD etc.).
// Caller passes baseUrl via opts; the integration site reads config
// once and threads it through.

import { mergeStreamField } from "@ollama-swarm/shared/streamFieldMerge";

/** Hard ceiling on accumulated thinking+content while reading JSONL.
 *  Defense-in-depth vs streamThinkGuard (which aborts via AbortSignal).
 *  Kept in sync with STREAM_HARD_MAX_TOTAL_CHARS in shared/streamThinkGuard. */
export const OLLAMA_STREAM_HARD_MAX_CHARS = 120_000;

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  thinking?: string;
  tool_calls?: Array<{
    type?: string;
    function: { name: string; arguments?: unknown };
  }>;
  tool_name?: string;
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
  /** Optional API key for Ollama Cloud direct access. When set, sent as
   *  Authorization: Bearer <key> header. Local Ollama doesn't use auth
   *  so this is typically only set by OllamaCloudProvider. */
  apiKey?: string;
  /** Phase 5a of #243: Ollama generation parameters. Forwarded as
   *  the `options` field of /api/chat — temperature, top_p, etc.
   *  Per-agent topology overrides set this from the per-row temperature
   *  input. Undefined = inherit Ollama / model default behavior. */
  options?: {
    temperature?: number;
    top_p?: number;
    [key: string]: unknown;
  };

  /** runId for per-run proxy attribution (sent as X-Swarm-Run-Id). */
  runId?: string;
  /** Ollama tool definitions — paired with tool-loop handling in OllamaProvider. */
  tools?: Array<{
    type: "function";
    function: { name: string; description: string; parameters: Record<string, unknown> };
  }>;
  /**
   * Ollama-only `think` (api.md). boolean or low|medium|high|max.
   * Never set for OpenCode — this client is Ollama HTTP only.
   */
  think?: boolean | "low" | "medium" | "high" | "max";
  /**
   * Ollama-only keep_alive (api.md). string duration ("30m") or seconds number.
   * 0 unloads after the call. Default: server default (~5m) when omitted.
   */
  keep_alive?: string | number;
}

/** Cumulative display text for streaming + final result (thinking wrapped for stripAgentText). */
export function buildOllamaStreamText(thinking: string, content: string): string {
  if (!thinking) return content;
  return `<think>${thinking}</think>${content}`;
}

export interface OllamaParsedToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatResult {
  /** Full assistant text (`message.content`, with `message.thinking` wrapped in think tags). */
  text: string;
  /** Total elapsed wall-clock ms. */
  elapsedMs: number;
  /** Reason the call ended. "done" = Ollama signaled done:true.
   *  "aborted" = the AbortSignal fired. "idle-timeout" = no body
   *  data for idleTimeoutMs (call hung). */
  finishReason: "done" | "aborted" | "idle-timeout";
  /** Parsed tool calls when the model invoked tools this turn. */
  toolCalls?: OllamaParsedToolCall[];
  /** Raw assistant content (no think wrapper) for tool-loop history. */
  contentOnly?: string;
  /** Raw thinking text from this turn. */
  thinkingOnly?: string;
  /** Token counts from final stream frame when Ollama/cloud provides them. */
  usage?: { promptTokens: number; responseTokens: number };
}

function createOllamaTimeoutController(
  idleMs: number,
  firstChunkMs: number,
  isFirstSeen: () => boolean,
  getLastByteAt: () => number,
) {
  const controller = new AbortController();
  const timer = setInterval(() => {
    const cap = isFirstSeen() ? idleMs : firstChunkMs;
    if (Date.now() - getLastByteAt() > cap) {
      controller.abort(new Error(`Ollama idle timeout: no body data for ${cap}ms`));
    }
  }, 1000);
  return {
    controller,
    cleanup: () => clearInterval(timer),
  };
}

export async function chat(opts: any): Promise<ChatResult> {
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
    promptChars: opts.messages.reduce((n: number, m: any) => n + m.content.length, 0),
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
    // Phase 5a of #243: per-agent generation parameters from the
    // topology row (temperature, top_p, num_ctx, num_predict, etc.).
    ...(opts.options !== undefined && Object.keys(opts.options).length > 0
      ? { options: opts.options }
      : {}),
    ...(opts.tools && opts.tools.length > 0 ? { tools: opts.tools } : {}),
    // api.md: think + keep_alive — Ollama native only (this module).
    ...(opts.think !== undefined ? { think: opts.think } : {}),
    ...(opts.keep_alive !== undefined ? { keep_alive: opts.keep_alive } : {}),
  });

  // Two-phase timeout: firstChunk for cold starts, idle after first byte.
  // Extracted helper below for reuse across providers.
  let lastByteAt = Date.now();
  let firstChunkSeen = false;
  const { controller: idleAbort, cleanup: clearIdleTimer } = createOllamaTimeoutController(
    idleTimeoutMs,
    firstChunkTimeoutMs,
    () => firstChunkSeen,
    () => lastByteAt,
  );

  const composed = AbortSignal.any([opts.signal, idleAbort.signal]);
  let finishReason: ChatResult["finishReason"] = "done";

  let response: Response;
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
    };
    if (opts.runId) {
      headers["x-swarm-run-id"] = opts.runId; // for proxy per-run isolation
    }

    const fetchOpts: any = {
      method: "POST",
      headers,
      body,
      signal: composed,
    };
    if (opts.httpDispatcher) {
      fetchOpts.dispatcher = opts.httpDispatcher;
    }
    response = await fetch(url, fetchOpts);
  } catch (err) {
    clearIdleTimer();
    if (opts.signal.aborted) finishReason = "aborted";
    else if (idleAbort.signal.aborted) finishReason = "idle-timeout";
    throw err;
  }

  if (!response.ok) {
    clearIdleTimer();
    const errText = await response.text().catch(() => "");
    throw new Error(`Ollama HTTP ${response.status}: ${errText.slice(0, 200)}`);
  }
  if (!response.body) {
    clearIdleTimer();
    throw new Error("Ollama returned no body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let content = "";
  let thinking = "";
  const toolCalls: OllamaParsedToolCall[] = [];
  let promptTokens = 0;
  let responseTokens = 0;

  const mergeToolCalls = (rawCalls: unknown[]) => {
    for (const raw of rawCalls) {
      if (typeof raw !== "object" || raw === null) continue;
      const fn = (raw as { function?: { name?: string; arguments?: unknown } }).function;
      if (!fn?.name) continue;
      let args: Record<string, unknown> = {};
      const a = fn.arguments;
      if (typeof a === "object" && a !== null && !Array.isArray(a)) {
        args = a as Record<string, unknown>;
      } else if (typeof a === "string") {
        try {
          const parsed = JSON.parse(a) as unknown;
          if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
            args = parsed as Record<string, unknown>;
          }
        } catch { /* */ }
      }
      const existing = toolCalls.find((t) => t.name === fn.name);
      if (existing) {
        existing.arguments = { ...existing.arguments, ...args };
      } else {
        toolCalls.push({ name: fn.name, arguments: args });
      }
    }
  };

  const emitStream = () => {
    const snapshot = buildOllamaStreamText(thinking, content);
    opts.onChunk?.(snapshot);
  };

  let streamCapped = false;
  try {
    while (true) {
      if (streamCapped) break;
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
          message?: {
            role?: string;
            content?: string;
            thinking?: string;
            tool_calls?: unknown[];
          };
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
        let frameTouched = false;
        if (parsed.message?.thinking) {
          thinking = mergeStreamField(thinking, parsed.message.thinking);
          frameTouched = true;
        }
        if (parsed.message?.content) {
          content = mergeStreamField(content, parsed.message.content);
          frameTouched = true;
        }
        if (
          Array.isArray(parsed.message?.tool_calls) &&
          parsed.message.tool_calls.length > 0
        ) {
          mergeToolCalls(parsed.message.tool_calls);
          frameTouched = true;
        }
        if (frameTouched) {
          if (thinking.length + content.length > OLLAMA_STREAM_HARD_MAX_CHARS) {
            // Stop reading further frames — fail-closed on runaway loops
            // even if the AbortSignal path is slow/missing.
            streamCapped = true;
            finishReason = "idle-timeout";
            emitStream();
            try {
              await reader.cancel();
            } catch { /* */ }
            break;
          }
          emitStream();
        }
        if (parsed.done) {
          // Native Ollama fields (local + many cloud models).
          if (typeof parsed.prompt_eval_count === "number") {
            promptTokens = parsed.prompt_eval_count;
          }
          if (typeof parsed.eval_count === "number") {
            responseTokens = parsed.eval_count;
          }
          // OpenAI-compat usage block (some cloud / proxy paths).
          const u = (parsed as { usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            input_tokens?: number;
            output_tokens?: number;
          } }).usage;
          if (u) {
            const pt = u.prompt_tokens ?? u.input_tokens;
            const rt = u.completion_tokens ?? u.output_tokens;
            if (typeof pt === "number" && pt > 0) promptTokens = pt;
            if (typeof rt === "number" && rt > 0) responseTokens = rt;
          }
        }
      }
    }
  } finally {
    clearIdleTimer();
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
    text: buildOllamaStreamText(thinking, content),
    elapsedMs: Date.now() - t0,
    finishReason,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    contentOnly: content,
    thinkingOnly: thinking || undefined,
    ...(promptTokens + responseTokens > 0
      ? { usage: { promptTokens, responseTokens } }
      : {}),
  };
}
