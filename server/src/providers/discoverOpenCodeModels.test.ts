import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  OPENCODE_GO_MODELS_URL,
  OPENCODE_ZEN_MODELS_URL,
  discoverOpenCodeGoModels,
  discoverOpenCodeModels,
  discoverOpenCodeZenModels,
} from "./discoverOpenCodeModels.js";

const sampleBody = {
  object: "list",
  data: [
    { id: "glm-5.1", object: "model" },
    { id: "qwen3.6-plus", object: "model" },
  ],
};

describe("discoverOpenCodeModels", () => {
  it("fetches Go models from /zen/go/v1/models with opencode-go/ prefix", async () => {
    const fetchImpl = (async (url: string) => {
      assert.equal(url, OPENCODE_GO_MODELS_URL);
      return new Response(JSON.stringify(sampleBody), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const models = await discoverOpenCodeGoModels({ apiKey: "test-key", fetchImpl });
    assert.deepEqual(models, ["opencode-go/glm-5.1", "opencode-go/qwen3.6-plus"]);
  });

  it("fetches Zen models from /zen/v1/models with opencode/ prefix", async () => {
    const fetchImpl = (async (url: string) => {
      assert.equal(url, OPENCODE_ZEN_MODELS_URL);
      return new Response(JSON.stringify({ data: [{ id: "deepseek-v4-flash" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const models = await discoverOpenCodeZenModels({ apiKey: "zen-key", fetchImpl });
    assert.deepEqual(models, ["opencode/deepseek-v4-flash"]);
  });

  it("merges Go and Zen lists with Go models first", async () => {
    const fetchImpl = (async (url: string) => {
      if (url === OPENCODE_GO_MODELS_URL) {
        return new Response(JSON.stringify({ data: [{ id: "glm-5.1" }] }), { status: 200 });
      }
      if (url === OPENCODE_ZEN_MODELS_URL) {
        return new Response(
          JSON.stringify({ data: [{ id: "glm-5.1" }, { id: "claude-fable-5" }] }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const models = await discoverOpenCodeModels({
      goApiKey: "go-key",
      zenApiKey: "zen-key",
      fetchImpl,
    });
    assert.deepEqual(models, [
      "opencode-go/glm-5.1",
      "opencode/glm-5.1",
      "opencode/claude-fable-5",
    ]);
  });

  it("returns null when no API key is provided", async () => {
    assert.equal(await discoverOpenCodeGoModels({}), null);
    assert.equal(await discoverOpenCodeZenModels({}), null);
    assert.equal(await discoverOpenCodeModels({}), null);
  });

  it("returns null on non-OK HTTP response", async () => {
    const fetchImpl = (async () => new Response("unauthorized", { status: 401 })) as typeof fetch;
    assert.equal(await discoverOpenCodeGoModels({ apiKey: "bad", fetchImpl }), null);
  });
});