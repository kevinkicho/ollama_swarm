import { test } from "node:test";
import assert from "node:assert/strict";
import { readAnthropicStream, readAnthropicStreamFull, AnthropicProvider } from "./AnthropicProvider.js";
import { readOpenAiStream, readOpenAiStreamFull, OpenAIProvider } from "./OpenAIProvider.js";
import { pickProvider, __resetProviderSingletons } from "./pickProvider.js";
import { config } from "../config.js";

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

// Regression for the 2026-05-01 streaming-truncation bug: when chunks
// arrive with delays > the loop's TIMEOUT_TICK_MS (200ms), the previous
// `Promise.race([reader.read(), timeout])` pattern abandoned in-flight
// reads. The abandoned promise consumed subsequent chunks, dropping
// every other chunk. This test gates each chunk behind a 250ms delay so
// the bug — if reintroduced — surfaces as truncated text.
test("readAnthropicStream — survives 250ms inter-chunk delays (no chunk-drop regression)", async () => {
  const events = [
    `event: message_start\ndata: {"type":"message_start","message":{"id":"m1","usage":{"input_tokens":1}}}\n\n`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"chunk1 "}}\n\n`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"chunk2 "}}\n\n`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"chunk3 "}}\n\n`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"chunk4"}}\n\n`,
    `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}\n\n`,
    `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
  ];
  // Each pull() resolves after 250ms — longer than the 200ms timeout
  // tick, so the buggy version dropped chunks here.
  let i = 0;
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (i >= events.length) {
        controller.close();
        return;
      }
      await new Promise((r) => setTimeout(r, 250));
      controller.enqueue(enc.encode(events[i++]));
    },
  });
  const result = await readAnthropicStream(
    stream,
    { signal: noopSignal, idleTimeoutMs: 10_000, firstChunkTimeoutMs: 10_000 },
    Date.now(),
  );
  assert.equal(result.finishReason, "done");
  assert.equal(result.text, "chunk1 chunk2 chunk3 chunk4");
  assert.deepEqual(result.usage, { promptTokens: 1, responseTokens: 4 });
});

test("readOpenAiStream — survives 250ms inter-chunk delays (no chunk-drop regression)", async () => {
  // Same regression coverage for OpenAIProvider — same fix, same risk.
  const events = [
    `data: {"choices":[{"delta":{"content":"chunk1 "}}]}\n\n`,
    `data: {"choices":[{"delta":{"content":"chunk2 "}}]}\n\n`,
    `data: {"choices":[{"delta":{"content":"chunk3 "}}]}\n\n`,
    `data: {"choices":[{"delta":{"content":"chunk4"}}]}\n\n`,
    `data: {"usage":{"prompt_tokens":1,"completion_tokens":4}}\n\n`,
    `data: [DONE]\n\n`,
  ];
  let i = 0;
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (i >= events.length) {
        controller.close();
        return;
      }
      await new Promise((r) => setTimeout(r, 250));
      controller.enqueue(enc.encode(events[i++]));
    },
  });
  const result = await readOpenAiStream(
    stream,
    { signal: noopSignal, idleTimeoutMs: 10_000, firstChunkTimeoutMs: 10_000 },
    Date.now(),
  );
  assert.equal(result.finishReason, "done");
  assert.equal(result.text, "chunk1 chunk2 chunk3 chunk4");
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

test("readAnthropicStreamFull — captures tool_use blocks with parsed input", async () => {
  // Realistic-shape Anthropic tool-use stream: text + tool_use both
  // emitted, indexed at 0 and 1, JSON streamed across multiple deltas.
  const events =
    `event: message_start\ndata: {"type":"message_start","message":{"id":"m1","usage":{"input_tokens":50}}}\n\n` +
    `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n` +
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"I'll grep for it."}}\n\n` +
    `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n` +
    `event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_x","name":"grep"}}\n\n` +
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"pattern\\":"}}\n\n` +
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"function add\\"}"}}\n\n` +
    `event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n` +
    `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":30}}\n\n` +
    `event: message_stop\ndata: {"type":"message_stop"}\n\n`;
  const result = await readAnthropicStreamFull(streamOf([events]), { signal: noopSignal });
  assert.equal(result.finishReason, "done");
  assert.equal(result.stopReason, "tool_use");
  assert.equal(result.blocks.length, 2);
  assert.deepEqual(result.blocks[0], { type: "text", text: "I'll grep for it." });
  assert.deepEqual(result.blocks[1], {
    type: "tool_use",
    id: "toolu_x",
    name: "grep",
    input: { pattern: "function add" },
  });
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

