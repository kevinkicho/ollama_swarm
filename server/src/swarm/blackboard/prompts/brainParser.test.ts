import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  buildBrainPrompt,
  parseBrainOutput,
  brainFallbackParse,
  DEFAULT_BRAIN_CONFIG,
  SCHEMA_DESCRIPTIONS,
  type BrainFallbackEvent,
  type BrainConfig,
  type BrainPromptFn,
} from "./brainParser.js";

const PlannerTodoSchema = z.object({
  description: z.string().min(1).max(500),
  expectedFiles: z.array(z.string()).min(1).max(2),
});

const PlannerArraySchema = z.array(PlannerTodoSchema).max(5);

describe("brainParser — buildBrainPrompt", () => {
  it("includes schema description and raw output", () => {
    const prompt = buildBrainPrompt("hello world", SCHEMA_DESCRIPTIONS.planner, "planner");
    assert.ok(prompt.includes("planner"));
    assert.ok(prompt.includes(SCHEMA_DESCRIPTIONS.planner));
    assert.ok(prompt.includes("hello world"));
  });

  it("truncates long raw output", () => {
    const long = "x".repeat(20000);
    const prompt = buildBrainPrompt(long, SCHEMA_DESCRIPTIONS.planner, "planner");
    assert.ok(prompt.includes("truncated"));
    assert.ok(prompt.length < long.length);
  });
});

describe("brainParser — parseBrainOutput", () => {
  it("parses valid JSON matching the schema", () => {
    const json = JSON.stringify([
      { description: "fix bug", expectedFiles: ["src/foo.ts"] },
    ]);
    const result = parseBrainOutput(json, PlannerArraySchema);
    assert.ok(result !== null);
    assert.equal(result.data.length, 1);
    assert.equal(result.data[0].description, "fix bug");
  });

  it("returns null for unparseable sentinel", () => {
    const result = parseBrainOutput('{"_brain_unparseable": true}', PlannerArraySchema);
    assert.equal(result, null);
  });

  it("returns null for non-matching JSON", () => {
    const json = JSON.stringify({ wrong: "shape" });
    const result = parseBrainOutput(json, PlannerArraySchema);
    assert.equal(result, null);
  });

  it("extracts JSON from markdown fences", () => {
    const fenced = "```json\n" + JSON.stringify([
      { description: "test", expectedFiles: ["a.ts"] },
    ]) + "\n```";
    const result = parseBrainOutput(fenced, PlannerArraySchema);
    assert.ok(result !== null);
    assert.equal(result.data[0].description, "test");
  });
});

describe("brainParser — brainFallbackParse", () => {
  it("succeeds when brain returns valid JSON", async () => {
    const events: BrainFallbackEvent[] = [];
    const mockPromptFn: BrainPromptFn = async () => {
      return JSON.stringify([
        { description: "brain-fixed todo", expectedFiles: ["brain.ts"] },
      ]);
    };

    const result = await brainFallbackParse(
      "some raw model output",
      PlannerArraySchema,
      "planner",
      DEFAULT_BRAIN_CONFIG,
      mockPromptFn,
      (e) => events.push(e),
    );

    assert.ok(result !== null);
    assert.equal(result[0].description, "brain-fixed todo");
    assert.equal(events.length, 1);
    assert.equal(events[0].brainSuccess, true);
    assert.equal(events[0].parser, "planner");
  });

  it("returns null when brain returns unparseable sentinel", async () => {
    const events: BrainFallbackEvent[] = [];
    const mockPromptFn: BrainPromptFn = async () => '{"_brain_unparseable": true}';

    const result = await brainFallbackParse(
      "gibberish output",
      PlannerArraySchema,
      "planner",
      DEFAULT_BRAIN_CONFIG,
      mockPromptFn,
      (e) => events.push(e),
    );

    assert.equal(result, null);
    assert.equal(events.length, 1);
    assert.equal(events[0].brainSuccess, false);
  });

  it("returns null when brain output doesn't match schema", async () => {
    const events: BrainFallbackEvent[] = [];
    const mockPromptFn: BrainPromptFn = async () => '{"wrong": "shape"}';

    const result = await brainFallbackParse(
      "some raw output",
      PlannerArraySchema,
      "planner",
      DEFAULT_BRAIN_CONFIG,
      mockPromptFn,
      (e) => events.push(e),
    );

    assert.equal(result, null);
    assert.equal(events.length, 1);
    assert.equal(events[0].brainSuccess, false);
  });

  it("returns null and logs when brain prompt throws", async () => {
    const events: BrainFallbackEvent[] = [];
    const mockPromptFn: BrainPromptFn = async () => { throw new Error("timeout"); };

    const result = await brainFallbackParse(
      "raw output",
      PlannerArraySchema,
      "planner",
      DEFAULT_BRAIN_CONFIG,
      mockPromptFn,
      (e) => events.push(e),
    );

    assert.equal(result, null);
    assert.equal(events.length, 1);
    assert.equal(events[0].brainSuccess, false);
  });

  it("respects custom brainConfig", async () => {
    const events: BrainFallbackEvent[] = [];
    let capturedModel = "";
    let capturedMaxTokens = 0;
    let capturedTimeout = 0;

    const mockPromptFn: BrainPromptFn = async (_prompt, model, maxTokens, timeoutMs) => {
      capturedModel = model;
      capturedMaxTokens = maxTokens;
      capturedTimeout = timeoutMs;
      return JSON.stringify([
        { description: "test", expectedFiles: ["a.ts"] },
      ]);
    };

    const customCfg: BrainConfig = {
      brainModel: "custom-model:test",
      timeoutMs: 5000,
      maxTokens: 2048,
    };

    await brainFallbackParse(
      "raw output",
      PlannerArraySchema,
      "planner",
      customCfg,
      mockPromptFn,
      (e) => events.push(e),
    );

    assert.equal(capturedModel, "custom-model:test");
    assert.equal(capturedMaxTokens, 2048);
    assert.equal(capturedTimeout, 5000);
    assert.equal(events[0].brainModel, "custom-model:test");
  });
});