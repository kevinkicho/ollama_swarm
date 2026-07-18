import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isProductiveCycle,
  isDurableProgress,
  isActiveCycle,
  durableMetFlips,
  updateZeroProgressStreak,
  formatNoProductiveProgressReason,
  DEFAULT_ZERO_PROGRESS_LIMIT,
  MAX_STRETCH_WAVES_PER_RUN,
  MAX_CRITERION_PROGRESS_WAVES_PER_RUN,
  mintProgressTodosFromUnmetCriteria,
  todoProgressSignature,
} from "./productiveProgress.js";

describe("isDurableProgress / isProductiveCycle", () => {
  it("false when all zeros", () => {
    assert.equal(
      isProductiveCycle({ metFlips: 0, commitsThisCycle: 0, newTodos: 0 }),
      false,
    );
  });
  it("true on durable met flips", () => {
    assert.equal(
      isProductiveCycle({ metFlips: 1, commitsThisCycle: 0, newTodos: 0 }),
      true,
    );
  });
  it("true on commits", () => {
    assert.equal(
      isProductiveCycle({ metFlips: 0, commitsThisCycle: 2, newTodos: 0 }),
      true,
    );
  });
  it("false on new todos alone (no audit/stretch spin)", () => {
    assert.equal(
      isProductiveCycle({ metFlips: 0, commitsThisCycle: 0, newTodos: 3 }),
      false,
    );
    assert.equal(
      isDurableProgress({ metFlips: 0, commitsThisCycle: 0, newTodos: 3 }),
      false,
    );
  });
  it("false when all met flips are skip-only", () => {
    assert.equal(
      isProductiveCycle({
        metFlips: 2,
        commitsThisCycle: 0,
        newTodos: 0,
        skipOnlyMetFlips: 2,
      }),
      false,
    );
    assert.equal(
      durableMetFlips({ metFlips: 2, commitsThisCycle: 0, newTodos: 0, skipOnlyMetFlips: 2 }),
      0,
    );
  });
  it("true when some met flips are durable", () => {
    assert.equal(
      isProductiveCycle({
        metFlips: 3,
        commitsThisCycle: 0,
        newTodos: 0,
        skipOnlyMetFlips: 1,
      }),
      true,
    );
  });
  it("true on tier promotion", () => {
    assert.equal(
      isProductiveCycle({
        metFlips: 0,
        commitsThisCycle: 0,
        newTodos: 0,
        tierPromoted: true,
      }),
      true,
    );
  });
  it("isActiveCycle true for new todos even when not durable", () => {
    assert.equal(
      isActiveCycle({ metFlips: 0, commitsThisCycle: 0, newTodos: 2 }),
      true,
    );
  });
});

describe("updateZeroProgressStreak", () => {
  it("resets on productive", () => {
    assert.deepEqual(updateZeroProgressStreak(2, true), {
      streak: 0,
      shouldStop: false,
    });
  });
  it("stops at default limit", () => {
    const r = updateZeroProgressStreak(DEFAULT_ZERO_PROGRESS_LIMIT - 1, false);
    assert.equal(r.streak, DEFAULT_ZERO_PROGRESS_LIMIT);
    assert.equal(r.shouldStop, true);
  });
  it("does not stop below limit", () => {
    const r = updateZeroProgressStreak(0, false);
    assert.equal(r.streak, 1);
    assert.equal(r.shouldStop, false);
  });
});

describe("formatNoProductiveProgressReason", () => {
  it("includes streak and durable wording", () => {
    assert.match(formatNoProductiveProgressReason(3), /3 cycle/);
    assert.match(formatNoProductiveProgressReason(3), /durable met flips|commits/i);
  });
});

describe("MAX_STRETCH_WAVES_PER_RUN", () => {
  it("allows multi-wave stretch for long autonomous runs", () => {
    assert.ok(MAX_STRETCH_WAVES_PER_RUN >= 3 && MAX_STRETCH_WAVES_PER_RUN <= 6);
  });
});

describe("mintProgressTodosFromUnmetCriteria", () => {
  it("mints one todo per criterion with files", () => {
    const todos = mintProgressTodosFromUnmetCriteria([
      {
        id: "c1",
        description: "Expand modules to 10 tabs",
        expectedFiles: ["01_complex_explorer.html", "02_penrose_tiling.html"],
      },
      {
        id: "c2",
        description: "Add tours",
        expectedFiles: ["tour-data.js"],
      },
    ]);
    assert.equal(todos.length, 2);
    assert.equal(todos[0]!.createdBy, "criterion-progress");
    assert.ok(todos[0]!.description.includes("c1"));
    assert.deepEqual(todos[0]!.expectedFiles, [
      "01_complex_explorer.html",
      "02_penrose_tiling.html",
    ]);
    assert.equal(todos[1]!.criterionId, "c2");
  });

  it("skips file-less criteria and avoid signatures", () => {
    const first = mintProgressTodosFromUnmetCriteria([
      { id: "c1", description: "Expand tabs", expectedFiles: ["a.html"] },
    ]);
    const sig = todoProgressSignature(first[0]!.description, first[0]!.expectedFiles);
    const second = mintProgressTodosFromUnmetCriteria(
      [
        { id: "c1", description: "Expand tabs", expectedFiles: ["a.html"] },
        { id: "c2", description: "No files", expectedFiles: [] },
      ],
      { avoidSignatures: new Set([sig]) },
    );
    assert.equal(second.length, 0);
  });

  it("uses fallbackFiles when criterion lists none", () => {
    const todos = mintProgressTodosFromUnmetCriteria(
      [{ description: "Improve docs", expectedFiles: [] }],
      { fallbackFiles: ["README.md"] },
    );
    assert.equal(todos.length, 1);
    assert.deepEqual(todos[0]!.expectedFiles, ["README.md"]);
  });

  it("exposes a generous criterion-progress wave budget", () => {
    assert.ok(MAX_CRITERION_PROGRESS_WAVES_PER_RUN >= 3);
  });
});
