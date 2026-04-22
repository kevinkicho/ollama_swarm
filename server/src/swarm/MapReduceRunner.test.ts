import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  sliceRoundRobin,
  buildMapperPrompt,
  buildReducerPrompt,
} from "./MapReduceRunner.js";
import type { TranscriptEntry } from "../types.js";

const system = (text: string): TranscriptEntry => ({
  id: crypto.randomUUID(),
  role: "system",
  text,
  ts: 0,
});

const agent = (index: number, text: string): TranscriptEntry => ({
  id: crypto.randomUUID(),
  role: "agent",
  agentIndex: index,
  agentId: `agent-${index}`,
  text,
  ts: 0,
});

describe("sliceRoundRobin", () => {
  it("distributes entries evenly when count is a multiple of k", () => {
    const result = sliceRoundRobin(["a", "b", "c", "d"], 2);
    assert.deepEqual(result, [["a", "c"], ["b", "d"]]);
  });

  it("handles uneven distribution (slices differ in length by at most 1)", () => {
    const result = sliceRoundRobin(["a", "b", "c", "d", "e"], 3);
    assert.deepEqual(result, [["a", "d"], ["b", "e"], ["c"]]);
    const lengths = result.map((s) => s.length);
    assert.ok(Math.max(...lengths) - Math.min(...lengths) <= 1);
  });

  it("every entry appears in exactly one slice (partition invariant)", () => {
    const entries = ["src/", "tests/", "docs/", "package.json", "README.md", "LICENSE"];
    const slices = sliceRoundRobin(entries, 3);
    const flat = slices.flat();
    assert.equal(flat.length, entries.length);
    for (const e of entries) assert.ok(flat.includes(e));
  });

  it("handles more slices than entries — extra slices are empty", () => {
    const result = sliceRoundRobin(["a", "b"], 5);
    assert.deepEqual(result, [["a"], ["b"], [], [], []]);
  });

  it("returns empty array when k <= 0", () => {
    assert.deepEqual(sliceRoundRobin(["a", "b"], 0), []);
  });

  it("handles an empty input", () => {
    const result = sliceRoundRobin<string>([], 3);
    assert.deepEqual(result, [[], [], []]);
  });
});

describe("buildMapperPrompt — isolation", () => {
  it("names only the assigned slice in the prompt (no peer slice leakage)", () => {
    const prompt = buildMapperPrompt(2, 1, 1, ["src/", "package.json"], [system("seed")]);
    assert.ok(prompt.includes("src/"));
    assert.ok(prompt.includes("package.json"));
    // Other repo areas that a peer mapper would cover must not appear.
    assert.ok(!prompt.includes("tests/"));
    assert.ok(!prompt.includes("docs/"));
  });

  it("warns the mapper not to speculate about entries outside its slice", () => {
    const prompt = buildMapperPrompt(2, 1, 1, ["src/"], [system("seed")]);
    assert.match(prompt, /Do NOT speculate about entries outside your slice/i);
  });

  it("identifies the mapper by index in header + closing", () => {
    const prompt = buildMapperPrompt(4, 1, 1, ["x"], []);
    assert.ok(prompt.includes("Mapper Agent 4"));
    assert.ok(prompt.includes("Now respond as Mapper Agent 4."));
  });

  it("tells mapper it cannot see peers — by design", () => {
    const prompt = buildMapperPrompt(2, 1, 2, ["x"], []);
    assert.match(prompt, /cannot see.*deliberate/i);
  });

  it("handles an empty slice gracefully", () => {
    const prompt = buildMapperPrompt(5, 1, 1, [], [system("seed")]);
    assert.ok(prompt.includes("(empty slice)"));
  });
});

describe("buildReducerPrompt", () => {
  it("includes mapper reports in the transcript body labeled [Mapper N]", () => {
    const t: TranscriptEntry[] = [
      system("seed"),
      agent(2, "UNIQUE_MAPPER_2_CONTENT"),
      agent(3, "UNIQUE_MAPPER_3_CONTENT"),
    ];
    const prompt = buildReducerPrompt(1, 1, t);
    assert.ok(prompt.includes("UNIQUE_MAPPER_2_CONTENT"));
    assert.ok(prompt.includes("UNIQUE_MAPPER_3_CONTENT"));
    assert.ok(prompt.includes("[Mapper 2]"));
    assert.ok(prompt.includes("[Mapper 3]"));
  });

  it("mid-run cycle asks for a coverage gap to investigate", () => {
    const prompt = buildReducerPrompt(1, 3, []);
    assert.match(prompt, /GAP in coverage/i);
  });

  it("last cycle asks for the final unified picture", () => {
    const prompt = buildReducerPrompt(3, 3, []);
    assert.match(prompt, /final unified picture/i);
  });

  it("forbids inventing evidence beyond mapper reports", () => {
    const prompt = buildReducerPrompt(1, 1, []);
    assert.match(prompt, /Do NOT invent evidence beyond what mappers reported/i);
  });
});
