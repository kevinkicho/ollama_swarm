// 2026-05-02 (blackboard feature #4): rollback decision tests.
// The git wrapper itself isn't unit-tested (too I/O heavy); the
// integration is exercised in real blackboard runs.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldRollback, rollbackTodoCommits } from "./todoRollback.js";

describe("shouldRollback — pure decision rule", () => {
  it("apply-time failure → NO rollback (commit never landed)", () => {
    assert.equal(shouldRollback({ source: "apply" }), false);
  });

  it("verify-gate failure → YES rollback (commits landed, tests broken)", () => {
    assert.equal(shouldRollback({ source: "verify" }), true);
  });

  it("auditor FALSE verdict → YES rollback", () => {
    assert.equal(shouldRollback({ source: "auditor", verdict: "false" }), true);
  });

  it("auditor UNMET verdict → YES rollback", () => {
    assert.equal(shouldRollback({ source: "auditor", verdict: "unmet" }), true);
  });

  it("auditor PARTIAL → NO rollback (some progress signal)", () => {
    assert.equal(shouldRollback({ source: "auditor", verdict: "partial" }), false);
  });

  it("auditor VERIFIED → NO rollback (criterion met)", () => {
    assert.equal(shouldRollback({ source: "auditor", verdict: "verified" }), false);
  });

  it("auditor UNVERIFIABLE → NO rollback (couldn't tell, don't unwind speculatively)", () => {
    assert.equal(shouldRollback({ source: "auditor", verdict: "unverifiable" }), false);
  });

  it("auditor with no verdict → NO rollback (defensive default)", () => {
    assert.equal(shouldRollback({ source: "auditor" }), false);
  });
});

describe("rollbackTodoCommits — empty-shas no-op", () => {
  it("returns ok:true with no resetTo when commitShas is empty", async () => {
    const r = await rollbackTodoCommits({
      clonePath: "/tmp/anything",
      commitShas: [],
      reason: "no-op",
    });
    assert.equal(r.ok, true);
    assert.equal(r.resetTo, undefined);
  });
});
