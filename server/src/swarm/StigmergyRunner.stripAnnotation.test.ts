// #303: tests for the stripAnnotationEnvelope helper. Pure-string
// transform, no I/O — exercise every shape the model emits.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stripAnnotationEnvelope } from "./StigmergyRunner.js";

describe("stripAnnotationEnvelope", () => {
  it("returns text unchanged when there's no JSON envelope", () => {
    const t = "Just some prose without an envelope.";
    assert.equal(stripAnnotationEnvelope(t), t);
  });

  it("strips a fenced ```json {...} ``` block at the end", () => {
    const t = `The supervisor is the system's operational backbone.

\`\`\`json
{"file": "src/supervisor.ts", "interest": 10, "confidence": 6, "note": "core loop"}
\`\`\``;
    const out = stripAnnotationEnvelope(t);
    assert.equal(out, "The supervisor is the system's operational backbone.");
  });

  it("strips a fenced ``` {...} ``` block (no language tag)", () => {
    const t = `Read the brain module.

\`\`\`
{"file": "src/brain.ts", "interest": 9, "confidence": 8, "note": "decision loop"}
\`\`\``;
    const out = stripAnnotationEnvelope(t);
    assert.equal(out, "Read the brain module.");
  });

  it("strips a bare trailing {...} block (no fences)", () => {
    const t = `I inspected agent.ts. It's the SDK adapter layer.

{"file": "src/agent.ts", "interest": 4, "confidence": 10, "note": "thin wrapper"}`;
    const out = stripAnnotationEnvelope(t);
    assert.equal(out, "I inspected agent.ts. It's the SDK adapter layer.");
  });

  it("preserves prose when JSON appears MID-text (not trailing)", () => {
    // We only strip TRAILING JSON. Mid-prose JSON (rare) is left alone
    // because it might be a legitimate code example.
    const t = `Found an example: {"foo": "bar"}. The actual annotation follows.`;
    const out = stripAnnotationEnvelope(t);
    assert.match(out, /The actual annotation follows/);
  });

  it("collapses trailing whitespace", () => {
    const t = "Prose.\n\n```json\n{\"file\":\"x\",\"interest\":5,\"confidence\":5,\"note\":\"\"}\n```\n\n\n";
    const out = stripAnnotationEnvelope(t);
    assert.equal(out, "Prose.");
  });

  it("handles multi-line JSON envelope", () => {
    const t = `My findings:

{
  "file": "src/team-manager.ts",
  "interest": 8,
  "confidence": 8,
  "note": "TeamManager: LLM-driven coordination layer"
}`;
    const out = stripAnnotationEnvelope(t);
    assert.equal(out, "My findings:");
  });

  it("returns empty string when input is JSON-only (no prose)", () => {
    const t = `{"file": "src/x.ts", "interest": 5, "confidence": 5, "note": "x"}`;
    const out = stripAnnotationEnvelope(t);
    assert.equal(out, "");
  });
});
