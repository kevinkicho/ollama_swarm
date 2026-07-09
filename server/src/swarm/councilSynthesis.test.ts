import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stripAgentText } from "@ollama-swarm/shared/stripAgentText";

const SRC = readFileSync(
  fileURLToPath(new URL("./councilSynthesis.ts", import.meta.url)),
  "utf8",
);

describe("councilSynthesis transcript hygiene", () => {
  it("uses stripAgentText before transcript_append (not a no-op stub)", () => {
    assert.match(SRC, /stripAgentText\(text\)/);
    assert.doesNotMatch(SRC, /finalText:\s*text,\s*thoughts:\s*\[\]/);
  });

  it("strips think tags from synthesis-shaped responses", () => {
    const raw =
      '<think>We need to produce a JSON array of concrete todos.</think>[\n  {"description": "fix tests", "expectedFiles": ["tests/a.py"]}\n]';
    const stripped = stripAgentText(raw);
    assert.match(stripped.thoughts, /JSON array of concrete todos/);
    assert.doesNotMatch(stripped.finalText, /<think>/);
    assert.match(stripped.finalText, /"description": "fix tests"/);
  });
});