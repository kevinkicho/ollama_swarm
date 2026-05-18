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

test("buildJudgePrompt — single candidate, no description, empty expected files", () => {
  const candidates: JudgeCandidate[] = [
    { id: "h1", hunks: [{ op: "append", file: "x.ts", content: "hello" }], workerIds: ["w1"] },
  ];
  const prompt = buildJudgePrompt({ todoDescription: "", expectedFiles: [], candidates });
  assert.match(prompt, /code-review judge/i);
  assert.match(prompt, /1 candidate patch/);
});

test("buildJudgePrompt — mixed hunk types in one candidate", () => {
  const candidates: JudgeCandidate[] = [
    {
      id: "mx",
      hunks: [
        { op: "replace", file: "a.ts", search: "old1", replace: "new1" },
        { op: "create", file: "b.ts", content: "new file" },
        { op: "append", file: "c.ts", content: "appended" },
      ],
      workerIds: ["w1", "w2"],
    },
  ];
  const prompt = buildJudgePrompt({ todoDescription: "Mixed", expectedFiles: ["a.ts"], candidates });
  assert.match(prompt, /SEARCH:.+old1/s);
  assert.match(prompt, /REPLACE:.+new1/s);
  assert.match(prompt, /CONTENT:.+new file/s);
  assert.match(prompt, /CONTENT:.+appended/s);
});

