import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { workersShouldDrain } from "./workerRunner.js";

describe("workersShouldDrain", () => {
  const idle = {
    pending: 0,
    stale: 0,
    replanPending: 0,
    replanRunning: false,
    anyThinking: false,
  };

  it("drains when nothing is claimable and no in-flight work", () => {
    assert.equal(workersShouldDrain(idle), true);
  });

  it("drains even with orphaned claimed/pending-commit (not inputs here)", () => {
    assert.equal(workersShouldDrain({ ...idle, pending: 0 }), true);
  });

  it("does not drain while open todos exist", () => {
    assert.equal(workersShouldDrain({ ...idle, pending: 2 }), false);
  });

  it("does not drain while stale todos await replan", () => {
    assert.equal(workersShouldDrain({ ...idle, stale: 1 }), false);
  });

  it("does not drain while replan queue is active", () => {
    assert.equal(workersShouldDrain({ ...idle, replanPending: 1 }), false);
    assert.equal(workersShouldDrain({ ...idle, replanRunning: true }), false);
  });

  it("does not drain while an agent is thinking", () => {
    assert.equal(workersShouldDrain({ ...idle, anyThinking: true }), false);
  });
});