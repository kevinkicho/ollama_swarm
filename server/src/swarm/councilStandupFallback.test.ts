import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseStandupIssues,
  standupFallbackTodosFromEntries,
  standupIssuesToTodoDrafts,
} from "./councilStandupFallback.js";

describe("councilStandupFallback", () => {
  it("parses standup issue JSON", () => {
    const issues = parseStandupIssues(
      '[{"issue":"empty db","file":"data/x.json","suggestion":"populate"}]',
    );
    assert.ok(issues);
    assert.equal(issues![0].file, "data/x.json");
  });

  it("converts issues to todo drafts without hard-coded paths", () => {
    const drafts = standupIssuesToTodoDrafts([
      { issue: "stub", file: "scripts/p.py", suggestion: "implement model" },
    ]);
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].expectedFiles[0], "scripts/p.py");
    assert.match(drafts[0].description, /implement model/);
  });

  it("extracts from transcript entries", () => {
    const drafts = standupFallbackTodosFromEntries([
      {
        id: "a1",
        role: "agent",
        agentIndex: 2,
        text: '[{"issue":"dup test","file":"tests/a.py","suggestion":"consolidate"}]',
        ts: 1,
        summary: { kind: "council_draft", round: 1, phase: "standup" },
      },
    ]);
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].createdBy, "standup-fallback");
  });
});