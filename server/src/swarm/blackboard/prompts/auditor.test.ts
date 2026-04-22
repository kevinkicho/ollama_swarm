import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AUDITOR_SYSTEM_PROMPT,
  buildAuditorRepairPrompt,
  buildAuditorUserPrompt,
  parseAuditorResponse,
  type AuditorSeed,
} from "./auditor.js";
import type { ExitCriterion } from "../types.js";

function criterion(
  id: string,
  description: string,
  status: ExitCriterion["status"] = "unmet",
  expectedFiles: string[] = [],
): ExitCriterion {
  return { id, description, expectedFiles, status, addedAt: 0 };
}

function seed(overrides: Partial<AuditorSeed> = {}): AuditorSeed {
  return {
    missionStatement: "Ship the thing.",
    unmetCriteria: [criterion("c1", "README has Quick Start", "unmet", ["README.md"])],
    resolvedCriteria: [],
    committed: [],
    skipped: [],
    findings: [],
    auditInvocation: 1,
    maxInvocations: 5,
    ...overrides,
  };
}

describe("parseAuditorResponse — happy path", () => {
  it("parses a bare object with mixed verdicts", () => {
    const res = parseAuditorResponse(
      JSON.stringify({
        verdicts: [
          { id: "c1", status: "met", rationale: "README now contains a Quick Start." },
          {
            id: "c2",
            status: "unmet",
            rationale: "Needs a license link.",
            todos: [{ description: "Add MIT license link", expectedFiles: ["README.md"] }],
          },
          { id: "c3", status: "wont-do", rationale: "Out of scope for this pass." },
        ],
      }),
    );
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.result.verdicts.length, 3);
      assert.equal(res.result.verdicts[0]?.status, "met");
      assert.equal(res.result.verdicts[1]?.todos.length, 1);
      assert.equal(res.result.verdicts[2]?.status, "wont-do");
      assert.equal(res.result.newCriteria.length, 0);
      assert.equal(res.dropped.length, 0);
    }
  });

  it("unwraps a fenced ```json block", () => {
    const raw = "```json\n" +
      JSON.stringify({
        verdicts: [{ id: "c1", status: "met", rationale: "done" }],
      }) + "\n```";
    const res = parseAuditorResponse(raw);
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.result.verdicts.length, 1);
  });

  it("unwraps prose-then-object", () => {
    const raw =
      "Here is my audit:\n" +
      JSON.stringify({
        verdicts: [{ id: "c1", status: "met", rationale: "done" }],
      }) +
      "\nEnd of audit.";
    const res = parseAuditorResponse(raw);
    assert.equal(res.ok, true);
  });

  it("accepts newCriteria alongside verdicts", () => {
    const res = parseAuditorResponse(
      JSON.stringify({
        verdicts: [{ id: "c1", status: "met", rationale: "ok" }],
        newCriteria: [
          { description: "Add CI badge", expectedFiles: ["README.md"] },
          { description: "Describe testing", expectedFiles: [] },
        ],
      }),
    );
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.result.newCriteria.length, 2);
      assert.deepEqual(res.result.newCriteria[1]?.expectedFiles, []);
    }
  });

  it("accepts empty verdicts array (nothing left unmet)", () => {
    const res = parseAuditorResponse(JSON.stringify({ verdicts: [] }));
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.result.verdicts.length, 0);
  });
});

