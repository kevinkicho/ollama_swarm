import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { subtaskPart, extractSubtaskResults } from "./subtaskPart.js";

describe("subtaskPart — builder", () => {
  it("produces minimal SubtaskPart with required fields", () => {
    const p = subtaskPart({
      description: "investigate auth.ts",
      prompt: "Read src/auth.ts and report any TODO comments.",
      agent: "swarm-read",
    });
    assert.equal(p.type, "subtask");
    assert.equal(p.description, "investigate auth.ts");
    assert.equal(p.agent, "swarm-read");
    assert.match(p.prompt, /TODO comments/);
    assert.equal(p.model, undefined);
  });

  it("caps description at 80 chars (opencode's display limit)", () => {
    const long = "a".repeat(150);
    const p = subtaskPart({ description: long, prompt: "x", agent: "swarm" });
    assert.equal(p.description.length, 80);
  });

  it("threads optional model override", () => {
    const p = subtaskPart({
      description: "x",
      prompt: "y",
      agent: "swarm-read",
      model: { providerID: "ollama", modelID: "qwen2.5:14b" },
    });
    assert.deepEqual(p.model, { providerID: "ollama", modelID: "qwen2.5:14b" });
  });
});

describe("extractSubtaskResults — parser", () => {
  it("returns [] when no <task_result> blocks present", () => {
    const r = extractSubtaskResults("just plain text");
    assert.deepEqual(r, []);
  });

  it("returns [] for empty input", () => {
    assert.deepEqual(extractSubtaskResults(""), []);
  });

  it("extracts a single task result", () => {
    const text = "task_id: abc\n\n<task_result>\nfound 3 TODOs in auth.ts\n</task_result>\n\nNow synthesizing...";
    const r = extractSubtaskResults(text);
    assert.deepEqual(r, ["found 3 TODOs in auth.ts"]);
  });

  it("extracts multiple task results in order", () => {
    const text = `
task_id: a\n\n<task_result>\nresult A\n</task_result>

task_id: b\n\n<task_result>\nresult B\n</task_result>

task_id: c\n\n<task_result>\nresult C\n</task_result>

Synthesis: A, B, C combined...
`;
    const r = extractSubtaskResults(text);
    assert.deepEqual(r, ["result A", "result B", "result C"]);
  });

  it("handles multiline subtask output", () => {
    const text = "<task_result>\nline 1\nline 2\nline 3\n</task_result>";
    const r = extractSubtaskResults(text);
    assert.deepEqual(r, ["line 1\nline 2\nline 3"]);
  });

  it("trims surrounding whitespace inside the wrapper", () => {
    const text = "<task_result>\n\n  spaced  \n\n</task_result>";
    const r = extractSubtaskResults(text);
    // Outer trim only — inner content preserved verbatim except surround
    assert.equal(r[0]?.trim(), "spaced");
  });
});
