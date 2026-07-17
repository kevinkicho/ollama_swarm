import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { finalizeAgentOutput } from "@ollama-swarm/shared/finalizeAgentOutput";

const SRC = readFileSync(
  fileURLToPath(new URL("./councilSynthesis.ts", import.meta.url)),
  "utf8",
);

describe("councilSynthesis transcript hygiene", () => {
  it("uses finalizeAgentOutput before transcript_append (RR-E stream integrity)", () => {
    assert.match(SRC, /finalizeAgentOutput\(text/);
    assert.doesNotMatch(SRC, /finalText:\s*text,\s*thoughts:\s*\[\]/);
  });

  it("strips think tags from synthesis-shaped responses", () => {
    const raw =
      '<think>We need to produce a JSON array of concrete todos.</think>[\n  {"description": "fix tests", "expectedFiles": ["tests/a.py"]}\n]';
    const stripped = finalizeAgentOutput(raw, { role: "general" });
    assert.match(stripped.thoughts, /JSON array of concrete todos/);
    assert.doesNotMatch(stripped.finalText, /<think>/);
    assert.match(stripped.finalText, /"description": "fix tests"/);
  });
});
