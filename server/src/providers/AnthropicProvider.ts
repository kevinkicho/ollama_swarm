// E3 Phase 1: AnthropicProvider — raw fetch against api.anthropic.com.
// Deliberately does NOT depend on @anthropic-ai/sdk so we don't add a
// new package. Anthropic's HTTP API is small enough that owning the
// stream parser ourselves is a few dozen lines.
//
// Streaming protocol (https://docs.anthropic.com/en/api/messages-streaming):
//   SSE events with `event: <type>` and `data: { ... }` lines.
//   - message_start          → message metadata (id, model, usage.input_tokens)
//   - content_block_start    → start of a text block
//   - content_block_delta    → { delta: { type: "text_delta", text: "…" } }
//   - content_block_stop     → end of block
//   - message_delta          → { usage: { output_tokens: N } }
//   - message_stop           → terminal
//
// We accumulate text from content_block_delta and read usage from
// message_start (input) + message_delta (output). API key reads from
// process.env.ANTHROPIC_API_KEY.

import type { ChatOpts, ChatResult, SessionProvider } from "./SessionProvider.js";

const ANTHROPIC_BASE = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

interface AnthropicSseEvent {
  type: string;
  index?: number;
  delta?: { type?: string; text?: string };
  message?: { id?: string; usage?: { input_tokens?: number; output_tokens?: number } };
  usage?: { input_tokens?: number; output_tokens?: number };
}

export class AnthropicProvider implements SessionProvider {
  readonly id = "anthropic" as const;

  constructor(private readonly apiKey: string = process.env.ANTHROPIC_API_KEY ?? "") {
    if (!this.apiKey) {
      // Lazy: we let chat() fail rather than throwing here so factory
      // construction stays cheap. The caller checks /api/providers
      // BEFORE picking this provider, so reaching chat() with no key
      // is a logic error worth a clear error message.
    }
  }

  async chat(opts: ChatOpts): Promise<ChatResult> {
    const t0 = Date.now();
    if (!this.apiKey) {
      return {
        text: "",
        elapsedMs: 0,
        finishReason: "error",
        errorMessage: "ANTHROPIC_API_KEY not set",
      };
    }
    opts.logDiag?.({
      type: "_anthropic_call",
      agentId: opts.agentId,
      model: opts.model,
      promptChars: opts.messages.reduce((n, m) => n + m.content.length, 0),
      ts: t0,
    });

    // Anthropic requires max_tokens; 8192 is a reasonable default for
    // the use case (worker hunks, planner JSON, etc.). Callers can
    // override via opts.options.max_tokens.
    const maxTokens = (opts.options?.max_tokens as number | undefined) ?? 8192;

    const body = JSON.stringify({
      model: opts.model,
      max_tokens: maxTokens,
      stream: true,
      ...(opts.system ? { system: opts.system } : {}),
      messages: opts.messages.map((m) => ({ role: m.role, content: m.content })),
      ...(opts.options?.temperature !== undefined ? { temperature: opts.options.temperature } : {}),
      ...(opts.options?.top_p !== undefined ? { top_p: opts.options.top_p } : {}),
    });

    let resp: Response;
    try {
      resp = await fetch(ANTHROPIC_BASE, {
        method: "POST",
        signal: opts.signal,
        headers: {
          "x-api-key": this.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
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

    return await readAnthropicStream(resp.body, opts, t0);
  }
}

// ---------------------------------------------------------------------------
// Pure stream reader — exported for tests.
// ---------------------------------------------------------------------------

export async function readAnthropicStream(
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

  // Idle / first-chunk watchdog. We rely on the AbortSignal threading
  // back through fetch — when the timer trips, we abort via opts.signal
  // wrapper isn't possible here since we don't own it. Instead we
  // raise a finishReason and let the caller's signal handle teardown
  // on retry.
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

    // Race the read with a watchdog timer so a never-arriving chunk
    // doesn't block forever — checkTimeout decides on next loop tick.
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
      if (raced === timeoutSentinel) continue; // re-check timeout / signal at top of loop
      chunk = raced;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (opts.signal.aborted) {
        return { text, elapsedMs: Date.now() - t0, finishReason: "aborted" };
      }
      return {
        text,
        elapsedMs: Date.now() - t0,
        finishReason: "error",
        errorMessage: msg,
      };
    }
    if (chunk.done) break;
    if (chunk.value && chunk.value.length > 0) {
      lastChunkAt = Date.now();
      firstChunkSeen = true;
      buf += decoder.decode(chunk.value, { stream: true });
      // SSE: events delimited by blank lines; each event has
      // `event: <type>\ndata: <json>` lines.
      let nl;
      while ((nl = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
        if (!dataLine) continue;
        const json = dataLine.slice("data: ".length).trim();
        if (!json) continue;
        let ev: AnthropicSseEvent;
        try {
          ev = JSON.parse(json) as AnthropicSseEvent;
        } catch {
          continue;
        }
        switch (ev.type) {
          case "content_block_delta":
            if (ev.delta?.type === "text_delta" && typeof ev.delta.text === "string") {
              text += ev.delta.text;
            }
            break;
          case "message_start":
            if (ev.message?.usage?.input_tokens !== undefined) {
              promptTokens = ev.message.usage.input_tokens;
            }
            break;
          case "message_delta":
            if (ev.usage?.output_tokens !== undefined) {
              responseTokens = ev.usage.output_tokens;
            }
            break;
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
