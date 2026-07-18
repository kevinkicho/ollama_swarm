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
});
