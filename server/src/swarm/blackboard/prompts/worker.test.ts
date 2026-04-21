import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { parseWorkerResponse, type WorkerParseResult } from "./worker.js";

function expectOk(
  r: WorkerParseResult,
): asserts r is Extract<WorkerParseResult, { ok: true }> {
  if (!r.ok) assert.fail(`expected ok, got: ${r.reason}`);
}

function expectErr(r: WorkerParseResult, pattern: RegExp): void {
  if (r.ok) assert.fail(`expected error matching ${pattern}, got ok`);
  assert.match(r.reason, pattern);
}

describe("parseWorkerResponse — happy paths", () => {
  it("parses a single-file diff", () => {
    const raw = JSON.stringify({
      diffs: [{ file: "src/index.ts", newText: "export const x = 1;\n" }],
    });
    const r = parseWorkerResponse(raw, ["src/index.ts"]);
    expectOk(r);
    assert.equal(r.diffs.length, 1);
    assert.equal(r.diffs[0].file, "src/index.ts");
    assert.equal(r.diffs[0].newText, "export const x = 1;\n");
    assert.equal(r.skip, undefined);
  });

  it("parses a two-file diff", () => {
    const raw = JSON.stringify({
      diffs: [
        { file: "a.ts", newText: "a" },
        { file: "b.ts", newText: "b" },
      ],
    });
    const r = parseWorkerResponse(raw, ["a.ts", "b.ts"]);
    expectOk(r);
    assert.equal(r.diffs.length, 2);
  });

  it("accepts a skip response with empty diffs", () => {
    const raw = JSON.stringify({ diffs: [], skip: "already implemented" });
    const r = parseWorkerResponse(raw, ["whatever.ts"]);
    expectOk(r);
    assert.equal(r.diffs.length, 0);
    assert.equal(r.skip, "already implemented");
  });

  it("strips ```json fences", () => {
    const raw = '```json\n{"diffs":[{"file":"a.ts","newText":"x"}]}\n```';
    const r = parseWorkerResponse(raw, ["a.ts"]);
    expectOk(r);
    assert.equal(r.diffs.length, 1);
  });

  it("extracts object from surrounding prose", () => {
    const raw = 'Here you go: {"diffs":[{"file":"a.ts","newText":"x"}]} — let me know.';
    const r = parseWorkerResponse(raw, ["a.ts"]);
    expectOk(r);
    assert.equal(r.diffs.length, 1);
  });

  it("allows newText to be the empty string", () => {
    // Worker saying "make this file empty" — legal. Runner decides whether to
    // allow it at write time (Phase 5 rejects; Phase 4 just logs).
    const raw = JSON.stringify({ diffs: [{ file: "empty.ts", newText: "" }] });
    const r = parseWorkerResponse(raw, ["empty.ts"]);
    expectOk(r);
    assert.equal(r.diffs[0].newText, "");
  });
});

describe("parseWorkerResponse — rejections", () => {
  it("rejects malformed JSON", () => {
    const r = parseWorkerResponse("{not valid", ["a.ts"]);
    expectErr(r, /JSON parse failed/);
  });

  it("rejects a top-level array instead of object", () => {
    const raw = JSON.stringify([{ file: "a.ts", newText: "x" }]);
    const r = parseWorkerResponse(raw, ["a.ts"]);
    expectErr(r, /expected object|diffs/i);
  });

  it("rejects missing `diffs` field", () => {
    const raw = JSON.stringify({ skip: "why" });
    const r = parseWorkerResponse(raw, ["a.ts"]);
    expectErr(r, /diffs/);
  });

  it("rejects more than 2 diffs", () => {
    const raw = JSON.stringify({
      diffs: [
        { file: "a.ts", newText: "x" },
        { file: "b.ts", newText: "y" },
        { file: "c.ts", newText: "z" },
      ],
    });
    const r = parseWorkerResponse(raw, ["a.ts", "b.ts", "c.ts"]);
    expectErr(r, /diffs/);
  });

  it("rejects a diff whose file is not in expectedFiles", () => {
    const raw = JSON.stringify({
      diffs: [{ file: "not-allowed.ts", newText: "x" }],
    });
    const r = parseWorkerResponse(raw, ["allowed.ts"]);
    expectErr(r, /not in expectedFiles/);
  });

  it("rejects duplicate diff files", () => {
    const raw = JSON.stringify({
      diffs: [
        { file: "a.ts", newText: "first" },
        { file: "a.ts", newText: "second" },
      ],
    });
    const r = parseWorkerResponse(raw, ["a.ts"]);
    expectErr(r, /duplicate/);
  });

  it("rejects a diff with blank file path", () => {
    const raw = JSON.stringify({
      diffs: [{ file: "  ", newText: "x" }],
    });
    const r = parseWorkerResponse(raw, ["a.ts"]);
    // Empty trim => min(1) fails, so the error is a schema issue.
    assert.equal(r.ok, false);
  });
});
