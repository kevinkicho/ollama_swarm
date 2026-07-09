import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseNameStatusDiff } from "./runDeliverables.js";

describe("parseNameStatusDiff", () => {
  it("classifies added and modified paths", () => {
    const d = parseNameStatusDiff("A\tsrc/new.ts\nM\tsrc/foo.ts\nD\tremoved.ts");
    assert.equal(d.length, 2);
    assert.deepEqual(d[0], { path: "src/new.ts", status: "created" });
    assert.deepEqual(d[1], { path: "src/foo.ts", status: "modified" });
  });

  it("caps at 50 entries", () => {
    const lines = Array.from({ length: 60 }, (_, i) => `M\tfile${i}.ts`).join("\n");
    assert.equal(parseNameStatusDiff(lines).length, 50);
  });
});