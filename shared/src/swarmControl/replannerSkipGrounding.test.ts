import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluateReplannerSkip } from "./replannerSkipGrounding.js";

describe("evaluateReplannerSkip", () => {
  it("blocks already-done skip when files missing", () => {
    const v = evaluateReplannerSkip({
      reason: "work appears to have been completed by another agent",
      expectedFiles: ["src/components/Foo.jsx"],
      fileContents: { "src/components/Foo.jsx": null },
      unmetCriteriaCount: 3,
    });
    assert.equal(v.allow, false);
  });

  it("blocks out-of-scope test waiver with unmet criteria", () => {
    const v = evaluateReplannerSkip({
      reason: "tests not needed for the current objective",
      expectedFiles: ["src/__tests__/Foo.test.jsx"],
      fileContents: { "src/__tests__/Foo.test.jsx": null },
      unmetCriteriaCount: 2,
    });
    assert.equal(v.allow, false);
  });

  it("allows skip when files exist and reason is substantive", () => {
    const v = evaluateReplannerSkip({
      reason: "duplicate of todo t4 — same file already committed in c2a1f9",
      expectedFiles: ["README.md"],
      fileContents: { "README.md": "# ok" },
      unmetCriteriaCount: 0,
    });
    assert.equal(v.allow, true);
  });
});