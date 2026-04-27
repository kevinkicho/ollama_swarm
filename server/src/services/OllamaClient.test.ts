import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chat } from "./OllamaClient.js";

// Mock-fetch helpers — install + uninstall a global fetch that returns
// a controlled streaming body. Each test installs its own fetch so they
// don't pollute each other.

interface MockResponseOpts {
  status?: number;
  /** JSONL frames the body should emit, one per call to reader.read(). */
  frames: string[];
  /** Optional ms delay between frames — useful for idle-timeout tests. */
  delayMs?: number;
}

function installMockFetch(opts: MockResponseOpts): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = async (_url: unknown, init?: RequestInit): Promise<Response> => {
    const status = opts.status ?? 200;
    const signal = init?.signal;
    let i = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (signal?.aborted) {
          controller.error(new Error("aborted"));
          return;
        }
        if (i >= opts.frames.length) {
          controller.close();
          return;
        }
        if (opts.delayMs) {
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(resolve, opts.delayMs);
            signal?.addEventListener("abort", () => {
              clearTimeout(t);
              reject(new Error("aborted"));
            }, { once: true });
          });
        }
        const frame = opts.frames[i++];
        controller.enqueue(new TextEncoder().encode(frame));
      },
    });
    return new Response(stream, { status });
  };
  return () => {
    globalThis.fetch = original;
  };
}

describe("OllamaClient.chat", () => {
  it("accumulates message.content across JSONL frames + returns final text", async () => {
    const restore = installMockFetch({
      frames: [
        '{"message":{"role":"assistant","content":"Hello"},"done":false}\n',
        '{"message":{"role":"assistant","content":" world"},"done":false}\n',
        '{"message":{"role":"assistant","content":"!"},"done":true,"prompt_eval_count":42,"eval_count":3}\n',
      ],
    });
    try {
      const ctrl = new AbortController();
      const chunks: string[] = [];
      let tokens: { promptTokens: number; responseTokens: number } | null = null;
      const result = await chat({ baseUrl: "http://test", 
        model: "test-model",
        messages: [{ role: "user", content: "hi" }],
        signal: ctrl.signal,
        onChunk: (t) => chunks.push(t),
        onTokens: (t) => { tokens = t; },
      });
      assert.equal(result.text, "Hello world!");
      assert.equal(result.finishReason, "done");
      assert.deepEqual(chunks, ["Hello", "Hello world", "Hello world!"]);
      assert.deepEqual(tokens, { promptTokens: 42, responseTokens: 3 });
    } finally {
      restore();
    }
  });

  it("handles multiple JSONL lines packed in one frame", async () => {
    const restore = installMockFetch({
      frames: [
        '{"message":{"content":"a"},"done":false}\n{"message":{"content":"b"},"done":false}\n{"message":{"content":"c"},"done":true}\n',
      ],
    });
    try {
      const result = await chat({ baseUrl: "http://test", 
        model: "test",
        messages: [{ role: "user", content: "hi" }],
        signal: new AbortController().signal,
      });
      assert.equal(result.text, "abc");
    } finally {
      restore();
    }
  });

  it("ignores malformed lines mid-stream", async () => {
    const restore = installMockFetch({
      frames: [
        '{"message":{"content":"good"},"done":false}\n',
        'GARBAGE NOT JSON\n',
        '{"message":{"content":" tail"},"done":true}\n',
      ],
    });
    try {
      const result = await chat({ baseUrl: "http://test", 
        model: "test",
        messages: [{ role: "user", content: "hi" }],
        signal: new AbortController().signal,
      });
      assert.equal(result.text, "good tail");
    } finally {
      restore();
    }
  });

  it("rejects on non-2xx HTTP status with body excerpt", async () => {
    const restore = installMockFetch({
      status: 500,
      frames: ['{"error":"model not loaded"}'],
    });
    try {
      await assert.rejects(
        () => chat({
          baseUrl: "http://test",
          model: "test",
          messages: [{ role: "user", content: "hi" }],
          signal: new AbortController().signal,
        }),
        /Ollama HTTP 500/,
      );
    } finally {
      restore();
    }
  });

  it("aborts cleanly when the caller's signal fires mid-stream", async () => {
    const restore = installMockFetch({
      frames: [
        '{"message":{"content":"start"},"done":false}\n',
        '{"message":{"content":"never-arrives"},"done":true}\n',
      ],
      delayMs: 100, // give us time to abort between frames
    });
    try {
      const ctrl = new AbortController();
      const promise = chat({
        baseUrl: "http://test",
        model: "test",
        messages: [{ role: "user", content: "hi" }],
        signal: ctrl.signal,
      });
      // Give the first frame a moment to arrive, then abort.
      setTimeout(() => ctrl.abort(), 50);
      await assert.rejects(promise, /abort/i);
    } finally {
      restore();
    }
  });

  it("aborts on idle timeout when body goes silent", async () => {
    const restore = installMockFetch({
      frames: [
        '{"message":{"content":"start"},"done":false}\n',
        '{"message":{"content":"never-arrives"},"done":true}\n',
      ],
      delayMs: 5_000, // way longer than our idle timeout
    });
    try {
      const ctrl = new AbortController();
      await assert.rejects(
        chat({
          baseUrl: "http://test",
          model: "test",
          messages: [{ role: "user", content: "hi" }],
          signal: ctrl.signal,
          idleTimeoutMs: 200,
        }),
        /timeout|abort/i,
      );
    } finally {
      restore();
    }
  });
});
