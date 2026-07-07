import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  detectTodoBatchFileOverlaps,
  hasActiveFileConflict,
} from "./workerFileConflict.js";

describe("workerFileConflict", () => {
  it("detects overlap with in-progress todo", () => {
    assert.equal(
      hasActiveFileConflict(
        ["src/a.ts"],
        [{ id: "t1", expectedFiles: ["src/a.ts", "src/b.ts"] }],
      ),
      true,
    );
    assert.equal(
      hasActiveFileConflict(
        ["src/c.ts"],
        [{ id: "t1", expectedFiles: ["src/a.ts"] }],
      ),
      false,
    );
  });

  it("detects batch overlaps for planner provisioning", () => {
    const overlaps = detectTodoBatchFileOverlaps([
      { description: "todo A", expectedFiles: ["src/x.ts"] },
      { description: "todo B", expectedFiles: ["src/x.ts", "src/y.ts"] },
    ]);
    assert.equal(overlaps.length, 1);
    assert.equal(overlaps[0]!.file, "src/x.ts");
    assert.equal(overlaps[0]!.todoIds.length, 2);
  });
});