import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tryParseWorkerHunks } from "./workerHunks.js";

describe("tryParseWorkerHunks", () => {
  it("parses replace_between with null endExclusive", () => {
    const raw = JSON.stringify({
      hunks: [
        {
          op: "replace_between",
          file: "tests/ui.spec.js",
          start: "test.beforeEach",
          endExclusive: null,
          replace: "test.beforeEach(async () => {})",
        },
      ],
    });
    const h = tryParseWorkerHunks(raw);
    assert.ok(h);
    assert.equal(h![0]!.op, "replace_between");
    assert.equal(h![0]!.endExclusive, undefined);
  });

  it("parses fenced hunks JSON", () => {
    const raw =
      '```json\n{"hunks":[{"op":"replace","file":"a.ts","search":"x","replace":"y"}]}\n```';
    const h = tryParseWorkerHunks(raw);
    assert.ok(h);
    assert.equal(h![0]!.op, "replace");
  });

  it("salvages broken JSON with unescaped quotes in search body", () => {
    // Invalid JSON: unescaped " inside search value
    const raw =
      '{"hunks":[{"op":"replace","file":"a.ts","search":"return { "ok": false }","replace":"x"}]}';
    const h = tryParseWorkerHunks(raw);
    assert.ok(h);
    assert.equal(h![0]!.file, "a.ts");
    assert.equal(h![0]!.op, "replace");
  });

  it("salvages raw newlines + extract op/file for display", () => {
    const raw =
      '{"hunks":[{"op":"create","file":"b.ts","content":"line1\nline2 with "quote"\n"}]}';
    const h = tryParseWorkerHunks(raw);
    assert.ok(h);
    assert.equal(h![0]!.op, "create");
    assert.equal(h![0]!.file, "b.ts");
  });
});
