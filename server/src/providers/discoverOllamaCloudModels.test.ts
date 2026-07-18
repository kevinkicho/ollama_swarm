import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  discoverOllamaCloudModels,
  toLocalCloudModelTag,
  toOllamaCloudApiModelName,
  OLLAMA_CLOUD_TAGS_URL,
} from "./discoverOllamaCloudModels.js";

describe("toLocalCloudModelTag / toOllamaCloudApiModelName", () => {
  it("maps bare API names to :cloud tags", () => {
    assert.equal(toLocalCloudModelTag("glm-5.2"), "glm-5.2:cloud");
    assert.equal(toLocalCloudModelTag("deepseek-v4-flash"), "deepseek-v4-flash:cloud");
  });

  it("maps size-tagged API names to -cloud suffix", () => {
    assert.equal(toLocalCloudModelTag("gemma4:31b"), "gemma4:31b-cloud");
    assert.equal(toLocalCloudModelTag("gpt-oss:120b"), "gpt-oss:120b-cloud");
    assert.equal(toLocalCloudModelTag("qwen3.5:397b"), "qwen3.5:397b-cloud");
    assert.equal(toLocalCloudModelTag("mistral-large-3:675b"), "mistral-large-3:675b-cloud");
  });

  it("is idempotent for already-local tags", () => {
    assert.equal(toLocalCloudModelTag("glm-5.2:cloud"), "glm-5.2:cloud");
    assert.equal(toLocalCloudModelTag("gemma4:31b-cloud"), "gemma4:31b-cloud");
  });

  it("strips cloud suffix for API chat", () => {
    assert.equal(toOllamaCloudApiModelName("glm-5.2:cloud"), "glm-5.2");
    assert.equal(toOllamaCloudApiModelName("gpt-oss:120b-cloud"), "gpt-oss:120b");
    assert.equal(toOllamaCloudApiModelName("deepseek-v4-flash"), "deepseek-v4-flash");
  });
});

describe("discoverOllamaCloudModels", () => {
  it("hits ollama.com/api/tags and maps names to local cloud tags", async () => {
    const names = await discoverOllamaCloudModels({
      fetchImpl: async (url) => {
        assert.equal(String(url), OLLAMA_CLOUD_TAGS_URL);
        return new Response(
          JSON.stringify({
            models: [
              { name: "glm-5.2" },
              { name: "gpt-oss:120b" },
              { model: "gemma4:31b" },
            ],
          }),
          { status: 200 },
        );
      },
    });
    assert.deepEqual(names, [
      "glm-5.2:cloud",
      "gpt-oss:120b-cloud",
      "gemma4:31b-cloud",
    ]);
  });

  it("returns null on HTTP error", async () => {
    const names = await discoverOllamaCloudModels({
      fetchImpl: async () => new Response("nope", { status: 503 }),
    });
    assert.equal(names, null);
  });

  it("returns null on empty models", async () => {
    const names = await discoverOllamaCloudModels({
      fetchImpl: async () =>
        new Response(JSON.stringify({ models: [] }), { status: 200 }),
    });
    assert.equal(names, null);
  });
});
