import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shortRepoLabel } from "./RecentRuns.js";

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
