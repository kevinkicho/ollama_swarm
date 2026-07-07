import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isAlreadyDoneSkipReason,
  reconcileCriteriaFromSkips,
  skipCoversCriterionFiles,
  filterAuditTodosAgainstSkips,
  promoteCriteriaFromSkipEvidence,
} from "./councilSkipReconcile.js";
import type { ExitCriterion } from "./blackboard/types.js";

test("isAlreadyDoneSkipReason — matches common worker phrases", () => {
  assert.equal(isAlreadyDoneSkipReason("already implemented in file"), true);
  assert.equal(isAlreadyDoneSkipReason("Content already present"), true);
  assert.equal(isAlreadyDoneSkipReason("file already contains the section"), true);
  assert.equal(isAlreadyDoneSkipReason("no additional content needed"), true);
  assert.equal(isAlreadyDoneSkipReason("no changes needed"), true);
  assert.equal(isAlreadyDoneSkipReason("implementation appears complete"), true);
  assert.equal(isAlreadyDoneSkipReason("all phases already have content"), true);
  assert.equal(isAlreadyDoneSkipReason("out of scope"), false);
});

test("skipCoversCriterionFiles — basename overlap for docs/foo vs foo", () => {
  assert.equal(
    skipCoversCriterionFiles(["docs/synthesis_methods.md"], ["synthesis_methods.md"]),
    true,
  );
  assert.equal(skipCoversCriterionFiles(["other.md"], ["synthesis_methods.md"]), false);
});

test("reconcileCriteriaFromSkips — promotes linked criterion on valid skip", () => {
  const criteria: ExitCriterion[] = [
    {
      id: "c1",
      description: "Add section",
      expectedFiles: ["doc.md"],
      status: "unmet",
      addedAt: 1,
    },
  ];
  const { criteria: updated, promotedIds } = reconcileCriteriaFromSkips(criteria, [
    {
      criterionId: "c1",
      reason: "already implemented",
      expectedFiles: ["doc.md"],
    },
  ]);
  assert.deepEqual(promotedIds, ["c1"]);
  assert.equal(updated[0]!.status, "met");
});

test("reconcileCriteriaFromSkips — file overlap fallback without criterionId", () => {
  const criteria: ExitCriterion[] = [
    {
      id: "c2",
      description: "Update methods doc",
      expectedFiles: ["synthesis_methods.md"],
      status: "unmet",
      addedAt: 1,
    },
  ];
  const { criteria: updated } = reconcileCriteriaFromSkips(criteria, [
    {
      reason: "already present",
      expectedFiles: ["synthesis_methods.md"],
    },
  ]);
  assert.equal(updated[0]!.status, "met");
});

test("reconcileCriteriaFromSkips — basename overlap with repoFiles canonicalization", () => {
  const criteria: ExitCriterion[] = [
    {
      id: "c3",
      description: "Methods doc",
      expectedFiles: ["docs/methods.md"],
      status: "unmet",
      addedAt: 1,
    },
  ];
  const repoFiles = ["methods.md"];
  const { criteria: updated } = reconcileCriteriaFromSkips(
    criteria,
    [{ reason: "already contains required content", expectedFiles: ["methods.md"] }],
    repoFiles,
  );
  assert.equal(updated[0]!.status, "met");
});

test("filterAuditTodosAgainstSkips — drops duplicate todos for skipped work", () => {
  const filtered = filterAuditTodosAgainstSkips(
    [
      { description: "Add methods section", expectedFiles: ["methods.md"], criterionId: "c1" },
      { description: "Fix unrelated bug", expectedFiles: ["bug.ts"] },
    ],
    [{ criterionId: "c1", reason: "already implemented", expectedFiles: ["methods.md"] }],
  );
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]!.expectedFiles[0], "bug.ts");
});

test("promoteCriteriaFromSkipEvidence — promotes covered unmet criteria", () => {
  const criteria: ExitCriterion[] = [
    {
      id: "c4",
      description: "Wire API",
      expectedFiles: ["api.ts"],
      status: "unmet",
      addedAt: 1,
    },
  ];
  const updated = promoteCriteriaFromSkipEvidence(criteria, [
    { reason: "content already present", expectedFiles: ["api.ts"] },
  ]);
  assert.equal(updated[0]!.status, "met");
});