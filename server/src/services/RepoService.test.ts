import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { deriveCloneDir } from "./RepoService.js";

test("deriveCloneDir — standard github URL", () => {
  const got = deriveCloneDir("https://github.com/sindresorhus/is-odd", "/tmp/runs");
  assert.equal(got, path.resolve("/tmp/runs", "is-odd"));
});

test("deriveCloneDir — strips .git suffix", () => {
  const got = deriveCloneDir("https://github.com/kevinkicho/multi-agent-orchestrator.git", "/tmp/runs");
  assert.equal(got, path.resolve("/tmp/runs", "multi-agent-orchestrator"));
});

test("deriveCloneDir — strips trailing slash before picking last segment", () => {
  const got = deriveCloneDir("https://github.com/sindresorhus/is-odd/", "/tmp/runs");
  assert.equal(got, path.resolve("/tmp/runs", "is-odd"));
});

test("deriveCloneDir — case-insensitive .git strip", () => {
  const got = deriveCloneDir("https://example.com/owner/Repo.GIT", "/tmp/runs");
  assert.equal(got, path.resolve("/tmp/runs", "Repo"));
});

test("deriveCloneDir — resolves relative parent path against cwd", () => {
  const got = deriveCloneDir("https://github.com/o/r", "runs");
  assert.equal(got, path.resolve("runs", "r"));
});

test("deriveCloneDir — accepts Windows-style parent path", () => {
  // path.resolve normalizes; on Windows it preserves the drive and backslashes,
  // on POSIX the backslash is just a character in a segment. Either way the repo
  // name must be appended.
  const got = deriveCloneDir("https://github.com/o/r", "C:\\Users\\x\\runs");
  assert.ok(got.endsWith("r"), `expected ${got} to end with "r"`);
});

test("deriveCloneDir — throws on unparseable URL", () => {
  assert.throws(() => deriveCloneDir("not a url", "/tmp/runs"), /invalid repo URL/);
});

test("deriveCloneDir — throws when URL has no path segment", () => {
  assert.throws(
    () => deriveCloneDir("https://github.com/", "/tmp/runs"),
    /cannot derive repo name/,
  );
});

test("deriveCloneDir — throws when last segment is just .git", () => {
  assert.throws(
    () => deriveCloneDir("https://github.com/owner/.git", "/tmp/runs"),
    /cannot derive repo name/,
  );
});
