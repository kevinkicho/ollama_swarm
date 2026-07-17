import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyOrGroundedRepair } from "./applyOrGroundedRepair.js";
import type { Hunk } from "./blackboard/applyHunks.js";

describe("applyOrGroundedRepair", () => {
  it("succeeds without repair when hunks apply", async () => {
    const hunks: Hunk[] = [
      { op: "replace", file: "a.ts", search: "foo", replace: "bar" },
    ];
    const r = await applyOrGroundedRepair({
      hunks,
      currentTextsByFile: { "a.ts": "hello foo\n" },
      expectedFiles: ["a.ts"],
      callModel: async () => {
        throw new Error("should not call model");
      },
    });
    assert.equal(r.ok, true);
    assert.equal(r.repaired, false);
    assert.equal(r.newTextsByFile?.["a.ts"], "hello bar\n");
  });

  it("repairs search miss when model returns unique search", async () => {
    const file = "alpha beta gamma\n";
    const bad: Hunk[] = [
      { op: "replace", file: "a.ts", search: "ALPHA BETA", replace: "ALPHA X" },
    ];
    const goodJson = JSON.stringify({
      hunks: [
        { op: "replace", file: "a.ts", search: "alpha beta", replace: "alpha X" },
      ],
    });
    const r = await applyOrGroundedRepair({
      hunks: bad,
      currentTextsByFile: { "a.ts": file },
      expectedFiles: ["a.ts"],
      callModel: async () => goodJson,
    });
    assert.equal(r.ok, true);
    assert.equal(r.repaired, true);
    assert.equal(r.repairAttempts, 1);
    assert.match(r.newTextsByFile?.["a.ts"] ?? "", /alpha X/);
  });

  it("fails closed when repair cannot fix", async () => {
    const r = await applyOrGroundedRepair({
      hunks: [
        { op: "replace", file: "a.ts", search: "missing", replace: "x" },
      ],
      currentTextsByFile: { "a.ts": "hello\n" },
      expectedFiles: ["a.ts"],
      callModel: async () =>
        JSON.stringify({
          hunks: [
            { op: "replace", file: "a.ts", search: "still missing", replace: "x" },
          ],
        }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.repaired, false);
    assert.ok((r.repairAttempts ?? 0) >= 1);
  });
});
