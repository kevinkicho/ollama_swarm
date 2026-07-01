// 2026-05-02 (blackboard feature #3): diff-aware critic tests.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseDiffAddedLines,
  detectAntiPatterns,
  formatAntiPatternsMarkdown,
} from "./diffCritic.js";

const SAMPLE_DIFF = `diff --git a/src/auth.ts b/src/auth.ts
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -10,5 +10,8 @@ export function login(user, pass) {
   if (!user) throw new Error("no user");
   if (!pass) throw new Error("no pass");
+  console.log("login attempt", user);
+  // TODO: rate limit this
   const session = createSession(user);
   return session;
 }
diff --git a/src/test.spec.ts b/src/test.spec.ts
--- a/src/test.spec.ts
+++ b/src/test.spec.ts
@@ -5,3 +5,5 @@ describe("auth", () => {
   it("rejects empty user", () => {
     expect(() => login("", "x")).toThrow();
   });
+  it("works with valid input", () => {});
 });`;

describe("parseDiffAddedLines", () => {
  it("extracts added lines per file with correct line numbers", () => {
    const out = parseDiffAddedLines(SAMPLE_DIFF);
    const authLines = out.filter((e) => e.file === "src/auth.ts");
    assert.ok(authLines.length >= 2, "should extract auth.ts additions");
    const consoleLog = authLines.find((l) => l.text.includes("console.log"));
    assert.ok(consoleLog, "console.log line must be captured");
    const todo = authLines.find((l) => l.text.includes("TODO"));
    assert.ok(todo, "TODO line must be captured");
  });

  it("does not capture removed (-) lines or unchanged context", () => {
    const out = parseDiffAddedLines(
      "diff --git a/x b/x\n@@ -1 +1,3 @@\n+added\n-removed\n unchanged",
    );
    assert.equal(out.length, 1);
    assert.match(out[0].text, /\+added/);
  });

  it("returns empty for empty input", () => {
    assert.deepEqual(parseDiffAddedLines(""), []);
  });
});

describe("detectAntiPatterns", () => {
  it("flags console.log as LOW severity debug-print", () => {
    const findings = detectAntiPatterns(SAMPLE_DIFF);
    const consoleFinding = findings.find((f) => f.pattern === "debug-print");
    assert.ok(consoleFinding);
    assert.equal(consoleFinding!.severity, "low");
    assert.equal(consoleFinding!.file, "src/auth.ts");
  });

  it("flags TODO comments as LOW self-added-todo", () => {
    const findings = detectAntiPatterns(SAMPLE_DIFF);
    const todoFinding = findings.find((f) => f.pattern === "self-added-todo");
    assert.ok(todoFinding);
    assert.equal(todoFinding!.severity, "low");
  });

  it("flags empty test blocks in test files", () => {
    const findings = detectAntiPatterns(SAMPLE_DIFF);
    const emptyTest = findings.find((f) => f.pattern === "test-no-expect");
    assert.ok(emptyTest);
    assert.equal(emptyTest!.severity, "medium");
    assert.match(emptyTest!.file, /\.spec\.ts$/);
  });

  it("does NOT flag console.log inside test files (excluded)", () => {
    const testDiff = `diff --git a/foo.test.ts b/foo.test.ts
--- a/foo.test.ts
+++ b/foo.test.ts
@@ -1 +1,2 @@
+console.log("debug from test")
 done`;
    const findings = detectAntiPatterns(testDiff);
    assert.equal(findings.filter((f) => f.pattern === "debug-print").length, 0);
  });

  it("flags lint-suppression patterns", () => {
    const diff = `diff --git a/src/x.ts b/src/x.ts
--- a/src/x.ts
+++ b/src/x.ts
@@ -1 +1,2 @@
+// eslint-disable-next-line
 done`;
    const findings = detectAntiPatterns(diff);
    const f = findings.find((f) => f.pattern === "lint-suppression");
    assert.ok(f);
    assert.equal(f!.severity, "high");
  });

  it("flags `as any` casts in TS files", () => {
    const diff = `diff --git a/src/x.ts b/src/x.ts
--- a/src/x.ts
+++ b/src/x.ts
@@ -1 +1,2 @@
+const result = parseUnknown(input) as any;
 done`;
    const findings = detectAntiPatterns(diff);
    assert.ok(findings.some((f) => f.pattern === "any-cast"));
  });

  it("flags hardcoded secrets", () => {
    const diff = `diff --git a/cfg.ts b/cfg.ts
--- a/cfg.ts
+++ b/cfg.ts
@@ -1 +1,2 @@
+const API_KEY = "PLACEHOLDER_FAKE_VALUE_FOR_TEST_ONLY";
 done`;
    const findings = detectAntiPatterns(diff);
    const f = findings.find((f) => f.pattern === "hardcoded-secret");
    assert.ok(f);
    assert.equal(f!.severity, "high");
  });

  it("returns empty for clean diff", () => {
    const cleanDiff = `diff --git a/src/x.ts b/src/x.ts
--- a/src/x.ts
+++ b/src/x.ts
@@ -1 +1,2 @@
+export function add(a: number, b: number): number { return a + b; }
 done`;
    const findings = detectAntiPatterns(cleanDiff);
    assert.equal(findings.length, 0);
  });

  it("sorts findings by severity (high first)", () => {
    const findings = detectAntiPatterns(SAMPLE_DIFF);
    if (findings.length >= 2) {
      const severities = findings.map((f) => f.severity);
      const sevOrder = { high: 0, medium: 1, low: 2 };
      for (let i = 1; i < severities.length; i++) {
        assert.ok(
          sevOrder[severities[i - 1]] <= sevOrder[severities[i]],
          `out of order at index ${i}: ${severities.join(",")}`,
        );
      }
    }
  });
});

describe("formatAntiPatternsMarkdown", () => {
  it("renders empty-state placeholder", () => {
    assert.match(formatAntiPatternsMarkdown([]), /no anti-patterns/i);
  });

  it("groups by severity bucket", () => {
    const md = formatAntiPatternsMarkdown([
      { file: "a.ts", line: 5, pattern: "debug-print", severity: "high", message: "msg" },
      { file: "b.ts", line: 2, pattern: "self-added-todo", severity: "medium", message: "msg" },
    ]);
    assert.match(md, /\*\*HIGH severity \(1\):\*\*/);
    assert.match(md, /\*\*MEDIUM severity \(1\):\*\*/);
    assert.match(md, /a\.ts:5/);
    assert.match(md, /b\.ts:2/);
  });
});
