import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseCouncilIssues, parseExecutionLine } from "./councilDraftParse.js";

describe("parseCouncilIssues", () => {
  it("parses issue array from council draft text", () => {
    const text = `[{"issue": "stub script", "file": "scripts/predict_tc.py", "severity": "high", "suggestion": "Implement model"}]`;
    const issues = parseCouncilIssues(text);
    assert.ok(issues);
    assert.equal(issues!.length, 1);
    assert.equal(issues![0].file, "scripts/predict_tc.py");
    assert.equal(issues![0].severity, "high");
  });

  it("returns null for prose-only draft", () => {
    assert.equal(parseCouncilIssues("Just some analysis prose."), null);
  });
});

describe("parseExecutionLine", () => {
  it("parses completion summary", () => {
    const ev = parseExecutionLine("[execution] Complete: 2 done, 1 failed, 3 skipped.");
    assert.equal(ev.status, "summary");
    assert.match(ev.detail, /2 done/);
  });

  it("parses skipped worker line", () => {
    const ev = parseExecutionLine("[execution] agent-2 skipped: Already satisfied.");
    assert.equal(ev.status, "skipped");
    assert.equal(ev.agentId, "agent-2");
    assert.equal(ev.detail, "Already satisfied.");
  });
});