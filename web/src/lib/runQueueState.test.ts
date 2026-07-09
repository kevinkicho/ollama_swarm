import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { RunSummaryDigest } from "../types";
import { runQueueIsActive, runQueueStatusLabel } from "./runQueueState";

function digest(partial: Partial<RunSummaryDigest>): RunSummaryDigest {
  return {
    name: "proj",
    clonePath: "/tmp/p",
    preset: "blackboard",
    model: "m",
    startedAt: 1,
    endedAt: 0,
    wallClockMs: 0,
    hasContract: false,
    isActive: false,
    ...partial,
  };
}

describe("runQueueIsActive", () => {
  it("does not treat endedAt=0 as active when server says inactive", () => {
    assert.equal(runQueueIsActive(digest({ isActive: false, endedAt: 0 })), false);
  });

  it("honors server isActive when no terminal fields", () => {
    assert.equal(runQueueIsActive(digest({ isActive: true, endedAt: 0 })), true);
  });

  it("is inactive when stopReason is set even if isActive true", () => {
    assert.equal(
      runQueueIsActive(digest({ isActive: true, stopReason: "crash" })),
      false,
    );
  });

  it("is inactive when endedAt is set", () => {
    assert.equal(runQueueIsActive(digest({ isActive: true, endedAt: 99_000 })), false);
  });
});

describe("runQueueStatusLabel", () => {
  it("shows crash stopReason for crashed runs", () => {
    const run = digest({ stopReason: "crash" });
    assert.equal(runQueueStatusLabel(run, false), "crash");
  });
});