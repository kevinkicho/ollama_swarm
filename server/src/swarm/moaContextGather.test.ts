// 2026-05-02 (lever #1): tests for the retrieval-augmented context
// gather. Pure-function tests are in-process; the gatherProposerContext
// function is exercised against an on-disk fixture so the read path
// + filesystem error handling are real.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractSeedTerms,
  rankFilesByRelevance,
  gatherProposerContext,
} from "./moaContextGather.js";

describe("extractSeedTerms — pure", () => {
  it("extracts ≥4-char tokens, lowercased + deduped", () => {
    const terms = extractSeedTerms("Audit the README claims for the auth module");
    // "the" and "for" are short or stop-words; "audit", "readme", "claims",
    // "auth", "module" survive.
    assert.ok(terms.includes("audit"));
    assert.ok(terms.includes("readme"));
    assert.ok(terms.includes("claims"));
    assert.ok(terms.includes("auth"));
    assert.ok(terms.includes("module"));
    assert.ok(!terms.includes("the"));
    assert.ok(!terms.includes("for"));
  });

  it("excludes common stop-words even when ≥4 chars", () => {
    const terms = extractSeedTerms("This will produce what each user should respond with");
    assert.ok(!terms.includes("this"));
    assert.ok(!terms.includes("will"));
    assert.ok(!terms.includes("user"));
    assert.ok(!terms.includes("respond"));
  });

  it("dedupes case-insensitively", () => {
    const terms = extractSeedTerms("Express express EXPRESS migration");
    const expressCount = terms.filter((t) => t === "express").length;
    assert.equal(expressCount, 1);
  });

  it("incorporates user messages alongside seed", () => {
    const terms = extractSeedTerms("audit", ["focus on retry logic", "skip cosmetic"]);
    assert.ok(terms.includes("audit"));
    assert.ok(terms.includes("retry"));
    assert.ok(terms.includes("logic"));
    assert.ok(terms.includes("cosmetic"));
  });

  it("(issue #5 fix) incorporates priorSynthesis terms when provided", () => {
    const terms = extractSeedTerms(
      "audit the auth module",
      [],
      "the analysis surfaced the rateLimiter wrapping every request",
    );
    assert.ok(terms.includes("audit"));
    assert.ok(terms.includes("auth"));
    // Terms from priorSynthesis must be picked up
    assert.ok(terms.includes("ratelimiter"));
    assert.ok(terms.includes("wrapping"));
    assert.ok(terms.includes("request"));
  });

  it("returns empty array on empty input", () => {
    assert.deepEqual(extractSeedTerms(""), []);
  });
});

describe("rankFilesByRelevance — pure", () => {
  it("ranks basename matches above path matches", () => {
    const ranked = rankFilesByRelevance(
      ["src/util/retry.ts", "src/auth/index.ts", "src/util/log.ts"],
      ["retry"],
    );
    assert.equal(ranked[0].path, "src/util/retry.ts");
  });

  it("penalizes deep files (depth = slash count)", () => {
    const ranked = rankFilesByRelevance(
      ["very/deep/nested/auth.ts", "auth.ts"],
      ["auth"],
    );
    assert.equal(ranked[0].path, "auth.ts");
  });

  it("rewards code-entrypoint basenames (index/main/server/app)", () => {
    const ranked = rankFilesByRelevance(
      ["src/lib/helpers.ts", "src/index.ts"],
      [], // no seed terms — only entrypoint bonus differentiates
    );
    assert.equal(ranked[0].path, "src/index.ts");
  });

  it("entrypoint pattern requires single-segment basename (not random.index.ts)", () => {
    // The regex is /^(index|main|server|app)\.[a-z]+$/, so dotted names
    // don't get the bonus. Verify by ensuring "config.json" doesn't beat
    // "package.json" via entrypoint logic alone.
    const ranked = rankFilesByRelevance(
      ["random.index.ts", "config.json"],
      [],
    );
    // Both are root-level, no seed match, no entrypoint match — depth-tied.
    // The order isn't load-bearing; what matters is neither got the +3 bonus.
    for (const r of ranked) assert.equal(r.score, 0);
  });

  it("returns descending-score order", () => {
    const ranked = rankFilesByRelevance(
      ["c.ts", "b.ts", "a.ts"],
      ["a"], // matches a.ts only
    );
    assert.equal(ranked[0].path, "a.ts");
    assert.ok(ranked[0].score > ranked[1].score);
  });
});

