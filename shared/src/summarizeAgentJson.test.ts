import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { summarizeAgentJson } from "./summarizeAgentJson.js";

describe("summarizeAgentJson", () => {
  describe("worker hunks (v2)", () => {
    it("summarizes a single replace hunk", () => {
      const r = summarizeAgentJson(
        JSON.stringify({ hunks: [{ op: "replace", file: "src/foo.ts", search: "old", replace: "new" }] }),
      );
      assert.ok(r);
      assert.match(r!.summary, /replace src\/foo\.ts/);
      assert.equal(r!.parsed.kind, "unknown");
    });

    it("summarizes a create hunk with char count", () => {
      const r = summarizeAgentJson(
        JSON.stringify({ hunks: [{ op: "create", file: "src/bar.ts", content: "hello world" }] }),
      );
      assert.ok(r);
      assert.match(r!.summary, /create src\/bar\.ts \(11 chars\)/);
    });

    it("summarizes an append hunk", () => {
      const r = summarizeAgentJson(
        JSON.stringify({ hunks: [{ op: "append", file: "src/log.ts", content: "appended content" }] }),
      );
      assert.ok(r);
      assert.match(r!.summary, /append src\/log\.ts/);
    });

    it("returns 'Declined' for worker skip with reason", () => {
      const r = summarizeAgentJson(
        JSON.stringify({ hunks: [], skip: "File already has this logic" }),
      );
      assert.ok(r);
      assert.match(r!.summary, /Declined: File already has this logic/);
    });

    it("returns 'Returned no changes' for empty hunks without skip reason", () => {
      const r = summarizeAgentJson(JSON.stringify({ hunks: [] }));
      assert.ok(r);
      assert.equal(r!.summary, "Returned no changes");
    });

    it("handles multiple hunks", () => {
      const r = summarizeAgentJson(JSON.stringify({
        hunks: [
          { op: "replace", file: "a.ts", search: "x", replace: "y" },
          { op: "create", file: "b.ts", content: "new" },
        ],
      }));
      assert.ok(r);
      assert.match(r!.summary, /^Wrote/);
      assert.match(r!.summary, /a\.ts/);
      assert.match(r!.summary, /b\.ts/);
    });

    it("handles hunk without valid file field", () => {
      const r = summarizeAgentJson(
        JSON.stringify({ hunks: [{ op: "replace", file: 123 }] }),
      );
      assert.ok(r);
      assert.match(r!.summary, /malformed hunk/);
    });
  });

  describe("worker diffs (v1 legacy)", () => {
    it("summarizes legacy diffs", () => {
      const r = summarizeAgentJson(
        JSON.stringify({ diffs: [{ file: "src/old.ts", newText: "some content" }] }),
      );
      assert.ok(r);
      assert.match(r!.summary, /src\/old\.ts \(12 chars\)/);
    });

    it("returns 'Declined' for legacy diffs with skip reason", () => {
      const r = summarizeAgentJson(
        JSON.stringify({ diffs: [], skip: "No changes needed" }),
      );
      assert.ok(r);
      assert.match(r!.summary, /Declined: No changes needed/);
    });
  });

  describe("replanner", () => {
    it("summarizes revised todo", () => {
      const r = summarizeAgentJson(
        JSON.stringify({ revised: { description: "Add null check to parseInput", expectedFiles: ["src/parse.ts"] } }),
      );
      assert.ok(r);
      assert.match(r!.summary, /Revised: Add null check to parseInput/);
      assert.match(r!.summary, /src\/parse\.ts/);
    });

    it("summarizes revised without expectedFiles", () => {
      const r = summarizeAgentJson(
        JSON.stringify({ revised: { description: "Fix bug in utils" } }),
      );
      assert.ok(r);
      assert.match(r!.summary, /^Revised: Fix bug in utils$/);
    });

    it("handles replanner skip", () => {
      const r = summarizeAgentJson(
        JSON.stringify({ skip: true, reason: "Already implemented" }),
      );
      assert.ok(r);
      assert.equal(r!.summary, "Skipped: Already implemented");
    });

    it("handles replanner skip with missing reason", () => {
      const r = summarizeAgentJson(JSON.stringify({ skip: true }));
      assert.ok(r);
      assert.equal(r!.summary, "Skipped: (no reason)");
    });
  });

  describe("contract", () => {
    it("summarizes a contract with multiple criteria", () => {
      const r = summarizeAgentJson(JSON.stringify({
        missionStatement: "Improve test coverage across the project",
        criteria: [
          { description: "Add tests for src/auth.ts", expectedFiles: ["src/auth.ts", "src/auth.test.ts"] },
          { description: "Add tests for src/db.ts", expectedFiles: ["src/db.ts"] },
        ],
      }));
      assert.ok(r);
      assert.match(r!.summary, /Contract: Improve test coverage/);
      assert.match(r!.summary, /2 criteria/);
      assert.equal(r!.parsed.kind, "contract");
    });

    it("handles a contract with empty criteria", () => {
      const r = summarizeAgentJson(JSON.stringify({
        missionStatement: "No real contract",
        criteria: [],
      }));
      assert.ok(r);
      assert.match(r!.summary, /0 criteria/);
    });

    it("shows first 3 criteria preview and +N more for >3", () => {
      const r = summarizeAgentJson(JSON.stringify({
        missionStatement: "Test",
        criteria: [
          { description: "c1" }, { description: "c2" }, { description: "c3" }, { description: "c4" },
        ],
      }));
      assert.ok(r);
      assert.match(r!.summary, /…\+1 more/);
    });
  });

  describe("hunk review", () => {
    it("summarizes approve + reason gate response", () => {
      const r = summarizeAgentJson(
        JSON.stringify({
          approve: true,
          reason: "Changes follow existing panel patterns and use a valid BBA series ID.",
        }),
      );
      assert.ok(r);
      assert.match(r!.summary, /Approved:/);
      assert.equal(r!.parsed.kind, "hunk_review");
      if (r!.parsed.kind === "hunk_review") {
        assert.equal(r!.parsed.approve, true);
      }
    });

    it("summarizes rejection", () => {
      const r = summarizeAgentJson(
        JSON.stringify({ approve: false, reason: "Anchor text not found in target file." }),
      );
      assert.ok(r);
      assert.match(r!.summary, /Rejected:/);
      assert.equal(r!.parsed.kind, "hunk_review");
    });
  });

  describe("auditor", () => {
    it("summarizes mixed verdicts with new criteria", () => {
      const r = summarizeAgentJson(JSON.stringify({
        verdicts: [
          { id: "c1", status: "met", rationale: "done" },
          { id: "c2", status: "unmet", rationale: "not started" },
          { id: "c3", status: "wont-do", rationale: "out of scope" },
        ],
        newCriteria: [{ description: "Extra work", expectedFiles: [] }],
      }));
      assert.ok(r);
      assert.match(r!.summary, /Audit:/);
      assert.match(r!.summary, /1 met/);
      assert.match(r!.summary, /1 unmet/);
      assert.match(r!.summary, /1 wont-do/);
      assert.match(r!.summary, /1 new criteri/);
      assert.equal(r!.parsed.kind, "auditor");
      assert.equal(r!.parsed.verdicts.length, 3);
    });
  });

  describe("planner todos", () => {
    it("summarizes an array of todos", () => {
      const r = summarizeAgentJson(JSON.stringify([
        { description: "extract helper from main.ts", expectedFiles: ["src/main.ts"] },
        { description: "add types for API response", expectedFiles: ["src/types.ts"] },
      ]));
      assert.ok(r);
      assert.match(r!.summary, /Posted 2 todos/);
      assert.match(r!.summary, /extract helper from main\.ts/);
      assert.match(r!.summary, /\+1 more/);
      assert.equal(r!.parsed.kind, "todos");
    });

    it("summarizes a single bare todo object (not array)", () => {
      const r = summarizeAgentJson(JSON.stringify({
        description: "remove deprecated function from utils.ts",
        expectedFiles: ["src/utils.ts"],
      }));
      assert.ok(r);
      assert.match(r!.summary, /Posted 1 todo/);
      assert.match(r!.summary, /remove deprecated function/);
      assert.equal(r!.parsed.kind, "todos");
    });
  });

  describe("non-JSON and edge cases", () => {
    it("returns null for plain prose", () => {
      assert.equal(summarizeAgentJson("Hello, this is just a chat message"), null);
    });

    it("returns null for empty string", () => {
      assert.equal(summarizeAgentJson(""), null);
    });

    it("returns null for invalid JSON", () => {
      assert.equal(summarizeAgentJson("{ invalid json }"), null);
    });

    it("handles JSON inside markdown fence", () => {
      const r = summarizeAgentJson("```json\n" + JSON.stringify({
        hunks: [{ op: "create", file: "f.md", content: "hello" }],
      }) + "\n```");
      assert.ok(r);
      assert.match(r!.summary, /create f\.md/);
    });

    it("truncates very long skip reasons", () => {
      const longReason = "a".repeat(200);
      const r = summarizeAgentJson(JSON.stringify({ hunks: [], skip: longReason }));
      assert.ok(r);
      assert.ok(r!.summary.length < 200);
    });
  });
});
