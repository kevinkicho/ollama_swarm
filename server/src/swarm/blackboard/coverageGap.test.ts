// 2026-05-02 (blackboard feature #5): coverage-gap detection tests.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractDirectivePaths,
  detectCoverageGaps,
  formatCoverageGapsMarkdown,
} from "./coverageGap.js";

describe("extractDirectivePaths", () => {
  it("extracts file paths with extensions", () => {
    const paths = extractDirectivePaths(
      "Please update README.md and src/auth.ts to handle the new flow",
    );
    assert.ok(paths.includes("readme.md"));
    assert.ok(paths.includes("src/auth.ts"));
  });

  it("extracts package.json from a directive", () => {
    const paths = extractDirectivePaths("Add the dep to package.json + restart");
    assert.ok(paths.includes("package.json"));
  });

  it("dedupes case-insensitively", () => {
    const paths = extractDirectivePaths(
      "update README.md and ALSO check Readme.md vs README.MD",
    );
    assert.equal(paths.filter((p) => p === "readme.md").length, 1);
  });

  it("returns empty array on empty input", () => {
    assert.deepEqual(extractDirectivePaths(""), []);
  });

  it("ignores tokens shorter than 4 chars", () => {
    // ".md" alone is too short; only path-shaped tokens with length ≥ 4 survive
    const paths = extractDirectivePaths("rename .md files");
    assert.ok(!paths.some((p) => p === ".md" || p === "md"));
  });
});

describe("detectCoverageGaps", () => {
  it("flags HIGH severity when criterion expectedFile wasn't touched + verdict is false/unmet", () => {
    const gaps = detectCoverageGaps({
      directive: "fix auth",
      criteriaExpectedFiles: [
        { criterionId: "c1", expectedFiles: ["src/auth.ts"], verdict: "false" },
      ],
      touchedFiles: ["src/log.ts"],
      repoFiles: ["src/auth.ts", "src/log.ts"],
    });
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].file, "src/auth.ts");
    assert.equal(gaps[0].severity, "high");
    assert.equal(gaps[0].source, "criterion");
  });

  it("flags MEDIUM severity for criterion gap when verdict is verified/partial", () => {
    const gaps = detectCoverageGaps({
      directive: "x",
      criteriaExpectedFiles: [
        { criterionId: "c1", expectedFiles: ["src/auth.ts"], verdict: "verified" },
      ],
      touchedFiles: [],
      repoFiles: ["src/auth.ts"],
    });
    assert.equal(gaps[0].severity, "medium");
  });

  it("flags MEDIUM severity for directive-mention gaps", () => {
    const gaps = detectCoverageGaps({
      directive: "update package.json + README.md",
      criteriaExpectedFiles: [],
      touchedFiles: ["src/index.ts"],
      repoFiles: ["package.json", "README.md", "src/index.ts"],
    });
    const pkgGap = gaps.find((g) => g.file.toLowerCase() === "package.json");
    assert.ok(pkgGap);
    assert.equal(pkgGap!.severity, "medium");
    assert.equal(pkgGap!.source, "directive-mention");
  });

  it("does NOT flag files that were touched", () => {
    const gaps = detectCoverageGaps({
      directive: "x",
      criteriaExpectedFiles: [
        { criterionId: "c1", expectedFiles: ["src/auth.ts"], verdict: "verified" },
      ],
      touchedFiles: ["src/auth.ts"],
      repoFiles: ["src/auth.ts"],
    });
    assert.equal(gaps.length, 0);
  });

  it("does NOT double-flag a file mentioned by both criterion AND directive", () => {
    const gaps = detectCoverageGaps({
      directive: "fix the bug in src/auth.ts",
      criteriaExpectedFiles: [
        { criterionId: "c1", expectedFiles: ["src/auth.ts"], verdict: "false" },
      ],
      touchedFiles: [],
      repoFiles: ["src/auth.ts"],
    });
    assert.equal(gaps.length, 1, "must only flag once even when both signals fire");
    // Criterion source wins (higher-confidence signal)
    assert.equal(gaps[0].source, "criterion");
  });

  it("returns empty when nothing was missed", () => {
    const gaps = detectCoverageGaps({
      directive: "any directive",
      criteriaExpectedFiles: [
        { criterionId: "c1", expectedFiles: ["a.ts"], verdict: "verified" },
        { criterionId: "c2", expectedFiles: ["b.ts"], verdict: "verified" },
      ],
      touchedFiles: ["a.ts", "b.ts"],
      repoFiles: ["a.ts", "b.ts"],
    });
    assert.deepEqual(gaps, []);
  });

  it("sorts HIGH before MEDIUM before LOW", () => {
    const gaps = detectCoverageGaps({
      directive: "z.md y.md",
      criteriaExpectedFiles: [
        { criterionId: "c1", expectedFiles: ["a.ts"], verdict: "false" }, // HIGH
        { criterionId: "c2", expectedFiles: ["b.ts"], verdict: "verified" }, // MEDIUM
      ],
      touchedFiles: [],
      repoFiles: ["a.ts", "b.ts", "z.md", "y.md"],
    });
    // HIGH first
    assert.equal(gaps[0].severity, "high");
    // The rest are MEDIUM
    for (let i = 1; i < gaps.length; i++) {
      assert.equal(gaps[i].severity, "medium");
    }
  });
});

describe("formatCoverageGapsMarkdown", () => {
  it("renders empty-state placeholder when no gaps", () => {
    const md = formatCoverageGapsMarkdown([]);
    assert.match(md, /no coverage gaps/i);
  });

  it("groups by severity in the output", () => {
    const md = formatCoverageGapsMarkdown([
      { file: "a.ts", reason: "r1", severity: "high", source: "criterion", criterionId: "c1" },
      { file: "b.ts", reason: "r2", severity: "medium", source: "directive-mention" },
    ]);
    assert.match(md, /\*\*HIGH severity:\*\*/);
    assert.match(md, /\*\*MEDIUM severity:\*\*/);
    assert.match(md, /`a\.ts`/);
    assert.match(md, /`b\.ts`/);
  });
});
