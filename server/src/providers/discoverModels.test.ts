// 2026-05-03: tests for the per-provider model discovery helpers.
// Pure parsers tested directly + the fetch-wrappers tested with a
// mock fetchImpl so no real network call is made.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseAnthropicModels,
  discoverAnthropicModels,
  type AnthropicModelsResponse,
} from "./discoverAnthropicModels.js";
import {
  parseOpenAIModels,
  discoverOpenAIModels,
  type OpenAIModelsResponse,
} from "./discoverOpenAIModels.js";

// ---------- parseAnthropicModels ----------

describe("parseAnthropicModels", () => {
  it("returns [] on empty body", () => {
    assert.deepEqual(parseAnthropicModels({}), []);
    assert.deepEqual(parseAnthropicModels({ data: [] }), []);
  });

  it("prefixes every id with anthropic/ and sorts by created_at desc", () => {
    const body: AnthropicModelsResponse = {
      data: [
        { id: "claude-haiku-4-5-20251001", created_at: "2025-10-01T00:00:00Z" },
        { id: "claude-opus-4-7", created_at: "2026-04-15T00:00:00Z" },
        { id: "claude-sonnet-4-6", created_at: "2026-02-01T00:00:00Z" },
      ],
    };
    assert.deepEqual(parseAnthropicModels(body), [
      "anthropic/claude-opus-4-7",
      "anthropic/claude-sonnet-4-6",
      "anthropic/claude-haiku-4-5-20251001",
    ]);
  });

  it("drops empty / non-string ids defensively", () => {
    const body = {
      data: [
        { id: "claude-opus-4-7", created_at: "2026-04-15T00:00:00Z" },
        { id: "" },
        { id: 42 as unknown as string },
        { id: "claude-sonnet-4-6", created_at: "2026-02-01T00:00:00Z" },
      ],
    };
    assert.deepEqual(parseAnthropicModels(body), [
      "anthropic/claude-opus-4-7",
      "anthropic/claude-sonnet-4-6",
    ]);
  });

  it("missing created_at sorts alphabetically (last in tie)", () => {
    const body: AnthropicModelsResponse = {
      data: [
        { id: "a-no-date" },
        { id: "b-with-date", created_at: "2026-01-01T00:00:00Z" },
        { id: "c-no-date" },
      ],
    };
    const out = parseAnthropicModels(body);
    // b sorts first (has date); a/c order is by lexicographic (no-date == "")
    assert.equal(out[0], "anthropic/b-with-date");
  });
});

// ---------- discoverAnthropicModels ----------

describe("discoverAnthropicModels", () => {
  it("returns null when no API key provided", async () => {
    const result = await discoverAnthropicModels({
      apiKey: "",
      fetchImpl: (() => { throw new Error("should not be called"); }) as unknown as typeof fetch,
    });
    assert.equal(result, null);
  });

  it("returns null on non-OK HTTP response", async () => {
    const fakeFetch = (async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    const result = await discoverAnthropicModels({ apiKey: "test-key", fetchImpl: fakeFetch });
    assert.equal(result, null);
  });

  it("returns null on network error", async () => {
    const fakeFetch = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const result = await discoverAnthropicModels({ apiKey: "test-key", fetchImpl: fakeFetch });
    assert.equal(result, null);
  });

  it("returns parsed list on success", async () => {
    const fakeFetch = (async (_url: string, opts?: RequestInit) => {
      // Verify the request shape: x-api-key header + anthropic-version header
      const headers = (opts?.headers ?? {}) as Record<string, string>;
      assert.equal(headers["x-api-key"], "test-key-abc");
      assert.equal(headers["anthropic-version"], "2023-06-01");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            { id: "claude-opus-4-7", created_at: "2026-04-15T00:00:00Z" },
          ],
        }),
      };
    }) as unknown as typeof fetch;
    const result = await discoverAnthropicModels({
      apiKey: "test-key-abc",
      fetchImpl: fakeFetch,
    });
    assert.deepEqual(result, ["anthropic/claude-opus-4-7"]);
  });
});

