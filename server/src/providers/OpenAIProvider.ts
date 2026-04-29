// E3 Phase 1: OpenAIProvider — raw fetch against api.openai.com.
// No @openai/api dep; the API surface is small enough to own.
//
// Streaming protocol (https://platform.openai.com/docs/api-reference/chat/streaming):
//   SSE events with `data: <json>` lines, ending with `data: [DONE]`.
//   Each chunk: { choices: [{ delta: { content: "…" } }], usage?: {…} }
//   Final chunk (when stream_options.include_usage=true) carries the usage block.

import type { ChatOpts, ChatResult, SessionProvider } from "./SessionProvider.js";

const OPENAI_BASE = "https://api.openai.com/v1/chat/completions";

interface OpenAiSseChunk {
  choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export class OpenAIProvider implements SessionProvider {
  readonly id = "openai" as const;

  constructor(private readonly apiKey: string = process.env.OPENAI_API_KEY ?? "") {}

  async chat(opts: ChatOpts): Promise<ChatResult> {
    const t0 = Date.now();
    if (!this.apiKey) {
      return {
        text: "",
        elapsedMs: 0,
        finishReason: "error",
        errorMessage: "OPENAI_API_KEY not set",
      };
    }
    opts.logDiag?.({
      type: "_openai_call",
      agentId: opts.agentId,
      model: opts.model,
      promptChars: opts.messages.reduce((n, m) => n + m.content.length, 0),
      ts: t0,
    });

    // Fold system into messages as the leading system entry.
    const messages =
      opts.system && opts.system.length > 0
        ? [{ role: "system" as const, content: opts.system }, ...opts.messages]
        : opts.messages;

    const body = JSON.stringify({
      model: opts.model,
      messages,
      stream: true,
      // Ensure the final chunk carries the usage block.
      stream_options: { include_usage: true },
      ...(opts.options?.temperature !== undefined ? { temperature: opts.options.temperature } : {}),
      ...(opts.options?.top_p !== undefined ? { top_p: opts.options.top_p } : {}),
    });

    let resp: Response;
    try {
      resp = await fetch(OPENAI_BASE, {
        method: "POST",
        signal: opts.signal,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        text: "",
        elapsedMs: Date.now() - t0,
        finishReason: opts.signal.aborted ? "aborted" : "error",
        errorMessage: msg,
      };
    }
    if (!resp.ok || !resp.body) {
      const errBody = await resp.text().catch(() => "");
      return {
        text: "",
        elapsedMs: Date.now() - t0,
        finishReason: "error",
        errorMessage: `HTTP ${resp.status}${errBody ? `: ${errBody.slice(0, 200)}` : ""}`,
      };
    }

    return await readOpenAiStream(resp.body, opts, t0);
  }
}

// ---------------------------------------------------------------------------
// Pure stream reader — exported for tests.
// ---------------------------------------------------------------------------

export async function readOpenAiStream(
  body: ReadableStream<Uint8Array>,
  opts: Pick<ChatOpts, "signal" | "idleTimeoutMs" | "firstChunkTimeoutMs">,
  t0: number,
): Promise<ChatResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let text = "";
  let promptTokens = 0;
  let responseTokens = 0;
  let lastChunkAt = Date.now();
  const idleTimeoutMs = opts.idleTimeoutMs ?? 60_000;
  const firstChunkTimeoutMs = opts.firstChunkTimeoutMs ?? 180_000;
  let firstChunkSeen = false;

  const checkTimeout = () => {
    const sinceLast = Date.now() - lastChunkAt;
    if (firstChunkSeen) {
      return sinceLast >= idleTimeoutMs ? "idle-timeout" : null;
    }
    return sinceLast >= firstChunkTimeoutMs ? "idle-timeout" : null;
  };

  while (true) {
    if (opts.signal.aborted) {
      return { text, elapsedMs: Date.now() - t0, finishReason: "aborted" };
    }
    const timeoutReason = checkTimeout();
    if (timeoutReason) {
      return { text, elapsedMs: Date.now() - t0, finishReason: timeoutReason };
    }

    // Race read with watchdog tick so blocked reads still respect timeouts.
    let chunk: { done: boolean; value?: Uint8Array };
    const TIMEOUT_TICK_MS = 200;
    try {
      const timeoutSentinel = Symbol("timeout");
      const raced = await Promise.race<typeof timeoutSentinel | { done: boolean; value?: Uint8Array }>([
        reader.read(),
        new Promise<typeof timeoutSentinel>((resolve) =>
          setTimeout(() => resolve(timeoutSentinel), TIMEOUT_TICK_MS),
        ),
      ]);
      if (raced === timeoutSentinel) continue;
      chunk = raced;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (opts.signal.aborted) {
        return { text, elapsedMs: Date.now() - t0, finishReason: "aborted" };
      }
      return { text, elapsedMs: Date.now() - t0, finishReason: "error", errorMessage: msg };
    }
    if (chunk.done) break;
    if (chunk.value && chunk.value.length > 0) {
      lastChunkAt = Date.now();
      firstChunkSeen = true;
      buf += decoder.decode(chunk.value, { stream: true });
      // OpenAI SSE: each event is a single `data: <json>` line, blank
      // line between events. `data: [DONE]` marks terminal.
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice("data: ".length).trim();
        if (payload === "[DONE]") {
          return {
            text,
            elapsedMs: Date.now() - t0,
            finishReason: "done",
            ...(promptTokens + responseTokens > 0
              ? { usage: { promptTokens, responseTokens } }
              : {}),
          };
        }
        let ev: OpenAiSseChunk;
        try {
          ev = JSON.parse(payload) as OpenAiSseChunk;
        } catch {
          continue;
        }
        const delta = ev.choices?.[0]?.delta?.content;
        if (typeof delta === "string") text += delta;
        if (ev.usage) {
          promptTokens = ev.usage.prompt_tokens ?? promptTokens;
          responseTokens = ev.usage.completion_tokens ?? responseTokens;
        }
      }
    }
  }

  return {
    text,
    elapsedMs: Date.now() - t0,
    finishReason: "done",
    ...(promptTokens + responseTokens > 0
      ? { usage: { promptTokens, responseTokens } }
      : {}),
  };
}
