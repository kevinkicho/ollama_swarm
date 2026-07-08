import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildRecentRunTipFields,
  formatRecentRunAgo,
  recentRunChipLabel,
  shortRepoLabel,
} from "./RecentRuns.js";

describe("shortRepoLabel", () => {
  it("strips https://github.com/ prefix", () => {
    assert.equal(
      shortRepoLabel("https://github.com/kevinkicho/debate-tcg"),
      "kevinkicho/debate-tcg",
    );
  });

  it("strips http://github.com/ prefix", () => {
    assert.equal(
      shortRepoLabel("http://github.com/user/repo"),
      "user/repo",
    );
  });

  it("strips trailing .git", () => {
    assert.equal(
      shortRepoLabel("https://github.com/kevinkicho/ollama_swarm.git"),
      "kevinkicho/ollama_swarm",
    );
  });

  it("handles both prefix and .git suffix", () => {
    assert.equal(
      shortRepoLabel("https://github.com/nick-kev/foo.git"),
      "nick-kev/foo",
    );
  });

  it("passes through non-github URLs unchanged", () => {
    assert.equal(
      shortRepoLabel("https://gitlab.com/user/repo"),
      "https://gitlab.com/user/repo",
    );
  });

  it("handles empty string", () => {
    assert.equal(shortRepoLabel(""), "");
  });

  it("handles URL with extra path segments", () => {
    assert.equal(
      shortRepoLabel("https://github.com/user/repo/tree/main/src"),
      "user/repo/tree/main/src",
    );
  });

  it("handles URL without trailing .git that ends with .git-like text", () => {
    assert.equal(
      shortRepoLabel("https://github.com/user/gitignore"),
      "user/gitignore",
    );
  });
});

describe("recentRunChipLabel", () => {
  it("shows repo + preset without a leading separator when repoUrl is set", () => {
    assert.deepEqual(
      recentRunChipLabel({
        repoUrl: "https://github.com/sindresorhus/got",
        parentPath: "C:\\users\\you\\projects",
        presetId: "council",
      }),
      { primary: "sindresorhus/got", preset: "council" },
    );
  });

  it("falls back to parentPath basename when repoUrl is empty (no stray dot)", () => {
    assert.deepEqual(
      recentRunChipLabel({
        repoUrl: "",
        parentPath: "C:\\Users\\kevin\\workspace\\ollama_swarm",
        presetId: "blackboard",
      }),
      { primary: "ollama_swarm", preset: "blackboard" },
    );
  });

  it("buildRecentRunTipFields includes structured rows", () => {
    const fields = buildRecentRunTipFields({
      id: "1",
      repoUrl: "https://github.com/user/repo",
      parentPath: "C:\\work\\repo",
      presetId: "council",
      directiveSnippet: "analyze papers",
      directive: "analyze papers on superconductors",
      startedAt: 1_700_000_000_000,
      runId: "run-abc",
      wallClockCapMin: "45",
      ambitionTiers: "2",
    });
    assert.deepEqual(
      fields.map((f) => f.label),
      ["preset", "repo", "workspace", "directive", "started", "run", "cap", "tiers"],
    );
    assert.equal(fields.find((f) => f.label === "repo")?.value, "user/repo");
    assert.equal(fields.find((f) => f.label === "directive")?.multiline, true);
  });

  it("formatRecentRunAgo uses relative units for recent timestamps", () => {
    const now = 1_700_000_000_000;
    assert.equal(formatRecentRunAgo(now - 500, now), "just now");
    assert.equal(formatRecentRunAgo(now - 30_000, now), "30s ago");
    assert.equal(formatRecentRunAgo(now - 120_000, now), "2m ago");
  });

  it("omits preset when it matches the only available label", () => {
    assert.deepEqual(
      recentRunChipLabel({
        repoUrl: "",
        parentPath: "",
        presetId: "blackboard",
      }),
      { primary: "blackboard" },
    );
  });
});
