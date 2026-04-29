import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBaselinePrompt, applyBaselineHunks } from "./BaselineRunner.js";
import type { Hunk } from "./blackboard/applyHunks.js";

test("buildBaselinePrompt — directive appears verbatim", () => {
  const out = buildBaselinePrompt({
    directive: "Fix the off-by-one in countDown.",
    repoFiles: ["src/main.ts", "package.json"],
    readme: null,
  });
  assert.match(out, /DIRECTIVE: Fix the off-by-one in countDown\./);
});

test("buildBaselinePrompt — file list rendered as bullet entries", () => {
  const out = buildBaselinePrompt({
    directive: "Add a comment.",
    repoFiles: ["src/main.ts", "src/util.ts"],
    readme: null,
  });
  assert.match(out, /Repo files \(top 50\):\n {2}src\/main\.ts\n {2}src\/util\.ts/);
});

test("buildBaselinePrompt — README truncated to 2000 chars", () => {
  const longReadme = "Z".repeat(5000);
  const out = buildBaselinePrompt({
    directive: "Make a change.",
    repoFiles: ["a.txt"],
    readme: longReadme,
  });
  // Body should contain at most 2000 Z's contiguously
  const match = out.match(/Z+/);
  assert.ok(match);
  assert.equal(match[0].length, 2000);
});

test("buildBaselinePrompt — schema instructions present", () => {
  const out = buildBaselinePrompt({ directive: "x", repoFiles: [], readme: null });
  assert.match(out, /\{"hunks": \[ \.\.\.search\/replace hunks \]\}/);
  assert.match(out, /Output ONLY the JSON/);
});

test("applyBaselineHunks — applies replace hunk to existing file", async () => {
  const reads = new Map<string, string>([["src/a.ts", "const x = 1;"]]);
  const writes: Array<{ file: string; content: string }> = [];
  const hunks: Hunk[] = [
    { op: "replace", file: "src/a.ts", search: "const x = 1;", replace: "const x = 2;" },
  ];
  const result = await applyBaselineHunks({
    hunks,
    fs: {
      read: async (f) => reads.get(f) ?? null,
      write: async (f, c) => {
        writes.push({ file: f, content: c });
      },
    },
  });
  assert.equal(result.applied, 1);
  assert.equal(result.reasons.length, 0);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].content, "const x = 2;");
});

test("applyBaselineHunks — failed hunk records reason and skips write", async () => {
  const hunks: Hunk[] = [
    { op: "replace", file: "src/a.ts", search: "MISSING", replace: "x" },
  ];
  const result = await applyBaselineHunks({
    hunks,
    fs: {
      read: async () => "const x = 1;",
      write: async () => {
        throw new Error("write should not be called when hunk fails");
      },
    },
  });
  assert.equal(result.applied, 0);
  assert.equal(result.reasons.length, 1);
  assert.match(result.reasons[0], /src\/a\.ts/);
});

test("applyBaselineHunks — multiple hunks against same file batched in one read/write", async () => {
  let readCalls = 0;
  let writeCalls = 0;
  const reads = new Map<string, string>([["src/a.ts", "alpha\nbeta\ngamma"]]);
  const hunks: Hunk[] = [
    { op: "replace", file: "src/a.ts", search: "alpha", replace: "AAA" },
    { op: "replace", file: "src/a.ts", search: "gamma", replace: "GGG" },
  ];
  const result = await applyBaselineHunks({
    hunks,
    fs: {
      read: async (f) => {
        readCalls += 1;
        return reads.get(f) ?? null;
      },
      write: async () => {
        writeCalls += 1;
      },
    },
  });
  assert.equal(result.applied, 2);
  assert.equal(readCalls, 1);
  assert.equal(writeCalls, 1);
});