test("buildJudgePrompt — multiple candidates with multiple hunks each", () => {
  const mkCandidate = (id: string, n: number): JudgeCandidate => ({
    id,
    hunks: Array.from({ length: n }, (_, i) => ({
      op: "replace" as const,
      file: `src/file${i}.ts`,
      search: `old${i}`,
      replace: `new${i}`,
    })),
    workerIds: [id],
  });
  const prompt = buildJudgePrompt({
    todoDescription: "Multi-hunk",
    expectedFiles: ["src/file0.ts", "src/file1.ts"],
    candidates: [mkCandidate("c1", 2), mkCandidate("c2", 2), mkCandidate("c3", 2)],
  });
  assert.match(prompt, /3 candidate patch/);
  assert.match(prompt, /Hunk 1: op=replace file=src\/file0\.ts/);
  assert.match(prompt, /Hunk 2: op=replace file=src\/file1\.ts/);
  assert.match(prompt, /\{"winner": N\} where N is the number \(1\.\.3\)/);
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

test("buildJudgePrompt — append hunk type", () => {
  const c: JudgeCandidate[] = [{ id: "a1", hunks: [{ op: "append", file: "x.ts", content: "c" }], workerIds: ["w1"] }];
  const p = buildJudgePrompt({ todoDescription: "t", expectedFiles: [], candidates: c });
  assert.match(p, /op=append/);
  assert.match(p, /CONTENT:/);
});

test("buildJudgePrompt — multiple hunks per candidate", () => {
  const c: JudgeCandidate[] = [{
    id: "m1", hunks: [
      { op: "replace", file: "a.ts", search: "old", replace: "new" },
      { op: "create", file: "b.ts", content: "hi" },
      { op: "append", file: "c.ts", content: "w" },
    ], workerIds: ["w1", "w2"],
  }];
  const p = buildJudgePrompt({ todoDescription: "m", expectedFiles: ["a.ts", "b.ts", "c.ts"], candidates: c });
  assert.match(p, /Hunk 1: op=replace/);
  assert.match(p, /Hunk 2: op=create/);
  assert.match(p, /Hunk 3: op=append/);
});

test("buildJudgePrompt — empty expected files", () => {
  const c: JudgeCandidate[] = [{ id: "e1", hunks: [{ op: "create", file: "x.ts", content: "x" }], workerIds: ["w1"] }];
  const p = buildJudgePrompt({ todoDescription: "no files", expectedFiles: [], candidates: c });
  assert.match(p, /Expected files:\s*$/m);
});

test("buildJudgePrompt — empty todo description", () => {
  const c: JudgeCandidate[] = [{ id: "e1", hunks: [{ op: "create", file: "x.ts", content: "x" }], workerIds: ["w1"] }];
  const p = buildJudgePrompt({ todoDescription: "", expectedFiles: ["x.ts"], candidates: c });
  assert.match(p, /TODO: \s*$/m);
});

test("buildJudgePrompt — many candidates numbering", () => {
  const mk = (id: string): JudgeCandidate => ({ id, hunks: [{ op: "create", file: `${id}.ts`, content: "c" }], workerIds: ["w"] });
  const p = buildJudgePrompt({ todoDescription: "many", expectedFiles: [], candidates: [mk("c1"), mk("c2"), mk("c3"), mk("c4"), mk("c5")] });
  assert.match(p, /Candidate 1/);
  assert.match(p, /Candidate 3/);
  assert.match(p, /Candidate 5/);
  assert.match(p, /\{"winner": N\} where N is the number \(1\.\.5\)/);
});

test("buildJudgePrompt — no SEARCH/REPLACE for non-replace hunks", () => {
  const c: JudgeCandidate[] = [{
    id: "nr", hunks: [{ op: "create", file: "a.ts", content: "a" }, { op: "append", file: "b.ts", content: "b" }], workerIds: ["w1"],
  }];
  const p = buildJudgePrompt({ todoDescription: "nr", expectedFiles: ["a.ts", "b.ts"], candidates: c });
  assert.doesNotMatch(p, /^\s*SEARCH:/m);
  assert.doesNotMatch(p, /^\s*REPLACE:/m);
});

test("buildJudgePrompt — handles append hunk type", () => {
  const candidates: JudgeCandidate[] = [
    {
      id: "a1",
      hunks: [{ op: "append", file: "src/x.ts", content: "append me\n" }],
      workerIds: ["w1"],
    },
  ];
  const prompt = buildJudgePrompt({
    todoDescription: "append test",
    expectedFiles: [],
    candidates,
  });
  assert.match(prompt, /op=append/);
  assert.match(prompt, /CONTENT:/);
});

test("buildJudgePrompt — handles multiple hunks per candidate", () => {
  const candidates: JudgeCandidate[] = [
    {
      id: "m1",
      hunks: [
        { op: "replace", file: "src/a.ts", search: "old", replace: "new" },
        { op: "create", file: "src/b.ts", content: "hello" },
        { op: "append", file: "src/c.ts", content: "world" },
      ],
      workerIds: ["w1", "w2"],
    },
  ];
  const prompt = buildJudgePrompt({
    todoDescription: "multi-hunk",
    expectedFiles: ["src/a.ts", "src/b.ts", "src/c.ts"],
    candidates,
  });
  assert.match(prompt, /Hunk 1: op=replace/);
  assert.match(prompt, /Hunk 2: op=create/);
  assert.match(prompt, /Hunk 3: op=append/);
});

test("buildJudgePrompt — handles empty expected files", () => {
  const candidates: JudgeCandidate[] = [
    { id: "e1", hunks: [{ op: "create", file: "x.ts", content: "x" }], workerIds: ["w1"] },
  ];
  const prompt = buildJudgePrompt({
    todoDescription: "no files",
    expectedFiles: [],
    candidates,
  });
  assert.match(prompt, /Expected files:\s*$/m);
});

test("buildJudgePrompt — handles empty todo description", () => {
  const candidates: JudgeCandidate[] = [
    { id: "e1", hunks: [{ op: "create", file: "x.ts", content: "x" }], workerIds: ["w1"] },
  ];
  const prompt = buildJudgePrompt({
    todoDescription: "",
    expectedFiles: ["x.ts"],
    candidates,
  });
  assert.match(prompt, /TODO: \s*$/m);
});

test("buildJudgePrompt — includes correct candidate numbering for many candidates", () => {
  const candidates: JudgeCandidate[] = [
    { id: "c1", hunks: [{ op: "create", file: "a.ts", content: "a" }], workerIds: ["wa"] },
    { id: "c2", hunks: [{ op: "create", file: "b.ts", content: "b" }], workerIds: ["wb"] },
    { id: "c3", hunks: [{ op: "create", file: "c.ts", content: "c" }], workerIds: ["wc"] },
    { id: "c4", hunks: [{ op: "create", file: "d.ts", content: "d" }], workerIds: ["wd"] },
    { id: "c5", hunks: [{ op: "create", file: "e.ts", content: "e" }], workerIds: ["we"] },
  ];
  const prompt = buildJudgePrompt({
    todoDescription: "many",
    expectedFiles: [],
    candidates,
  });
  assert.match(prompt, /Candidate 1/);
  assert.match(prompt, /Candidate 3/);
  assert.match(prompt, /Candidate 5/);
  assert.match(prompt, /\{"winner": N\} where N is the number \(1\.\.5\)/);
});

test("buildJudgePrompt — does not include SEARCH/REPLACE for non-replace hunks", () => {
  const candidates: JudgeCandidate[] = [
    {
      id: "nr1",
      hunks: [
        { op: "create" as const, file: "a.ts", content: "a" },
        { op: "append" as const, file: "b.ts", content: "b" },
      ],
      workerIds: ["w1"],
    },
  ];
  const prompt = buildJudgePrompt({
    todoDescription: "no replace",
    expectedFiles: ["a.ts", "b.ts"],
    candidates,
  });
  assert.doesNotMatch(prompt, /^\s*SEARCH:/m);
  assert.doesNotMatch(prompt, /^\s*REPLACE:/m);
});
