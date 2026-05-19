import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bumpAgentCounter, countNewlines, checkExpectedSymbols } from "./runnerHelpers.js";

describe("bumpAgentCounter", () => {
  it("increments an existing counter", () => {
    const m = new Map<string, number>();
    m.set("agent-1", 5);
    bumpAgentCounter(m, "agent-1");
    assert.equal(m.get("agent-1"), 6);
  });

  it("initializes a missing key to 1", () => {
    const m = new Map<string, number>();
    bumpAgentCounter(m, "agent-3");
    assert.equal(m.get("agent-3"), 1);
  });

  it("handles empty map", () => {
    const m = new Map<string, number>();
    bumpAgentCounter(m, "fresh");
    assert.equal(m.get("fresh"), 1);
  });

  it("increments distinct keys independently", () => {
    const m = new Map<string, number>();
    bumpAgentCounter(m, "a");
    bumpAgentCounter(m, "b");
    bumpAgentCounter(m, "a");
    bumpAgentCounter(m, "a");
    assert.equal(m.get("a"), 3);
    assert.equal(m.get("b"), 1);
  });
});

describe("countNewlines", () => {
  it("returns 0 for empty string", () => {
    assert.equal(countNewlines(""), 0);
  });

  it("returns 1 for single line without newline", () => {
    assert.equal(countNewlines("hello"), 1);
  });

  it("returns 2 for two lines", () => {
    assert.equal(countNewlines("line1\nline2"), 2);
  });

  it("returns 2 for two lines with trailing newline", () => {
    assert.equal(countNewlines("line1\nline2\n"), 2);
  });

  it("returns 0 for a bare newline", () => {
    assert.equal(countNewlines("\n"), 0);
  });

  it("returns 5 for five lines", () => {
    assert.equal(countNewlines("a\nb\nc\nd\ne"), 5);
  });

  it("handles windows-style line endings", () => {
    assert.equal(countNewlines("a\r\nb\r\nc"), 3);
  });

  it("counts empty-line separated strings as N+1 (trailing-newline stripped only once)", () => {
    assert.equal(countNewlines("\n\n\n"), 3);
  });

  it("handles trailing newline followed by content", () => {
    assert.equal(countNewlines("a\n\nb"), 3);
  });
});

describe("checkExpectedSymbols", () => {
  let workdir: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "runner-helpers-"));
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it("returns ok=true when expectedSymbols is empty", async () => {
    const result = await checkExpectedSymbols(
      { description: "add feature", expectedFiles: ["src/app.ts"], expectedSymbols: [] },
      workdir,
    );
    assert.ok(result.ok);
  });

  it("returns ok=true when expectedSymbols is undefined", async () => {
    const result = await checkExpectedSymbols(
      { description: "add feature", expectedFiles: ["src/app.ts"] },
      workdir,
    );
    assert.ok(result.ok);
  });

  it("returns ok=true when no expectedFiles exist (pure create todo)", async () => {
    const result = await checkExpectedSymbols(
      {
        description: "create new file",
        expectedFiles: ["nonexistent.ts"],
        expectedSymbols: ["SomeClass"],
      },
      workdir,
    );
    assert.ok(result.ok);
  });

  it("finds a symbol when it exists in the expected file", async () => {
    writeFileSync(join(workdir, "app.ts"), "export function createUser() { return {}; }");
    const result = await checkExpectedSymbols(
      {
        description: "fix createUser",
        expectedFiles: ["app.ts"],
        expectedSymbols: ["createUser"],
      },
      workdir,
    );
    assert.ok(result.ok);
  });

  it("finds a symbol in any of multiple expectedFiles", async () => {
    writeFileSync(join(workdir, "a.ts"), "// nothing");
    writeFileSync(join(workdir, "b.ts"), "export class MyClass {}");
    const result = await checkExpectedSymbols(
      {
        description: "fix MyClass",
        expectedFiles: ["a.ts", "b.ts"],
        expectedSymbols: ["MyClass"],
      },
      workdir,
    );
    assert.ok(result.ok);
  });

  it("returns missing list when symbol not found in any file", async () => {
    writeFileSync(join(workdir, "app.ts"), "function helper() {}");
    const result = await checkExpectedSymbols(
      {
        description: "fix nonexistent",
        expectedFiles: ["app.ts"],
        expectedSymbols: ["nonexistent"],
      },
      workdir,
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.missing.length, 1);
      assert.equal(result.missing[0].symbol, "nonexistent");
    }
  });

  it("uses word-boundary matching (no partial matches)", async () => {
    writeFileSync(join(workdir, "data.ts"), "const userDataLoad = () => {};");
    const result = await checkExpectedSymbols(
      {
        description: "find userData",
        expectedFiles: ["data.ts"],
        expectedSymbols: ["userData"],
      },
      workdir,
    );
    // "userData" should NOT match "userDataLoad" due to word boundary
    assert.equal(result.ok, false);
  });

  it("finds exact word-boundary match", async () => {
    writeFileSync(join(workdir, "data.ts"), "const userData = 42;");
    const result = await checkExpectedSymbols(
      {
        description: "find userData",
        expectedFiles: ["data.ts"],
        expectedSymbols: ["userData"],
      },
      workdir,
    );
    assert.ok(result.ok);
  });

  it("reports all missing symbols", async () => {
    writeFileSync(join(workdir, "x.ts"), "// empty file");
    const result = await checkExpectedSymbols(
      {
        description: "check multiple",
        expectedFiles: ["x.ts"],
        expectedSymbols: ["a", "b", "c"],
      },
      workdir,
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.missing.length, 3);
    }
  });

  it("escapes regex special characters in symbol names (dot, parens, etc)", async () => {
    writeFileSync(join(workdir, "ops.ts"), "function foo.bar() { return null; } // (special chars)");
    const result = await checkExpectedSymbols(
      {
        description: "check special",
        expectedFiles: ["ops.ts"],
        expectedSymbols: ["foo.bar"],
      },
      workdir,
    );
    // "foo.bar" is properly escaped (\.) and should match as a word-boundary pattern
    assert.ok(result.ok);
  });

  it("skips non-existent files silently", async () => {
    writeFileSync(join(workdir, "exists.ts"), "class RealClass {}");
    const result = await checkExpectedSymbols(
      {
        description: "check mixed",
        expectedFiles: ["nonexistent1.ts", "exists.ts", "nonexistent2.ts"],
        expectedSymbols: ["RealClass"],
      },
      workdir,
    );
    assert.ok(result.ok);
  });
});
