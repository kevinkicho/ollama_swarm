import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isAlreadyDoneSkipReason,
  reconcileCriteriaFromSkips,
  skipCoversCriterionFiles,
  filterAuditTodosAgainstSkips,
  filterAuditTodosAgainstPermanentSkips,
  promoteCriteriaFromSkipEvidence,
  refuseMetFromExhaustedPermanentSkips,
  criterionGroundedForSkipPromote,
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
  assert.equal(isAlreadyDoneSkipReason("All changes are already applied to dft_calculator.py"), true);
  assert.equal(isAlreadyDoneSkipReason("No change needed."), true);
  assert.equal(isAlreadyDoneSkipReason("out of scope"), false);
});

test("skipCoversCriterionFiles — basename overlap for docs/foo vs foo", () => {
  assert.equal(
    skipCoversCriterionFiles(["docs/synthesis_methods.md"], ["synthesis_methods.md"]),
    true,
  );
  assert.equal(skipCoversCriterionFiles(["other.md"], ["synthesis_methods.md"]), false);
});

test("criterionGroundedForSkipPromote — rejects empty expectedFiles", () => {
  const c: ExitCriterion = {
    id: "c0",
    description: "vague",
    expectedFiles: [],
    status: "unmet",
    addedAt: 1,
  };
  assert.equal(criterionGroundedForSkipPromote(c, ["x.md"], ["x.md"]), false);
});

test("criterionGroundedForSkipPromote — rejects missing files when inventory known", () => {
  const c: ExitCriterion = {
    id: "c0",
    description: "Add missing",
    expectedFiles: ["does-not-exist.md"],
    status: "unmet",
    addedAt: 1,
  };
  assert.equal(
    criterionGroundedForSkipPromote(c, ["does-not-exist.md"], ["README.md"]),
    false,
  );
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

test("reconcileCriteriaFromSkips — does not promote missing disk files", () => {
  const criteria: ExitCriterion[] = [
    {
      id: "cX",
      description: "Create phantom",
      expectedFiles: ["phantom_only.md"],
      status: "unmet",
      addedAt: 1,
    },
  ];
  const { promotedIds } = reconcileCriteriaFromSkips(
    criteria,
    [{ criterionId: "cX", reason: "already done", expectedFiles: ["phantom_only.md"] }],
    ["README.md", "app.py"],
  );
  assert.deepEqual(promotedIds, []);
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

test("filterAuditTodosAgainstPermanentSkips — drops re-minted Create Vitest shapes (2964afe8)", async () => {
  const { filterAuditTodosAgainstPermanentSkips } = await import("./councilSkipReconcile.js");
  const { kept, dropped } = filterAuditTodosAgainstPermanentSkips(
    [
      {
        description: "Create Vitest unit tests for fao route",
        expectedFiles: ["server/__tests__/fao.test.js"],
      },
      {
        description: "Implement FAO handler error mapping",
        expectedFiles: ["server/src/routes/fao.ts"],
      },
    ],
    [
      {
        description: "Create Vitest unit tests for fao route",
        expectedFiles: ["server/__tests__/fao.test.js"],
        reason: "permanent:attempts-exhausted: 2 attempts",
      },
    ],
    { hadDurableProgress: false },
  );
  assert.equal(dropped.length, 1);
  assert.match(dropped[0]!.description, /Create Vitest/i);
  assert.equal(kept.length, 1);
  assert.match(kept[0]!.description, /Implement FAO/);
});

test("filterAuditTodosAgainstPermanentSkips — allows remint after durable progress", async () => {
  const { filterAuditTodosAgainstPermanentSkips } = await import("./councilSkipReconcile.js");
  const { kept, dropped } = filterAuditTodosAgainstPermanentSkips(
    [{ description: "Create Vitest unit tests for fao", expectedFiles: [] }],
    [
      {
        description: "Create Vitest unit tests for fao",
        expectedFiles: [],
        reason: "permanent:attempts-exhausted",
      },
    ],
    { hadDurableProgress: true },
  );
  assert.equal(dropped.length, 0);
  assert.equal(kept.length, 1);
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

test("promoteCriteriaFromSkipEvidence — refuses empty expectedFiles criteria", () => {
  const criteria: ExitCriterion[] = [
    {
      id: "c5",
      description: "Vague work",
      expectedFiles: [],
      status: "unmet",
      addedAt: 1,
    },
  ];
  const updated = promoteCriteriaFromSkipEvidence(criteria, [
    { criterionId: "c5", reason: "already done", expectedFiles: [] },
  ]);
  assert.equal(updated[0]!.status, "unmet");
});

test("refuseMetFromExhaustedPermanentSkips — demotes met without commit (961a885f)", () => {
  const criteria: ExitCriterion[] = [
    {
      id: "c10",
      description: "Every new panel must include DataFooter",
      expectedFiles: ["src/markets/insurance/InsuranceDashboard.jsx"],
      status: "met",
      addedAt: 1,
    },
  ];
  const { demotedIds, criteria: out } = refuseMetFromExhaustedPermanentSkips(
    criteria,
    [
      {
        description: "Create new panel components with DataFooter",
        expectedFiles: ["src/markets/insurance/InsuranceDashboard.jsx"],
        reason: "permanent:attempts-exhausted: pure think",
        criterionId: "c10",
      },
    ],
    [], // no commits
  );
  assert.deepEqual(demotedIds, ["c10"]);
  assert.equal(out[0]!.status, "unmet");
});

test("refuseMetFromExhaustedPermanentSkips — keeps met when commit covers files", () => {
  const criteria: ExitCriterion[] = [
    {
      id: "c10",
      description: "footer",
      expectedFiles: ["src/markets/insurance/InsuranceDashboard.jsx"],
      status: "met",
      addedAt: 1,
    },
  ];
  const { demotedIds, criteria: out } = refuseMetFromExhaustedPermanentSkips(
    criteria,
    [
      {
        description: "Create panels",
        expectedFiles: ["src/markets/insurance/InsuranceDashboard.jsx"],
        reason: "permanent:attempts-exhausted",
        criterionId: "c10",
      },
    ],
    ["src/markets/insurance/InsuranceDashboard.jsx"],
  );
  assert.equal(demotedIds.length, 0);
  assert.equal(out[0]!.status, "met");
});

test("filterAuditTodosAgainstPermanentSkips — drops create/wire panel remint", () => {
  const { kept, dropped } = filterAuditTodosAgainstPermanentSkips(
    [
      {
        description: "Create new panel components that use BentoCard DataFooter",
        expectedFiles: ["src/markets/insurance/X.jsx"],
      },
    ],
    [
      {
        description: "Create new panel components that use BentoCard DataFooter",
        expectedFiles: ["src/markets/insurance/X.jsx"],
        reason: "permanent:attempts-exhausted",
      },
    ],
    { hadDurableProgress: false },
  );
  assert.equal(dropped.length, 1);
  assert.equal(kept.length, 0);
});
