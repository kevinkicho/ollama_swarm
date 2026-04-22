import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AUDITOR_FALLBACK_FILE_MAX,
  AUDITOR_FALLBACK_RECENT_COMMITS,
  AUDITOR_SYSTEM_PROMPT,
  buildAuditorFileStates,
  buildAuditorRepairPrompt,
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

  it("returns the criterion's own expectedFiles verbatim when non-empty", () => {
    const c = criterion("c1", "README has Quick Start", "unmet", ["README.md", "docs/intro.md"]);
    const out = resolveCriterionFiles(c, [
      commit("t1", ["unrelated.ts"], 100, "c1"),
    ]);
    assert.deepEqual(out, ["README.md", "docs/intro.md"]);
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
