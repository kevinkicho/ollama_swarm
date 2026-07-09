import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseCouncilSynthesisText } from "./councilSynthesisParse.js";

describe("parseCouncilSynthesisText", () => {
  it("parses a bare todos array", () => {
    const text = JSON.stringify([
      { description: "Fix predict_tc.py ML pipeline", expectedFiles: ["scripts/predict_tc.py"] },
      { description: "Expand superconductor database", expectedFiles: ["data/superconductor_database.json"] },
    ]);
    const parsed = parseCouncilSynthesisText(text);
    assert.ok(parsed);
    assert.equal(parsed!.todos.length, 2);
    assert.equal(parsed!.prose, "");
    assert.match(parsed!.prettyJson, /predict_tc/);
  });

  it("isolates prose before JSON array", () => {
    const text =
      "Merged findings from 4 auditors.\n\n" +
      '[{"description": "Wire real API in DashboardPanel", "expectedFiles": ["src/DashboardPanel.tsx"]}]';
    const parsed = parseCouncilSynthesisText(text);
    assert.ok(parsed);
    assert.equal(parsed!.todos.length, 1);
    assert.match(parsed!.prose, /Merged findings/);
    assert.doesNotMatch(parsed!.prose, /\[/);
  });

  it("parses fenced JSON after preamble", () => {
    const text = `Consensus plan:\n\`\`\`json\n[{"description": "Add tests", "expectedFiles": ["tests/a.test.ts"]}]\n\`\`\``;
    const parsed = parseCouncilSynthesisText(text);
    assert.ok(parsed);
    assert.equal(parsed!.todos[0]?.description, "Add tests");
    assert.match(parsed!.prose, /Consensus plan/);
  });

  it("returns null for prose-only legacy synthesis", () => {
    const parsed = parseCouncilSynthesisText(
      "Consensus across 4 drafters: split by domain over feature-folders.",
    );
    assert.equal(parsed, null);
  });

  it("returns null for empty todo descriptions", () => {
    const parsed = parseCouncilSynthesisText('[{"description": "", "expectedFiles": []}]');
    assert.equal(parsed, null);
  });
});