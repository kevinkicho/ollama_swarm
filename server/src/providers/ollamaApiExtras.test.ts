import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isOllamaFamilyModel,
  lookupCloudRetirement,
  ollamaOptionsForRole,
  ollamaThinkForCall,
  ollamaShow,
  ollamaUnloadModel,
  OLLAMA_RUN_KEEP_ALIVE,
} from "./ollamaApiExtras.js";

describe("isOllamaFamilyModel — OpenCode safety", () => {
  it("true for local and cloud ollama tags", () => {
    assert.equal(isOllamaFamilyModel("llama3:8b"), true);
    assert.equal(isOllamaFamilyModel("glm-5.2:cloud"), true);
    assert.equal(isOllamaFamilyModel("gpt-oss:120b-cloud"), true);
  });

  it("false for OpenCode / Anthropic / OpenAI — never use Ollama extras", () => {
    assert.equal(isOllamaFamilyModel("opencode-go/glm-5.2"), false);
    assert.equal(isOllamaFamilyModel("opencode-go/deepseek-v4-flash"), false);
    assert.equal(isOllamaFamilyModel("opencode/foo"), false);
    assert.equal(isOllamaFamilyModel("anthropic/claude-opus-4-7"), false);
    assert.equal(isOllamaFamilyModel("openai/gpt-5"), false);
  });
});

describe("lookupCloudRetirement", () => {
  it("flags retired models and suggests alternatives", () => {
    const r = lookupCloudRetirement("glm-5:cloud");
    assert.equal(r.retired, true);
    assert.equal(r.alternative, "glm-5.2");
  });

  it("current models are not retired", () => {
    const r = lookupCloudRetirement("deepseek-v4-flash:cloud");
    assert.equal(r.retired, false);
  });
});

describe("ollamaOptionsForRole", () => {
  it("gives planners more context; workers a predict cap", () => {
    const p = ollamaOptionsForRole("planner");
    assert.ok((p.num_ctx ?? 0) >= 16_000);
    const w = ollamaOptionsForRole("worker");
    assert.ok((w.num_predict ?? 0) > 0);
  });
});

describe("ollamaThinkForCall", () => {
  it("disables think for JSON emit-only", () => {
    assert.equal(ollamaThinkForCall({ hasJsonFormat: true, tools: false }), false);
  });
  it("leaves default when tools are on", () => {
    assert.equal(ollamaThinkForCall({ hasJsonFormat: true, tools: true }), undefined);
  });
  it("respects explicit override", () => {
    assert.equal(ollamaThinkForCall({ explicit: "low" }), "low");
  });
});

describe("OLLAMA_RUN_KEEP_ALIVE", () => {
  it("is a non-empty keep_alive string", () => {
    assert.match(OLLAMA_RUN_KEEP_ALIVE, /^\d+[smh]$/);
  });
});

describe("ollamaUnloadModel — OpenCode guard", () => {
  it("returns false without calling fetch for OpenCode models", async () => {
    let called = false;
    const ok = await ollamaUnloadModel({
      baseUrl: "http://127.0.0.1:11434",
      model: "opencode-go/glm-5.2",
      fetchImpl: async () => {
        called = true;
        return new Response("{}", { status: 200 });
      },
    });
    assert.equal(ok, false);
    assert.equal(called, false);
  });
});

describe("ollamaShow", () => {
  it("POSTs /api/show with cloud-stripped model on ollama.com", async () => {
    let body = "";
    const result = await ollamaShow({
      baseUrl: "https://ollama.com",
      model: "glm-5.2:cloud",
      fetchImpl: async (url, init) => {
        assert.match(String(url), /\/api\/show$/);
        body = String(init?.body ?? "");
        return new Response(
          JSON.stringify({
            capabilities: ["completion", "tools"],
            details: { parameter_size: "1B" },
            model_info: { "llama.context_length": 8192 },
          }),
          { status: 200 },
        );
      },
    });
    assert.ok(result);
    assert.equal(JSON.parse(body).model, "glm-5.2");
    assert.deepEqual(result!.capabilities, ["completion", "tools"]);
    assert.equal(result!.contextLength, 8192);
  });
});
