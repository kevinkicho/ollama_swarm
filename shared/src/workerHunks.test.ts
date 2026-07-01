import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tryParseWorkerHunks } from "./workerHunks";

describe("tryParseWorkerHunks", () => {
  it("returns null for empty input", () => {
    assert.equal(tryParseWorkerHunks(""), null);
    assert.equal(tryParseWorkerHunks("   "), null);
  });

  it("returns null for non-JSON input", () => {
    assert.equal(tryParseWorkerHunks("not json"), null);
    assert.equal(tryParseWorkerHunks("hello world"), null);
  });

  it("returns null for JSON without hunks array", () => {
    assert.equal(tryParseWorkerHunks("{}"), null);
    assert.equal(tryParseWorkerHunks('{"a": 1}'), null);
  });

  it("returns null for empty hunks array", () => {
    assert.equal(tryParseWorkerHunks('{"hunks": []}'), null);
  });

  it("returns null for JSON without a valid hunks field", () => {
    assert.equal(tryParseWorkerHunks('{"hunks": "not an array"}'), null);
    assert.equal(tryParseWorkerHunks('{"hunks": 123}'), null);
  });

  it("parses a valid replace hunk", () => {
    const r = tryParseWorkerHunks(JSON.stringify({
      hunks: [{ op: "replace", file: "a.ts", search: "old", replace: "new" }],
    }));
    assert.ok(r);
    assert.equal(r!.length, 1);
    assert.equal(r![0].op, "replace");
    assert.equal(r![0].file, "a.ts");
    assert.equal(r![0].search, "old");
    assert.equal(r![0].replace, "new");
  });

  it("parses a valid create hunk", () => {
    const r = tryParseWorkerHunks(JSON.stringify({
      hunks: [{ op: "create", file: "b.ts", content: "new content" }],
    }));
    assert.ok(r);
    assert.equal(r!.length, 1);
    assert.equal(r![0].op, "create");
    assert.equal(r![0].file, "b.ts");
    assert.equal(r![0].content, "new content");
  });

  it("parses a valid append hunk", () => {
    const r = tryParseWorkerHunks(JSON.stringify({
      hunks: [{ op: "append", file: "c.ts", content: "trailing stuff" }],
    }));
    assert.ok(r);
    assert.equal(r!.length, 1);
    assert.equal(r![0].op, "append");
    assert.equal(r![0].file, "c.ts");
    assert.equal(r![0].content, "trailing stuff");
  });

  it("parses multiple hunks of mixed types", () => {
    const r = tryParseWorkerHunks(JSON.stringify({
      hunks: [
        { op: "replace", file: "a.ts", search: "old", replace: "new" },
        { op: "create", file: "b.ts", content: "hello" },
        { op: "append", file: "c.ts", content: "world" },
      ],
    }));
    assert.ok(r);
    assert.equal(r!.length, 3);
    assert.equal(r![0].op, "replace");
    assert.equal(r![1].op, "create");
    assert.equal(r![2].op, "append");
  });

  it("skips hunks with missing op or file", () => {
    const r = tryParseWorkerHunks(JSON.stringify({
      hunks: [
        { file: "a.ts", search: "old", replace: "new" }, // missing op
        { op: "create", content: "hello" },              // missing file
        { op: "replace", file: "b.ts", search: "old", replace: "new" },
      ],
    }));
    assert.ok(r);
    assert.equal(r!.length, 1);
    assert.equal(r![0].file, "b.ts");
  });

  it("skips replace hunks missing search or replace", () => {
    const r = tryParseWorkerHunks(JSON.stringify({
      hunks: [
        { op: "replace", file: "a.ts", search: "old" },              // missing replace
        { op: "replace", file: "b.ts", replace: "new" },              // missing search
        { op: "replace", file: "c.ts", search: "old", replace: "new" },
      ],
    }));
    assert.ok(r);
    assert.equal(r!.length, 1);
    assert.equal(r![0].file, "c.ts");
  });

  it("skips create/append hunks missing content", () => {
    const r = tryParseWorkerHunks(JSON.stringify({
      hunks: [
        { op: "create", file: "a.ts" },                               // missing content
        { op: "append", file: "b.ts" },                                // missing content
        { op: "create", file: "c.ts", content: "present" },
      ],
    }));
    assert.ok(r);
    assert.equal(r!.length, 1);
    assert.equal(r![0].file, "c.ts");
  });

  it("handles JSON wrapped in ```json fences", () => {
    const r = tryParseWorkerHunks('```json\n{"hunks":[{"op":"create","file":"x.ts","content":"C"}]}\n```');
    assert.ok(r);
    assert.equal(r!.length, 1);
    assert.equal(r![0].op, "create");
  });

  it("handles JSON wrapped in bare ``` fences", () => {
    const r = tryParseWorkerHunks('```\n{"hunks":[{"op":"create","file":"x.ts","content":"C"}]}\n```');
    assert.ok(r);
    assert.equal(r!.length, 1);
    assert.equal(r![0].op, "create");
  });

  it("handles first-balanced JSON extraction (gemma4 hallucination pattern)", () => {
    const r = tryParseWorkerHunks('{"hunks":[{"op":"create","file":"x.ts","content":"C"}]}\nsome trailing junk\n{"fake": "stuff"}');
    assert.ok(r);
    assert.equal(r!.length, 1);
    assert.equal(r![0].file, "x.ts");
  });

  it("handles unknown op types gracefully", () => {
    const r = tryParseWorkerHunks(JSON.stringify({
      hunks: [
        { op: "weird_op", file: "a.ts", search: "old", replace: "new" },
        { op: "create", file: "b.ts", content: "valid" },
      ],
    }));
    assert.ok(r);
    assert.equal(r!.length, 1);
    assert.equal(r![0].op, "create");
  });

  it("skips null entries in hunks array", () => {
    const r = tryParseWorkerHunks(JSON.stringify({
      hunks: [null, { op: "create", file: "a.ts", content: "C" }, null],
    }));
    assert.ok(r);
    assert.equal(r!.length, 1);
  });

  it("handles non-object parsed result (JSON array)", () => {
    assert.equal(tryParseWorkerHunks("[1, 2, 3]"), null);
  });
});
