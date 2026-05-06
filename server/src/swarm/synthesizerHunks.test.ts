import test from "node:test";
import assert from "node:assert";
import {
  buildSynthesizerHunksPrompt,
  parseSynthesizerHunks,
} from "./synthesizerHunks.js";
import type { Hunk } from "./blackboard/applyHunks.js";

test("buildSynthesizerHunksPrompt — directive and context included", () => {
  const prompt = buildSynthesizerHunksPrompt({
    directive: "Implement authentication middleware",
    fileListing: "src/auth.ts\nsrc/middleware.ts",
    discussionContext: "Agents agreed on JWT-based approach",
    relevantFiles: ["src/auth.ts", "src/middleware.ts"],
  });

  assert.ok(prompt.includes("Implement authentication middleware"));
  assert.ok(prompt.includes("JWT-based approach"));
  assert.ok(prompt.includes("src/auth.ts"));
  assert.ok(prompt.includes("Relevant Files"));
});

test("buildSynthesizerHunksPrompt — hunks JSON format shown", () => {
  const prompt = buildSynthesizerHunksPrompt({
    directive: "Add error handling",
    fileListing: "src/index.ts",
    discussionContext: "Use try-catch pattern",
  });

  assert.ok(prompt.includes('"hunks"'));
  assert.ok(prompt.includes('"op": "replace"'));
  assert.ok(prompt.includes('"search"'));
  assert.ok(prompt.includes('"replace"'));
});

test("parseSynthesizerHunks — valid hunks envelope", () => {
  const allowedFiles = new Set(["src/foo.ts", "src/bar.ts"]);
  const raw = JSON.stringify({
    hunks: [
      { op: "replace", file: "src/foo.ts", search: "old", replace: "new" },
      { op: "create", file: "src/bar.ts", content: "// new file" },
    ],
  });

  const result = parseSynthesizerHunks(raw, allowedFiles);

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.hunks.length, 2);
  assert.strictEqual(result.hunks[0]?.file, "src/foo.ts");
  assert.strictEqual(result.hunks[1]?.op, "create");
});

test("parseSynthesizerHunks — skip envelope", () => {
  const allowedFiles = new Set(["src/foo.ts"]);
  const raw = JSON.stringify({
    hunks: [],
    skip: "Not enough context to implement",
  });

  const result = parseSynthesizerHunks(raw, allowedFiles);

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.hunks.length, 0);
});

test("parseSynthesizerHunks — invalid JSON", () => {
  const allowedFiles = new Set(["src/foo.ts"]);
  const raw = "not valid json {";

  const result = parseSynthesizerHunks(raw, allowedFiles);

  assert.strictEqual(result.ok, false);
  assert.ok(result.reason?.includes("parse"));
});

test("parseSynthesizerHunks — file not in allowed set rejected", () => {
  const allowedFiles = new Set(["src/foo.ts"]);
  const raw = JSON.stringify({
    hunks: [{ op: "create", file: "/etc/passwd", content: "malicious" }],
  });

  const result = parseSynthesizerHunks(raw, allowedFiles);

  // parseWorkerResponse rejects files not in allowed set
  assert.strictEqual(result.ok, false);
  assert.ok(result.reason?.includes("file") || result.reason?.includes("not allowed"));
});

test("parseSynthesizerHunks — extracts from markdown fence", () => {
  const allowedFiles = new Set(["src/app.ts"]);
  const raw = `
Here are the hunks:

\`\`\`json
{
  "hunks": [{ "op": "replace", "file": "src/app.ts", "search": "old", "replace": "new" }]
}
\`\`\`
`;

  const result = parseSynthesizerHunks(raw, allowedFiles);

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.hunks.length, 1);
});