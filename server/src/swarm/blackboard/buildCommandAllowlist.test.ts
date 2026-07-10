import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkBuildCommand, listAllowedBinaries } from "./buildCommandAllowlist.js";

describe("checkBuildCommand — permissive shell policy (2026-07-10)", () => {
  it("accepts a simple `npm test` invocation", () => {
    const r = checkBuildCommand("npm test");
    assert.equal(r.ok, true);
    assert.equal(r.binary, "npm");
  });

  it("accepts `cd … && head …` chaining", () => {
    const r = checkBuildCommand(
      "cd C:\\Users\\kevin\\workspace\\repo && head -30 data/file.md",
    );
    assert.equal(r.ok, true);
  });

  it("accepts pipes and redirection", () => {
    assert.equal(checkBuildCommand("npm test | head -5").ok, true);
    assert.equal(checkBuildCommand("npm test > out.txt").ok, true);
  });

  it("accepts curl / sh and other binaries", () => {
    assert.equal(checkBuildCommand("curl https://example.com").ok, true);
    assert.equal(checkBuildCommand("sh -c 'echo hi'").ok, true);
  });

  it("rejects empty / whitespace-only commands", () => {
    assert.equal(checkBuildCommand("").ok, false);
    assert.equal(checkBuildCommand("   \t\n  ").ok, false);
  });

  it("listAllowedBinaries still returns legacy snapshot", () => {
    const list = listAllowedBinaries();
    assert.ok(list.includes("npm"));
    assert.ok(list.includes("python"));
  });
});
