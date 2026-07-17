import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mergeAnchorsForTodo } from "./mergeAnchors.js";

describe("mergeAnchorsForTodo", () => {
  it("merges planner, description quotes, and file keywords", () => {
    const file = [
      "## Interest Rates",
      "export const FRED = 1;",
      "## Demographics",
      "export const census = 2;",
    ].join("\n");
    const anchors = mergeAnchorsForTodo({
      todoDescription: 'Update "Interest Rates" section for Demographics panel',
      expectedAnchors: ["## Interest Rates"],
      fileContents: { "src/data/panelRegistry.js": file },
      expectedFiles: ["src/data/panelRegistry.js"],
    });
    assert.ok(anchors.includes("## Interest Rates"));
    assert.ok(anchors.some((a) => /Interest Rates|Demographics/i.test(a)));
  });

  it("dedupes and caps", () => {
    const anchors = mergeAnchorsForTodo({
      todoDescription: '"A" "A" "B"',
      expectedAnchors: ["A", "A"],
      fileContents: { f: "A\nB\n".repeat(100) },
      expectedFiles: ["f"],
      maxAnchors: 2,
    });
    assert.equal(new Set(anchors).size, anchors.length);
    assert.ok(anchors.length <= 2);
  });
});
