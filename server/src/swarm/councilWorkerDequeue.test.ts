import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scoreCouncilTodoForDequeue, HOTSPOT_FAIL_STREAK_HARD } from "./councilTodoPlan.js";

describe("scoreCouncilTodoForDequeue — hotspot soft/hard", () => {
  const base = {
    kind: "hunks" as const,
    description: "Fix the panel",
    expectedFiles: ["src/data/panelRegistry.js"],
  };

  it("soft-penalizes files with fail streak", () => {
    const clean = scoreCouncilTodoForDequeue(base, [], false);
    const hot = scoreCouncilTodoForDequeue(base, [], false, {
      fileFailStreak: new Map([["panelregistry.js", 2]]),
    });
    assert.ok(hot < clean, "hotspot should score lower");
    assert.ok(hot > Number.NEGATIVE_INFINITY, "soft streak still schedulable");
  });

  it("hard-defers when streak high and non-hotspot work exists", () => {
    const s = scoreCouncilTodoForDequeue(base, [], false, {
      fileFailStreak: new Map([["panelregistry.js", HOTSPOT_FAIL_STREAK_HARD]]),
      hasNonHotspotPending: true,
    });
    assert.equal(s, Number.NEGATIVE_INFINITY);
  });

  it("still schedules hard hotspot when it is the only work", () => {
    const s = scoreCouncilTodoForDequeue(base, [], false, {
      fileFailStreak: new Map([["panelregistry.js", HOTSPOT_FAIL_STREAK_HARD]]),
      hasNonHotspotPending: false,
    });
    assert.ok(s > Number.NEGATIVE_INFINITY);
  });
});
