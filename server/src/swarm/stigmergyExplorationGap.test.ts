// 2026-05-02 (stigmergy improvement #3): tests for exploration-gap
// detection.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractDirectiveExplorationTargets,
  extractTopLevelDirs,
  detectExplorationGaps,
  formatExplorationGapsMarkdown,
} from "./stigmergyExplorationGap.js";

describe("extractDirectiveExplorationTargets", () => {
  it("extracts file paths with extensions", () => {
    const t = extractDirectiveExplorationTargets("walk src/auth.ts and api.ts");
    assert.ok(t.includes("src/auth.ts"));
    assert.ok(t.includes("api.ts"));
  });

  it("extracts dir mentions ending in /", () => {
    const t = extractDirectiveExplorationTargets("focus on tests/ and config/");
    assert.ok(t.includes("tests/"));
    assert.ok(t.includes("config/"));
  });

  it("dedupes case-insensitively", () => {
    const t = extractDirectiveExplorationTargets("README.md and ALSO Readme.md");
    assert.equal(t.filter((x) => x === "readme.md").length, 1);
  });

  it("ignores tokens shorter than 4 chars", () => {
    const t = extractDirectiveExplorationTargets("look at .md files");
    assert.ok(!t.includes(".md"));
  });
});

describe("extractTopLevelDirs", () => {
  it("returns top-level dir prefix per file", () => {
    const dirs = extractTopLevelDirs([
      "src/auth.ts",
      "src/api.ts",
      "tests/auth.test.ts",
      "docs/setup.md",
      "package.json",
    ]);
    assert.deepEqual(dirs.sort(), ["docs", "src", "tests"]);
  });

  it("ignores root-level files", () => {
    const dirs = extractTopLevelDirs(["README.md", "package.json"]);
    assert.deepEqual(dirs, []);
  });

  it("returns empty array on empty input", () => {
    assert.deepEqual(extractTopLevelDirs([]), []);
  });
});

describe("detectExplorationGaps", () => {
  it("flags HIGH severity for directive-mentioned files NOT annotated", () => {
    const gaps = detectExplorationGaps({
      directive: "audit src/auth.ts and src/log.ts",
      annotatedFiles: ["src/log.ts"],
      repoFiles: ["src/auth.ts", "src/log.ts"],
    });
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].target, "src/auth.ts");
    assert.equal(gaps[0].severity, "high");
    assert.equal(gaps[0].source, "directive-mention");
  });

  it("flags MEDIUM severity for top-level dirs with ZERO annotations", () => {
    const gaps = detectExplorationGaps({
      directive: "explore the repo",
      annotatedFiles: ["src/auth.ts"],
      repoFiles: ["src/auth.ts", "tests/x.test.ts", "docs/y.md"],
    });
    const dirs = gaps.filter((g) => g.source === "top-level-dir").map((g) => g.target);
    assert.ok(dirs.includes("tests/"));
    assert.ok(dirs.includes("docs/"));
    assert.ok(!dirs.includes("src/"), "src had annotations");
  });

  it("does NOT flag annotated files", () => {
    const gaps = detectExplorationGaps({
      directive: "audit src/auth.ts",
      annotatedFiles: ["src/auth.ts"],
      repoFiles: ["src/auth.ts"],
    });
    assert.equal(gaps.length, 0);
  });

  it("skips standard noise dirs (node_modules, .git, dist, build, coverage, .cache)", () => {
    const gaps = detectExplorationGaps({
      directive: "explore",
      annotatedFiles: [],
      repoFiles: [
        "src/x.ts",
        "node_modules/lib/y.js",
        ".git/HEAD",
        "dist/x.js",
        "build/y.js",
        ".cache/z",
        "coverage/lcov.info",
      ],
    });
    const targets = gaps.map((g) => g.target);
    assert.ok(!targets.includes("node_modules/"));
    assert.ok(!targets.includes(".git/"));
    assert.ok(!targets.includes("dist/"));
    assert.ok(!targets.includes("build/"));
    assert.ok(!targets.includes(".cache/"));
    assert.ok(!targets.includes("coverage/"));
  });

  it("counts a top-level dir as covered if ANY file under it was annotated", () => {
    const gaps = detectExplorationGaps({
      directive: "explore",
      annotatedFiles: ["src/auth.ts"], // just one file under src
      repoFiles: ["src/auth.ts", "src/log.ts", "src/api.ts"],
    });
    assert.equal(gaps.filter((g) => g.target === "src/").length, 0);
  });

  it("sorts HIGH before MEDIUM", () => {
    const gaps = detectExplorationGaps({
      directive: "audit src/auth.ts",
      annotatedFiles: [],
      repoFiles: ["src/auth.ts", "tests/x.test.ts", "docs/y.md"],
    });
    if (gaps.length >= 2) {
      assert.equal(gaps[0].severity, "high");
      for (let i = 1; i < gaps.length; i++) {
        assert.notEqual(gaps[i].severity, "high");
      }
    }
  });
});

describe("formatExplorationGapsMarkdown", () => {
  it("returns 'no gaps' placeholder when empty", () => {
    assert.match(formatExplorationGapsMarkdown([]), /no exploration gaps/i);
  });

  it("groups by severity in output", () => {
    const md = formatExplorationGapsMarkdown([
      { target: "x.ts", reason: "r1", severity: "high", source: "directive-mention" },
      { target: "y/", reason: "r2", severity: "medium", source: "top-level-dir" },
    ]);
    assert.match(md, /\*\*HIGH severity:\*\*/);
    assert.match(md, /\*\*MEDIUM severity:\*\*/);
    assert.match(md, /`x\.ts`/);
    assert.match(md, /`y\/`/);
  });
});
