import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyPath, classifyExpectedFiles } from "./pathValidation.js";

const REPO_FILES = [
  "README.md",
  "package.json",
  "tsconfig.json",
  "src/brain/brain.ts",
  "src/brain/brain.test.ts",
  "src/supervisor/supervisor.ts",
  "src/token-tracker.ts",
  "src/task-queue.ts",
  "src/launcher.ts",
  "src/team-manager.ts",
  "KNOWN_LIMITATIONS.md",
];

describe("classifyPath — existing", () => {
  it("returns 'existing' for a verbatim match at root", () => {
    assert.equal(classifyPath("README.md", REPO_FILES), "existing");
    assert.equal(classifyPath("KNOWN_LIMITATIONS.md", REPO_FILES), "existing");
  });

  it("returns 'existing' for a verbatim match nested", () => {
    assert.equal(classifyPath("src/brain/brain.ts", REPO_FILES), "existing");
  });
});

describe("classifyPath — plausible-new (parent dir exists)", () => {
  it("accepts a new file at repo root", () => {
    assert.equal(classifyPath("CONTRIBUTING.md", REPO_FILES), "plausible-new");
  });

  it("accepts a colocated test next to source (v8-style: src/brain/brain.test.ts was new there)", () => {
    // Repo has src/supervisor/supervisor.ts — a new colocated supervisor.test.ts
    // should be plausible.
    assert.equal(
      classifyPath("src/supervisor/supervisor.test.ts", REPO_FILES),
      "plausible-new",
    );
  });

  it("accepts a new file inside src/", () => {
    assert.equal(classifyPath("src/new-module.ts", REPO_FILES), "plausible-new");
  });
});

describe("classifyPath — suspicious (v9 failure mode)", () => {
  it("marks src/tests/* as suspicious but no longer rejects (planner may create new dirs)", () => {
    assert.equal(
      classifyPath("src/tests/token-tracker.test.ts", REPO_FILES),
      "suspicious",
    );
    assert.equal(
      classifyPath("src/tests/launcher.test.ts", REPO_FILES),
      "suspicious",
    );
  });

  it("marks docs/* as suspicious but no longer rejects", () => {
    assert.equal(classifyPath("docs/architecture.md", REPO_FILES), "suspicious");
  });

  it("marks a deeply nested invented path as suspicious but no longer rejects", () => {
    assert.equal(
      classifyPath("src/a/b/c/d/e/f.ts", REPO_FILES),
      "suspicious",
    );
  });
});

describe("classifyPath — normalization", () => {
  it("treats backslash paths the same as forward-slash paths", () => {
    // Model occasionally emits Windows-style separators; we should still
    // compare against the forward-slash REPO FILE LIST.
    assert.equal(classifyPath("src\\brain\\brain.ts", REPO_FILES), "existing");
    assert.equal(
      classifyPath("src\\brain\\new.test.ts", REPO_FILES),
      "plausible-new",
    );
    assert.equal(
      classifyPath("src\\tests\\token-tracker.test.ts", REPO_FILES),
      "suspicious",
    );
  });
});

describe("classifyPath — empty repoFiles degrades gracefully", () => {
  it("treats root-level paths as plausible-new (can't prove absence)", () => {
    assert.equal(classifyPath("README.md", []), "plausible-new");
  });

  it("treats nested paths as suspicious", () => {
    assert.equal(classifyPath("src/foo.ts", []), "suspicious");
  });
});

describe("classifyExpectedFiles — batch", () => {
  it("accepts all paths but reports suspicious as rejected", () => {
    const r = classifyExpectedFiles(
      [
        "src/brain/brain.ts", // existing
        "src/supervisor/supervisor.test.ts", // plausible-new
        "src/tests/token-tracker.test.ts", // suspicious (accepted but reported)
        "KNOWN_LIMITATIONS.md", // existing
      ],
      REPO_FILES,
    );
    assert.deepEqual(r.accepted, [
      "src/brain/brain.ts",
      "src/supervisor/supervisor.test.ts",
      "src/tests/token-tracker.test.ts",
      "KNOWN_LIMITATIONS.md",
    ]);
    assert.equal(r.rejected.length, 1);
    assert.equal(r.rejected[0].path, "src/tests/token-tracker.test.ts");
  });

  it("returns empty arrays for empty input", () => {
    const r = classifyExpectedFiles([], REPO_FILES);
    assert.deepEqual(r.accepted, []);
    assert.deepEqual(r.rejected, []);
  });

  it("all-accepted input yields empty rejected", () => {
    const r = classifyExpectedFiles(
      ["README.md", "src/brain/brain.ts"],
      REPO_FILES,
    );
    assert.deepEqual(r.accepted, ["README.md", "src/brain/brain.ts"]);
    assert.deepEqual(r.rejected, []);
  });

  it("all-suspicious input yields all accepted with rejections reported", () => {
    const r = classifyExpectedFiles(
      ["src/tests/a.ts", "src/tests/b.ts"],
      REPO_FILES,
    );
    assert.equal(r.accepted.length, 2);
    assert.equal(r.rejected.length, 2);
  });
});
