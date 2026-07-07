import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isAlreadyDoneSkipReason,
  reconcileCriteriaFromSkips,
} from "./councilSkipReconcile.js";
import type { ExitCriterion } from "./blackboard/types.js";

test("isAlreadyDoneSkipReason — matches common worker phrases", () => {
  assert.equal(isAlreadyDoneSkipReason("already implemented in file"), true);
  assert.equal(isAlreadyDoneSkipReason("Content already present"), true);
  assert.equal(isAlreadyDoneSkipReason("out of scope"), false);
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