describe("gatherProposerContext — on-disk integration", () => {
  function setupRepo(): { cwd: string; cleanup: () => void } {
    const cwd = mkdtempSync(join(tmpdir(), "moa-gather-"));
    return { cwd, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
  }

  it("includes always-try config files when they exist in repoFiles", async () => {
    const { cwd, cleanup } = setupRepo();
    try {
      writeFileSync(join(cwd, "package.json"), '{"name":"test","version":"1.0.0"}');
      writeFileSync(join(cwd, "tsconfig.json"), '{"compilerOptions":{"target":"es2022"}}');
      mkdirSync(join(cwd, "src"));
      writeFileSync(join(cwd, "src", "unrelated.ts"), "export const x = 1;");

      const out = await gatherProposerContext({
        clonePath: cwd,
        seed: "discuss anything",
        repoFiles: ["package.json", "tsconfig.json", "src/unrelated.ts"],
      });

      const paths = out.map((e) => e.path);
      assert.ok(paths.includes("package.json"), "package.json must be included");
      assert.ok(paths.includes("tsconfig.json"), "tsconfig.json must be included");
    } finally {
      cleanup();
    }
  });

  it("includes seed-relevant files even when no config files match", async () => {
    const { cwd, cleanup } = setupRepo();
    try {
      mkdirSync(join(cwd, "src"));
      writeFileSync(join(cwd, "src", "auth.ts"), "export function login() {}");
      writeFileSync(join(cwd, "src", "log.ts"), "export function log() {}");

      const out = await gatherProposerContext({
        clonePath: cwd,
        seed: "review the auth module for security issues",
        repoFiles: ["src/auth.ts", "src/log.ts"],
      });

      const paths = out.map((e) => e.path);
      assert.ok(paths.includes("src/auth.ts"), "auth.ts must be included (seed term match)");
    } finally {
      cleanup();
    }
  });

  it("truncates each excerpt to FILE_EXCERPT_MAX (1500 chars)", async () => {
    const { cwd, cleanup } = setupRepo();
    try {
      const longContent = "x".repeat(3000);
      writeFileSync(join(cwd, "huge.ts"), longContent);
      const out = await gatherProposerContext({
        clonePath: cwd,
        seed: "huge",
        repoFiles: ["huge.ts"],
      });
      assert.equal(out[0].path, "huge.ts");
      assert.equal(out[0].excerpt.length, 1500);
    } finally {
      cleanup();
    }
  });

  it("silently skips files that fail to read", async () => {
    const { cwd, cleanup } = setupRepo();
    try {
      writeFileSync(join(cwd, "exists.ts"), "x");
      // Don't create "ghost.ts" — it's in repoFiles but not on disk.
      const out = await gatherProposerContext({
        clonePath: cwd,
        seed: "ghost exists",
        repoFiles: ["ghost.ts", "exists.ts"],
      });
      const paths = out.map((e) => e.path);
      assert.ok(paths.includes("exists.ts"));
      assert.ok(!paths.includes("ghost.ts"));
    } finally {
      cleanup();
    }
  });

  it("returns empty array when repoFiles is empty", async () => {
    const { cwd, cleanup } = setupRepo();
    try {
      const out = await gatherProposerContext({
        clonePath: cwd,
        seed: "anything",
        repoFiles: [],
      });
      assert.deepEqual(out, []);
    } finally {
      cleanup();
    }
  });

  it("caps the number of files at MAX_FILES_TO_FETCH (8)", async () => {
    const { cwd, cleanup } = setupRepo();
    try {
      // Create 20 small files that all match the seed term.
      const files: string[] = [];
      for (let i = 0; i < 20; i++) {
        const name = `auth${i}.ts`;
        writeFileSync(join(cwd, name), "x");
        files.push(name);
      }
      const out = await gatherProposerContext({
        clonePath: cwd,
        seed: "auth",
        repoFiles: files,
      });
      assert.ok(out.length <= 8, `must cap at 8 files; got ${out.length}`);
    } finally {
      cleanup();
    }
  });
});

describe("gatherProposerContext — issue #5 (alreadyFetched + priorSynthesis)", () => {
  function setupRepo(): { cwd: string; cleanup: () => void } {
    const cwd = mkdtempSync(join(tmpdir(), "moa-gather-issue5-"));
    return { cwd, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
  }

  it("excludes files already fetched in a prior round", async () => {
    const { cwd, cleanup } = setupRepo();
    try {
      writeFileSync(join(cwd, "package.json"), '{"name":"x"}');
      writeFileSync(join(cwd, "src.ts"), "export const x = 1;");
      const out = await gatherProposerContext({
        clonePath: cwd,
        seed: "anything",
        repoFiles: ["package.json", "src.ts"],
        alreadyFetched: ["package.json"],
      });
      const paths = out.map((e) => e.path);
      assert.ok(!paths.includes("package.json"), "already-fetched config must be excluded");
      assert.ok(paths.includes("src.ts"));
    } finally {
      cleanup();
    }
  });

  it("uses priorSynthesis terms to surface NEW relevant files", async () => {
    const { cwd, cleanup } = setupRepo();
    try {
      writeFileSync(join(cwd, "src.ts"), "x");
      writeFileSync(join(cwd, "auth.ts"), "x");
      writeFileSync(join(cwd, "ratelimiter.ts"), "x");
      const out = await gatherProposerContext({
        clonePath: cwd,
        seed: "audit the auth module",
        repoFiles: ["src.ts", "auth.ts", "ratelimiter.ts"],
        priorSynthesis: "the analysis surfaced the ratelimiter wrapping every request",
        alreadyFetched: ["auth.ts"],
      });
      const paths = out.map((e) => e.path);
      // ratelimiter should now be picked up via the synthesis term
      assert.ok(paths.includes("ratelimiter.ts"), "ratelimiter must be picked up via priorSynthesis");
      // auth.ts already fetched — must be excluded
      assert.ok(!paths.includes("auth.ts"));
    } finally {
      cleanup();
    }
  });
});
