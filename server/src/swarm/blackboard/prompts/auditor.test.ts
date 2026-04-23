import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AUDITOR_FALLBACK_FILE_MAX,
  AUDITOR_FALLBACK_RECENT_COMMITS,
  AUDITOR_SYSTEM_PROMPT,
  buildAuditorFileStates,
  buildAuditorRepairPrompt,
  buildAuditorSeedCore,
  buildAuditorUserPrompt,
  parseAuditorResponse,
  resolveCriterionFiles,
  type AuditorSeed,
  type CommittedTodoSummary,
} from "./auditor.js";
import {
  WORKER_FILE_HEAD_BYTES,
  WORKER_FILE_TAIL_BYTES,
  WORKER_FILE_WINDOW_THRESHOLD,
} from "../windowFile.js";
import type { ExitContract, ExitCriterion, Finding, Todo } from "../types.js";

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
    currentFileState: {},
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

  it("system prompt forbids wont-do on first-attempt (Unit 11)", () => {
    // The MatSci Explorer run (2026-04-22) exposed a short-circuit: the
    // auditor verdicted 4 of 6 criteria as `wont-do` on invocation 1 with
    // rationale "No test files exist" — even though workers can create new
    // files. The tightened prompt requires ZERO-attempted criteria to go
    // unmet (not wont-do), forcing the planner to try rather than surrender.
    assert.match(
      AUDITOR_SYSTEM_PROMPT,
      /zero attempted todos[\s\S]*never.*wont-do/i,
    );
    assert.match(AUDITOR_SYSTEM_PROMPT, /Workers CAN create new files/i);
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

  // Unit 46b: prompt-budget caps on rationales + file-state.
  it("user prompt truncates a long rationale on a resolved criterion", () => {
    const longRationale = "x".repeat(2_000);
    const c = criterion("c1", "done thing", "met");
    c.rationale = longRationale;
    const p = buildAuditorUserPrompt(seed({ resolvedCriteria: [c] }));
    // The truncated rationale appears with a trailing ellipsis;
    // the full 2000-char string does NOT.
    assert.ok(!p.includes(longRationale), "raw 2000-char rationale should not appear in prompt");
    assert.ok(p.includes("..."), "truncation marker present");
  });

  it("user prompt also truncates a long rationale on an unmet criterion's prior verdict", () => {
    const longRationale = "y".repeat(2_000);
    const c = criterion("c1", "still open", "unmet", ["README.md"]);
    c.rationale = longRationale;
    const p = buildAuditorUserPrompt(seed({ unmetCriteria: [c] }));
    assert.ok(!p.includes(longRationale));
    assert.match(p, /prior:/);
  });

  it("user prompt drops file-state entries past the byte budget with an explicit marker", () => {
    // Build 10 files at ~12 KB each. Total 120 KB > 60 KB cap → some get dropped.
    const fileState: Record<string, import("./auditor.js").AuditorFileStateEntry> = {};
    for (let i = 0; i < 10; i++) {
      const name = `file_${i.toString().padStart(2, "0")}.md`;
      const content = "x".repeat(12_000);
      fileState[name] = { exists: true, content, full: false, originalLength: 50_000 };
    }
    const p = buildAuditorUserPrompt(seed({ currentFileState: fileState }));
    // Earlier files are kept; later files (alphabetically) get dropped.
    assert.match(p, /file_00\.md/);
    assert.ok(!p.includes("file_09.md"), "last alphabetical file should be omitted");
    assert.match(p, /additional file\(s\) omitted/);
    assert.match(p, /60000-char budget/);
  });

  it("user prompt keeps all files when total fits inside the budget", () => {
    // 3 small files, well under 60 KB → no truncation marker.
    const fileState: Record<string, import("./auditor.js").AuditorFileStateEntry> = {
      "a.md": { exists: true, content: "a", full: true, originalLength: 1 },
      "b.md": { exists: true, content: "b", full: true, originalLength: 1 },
      "c.md": { exists: true, content: "c", full: true, originalLength: 1 },
    };
    const p = buildAuditorUserPrompt(seed({ currentFileState: fileState }));
    assert.match(p, /a\.md/);
    assert.match(p, /b\.md/);
    assert.match(p, /c\.md/);
    assert.ok(!/additional file\(s\) omitted/.test(p));
  });

  it("repair prompt echoes the parser error and prior response", () => {
    const p = buildAuditorRepairPrompt("broken output", "JSON parse failed: xyz");
    assert.match(p, /broken output/);
    assert.match(p, /JSON parse failed: xyz/);
    assert.match(p, /verdicts/);
  });

  // ---- Unit 5b: system prompt now teaches "read the file first" ----

  it("system prompt describes current file state as primary evidence", () => {
    // Auditor must understand that the user prompt contains file contents,
    // and that those contents drive the decision (not commit history alone).
    assert.match(AUDITOR_SYSTEM_PROMPT, /CURRENT CONTENTS/);
    assert.match(AUDITOR_SYSTEM_PROMPT, /primary evidence/i);
  });

  it("system prompt warns about duplicate/stacked prior attempts", () => {
    // The v6 failure mode: auditor couldn't see that four env-var tables had
    // stacked under the same heading. System prompt must train the auditor
    // to recognize that signature and route to CONSOLIDATE/REPAIR todos
    // rather than another re-add.
    assert.match(AUDITOR_SYSTEM_PROMPT, /DUPLICATE|duplicate/);
    assert.match(AUDITOR_SYSTEM_PROMPT, /CONSOLIDATE|consolidate/i);
    assert.match(AUDITOR_SYSTEM_PROMPT, /re-add/i);
  });

  it("system prompt explains windowed large-file views", () => {
    // If the middle of a file is omitted, the auditor should weight visible
    // head/tail and prefer a verification todo over a confident "met" call.
    assert.match(AUDITOR_SYSTEM_PROMPT, /WINDOWED|window|head.*marker.*tail/i);
  });

  // ---- Unit 5b: user prompt now renders the file-state block ----

  it("user prompt includes a Current file state section", () => {
    const p = buildAuditorUserPrompt(
      seed({
        currentFileState: {
          "README.md": {
            exists: true,
            content: "# Hello\n",
            full: true,
            originalLength: 8,
          },
        },
      }),
    );
    assert.match(p, /Current file state/i);
    assert.match(p, /README\.md/);
    assert.match(p, /# Hello/);
    assert.match(p, /full/);
  });

  it("user prompt marks a missing file as (does not exist on disk)", () => {
    const p = buildAuditorUserPrompt(
      seed({
        currentFileState: {
          "src/new.ts": {
            exists: false,
            content: "",
            full: true,
            originalLength: 0,
          },
        },
      }),
    );
    assert.match(p, /src\/new\.ts \(does not exist on disk\)/);
  });

  it("user prompt marks a windowed file with the WINDOWED label and original size", () => {
    const p = buildAuditorUserPrompt(
      seed({
        currentFileState: {
          "CHANGELOG.md": {
            exists: true,
            content: "HEAD\n\n... [40000 chars omitted ...] ...\n\nTAIL",
            full: false,
            originalLength: 50_000,
          },
        },
      }),
    );
    assert.match(p, /CHANGELOG\.md/);
    assert.match(p, /50000 chars/);
    assert.match(p, /WINDOWED/);
    // The body (head and tail) reaches the prompt — the auditor is meant to
    // reason about it, not just see the header.
    assert.match(p, /HEAD/);
    assert.match(p, /TAIL/);
  });

  it("user prompt file-state entries are deterministic (sorted by path)", () => {
    // Same seed → same prompt, so a test harness reading the user prompt
    // transcript can diff cleanly when only the content of a known file
    // changes. We sort by path to eliminate iteration-order wobble across
    // Node versions / V8 builds.
    const p = buildAuditorUserPrompt(
      seed({
        currentFileState: {
          "b.md": { exists: true, content: "B", full: true, originalLength: 1 },
          "a.md": { exists: true, content: "A", full: true, originalLength: 1 },
        },
      }),
    );
    const aIdx = p.indexOf("a.md");
    const bIdx = p.indexOf("b.md");
    assert.ok(aIdx !== -1 && bIdx !== -1);
    assert.ok(aIdx < bIdx, `expected a.md to appear before b.md, got aIdx=${aIdx} bIdx=${bIdx}`);
  });

  it("user prompt handles an empty currentFileState gracefully", () => {
    // e.g. unmet criteria have no expectedFiles, or there are no unmet
    // criteria at all. Prompt should note the absence rather than render
    // a silent empty block that looks like a truncated template.
    const p = buildAuditorUserPrompt(seed({ currentFileState: {} }));
    assert.match(p, /Current file state/i);
    assert.match(p, /no files/i);
  });
});

describe("buildAuditorFileStates — pure file-state wrapper", () => {
  it("returns an empty record for an empty input", () => {
    const out = buildAuditorFileStates({});
    assert.deepEqual(out, {});
  });

  it("marks a null content as non-existent with empty view", () => {
    const out = buildAuditorFileStates({ "src/new.ts": null });
    assert.deepEqual(out["src/new.ts"], {
      exists: false,
      content: "",
      full: true,
      originalLength: 0,
    });
  });

  it("passes a small file through in full", () => {
    const body = "# Tiny\n\nhello\n";
    const out = buildAuditorFileStates({ "README.md": body });
    assert.equal(out["README.md"].exists, true);
    assert.equal(out["README.md"].full, true);
    assert.equal(out["README.md"].content, body);
    assert.equal(out["README.md"].originalLength, body.length);
  });

  it("windows a large file via windowFileForWorker (same view as worker sees)", () => {
    // Past-threshold content triggers the window. Distinctive head/tail so we
    // can verify the auditor gets the SAME head+marker+tail the worker gets —
    // that's the whole point of reusing windowFileForWorker.
    const head = "HEAD-UNIQUE-" + "a".repeat(WORKER_FILE_HEAD_BYTES);
    const tail = "b".repeat(WORKER_FILE_TAIL_BYTES) + "-TAIL-UNIQUE";
    const filler = "x".repeat(WORKER_FILE_WINDOW_THRESHOLD);
    const big = head + filler + tail;

    const out = buildAuditorFileStates({ "README.md": big });
    assert.equal(out["README.md"].exists, true);
    assert.equal(out["README.md"].full, false);
    assert.equal(out["README.md"].originalLength, big.length);
    assert.ok(out["README.md"].content.includes("HEAD-UNIQUE-"));
    assert.ok(out["README.md"].content.includes("-TAIL-UNIQUE"));
    // Windowed view is dramatically smaller than the source.
    assert.ok(out["README.md"].content.length < big.length / 2);
  });

  it("handles a mix of present, missing, small, and large files in one call", () => {
    const big = "z".repeat(WORKER_FILE_WINDOW_THRESHOLD + 1_000);
    const out = buildAuditorFileStates({
      "README.md": "# small\n",
      "src/new.ts": null,
      "CHANGELOG.md": big,
    });
    assert.equal(out["README.md"].exists, true);
    assert.equal(out["README.md"].full, true);
    assert.equal(out["src/new.ts"].exists, false);
    assert.equal(out["src/new.ts"].content, "");
    assert.equal(out["CHANGELOG.md"].exists, true);
    assert.equal(out["CHANGELOG.md"].full, false);
    assert.equal(out["CHANGELOG.md"].originalLength, big.length);
  });

  it("is deterministic — same input produces identical output", () => {
    const src = { "a.ts": "const x = 1;\n", "b.ts": null };
    const a = buildAuditorFileStates(src);
    const b = buildAuditorFileStates(src);
    assert.deepEqual(a, b);
  });

  it("treats an empty-string file as existing (not missing)", () => {
    // Regression guard: null means "not on disk", "" means "empty file" —
    // the auditor needs to see an empty placeholder file differently from
    // a missing one to reason about create-vs-edit.
    const out = buildAuditorFileStates({ ".keep": "" });
    assert.equal(out[".keep"].exists, true);
    assert.equal(out[".keep"].content, "");
    assert.equal(out[".keep"].originalLength, 0);
    assert.equal(out[".keep"].full, true);
  });
});

describe("resolveCriterionFiles — Unit 5d", () => {
  function commit(
    todoId: string,
    expectedFiles: string[],
    committedAt = 0,
    criterionId?: string,
  ): CommittedTodoSummary {
    return {
      todoId,
      description: `todo ${todoId}`,
      expectedFiles,
      committedAt,
      criterionId,
    };
  }

  it("returns the criterion's own expectedFiles verbatim when no linked commits exist (Unit 28 degenerate case)", () => {
    const c = criterion("c1", "README has Quick Start", "unmet", ["README.md", "docs/intro.md"]);
    // No linked commits — nothing to union in.
    const out = resolveCriterionFiles(c, [
      commit("t1", ["some-other-file.ts"], 100, "c2"), // owned by c2, ignored
    ]);
    assert.deepEqual(out, ["README.md", "docs/intro.md"]);
  });

  // Unit 28: the 2026-04-21 multi-agent-orchestrator failure mode —
  // planner's declared path passes parse-time grounding (parent dir exists)
  // but the exact file is dangling, while workers land their commits at a
  // different anchor linked to the same criterion.
  it("unions declared expectedFiles with linked-commit files (Unit 28)", () => {
    const c = criterion(
      "c1",
      "Tests exist for team manager",
      "unmet",
      ["src/brain/team-manager.test.ts"], // dangling — file never created
    );
    const out = resolveCriterionFiles(c, [
      commit("t1", ["src/tests/team-manager.test.ts"], 100, "c1"), // where work landed
    ]);
    // Declared first, linked after — gives the auditor the planner-chosen
    // anchor AND the real-work anchor in the same prompt.
    assert.deepEqual(out, [
      "src/brain/team-manager.test.ts",
      "src/tests/team-manager.test.ts",
    ]);
  });

  it("dedupes when a declared path matches a linked-commit path (Unit 28)", () => {
    const c = criterion("c1", "README has Quick Start", "unmet", ["README.md"]);
    const out = resolveCriterionFiles(c, [
      commit("t1", ["README.md"], 100, "c1"), // same file
      commit("t2", ["docs/intro.md"], 200, "c1"), // different file
    ]);
    // README.md appears once (dedup); docs/intro.md tacked on after.
    assert.deepEqual(out, ["README.md", "docs/intro.md"]);
  });

  it("caps the linked-commit portion at AUDITOR_FALLBACK_FILE_MAX when declared is non-empty (Unit 28)", () => {
    const c = criterion("c1", "d", "unmet", ["declared.ts"]);
    // 6 distinct linked files — linked union must cap at 4, and the overall
    // length ceiling is declared.length + AUDITOR_FALLBACK_FILE_MAX = 5.
    const out = resolveCriterionFiles(c, [
      commit("t1", ["l1"], 100, "c1"),
      commit("t2", ["l2"], 200, "c1"),
      commit("t3", ["l3"], 300, "c1"),
      commit("t4", ["l4"], 400, "c1"),
      commit("t5", ["l5"], 500, "c1"),
      commit("t6", ["l6"], 600, "c1"),
    ]);
    assert.equal(out.length, 1 + AUDITOR_FALLBACK_FILE_MAX);
    assert.equal(out[0], "declared.ts", "declared stays at head");
    // Linked portion takes the 4 most recent: l6, l5, l4, l3.
    assert.deepEqual(out.slice(1), ["l6", "l5", "l4", "l3"]);
  });

  it("ignores linked commits from a DIFFERENT criterionId even when declared is non-empty (Unit 28)", () => {
    const c = criterion("c1", "d", "unmet", ["declared.ts"]);
    const out = resolveCriterionFiles(c, [
      commit("t1", ["c2-owned.ts"], 100, "c2"), // owned by c2 — do NOT union
      commit("t2", ["true-linked.ts"], 200, "c1"),
    ]);
    assert.deepEqual(out, ["declared.ts", "true-linked.ts"]);
    assert.equal(out.includes("c2-owned.ts"), false);
  });

  it("defensively copies the criterion's own files (caller can mutate safely)", () => {
    const c = criterion("c1", "d", "unmet", ["a.ts"]);
    const out = resolveCriterionFiles(c, []);
    out.push("b.ts");
    assert.deepEqual(c.expectedFiles, ["a.ts"]);
  });

  it("falls back to committed todos whose criterionId matches", () => {
    const c = criterion("c4", "Tests exist for config", "unmet", []);
    const out = resolveCriterionFiles(c, [
      commit("t1", ["src/a.ts"], 100, "c4"),
      commit("t2", ["src/b.ts"], 200, "c4"),
      commit("t3", ["src/other.ts"], 300, "c2"),
    ]);
    // Files from c4-linked todos only; newest-first, but both make the cap.
    assert.deepEqual(out.sort(), ["src/a.ts", "src/b.ts"]);
    assert.equal(out.includes("src/other.ts"), false);
  });

  it("dedupes repeated file paths across linked todos", () => {
    const c = criterion("c4", "d", "unmet", []);
    const out = resolveCriterionFiles(c, [
      commit("t1", ["src/a.ts"], 100, "c4"),
      commit("t2", ["src/a.ts", "src/b.ts"], 200, "c4"),
    ]);
    assert.equal(out.length, 2);
    assert.equal(new Set(out).size, 2);
    assert.equal(out.includes("src/a.ts"), true);
    assert.equal(out.includes("src/b.ts"), true);
  });

  it("caps linked fallback at AUDITOR_FALLBACK_FILE_MAX files", () => {
    const c = criterion("c1", "d", "unmet", []);
    // 6 distinct files, all linked to c1 — result must cap at 4.
    const out = resolveCriterionFiles(c, [
      commit("t1", ["f1"], 100, "c1"),
      commit("t2", ["f2"], 200, "c1"),
      commit("t3", ["f3"], 300, "c1"),
      commit("t4", ["f4"], 400, "c1"),
      commit("t5", ["f5"], 500, "c1"),
      commit("t6", ["f6"], 600, "c1"),
    ]);
    assert.equal(out.length, AUDITOR_FALLBACK_FILE_MAX);
    // Newest-first ordering means we prefer f6, f5, f4, f3 over older files.
    assert.deepEqual(out, ["f6", "f5", "f4", "f3"]);
  });

  it("widens to recent unlinked commits when no criterion-linked commits exist", () => {
    const c = criterion("c1", "d", "unmet", []);
    const out = resolveCriterionFiles(c, [
      commit("t1", ["old.ts"], 100), // unlinked
      commit("t2", ["mid.ts"], 200), // unlinked
      commit("t3", ["new.ts"], 300), // unlinked
    ]);
    // All three survive the cap (cap is 4).
    assert.deepEqual(out.sort(), ["mid.ts", "new.ts", "old.ts"]);
  });

  it("skips commits with a DIFFERENT criterionId in the unlinked fallback", () => {
    const c = criterion("c1", "d", "unmet", []);
    const out = resolveCriterionFiles(c, [
      commit("t1", ["owned.ts"], 100, "c2"), // owned by c2 — must be excluded
      commit("t2", ["free.ts"], 200), // truly unlinked
    ]);
    assert.deepEqual(out, ["free.ts"]);
    assert.equal(out.includes("owned.ts"), false);
  });

  it("limits the unlinked fallback to AUDITOR_FALLBACK_RECENT_COMMITS todos", () => {
    const c = criterion("c1", "d", "unmet", []);
    // 6 unlinked commits, each with one unique file — but we only look at the
    // 4 most recent, so the 2 oldest files must not appear.
    const out = resolveCriterionFiles(c, [
      commit("t1", ["old1"], 100),
      commit("t2", ["old2"], 200),
      commit("t3", ["recent1"], 300),
      commit("t4", ["recent2"], 400),
      commit("t5", ["recent3"], 500),
      commit("t6", ["recent4"], 600),
    ]);
    // Should be exactly the 4 most recent files, newest-first.
    assert.deepEqual(out, ["recent4", "recent3", "recent2", "recent1"]);
    assert.equal(AUDITOR_FALLBACK_RECENT_COMMITS, 4);
  });

  it("prefers linked commits over unlinked even when unlinked are newer", () => {
    const c = criterion("c1", "d", "unmet", []);
    const out = resolveCriterionFiles(c, [
      commit("t1", ["linked.ts"], 100, "c1"), // older, but linked
      commit("t2", ["orphan.ts"], 500), // newer, but unlinked
    ]);
    // Step 2 finds a linked commit, so step 3 (unlinked fallback) doesn't fire.
    assert.deepEqual(out, ["linked.ts"]);
    assert.equal(out.includes("orphan.ts"), false);
  });

  it("returns [] when no expectedFiles, no linked commits, no unlinked commits", () => {
    const c = criterion("c1", "d", "unmet", []);
    assert.deepEqual(resolveCriterionFiles(c, []), []);
    assert.deepEqual(
      resolveCriterionFiles(c, [commit("t1", ["x.ts"], 100, "c2")]),
      [],
    );
  });

  it("is deterministic for a given input order", () => {
    const c = criterion("c1", "d", "unmet", []);
    const committed = [
      commit("t1", ["a.ts"], 100, "c1"),
      commit("t2", ["b.ts"], 200, "c1"),
    ];
    const a = resolveCriterionFiles(c, committed);
    const b = resolveCriterionFiles(c, committed);
    assert.deepEqual(a, b);
  });

  it("handles missing committedAt as 0 when sorting by recency", () => {
    const c = criterion("c1", "d", "unmet", []);
    const out = resolveCriterionFiles(c, [
      commit("t1", ["withTs.ts"], 500, "c1"),
      { todoId: "t2", description: "no ts", expectedFiles: ["noTs.ts"], criterionId: "c1" },
    ]);
    // t1 has committedAt=500, t2 has undefined (treated as 0), so t1 wins
    // recency. Both fit under the cap, order is newest-first.
    assert.deepEqual(out, ["withTs.ts", "noTs.ts"]);
  });
});

describe("buildAuditorSeedCore — Unit 5e", () => {
  // Helpers scoped to this block so the synthetic fixtures look like the real
  // Todo/Finding shapes without dragging in builder logic from elsewhere.
  function todo(overrides: Partial<Todo> & Pick<Todo, "id" | "status">): Todo {
    return {
      description: `todo ${overrides.id}`,
      expectedFiles: [],
      createdBy: "planner",
      createdAt: 0,
      replanCount: 0,
      ...overrides,
    };
  }
  function contract(criteria: ExitCriterion[]): ExitContract {
    return { missionStatement: "Ship the thing.", criteria };
  }
  function finding(agentId: string, text: string, createdAt = 0): Finding {
    return { id: `f-${agentId}-${createdAt}`, agentId, text, createdAt };
  }

  it("reads the criterion's own expectedFiles via readFiles and windows them", async () => {
    // Happy path: criterion has its own files, so resolveCriterionFiles is a
    // pass-through and readFiles is called exactly with those paths.
    const readCalls: string[][] = [];
    const seedOut = await buildAuditorSeedCore({
      contract: contract([criterion("c1", "README has Quick Start", "unmet", ["README.md"])]),
      todos: [],
      findings: [],
      readFiles: async (paths) => {
        readCalls.push([...paths]);
        return { "README.md": "# Quick Start\n\nRun it." };
      },
      auditInvocation: 1,
      maxInvocations: 5,
    });
    assert.equal(readCalls.length, 1);
    assert.deepEqual(readCalls[0], ["README.md"]);
    assert.equal(seedOut.currentFileState["README.md"]?.exists, true);
    assert.match(seedOut.currentFileState["README.md"]!.content, /Quick Start/);
    assert.equal(seedOut.unmetCriteria.length, 1);
    assert.deepEqual(seedOut.unmetCriteria[0]!.expectedFiles, ["README.md"]);
  });

  it("applies Unit 5d fallback: empty expectedFiles + linked committed todo → file in currentFileState (v7 c4/c5 scenario)", async () => {
    // This is the critical regression guard: the v7 run had c4/c5 criteria
    // with empty expectedFiles. Without Unit 5d, readFiles saw an empty list
    // and the auditor had zero file state to reason about. With Unit 5d, the
    // committed todo's files are inferred via criterionId linkage and passed
    // through readFiles, so the auditor sees the actual test-file contents.
    const readCalls: string[][] = [];
    const seedOut = await buildAuditorSeedCore({
      contract: contract([
        criterion("c4", "Unit tests exist for brain logic", "unmet", []),
      ]),
      todos: [
        todo({
          id: "t1",
          status: "committed",
          expectedFiles: ["src/brain/brain.test.ts"],
          committedAt: 1_000,
          criterionId: "c4",
        }),
      ],
      findings: [],
      readFiles: async (paths) => {
        readCalls.push([...paths]);
        return { "src/brain/brain.test.ts": "import { test } from 'node:test';\n// real test\n" };
      },
      auditInvocation: 1,
      maxInvocations: 5,
    });
    assert.equal(readCalls.length, 1);
    assert.deepEqual(readCalls[0], ["src/brain/brain.test.ts"]);
    assert.deepEqual(seedOut.unmetCriteria[0]!.expectedFiles, ["src/brain/brain.test.ts"]);
    assert.equal(seedOut.currentFileState["src/brain/brain.test.ts"]?.exists, true);
    assert.match(
      seedOut.currentFileState["src/brain/brain.test.ts"]!.content,
      /real test/,
    );
  });

  it("applies Unit 5d unlinked fallback when no linked committed todos exist", async () => {
    const seedOut = await buildAuditorSeedCore({
      contract: contract([criterion("c1", "Some orphan criterion", "unmet", [])]),
      todos: [
        todo({
          id: "t1",
          status: "committed",
          expectedFiles: ["CONTRIBUTING.md"],
          committedAt: 500,
          // no criterionId → orphan, eligible for unlinked fallback
        }),
      ],
      findings: [],
      readFiles: async (paths) => {
        assert.deepEqual(paths, ["CONTRIBUTING.md"]);
        return { "CONTRIBUTING.md": "# How to contribute\n" };
      },
      auditInvocation: 1,
      maxInvocations: 5,
    });
    assert.deepEqual(seedOut.unmetCriteria[0]!.expectedFiles, ["CONTRIBUTING.md"]);
    assert.equal(seedOut.currentFileState["CONTRIBUTING.md"]?.exists, true);
  });

  it("never calls readFiles when no unmet criterion has any resolvable files", async () => {
    // Empty expectedFiles, no committed todos at all → nothing to read.
    // The seed should still build cleanly with an empty currentFileState.
    let readFilesCallCount = 0;
    const seedOut = await buildAuditorSeedCore({
      contract: contract([criterion("c1", "orphan", "unmet", [])]),
      todos: [],
      findings: [],
      readFiles: async () => {
        readFilesCallCount += 1;
        return {};
      },
      auditInvocation: 1,
      maxInvocations: 5,
    });
    assert.equal(readFilesCallCount, 0);
    assert.deepEqual(seedOut.currentFileState, {});
    assert.deepEqual(seedOut.unmetCriteria[0]!.expectedFiles, []);
  });

  it("batches readFiles into a single call with a deduped union across unmet criteria", async () => {
    // Two unmet criteria name the same file. readFiles should see it once so
    // the runner's batch read doesn't do wasted disk work (the dedupe lives
    // inside buildAuditorSeedCore, not at the call site).
    const readCalls: string[][] = [];
    await buildAuditorSeedCore({
      contract: contract([
        criterion("c1", "a", "unmet", ["shared.md", "a.md"]),
        criterion("c2", "b", "unmet", ["shared.md", "b.md"]),
      ]),
      todos: [],
      findings: [],
      readFiles: async (paths) => {
        readCalls.push([...paths]);
        return Object.fromEntries(paths.map((p) => [p, `content of ${p}`]));
      },
      auditInvocation: 1,
      maxInvocations: 5,
    });
    assert.equal(readCalls.length, 1);
    const seen = readCalls[0]!;
    assert.equal(seen.length, 3, `expected 3 deduped paths, got ${seen.join(",")}`);
    assert.equal(new Set(seen).size, 3);
    assert.ok(seen.includes("shared.md"));
    assert.ok(seen.includes("a.md"));
    assert.ok(seen.includes("b.md"));
  });

  it("only reads files for UNMET criteria (resolved criteria are context-only)", async () => {
    // A met/wont-do criterion with expectedFiles should NOT trigger a file
    // read — the auditor isn't re-verdicting it, so its file state is noise.
    const readCalls: string[][] = [];
    await buildAuditorSeedCore({
      contract: contract([
        criterion("c1", "unmet one", "unmet", ["open.md"]),
        criterion("c2", "met one", "met", ["closed.md"]),
        criterion("c3", "wont-do one", "wont-do", ["skipped.md"]),
      ]),
      todos: [],
      findings: [],
      readFiles: async (paths) => {
        readCalls.push([...paths]);
        return Object.fromEntries(paths.map((p) => [p, ""]));
      },
      auditInvocation: 1,
      maxInvocations: 5,
    });
    assert.deepEqual(readCalls[0], ["open.md"]);
    assert.equal(readCalls[0]!.includes("closed.md"), false);
    assert.equal(readCalls[0]!.includes("skipped.md"), false);
  });

  it("partitions todos into committed/skipped summaries (committed sorted oldest-first)", async () => {
    const seedOut = await buildAuditorSeedCore({
      contract: contract([criterion("c1", "d", "unmet", ["x.md"])]),
      todos: [
        todo({ id: "t-newer", status: "committed", committedAt: 300, expectedFiles: ["x.md"] }),
        todo({ id: "t-open", status: "open" }),
        todo({ id: "t-older", status: "committed", committedAt: 100, expectedFiles: ["y.md"] }),
        todo({ id: "t-skip", status: "skipped", skippedReason: "duplicate" }),
      ],
      findings: [],
      readFiles: async () => ({ "x.md": "" }),
      auditInvocation: 1,
      maxInvocations: 5,
    });
    // committed entries sorted oldest-first so buildAuditorUserPrompt's
    // slice(-40) preserves the newest 40 — flipping the sort here would
    // silently truncate the wrong end.
    assert.deepEqual(
      seedOut.committed.map((c) => c.todoId),
      ["t-older", "t-newer"],
    );
    assert.deepEqual(seedOut.skipped.map((s) => s.todoId), ["t-skip"]);
    assert.equal(seedOut.skipped[0]!.skippedReason, "duplicate");
  });

  it("maps findings through unchanged", async () => {
    const seedOut = await buildAuditorSeedCore({
      contract: contract([criterion("c1", "d", "unmet", [])]),
      todos: [],
      findings: [finding("agent-1", "hit a snag", 42), finding("agent-2", "all clear", 99)],
      readFiles: async () => ({}),
      auditInvocation: 1,
      maxInvocations: 5,
    });
    assert.equal(seedOut.findings.length, 2);
    assert.deepEqual(seedOut.findings[0], { agentId: "agent-1", text: "hit a snag", createdAt: 42 });
    assert.deepEqual(seedOut.findings[1], { agentId: "agent-2", text: "all clear", createdAt: 99 });
  });

  it("surfaces resolved (non-unmet) criteria as context-only, with defensively-copied expectedFiles", async () => {
    const seedOut = await buildAuditorSeedCore({
      contract: contract([
        criterion("c1", "unmet one", "unmet", ["open.md"]),
        criterion("c2", "met one", "met", ["closed.md"]),
      ]),
      todos: [],
      findings: [],
      readFiles: async () => ({ "open.md": "" }),
      auditInvocation: 1,
      maxInvocations: 5,
    });
    assert.equal(seedOut.resolvedCriteria.length, 1);
    assert.equal(seedOut.resolvedCriteria[0]!.id, "c2");
    // Mutating the returned array must not leak back into the input contract.
    seedOut.resolvedCriteria[0]!.expectedFiles.push("mutated.md");
    assert.equal(seedOut.resolvedCriteria[0]!.expectedFiles.length, 2);
    // (the original criterion object is separately verified to be intact below)
  });

  it("passes mission statement and invocation counts through to the seed", async () => {
    const seedOut = await buildAuditorSeedCore({
      contract: {
        missionStatement: "Harden the auditor.",
        criteria: [criterion("c1", "d", "unmet", [])],
      },
      todos: [],
      findings: [],
      readFiles: async () => ({}),
      auditInvocation: 3,
      maxInvocations: 5,
    });
    assert.equal(seedOut.missionStatement, "Harden the auditor.");
    assert.equal(seedOut.auditInvocation, 3);
    assert.equal(seedOut.maxInvocations, 5);
  });

  it("marks a missing file (readFiles returned null) as non-existent in currentFileState", async () => {
    // Round-trips buildAuditorFileStates semantics end-to-end: null → exists:false.
    const seedOut = await buildAuditorSeedCore({
      contract: contract([criterion("c1", "d", "unmet", ["missing.ts"])]),
      todos: [],
      findings: [],
      readFiles: async () => ({ "missing.ts": null }),
      auditInvocation: 1,
      maxInvocations: 5,
    });
    assert.equal(seedOut.currentFileState["missing.ts"]?.exists, false);
    assert.equal(seedOut.currentFileState["missing.ts"]?.content, "");
  });

  it("windows a large file in currentFileState (same view as the worker sees)", async () => {
    const head = "HEAD-UNIQUE-" + "a".repeat(WORKER_FILE_HEAD_BYTES);
    const tail = "b".repeat(WORKER_FILE_TAIL_BYTES) + "-TAIL-UNIQUE";
    const filler = "x".repeat(WORKER_FILE_WINDOW_THRESHOLD);
    const big = head + filler + tail;
    const seedOut = await buildAuditorSeedCore({
      contract: contract([criterion("c1", "d", "unmet", ["CHANGELOG.md"])]),
      todos: [],
      findings: [],
      readFiles: async () => ({ "CHANGELOG.md": big }),
      auditInvocation: 1,
      maxInvocations: 5,
    });
    const entry = seedOut.currentFileState["CHANGELOG.md"]!;
    assert.equal(entry.exists, true);
    assert.equal(entry.full, false);
    assert.equal(entry.originalLength, big.length);
    assert.ok(entry.content.includes("HEAD-UNIQUE-"));
    assert.ok(entry.content.includes("-TAIL-UNIQUE"));
  });

  it("does not mutate the input contract (unmetCriteria.expectedFiles is a fresh array)", async () => {
    const original = criterion("c1", "d", "unmet", []);
    const c = contract([original]);
    const seedOut = await buildAuditorSeedCore({
      contract: c,
      todos: [
        todo({
          id: "t1",
          status: "committed",
          expectedFiles: ["inferred.md"],
          committedAt: 100,
          criterionId: "c1",
        }),
      ],
      findings: [],
      readFiles: async () => ({ "inferred.md": "" }),
      auditInvocation: 1,
      maxInvocations: 5,
    });
    // Unit 5d decorates unmetCriteria[0].expectedFiles in the seed, but the
    // underlying ExitContract must be untouched so the runner's in-memory
    // contract representation doesn't drift between audit invocations.
    assert.deepEqual(seedOut.unmetCriteria[0]!.expectedFiles, ["inferred.md"]);
    assert.deepEqual(original.expectedFiles, []);
    assert.equal(c.criteria[0]!.expectedFiles.length, 0);
  });
});

// Unit 36: Live UI snapshot evidence in the auditor prompt.
describe("AUDITOR_SYSTEM_PROMPT — Unit 36 UI evidence rule", () => {
  it("has Rule 11 about UI snapshots being PRIMARY EVIDENCE", () => {
    assert.match(AUDITOR_SYSTEM_PROMPT, /11\. Unit 36/);
    assert.match(AUDITOR_SYSTEM_PROMPT, /Live UI snapshot/);
    assert.match(AUDITOR_SYSTEM_PROMPT, /PRIMARY EVIDENCE/);
  });

  it("tells auditor to verdict unmet when snapshot contradicts file changes", () => {
    assert.match(AUDITOR_SYSTEM_PROMPT, /verdict is `unmet`/);
  });

  it("documents the fallback to file-only when snapshot is absent", () => {
    assert.match(AUDITOR_SYSTEM_PROMPT, /fall back to file-only evaluation/);
  });
});

describe("buildAuditorUserPrompt — Unit 36 UI snapshot block", () => {
  function seedWithUi(
    uiUrl: string | undefined,
    uiSnapshot: string | undefined,
  ): AuditorSeed {
    return {
      missionStatement: "m",
      unmetCriteria: [
        criterion("c1", "home page renders sign-up CTA", "unmet", ["src/home.tsx"]),
      ],
      resolvedCriteria: [],
      committed: [],
      skipped: [],
      findings: [],
      currentFileState: {
        "src/home.tsx": { exists: true, content: "<Home/>", full: true, originalLength: 7 },
      },
      auditInvocation: 1,
      maxInvocations: 5,
      uiUrl,
      uiSnapshot,
    };
  }

  it("renders the UI snapshot block when both uiUrl and uiSnapshot are present", () => {
    const p = buildAuditorUserPrompt(
      seedWithUi("http://localhost:3000", "heading 'Welcome'\nbutton 'Sign up'\n"),
    );
    assert.match(p, /Live UI snapshot \(from http:\/\/localhost:3000\)/);
    assert.match(p, /PRIMARY EVIDENCE for user-visible criteria/);
    assert.match(p, /button 'Sign up'/);
  });

  it("omits the UI snapshot block when uiSnapshot is undefined", () => {
    const p = buildAuditorUserPrompt(
      seedWithUi("http://localhost:3000", undefined),
    );
    assert.ok(!p.includes("Live UI snapshot"));
  });

  it("omits the UI snapshot block when uiUrl is undefined (snapshot without url is meaningless)", () => {
    const p = buildAuditorUserPrompt(seedWithUi(undefined, "content"));
    assert.ok(!p.includes("Live UI snapshot"));
  });

  it("truncates a >16K snapshot with a chars-truncated marker", () => {
    const big = "x".repeat(20_000);
    const p = buildAuditorUserPrompt(
      seedWithUi("http://localhost:3000", big),
    );
    assert.match(p, /chars truncated/);
    // Should include the truncated amount
    assert.ok(p.includes("4000 chars truncated"));
  });

  it("keeps the primary file-state block AFTER the UI snapshot block", () => {
    const p = buildAuditorUserPrompt(
      seedWithUi("http://localhost:3000", "snapshot"),
    );
    const uiIdx = p.indexOf("Live UI snapshot");
    const fileIdx = p.indexOf("Current file state for UNMET");
    assert.ok(uiIdx >= 0 && fileIdx >= 0, "both blocks present");
    assert.ok(uiIdx < fileIdx, "UI snapshot comes before file state");
  });
});

describe("buildAuditorSeedCore — Unit 36 UI passthrough", () => {
  it("passes uiUrl + uiSnapshot through to the seed", async () => {
    const c: ExitContract = {
      missionStatement: "m",
      criteria: [criterion("c1", "d", "unmet", ["x.ts"])],
    };
    const seed = await buildAuditorSeedCore({
      contract: c,
      todos: [],
      findings: [],
      readFiles: async () => ({ "x.ts": "x" }),
      auditInvocation: 1,
      maxInvocations: 5,
      uiUrl: "http://localhost:3000",
      uiSnapshot: "body\n",
    });
    assert.equal(seed.uiUrl, "http://localhost:3000");
    assert.equal(seed.uiSnapshot, "body\n");
  });

  it("leaves uiUrl/uiSnapshot undefined when not provided", async () => {
    const c: ExitContract = {
      missionStatement: "m",
      criteria: [criterion("c1", "d", "unmet", ["x.ts"])],
    };
    const seed = await buildAuditorSeedCore({
      contract: c,
      todos: [],
      findings: [],
      readFiles: async () => ({ "x.ts": "x" }),
      auditInvocation: 1,
      maxInvocations: 5,
    });
    assert.equal(seed.uiUrl, undefined);
    assert.equal(seed.uiSnapshot, undefined);
  });
});
