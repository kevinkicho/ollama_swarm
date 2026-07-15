import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildCouncilTodoExtractPrompt,
  buildAuditorUnmetTodoFallbackPrompt,
  buildAuditFollowUpTodoPrompt,
} from "./councilDecisions.js";
import { JSON_ARRAY_ONLY_LINE } from "./blackboard/prompts/sharedSnippets.js";

describe("buildCouncilTodoExtractPrompt", () => {
  it("includes JSON-array-only contract and partitioning rule", () => {
    const p = buildCouncilTodoExtractPrompt({
      progressBlock: "",
      synthesisText: "Add bcrypt hashing.",
      recentDrafts: "[Agent 2] agree",
      treeSection: "dirs",
      componentStructure: "",
      serviceStructure: "",
      projectFiles: "src/auth.ts",
      committedFilesSection: "(none)",
    });
    assert.ok(p.includes(JSON_ARRAY_ONLY_LINE));
    assert.match(p, /PARTITIONING/i);
    assert.match(p, /ACTIONABLE/i);
    assert.match(p, /bcrypt/);
  });
});

describe("buildAuditorUnmetTodoFallbackPrompt", () => {
  it("lists each unmet criterion and requires JSON array", () => {
    const p = buildAuditorUnmetTodoFallbackPrompt([
      { description: "Wire auth", expectedFiles: ["src/auth.ts"] },
      { description: "Add tests", expectedFiles: [] },
    ]);
    assert.ok(p.includes(JSON_ARRAY_ONLY_LINE));
    assert.match(p, /Wire auth/);
    assert.match(p, /Add tests/);
    assert.match(p, /Max 8 todos/);
  });
});

describe("buildAuditFollowUpTodoPrompt", () => {
  it("uses shared JSON-array contract", () => {
    const p = buildAuditFollowUpTodoPrompt({
      missingWork: "Auth panel still uses mock data",
      treeSection: "\nProject top-level files: src, package.json",
    });
    assert.ok(p.includes(JSON_ARRAY_ONLY_LINE));
    assert.match(p, /mock data/);
    assert.match(p, /Max 4 items/);
  });
});