test("readOpenAiStreamFull — captures tool_calls with arguments streamed across chunks", async () => {
  // OpenAI streams tool-call name on first chunk, then arguments JSON
  // in fragments, finally finish_reason="tool_calls".
  const events =
    `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_x","type":"function","function":{"name":"grep","arguments":""}}]}}]}\n` +
    `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"pattern\\":"}}]}}]}\n` +
    `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"function add\\"}"}}]}}]}\n` +
    `data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":40,"completion_tokens":15}}\n` +
    `data: [DONE]\n`;
  const result = await readOpenAiStreamFull(streamOf([events]), { signal: noopSignal });
  assert.equal(result.finishReason, "done");
  assert.equal(result.stopReason, "tool_calls");
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].id, "call_x");
  assert.equal(result.toolCalls[0].name, "grep");
  assert.deepEqual(JSON.parse(result.toolCalls[0].argsJson), { pattern: "function add" });
  assert.equal(result.promptTokens, 40);
  assert.equal(result.responseTokens, 15);
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

test("pickProvider — :cloud model routes to ollama-cloud when API key present", () => {
  __resetProviderSingletons();
  const { provider, modelId } = pickProvider("glm-5.1:cloud");
  if (config.OLLAMA_CLOUD_API_KEY || config.OLLAMA_API_KEY) {
    assert.equal(provider.id, "ollama-cloud");
  } else {
    assert.equal(provider.id, "ollama");
  }
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

// #86 (2026-05-01): OllamaProvider must forward `format` to the
// underlying ollamaChat call. Without this, the constrained-decoding
// pipeline goes through promptWithRetry → OllamaProvider → ollamaChat
// and silently drops the format halfway. Mock ollamaChat at the
// module level via a manual stub injected into a fresh provider.
test("OllamaProvider — forwards format to ollamaChat", async () => {
  // Use a fake fetch shim: replace global fetch for this test only,
  // capture the request body, and assert format made it through.
  const realFetch = globalThis.fetch;
  let observedBody: any = null;
  globalThis.fetch = (async (_url: string, init: any) => {
    observedBody = init?.body ? JSON.parse(init.body) : null;
    // Minimal valid Ollama JSONL response: one chunk + done
    const lines = [
      JSON.stringify({ message: { role: "assistant", content: "ok" } }),
      JSON.stringify({ done: true, prompt_eval_count: 1, eval_count: 1 }),
    ].join("\n") + "\n";
    return new Response(lines, { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
  }) as unknown as typeof fetch;
  try {
    const provider = new (await import("./OllamaProvider.js")).OllamaProvider("http://localhost:11434");
    const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };
    await provider.chat({
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
      signal: new AbortController().signal,
      format: schema,
    });
    assert.deepEqual(observedBody.format, schema, "format field must reach Ollama");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("OpenAIProvider — forwards response_format on tool-free emit calls", async () => {
  const realFetch = globalThis.fetch;
  let observedBody: Record<string, unknown> | null = null;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    observedBody = init?.body ? JSON.parse(init.body as string) : null;
    const events =
      `data: {"choices":[{"delta":{"content":"{}"}}]}\n\n` +
      `data: [DONE]\n\n`;
    return new Response(events, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }) as unknown as typeof fetch;
  try {
    const { CONTRACT_JSON_SCHEMA } = await import("../swarm/blackboard/prompts/jsonSchemas.js");
    const p = new OpenAIProvider("sk-test-key");
    await p.chat({
      model: "gpt-5-mini",
      messages: [{ role: "user", content: "emit" }],
      signal: new AbortController().signal,
      format: CONTRACT_JSON_SCHEMA,
    });
    const rf = observedBody!.response_format as {
      type: string;
      json_schema: { name: string; strict: boolean; schema: unknown };
    };
    assert.equal(rf.type, "json_schema");
    assert.equal(rf.json_schema.strict, true);
    assert.equal(rf.json_schema.name, "emit_response");
    assert.deepEqual(rf.json_schema.schema, CONTRACT_JSON_SCHEMA);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("OpenAIProvider — omits response_format when tools are active", async () => {
  const realFetch = globalThis.fetch;
  let observedBody: Record<string, unknown> | null = null;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    observedBody = init?.body ? JSON.parse(init.body as string) : null;
    const events =
      `data: {"choices":[{"delta":{"content":"ok"}}]}\n\n` +
      `data: [DONE]\n\n`;
    return new Response(events, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }) as unknown as typeof fetch;
  try {
    const { CONTRACT_JSON_SCHEMA } = await import("../swarm/blackboard/prompts/jsonSchemas.js");
    const p = new OpenAIProvider("sk-test-key");
    await p.chat({
      model: "gpt-5-mini",
      messages: [{ role: "user", content: "explore" }],
      signal: new AbortController().signal,
      format: CONTRACT_JSON_SCHEMA,
      tools: ["read"],
      dispatcher: { dispatch: async () => ({ ok: true, output: "" }) } as never,
    });
    assert.equal("response_format" in observedBody!, false);
    assert.ok(Array.isArray(observedBody!.tools));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("AnthropicProvider — forwards output_format + beta header on tool-free emit", async () => {
  const realFetch = globalThis.fetch;
  let observedBody: Record<string, unknown> | null = null;
  let observedHeaders: Record<string, string> | null = null;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    observedBody = init?.body ? JSON.parse(init.body as string) : null;
    observedHeaders = init?.headers as Record<string, string>;
    const events =
      `event: message_start\ndata: {"type":"message_start","message":{"id":"m1","usage":{"input_tokens":1}}}\n\n` +
      `event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"{}"}}\n\n` +
      `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n` +
      `event: message_stop\ndata: {"type":"message_stop"}\n\n`;
    return new Response(events, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }) as unknown as typeof fetch;
  try {
    const { CONTRACT_JSON_SCHEMA } = await import("../swarm/blackboard/prompts/jsonSchemas.js");
    const p = new AnthropicProvider("sk-ant-test-key");
    await p.chat({
      model: "claude-opus-4-7",
      messages: [{ role: "user", content: "emit" }],
      signal: new AbortController().signal,
      format: CONTRACT_JSON_SCHEMA,
    });
    const of = observedBody!.output_format as { type: string; schema: unknown };
    assert.equal(of.type, "json_schema");
    assert.deepEqual(of.schema, CONTRACT_JSON_SCHEMA);
    assert.match(observedHeaders!["anthropic-beta"] ?? "", /structured-outputs/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("AnthropicProvider — omits output_format when tools are active", async () => {
  const realFetch = globalThis.fetch;
  let observedBody: Record<string, unknown> | null = null;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    observedBody = init?.body ? JSON.parse(init.body as string) : null;
    const events =
      `event: message_start\ndata: {"type":"message_start","message":{"id":"m1","usage":{"input_tokens":1}}}\n\n` +
      `event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\n` +
      `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n` +
      `event: message_stop\ndata: {"type":"message_stop"}\n\n`;
    return new Response(events, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }) as unknown as typeof fetch;
  try {
    const { CONTRACT_JSON_SCHEMA } = await import("../swarm/blackboard/prompts/jsonSchemas.js");
    const p = new AnthropicProvider("sk-ant-test-key");
    await p.chat({
      model: "claude-opus-4-7",
      messages: [{ role: "user", content: "explore" }],
      signal: new AbortController().signal,
      format: CONTRACT_JSON_SCHEMA,
      tools: ["read"],
      dispatcher: { dispatch: async () => ({ ok: true, output: "" }) } as never,
    });
    assert.equal("output_format" in observedBody!, false);
    assert.ok(Array.isArray(observedBody!.tools));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("OpenAIProvider — forwards response_format across model budget tiers", async () => {
  const realFetch = globalThis.fetch;
  const models = ["gpt-5-mini", "gpt-4o", "o3-mini"];
  for (const model of models) {
    let observedBody: Record<string, unknown> | null = null;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      observedBody = init?.body ? JSON.parse(init.body as string) : null;
      const events =
        `data: {"choices":[{"delta":{"content":"{}"}}]}\n\n` +
        `data: [DONE]\n\n`;
      return new Response(events, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    try {
      const { CONTRACT_JSON_SCHEMA } = await import("../swarm/blackboard/prompts/jsonSchemas.js");
      const p = new OpenAIProvider("sk-test-key");
      await p.chat({
        model,
        messages: [{ role: "user", content: "emit" }],
        signal: new AbortController().signal,
        format: CONTRACT_JSON_SCHEMA,
      });
      const rf = observedBody!.response_format as { type: string };
      assert.equal(rf.type, "json_schema", `model ${model}`);
    } finally {
      globalThis.fetch = realFetch;
    }
  }
});

test("OllamaProvider — omits format when caller doesn't pass it", async () => {
  const realFetch = globalThis.fetch;
  let observedBody: any = null;
  globalThis.fetch = (async (_url: string, init: any) => {
    observedBody = init?.body ? JSON.parse(init.body) : null;
    const lines = [
      JSON.stringify({ message: { role: "assistant", content: "ok" } }),
      JSON.stringify({ done: true }),
    ].join("\n") + "\n";
    return new Response(lines, { status: 200 });
  }) as unknown as typeof fetch;
  try {
    const provider = new (await import("./OllamaProvider.js")).OllamaProvider("http://localhost:11434");
    await provider.chat({
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
      signal: new AbortController().signal,
    });
    assert.equal("format" in observedBody, false, "format must be absent when caller omits it");
  } finally {
    globalThis.fetch = realFetch;
  }
});
