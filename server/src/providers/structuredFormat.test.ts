import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  anthropicStructuredBody,
  openAiResponseFormatBody,
  structuredFormatForChat,
} from "./structuredFormat.js";
import { CONTRACT_JSON_SCHEMA } from "../swarm/blackboard/prompts/jsonSchemas.js";

describe("structuredFormat", () => {
  it("wraps raw JSON Schema for OpenAI strict mode", () => {
    const body = openAiResponseFormatBody(CONTRACT_JSON_SCHEMA, "contract");
    assert.equal((body!.response_format as { type: string }).type, "json_schema");
    const js = (body!.response_format as { json_schema: { name: string; strict: boolean } }).json_schema;
    assert.equal(js.name, "contract");
    assert.equal(js.strict, true);
  });

  it("maps json string to json_object for OpenAI", () => {
    const body = openAiResponseFormatBody("json");
    assert.deepEqual(body, { response_format: { type: "json_object" } });
  });

  it("maps raw schema to Anthropic output_format", () => {
    const body = anthropicStructuredBody(CONTRACT_JSON_SCHEMA);
    assert.equal(body!.output_format.type, "json_schema");
    assert.ok(body!.beta.includes("structured-outputs"));
  });

  it("skips structured format when tools are active", () => {
    const out = structuredFormatForChat({
      model: "gpt-4",
      messages: [],
      signal: new AbortController().signal,
      format: CONTRACT_JSON_SCHEMA,
      tools: ["read"],
      dispatcher: {} as never,
    });
    assert.deepEqual(out, {});
  });

  it("applies structured format on tool-free emit calls", () => {
    const out = structuredFormatForChat({
      model: "gpt-4",
      messages: [],
      signal: new AbortController().signal,
      format: CONTRACT_JSON_SCHEMA,
    });
    assert.ok(out.openAi);
    assert.ok(out.anthropic);
  });

  it("applies structured format across provider × model budget tiers", () => {
    const models = [
      "gpt-5-mini",
      "openai/gpt-4o",
      "claude-opus-4-7",
      "anthropic/claude-haiku-4-5-20251001",
      "deepseek-v4-flash:cloud",
      "glm-5.1:cloud",
      "unknown-local-model",
    ];
    for (const model of models) {
      const out = structuredFormatForChat({
        model,
        messages: [],
        signal: new AbortController().signal,
        format: CONTRACT_JSON_SCHEMA,
      });
      assert.equal((out.openAi!.response_format as { type: string }).type, "json_schema", model);
      assert.equal(out.anthropic!.output_format.type, "json_schema", model);
    }
  });
});