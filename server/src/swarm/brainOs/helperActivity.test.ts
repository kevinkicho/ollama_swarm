import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  noteHelperStarted,
  noteHelperEnded,
  listActiveHelpers,
  activeHelperCount,
  resetHelperActivity,
} from "./helperActivity.js";

describe("helperActivity", () => {
  beforeEach(() => resetHelperActivity());

  it("tracks recruit and release", () => {
    noteHelperStarted({
      helperId: "h1",
      runId: "run-1",
      kind: "apply_miss",
      privilege: "repairer",
      depth: 0,
      startedAt: Date.now(),
    });
    assert.equal(activeHelperCount("run-1"), 1);
    assert.equal(listActiveHelpers("run-1")[0]!.helperId, "h1");
    noteHelperEnded("run-1", "h1");
    assert.equal(activeHelperCount("run-1"), 0);
  });

  it("isolates by runId", () => {
    noteHelperStarted({
      helperId: "a",
      runId: "r1",
      kind: "tool_block",
      privilege: "runner",
      depth: 0,
      startedAt: 1,
    });
    noteHelperStarted({
      helperId: "b",
      runId: "r2",
      kind: "progress_stuck",
      privilege: "arbiter",
      depth: 0,
      startedAt: 2,
    });
    assert.equal(activeHelperCount("r1"), 1);
    assert.equal(activeHelperCount("r2"), 1);
    assert.equal(listActiveHelpers().length, 2);
  });
});
