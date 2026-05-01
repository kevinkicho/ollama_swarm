import { test } from "node:test";
import assert from "node:assert/strict";
import { buildJudgePrompt } from "./hunkJudgePrompt.js";
import type { JudgeCandidate } from "./hunkVoting.js";

test("buildJudgePrompt — includes the TODO + expected files + N candidates + JSON-only reply instruction", () => {
  const candidates: JudgeCandidate[] = [
    {
      id: "h1",
      hunks: [{ op: "replace", file: "src/x.ts", search: "old", replace: "new" }],
      workerIds: ["w1", "w2"],
    },
    {
      id: "h2",
      hunks: [{ op: "replace", file: "src/x.ts", search: "old", replace: "different" }],
      workerIds: ["w3"],
    },
  ];
  const prompt = buildJudgePrompt({
    todoDescription: "Fix the off-by-one in countDown",
    expectedFiles: ["src/countdown.js"],
    candidates,
  });
  assert.match(prompt, /code-review judge/i);
  assert.match(prompt, /Fix the off-by-one in countDown/);
  assert.match(prompt, /Expected files: src\/countdown\.js/);
  assert.match(prompt, /Candidate 1 \(proposed by 2 worker\(s\): w1, w2\)/);
  assert.match(prompt, /Candidate 2 \(proposed by 1 worker\(s\): w3\)/);
  assert.match(prompt, /SEARCH:/);
  assert.match(prompt, /REPLACE:/);
  assert.match(prompt, /\{"winner": N\} where N is the number \(1\.\.2\)/);
});

test("buildJudgePrompt — handles create + append hunks (content field, not search/replace)", () => {
  const candidates: JudgeCandidate[] = [
    {
      id: "c1",
      hunks: [{ op: "create", file: "src/new.ts", content: "export const x = 1;\n" }],
      workerIds: ["w1"],
    },
  ];
  const prompt = buildJudgePrompt({
    todoDescription: "Create a new module",
    expectedFiles: ["src/new.ts"],
    candidates,
  });
  assert.match(prompt, /CONTENT:/);
  assert.match(prompt, /export const x = 1;/);
  // SEARCH/REPLACE shouldn't appear for create/append hunks
  assert.doesNotMatch(prompt, /^\s*SEARCH:/m);
});

test("buildJudgePrompt — truncates very long search/replace text", () => {
  const longText = "X".repeat(2000);
  const candidates: JudgeCandidate[] = [
    {
      id: "h1",
      hunks: [{ op: "replace", file: "src/x.ts", search: longText, replace: "y" }],
      workerIds: ["w1"],
    },
  ];
  const prompt = buildJudgePrompt({
    todoDescription: "test",
    expectedFiles: ["src/x.ts"],
    candidates,
  });
  // The X-fill should be truncated to 800 chars per slice; assert it's
  // bounded.
  const xCount = (prompt.match(/X/g) ?? []).length;
  assert.ok(xCount <= 800, `X-fill not truncated: ${xCount}`);
});