// ---------- parseOpenAIModels ----------

describe("parseOpenAIModels", () => {
  it("returns [] on empty body", () => {
    assert.deepEqual(parseOpenAIModels({}), []);
  });

  it("filters to chat-grade prefixes (drops embeddings / audio / image)", () => {
    const body: OpenAIModelsResponse = {
      data: [
        { id: "gpt-5", created: 1700000000 },
        { id: "text-embedding-3-large", created: 1690000000 },
        { id: "whisper-1", created: 1670000000 },
        { id: "dall-e-3", created: 1680000000 },
        { id: "gpt-5-mini", created: 1700000001 },
        { id: "tts-1", created: 1660000000 },
        { id: "o1-preview", created: 1695000000 },
      ],
    };
    const out = parseOpenAIModels(body);
    assert.deepEqual(out, [
      "openai/gpt-5-mini",  // newest created
      "openai/gpt-5",
      "openai/o1-preview",
    ]);
  });

  it("drops dated YYYY-MM-DD snapshot ids", () => {
    const body: OpenAIModelsResponse = {
      data: [
        { id: "gpt-5", created: 1700000000 },
        { id: "gpt-5-2026-01-15", created: 1701000000 },  // dated snapshot — drop
        { id: "gpt-5-mini", created: 1700000001 },
      ],
    };
    const out = parseOpenAIModels(body);
    assert.deepEqual(out, ["openai/gpt-5-mini", "openai/gpt-5"]);
  });

  it("drops *-NNNN snapshot ids (e.g. gpt-4-0613)", () => {
    const body: OpenAIModelsResponse = {
      data: [
        { id: "gpt-4", created: 1700000000 },
        { id: "gpt-4-0613", created: 1701000000 }, // dated snapshot — drop
      ],
    };
    const out = parseOpenAIModels(body);
    assert.deepEqual(out, ["openai/gpt-4"]);
  });

  it("sorts by created desc (newest first)", () => {
    const body: OpenAIModelsResponse = {
      data: [
        { id: "gpt-4", created: 1690000000 },
        { id: "gpt-5", created: 1700000000 },
        { id: "o3", created: 1710000000 },
      ],
    };
    assert.deepEqual(parseOpenAIModels(body), [
      "openai/o3",
      "openai/gpt-5",
      "openai/gpt-4",
    ]);
  });
});

// ---------- discoverOpenAIModels ----------

describe("discoverOpenAIModels", () => {
  it("returns null when no API key", async () => {
    const result = await discoverOpenAIModels({ apiKey: "" });
    assert.equal(result, null);
  });

  it("returns null on non-OK HTTP", async () => {
    const fakeFetch = (async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    const result = await discoverOpenAIModels({ apiKey: "test-key", fetchImpl: fakeFetch });
    assert.equal(result, null);
  });

  it("returns null on network error", async () => {
    const fakeFetch = (async () => { throw new Error("ETIMEDOUT"); }) as unknown as typeof fetch;
    const result = await discoverOpenAIModels({ apiKey: "test-key", fetchImpl: fakeFetch });
    assert.equal(result, null);
  });

  it("uses Bearer auth header on success", async () => {
    const fakeFetch = (async (_url: string, opts?: RequestInit) => {
      const headers = (opts?.headers ?? {}) as Record<string, string>;
      assert.equal(headers.Authorization, "Bearer test-key-xyz");
      return {
        ok: true,
        json: async () => ({ data: [{ id: "gpt-5", created: 1700000000 }] }),
      };
    }) as unknown as typeof fetch;
    const result = await discoverOpenAIModels({
      apiKey: "test-key-xyz",
      fetchImpl: fakeFetch,
    });
    assert.deepEqual(result, ["openai/gpt-5"]);
  });
});