describe("parseAuditorResponse — rejections and drops", () => {
  it("rejects a bare array (wrong shape)", () => {
    const res = parseAuditorResponse(JSON.stringify([{ id: "c1", status: "met", rationale: "x" }]));
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.reason, /expected top-level JSON object/);
  });

  it("rejects when verdicts is missing", () => {
    const res = parseAuditorResponse(JSON.stringify({ newCriteria: [] }));
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.reason, /verdicts must be an array/);
  });

  it("rejects when newCriteria is present but not an array", () => {
    const res = parseAuditorResponse(
      JSON.stringify({ verdicts: [], newCriteria: "oops" }),
    );
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.reason, /newCriteria must be an array/);
  });

  it("drops verdicts with invalid status but keeps the rest", () => {
    const res = parseAuditorResponse(
      JSON.stringify({
        verdicts: [
          { id: "c1", status: "met", rationale: "ok" },
          { id: "c2", status: "pending", rationale: "bogus status" },
          { id: "c3", status: "wont-do", rationale: "skip" },
        ],
      }),
    );
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.result.verdicts.length, 2);
      assert.equal(res.dropped.length, 1);
    }
  });

  it("drops unmet verdicts with empty rationale but keeps valid ones", () => {
    const res = parseAuditorResponse(
      JSON.stringify({
        verdicts: [
          { id: "c1", status: "met", rationale: "" },
          {
            id: "c2",
            status: "unmet",
            rationale: "needs more",
            todos: [{ description: "do x", expectedFiles: ["a.ts"] }],
          },
        ],
      }),
    );
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.result.verdicts.length, 1);
      assert.equal(res.result.verdicts[0]?.id, "c2");
      assert.equal(res.dropped.length, 1);
    }
  });

  it("drops newCriteria with invalid shape while preserving verdicts", () => {
    const res = parseAuditorResponse(
      JSON.stringify({
        verdicts: [{ id: "c1", status: "met", rationale: "ok" }],
        newCriteria: [
          { description: "good one", expectedFiles: ["a.ts"] },
          { description: "", expectedFiles: [] },
          { description: "too many files", expectedFiles: ["1", "2", "3", "4", "5"] },
        ],
      }),
    );
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.result.newCriteria.length, 1);
      assert.equal(res.dropped.length, 2);
    }
  });

  it("rejects unparseable JSON", () => {
    const res = parseAuditorResponse("absolutely not json");
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.reason, /JSON parse failed/);
  });

  it("drops unmet verdicts whose todo expectedFiles include a directory path", () => {
    const res = parseAuditorResponse(
      JSON.stringify({
        verdicts: [
          {
            id: "c1",
            status: "unmet",
            rationale: "needs more tests",
            todos: [{ description: "add tests", expectedFiles: ["__tests__/"] }],
          },
        ],
      }),
    );
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.result.verdicts.length, 0);
      assert.equal(res.dropped.length, 1);
      assert.match(res.dropped[0].reason, /file path, not a directory/);
    }
  });

  it("drops newCriteria whose expectedFiles include a directory path", () => {
    const res = parseAuditorResponse(
      JSON.stringify({
        verdicts: [{ id: "c1", status: "met", rationale: "ok" }],
        newCriteria: [
          { description: "good", expectedFiles: ["README.md"] },
          { description: "dir", expectedFiles: ["docs/"] },
        ],
      }),
    );
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.result.newCriteria.length, 1);
      assert.equal(res.dropped.length, 1);
      assert.match(res.dropped[0].reason, /file path, not a directory/);
    }
  });
});

describe("AUDITOR prompts", () => {
  it("system prompt enumerates the three verdict values", () => {
    assert.match(AUDITOR_SYSTEM_PROMPT, /"met"/);
    assert.match(AUDITOR_SYSTEM_PROMPT, /"wont-do"/);
    assert.match(AUDITOR_SYSTEM_PROMPT, /"unmet"/);
  });

  it("system prompt requires todos when unmet", () => {
    assert.match(AUDITOR_SYSTEM_PROMPT, /unmet.*todos.*REQUIRED/i);
  });

  it("system prompt steers shell-execution criteria to wont-do", () => {
    // Auditor must recognize that criteria requiring shell execution (tsc,
    // ESLint, tests) can't be satisfied via file diffs and should route to
    // wont-do rather than emitting unmet verdicts with no file anchor.
    assert.match(AUDITOR_SYSTEM_PROMPT, /CANNOT run shell commands/);
    assert.match(AUDITOR_SYSTEM_PROMPT, /issue `wont-do`/);
  });

  it("user prompt lists unmet criteria and resolved criteria separately", () => {
    const p = buildAuditorUserPrompt(
      seed({
        unmetCriteria: [criterion("c1", "open task")],
        resolvedCriteria: [criterion("c2", "done task", "met")],
      }),
    );
    assert.match(p, /open task/);
    assert.match(p, /done task/);
    assert.match(p, /UNMET/);
    assert.match(p, /already resolved/);
  });

  it("user prompt embeds mission + invocation count", () => {
    const p = buildAuditorUserPrompt(
      seed({ missionStatement: "Ship docs.", auditInvocation: 3, maxInvocations: 5 }),
    );
    assert.match(p, /Ship docs\./);
    assert.match(p, /3 of 5/);
  });

  it("user prompt truncates long context lists to 40 items", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      todoId: `t${i}`,
      description: `committed ${i}`,
      expectedFiles: [],
    }));
    const p = buildAuditorUserPrompt(seed({ committed: many }));
    assert.match(p, /committed 59/);
    assert.ok(!/committed 0\b/.test(p), "should have truncated oldest committed entries");
  });

  it("user prompt handles all-empty context lists gracefully", () => {
    const p = buildAuditorUserPrompt(seed());
    assert.match(p, /nothing committed yet/);
    assert.match(p, /no skips/);
    assert.match(p, /no findings/);
  });

  it("repair prompt echoes the parser error and prior response", () => {
    const p = buildAuditorRepairPrompt("broken output", "JSON parse failed: xyz");
    assert.match(p, /broken output/);
    assert.match(p, /JSON parse failed: xyz/);
    assert.match(p, /verdicts/);
  });
});
