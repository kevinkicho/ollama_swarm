import { test } from "node:test";
import assert from "node:assert/strict";
import { readAnthropicStream, AnthropicProvider } from "./AnthropicProvider.js";
import { readOpenAiStream, OpenAIProvider } from "./OpenAIProvider.js";
import { pickProvider, __resetProviderSingletons } from "./pickProvider.js";

// Helper: build a ReadableStream from an array of byte chunks.
function streamOf(chunks: Array<string | Uint8Array>): ReadableStream<Uint8Array> {
  let i = 0;
  const enc = new TextEncoder();
  return new ReadableStream({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      const c = chunks[i++];
      controller.enqueue(typeof c === "string" ? enc.encode(c) : c);
    },
  });
}

const noopSignal = new AbortController().signal;

// ---------------------------------------------------------------------------
// readAnthropicStream
// ---------------------------------------------------------------------------

test("readAnthropicStream — assembles text from content_block_delta events", async () => {
  const events =
    `event: message_start\ndata: {"type":"message_start","message":{"id":"m1","usage":{"input_tokens":100}}}\n\n` +
    `event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n\n` +
    `event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":", world"}}\n\n` +
    `event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":50}}\n\n` +
    `event: message_stop\ndata: {"type":"message_stop"}\n\n`;
  const result = await readAnthropicStream(streamOf([events]), { signal: noopSignal }, Date.now());
  assert.equal(result.text, "Hello, world");
  assert.equal(result.finishReason, "done");
  assert.deepEqual(result.usage, { promptTokens: 100, responseTokens: 50 });
});

test("readAnthropicStream — handles chunks split mid-event", async () => {
  // Same events but split arbitrarily across reads
  const events =
    `event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"foo"}}\n\n` +
    `event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"bar"}}\n\n`;
  // Split into 5-byte chunks — exercises the buffering loop
  const chunks: string[] = [];
  for (let p = 0; p < events.length; p += 5) chunks.push(events.slice(p, p + 5));
  const result = await readAnthropicStream(streamOf(chunks), { signal: noopSignal }, Date.now());
  assert.equal(result.text, "foobar");
});

test("readAnthropicStream — aborted signal halts cleanly", async () => {
  const ctrl = new AbortController();
  const stream = new ReadableStream<Uint8Array>({
    pull() {
      // never resolve
    },
  });
  // Schedule abort after the read attempt is in flight
  setTimeout(() => ctrl.abort(), 30);
  const result = await readAnthropicStream(stream, { signal: ctrl.signal, idleTimeoutMs: 5_000, firstChunkTimeoutMs: 5_000 }, Date.now());
  assert.equal(result.finishReason, "aborted");
  assert.equal(result.text, "");
});

test("readAnthropicStream — first-chunk timeout triggers idle-timeout finish", async () => {
  const stream = new ReadableStream<Uint8Array>({
    pull() {
      // never resolve — internal watchdog (200ms tick) lets the loop
      // notice the firstChunkTimeoutMs has elapsed.
    },
  });
  const result = await readAnthropicStream(
    stream,
    { signal: noopSignal, idleTimeoutMs: 1_000, firstChunkTimeoutMs: 100 },
    Date.now(),
  );
  assert.equal(result.finishReason, "idle-timeout");
});

test("AnthropicProvider — chat returns error when no API key set", async () => {
  const p = new AnthropicProvider("");
  const result = await p.chat({
    model: "claude-opus-4-7",
    messages: [{ role: "user", content: "hi" }],
    signal: noopSignal,
  });
  assert.equal(result.finishReason, "error");
  assert.match(result.errorMessage ?? "", /ANTHROPIC_API_KEY/);
});

// ---------------------------------------------------------------------------
// readOpenAiStream
// ---------------------------------------------------------------------------

test("readOpenAiStream — assembles text from delta.content + records usage", async () => {
  const events =
    `data: {"choices":[{"delta":{"content":"foo"}}]}\n\n` +
    `data: {"choices":[{"delta":{"content":"bar"}}]}\n\n` +
    `data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":20}}\n\n` +
    `data: [DONE]\n\n`;
  const result = await readOpenAiStream(streamOf([events]), { signal: noopSignal }, Date.now());
  assert.equal(result.text, "foobar");
  assert.equal(result.finishReason, "done");
  assert.deepEqual(result.usage, { promptTokens: 10, responseTokens: 20 });
});

test("readOpenAiStream — terminates on [DONE] even without usage block", async () => {
  const events =
    `data: {"choices":[{"delta":{"content":"only"}}]}\n\n` +
    `data: [DONE]\n\n`;
  const result = await readOpenAiStream(streamOf([events]), { signal: noopSignal }, Date.now());
  assert.equal(result.text, "only");
  assert.equal(result.finishReason, "done");
  assert.equal(result.usage, undefined);
});

test("OpenAIProvider — chat returns error when no API key set", async () => {
  const p = new OpenAIProvider("");
  const result = await p.chat({
    model: "gpt-5",
    messages: [{ role: "user", content: "hi" }],
    signal: noopSignal,
  });
  assert.equal(result.finishReason, "error");
  assert.match(result.errorMessage ?? "", /OPENAI_API_KEY/);
});

// ---------------------------------------------------------------------------
// pickProvider factory
// ---------------------------------------------------------------------------

test("pickProvider — bare model defaults to ollama, strips no prefix", () => {
  __resetProviderSingletons();
  const { provider, modelId } = pickProvider("glm-5.1:cloud");
  assert.equal(provider.id, "ollama");
  assert.equal(modelId, "glm-5.1:cloud");
});

test("pickProvider — anthropic-prefixed routes to AnthropicProvider with bare modelId", () => {
  __resetProviderSingletons();
  const { provider, modelId } = pickProvider("anthropic/claude-opus-4-7");
  assert.equal(provider.id, "anthropic");
  assert.equal(modelId, "claude-opus-4-7");
});

test("pickProvider — openai-prefixed routes to OpenAIProvider with bare modelId", () => {
  __resetProviderSingletons();
  const { provider, modelId } = pickProvider("openai/gpt-5-mini");
  assert.equal(provider.id, "openai");
  assert.equal(modelId, "gpt-5-mini");
});

test("pickProvider — singleton reuse: same call twice returns same provider instance", () => {
  __resetProviderSingletons();
  const a = pickProvider("anthropic/claude-opus-4-7").provider;
  const b = pickProvider("anthropic/claude-haiku-4-5-20251001").provider;
  assert.equal(a, b, "expected the same AnthropicProvider singleton across calls");
});
