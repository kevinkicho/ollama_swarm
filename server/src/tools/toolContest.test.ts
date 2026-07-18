import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  openToolContest,
  contestToolDenial,
  resolveToolContest,
  consumeToolAllowOnce,
  listOpenContests,
  resetToolContests,
  formatContestableDenial,
} from "./toolContest.js";

describe("toolContest", () => {
  beforeEach(() => resetToolContests());

  it("opens contestable denial and grants one-shot allow on approve", () => {
    const c = openToolContest({
      runId: "r1",
      agentId: "a1",
      tool: "write",
      profile: "swarm-read",
      denyReason: "denied",
    });
    assert.equal(listOpenContests("r1").length, 1);
    contestToolDenial({
      runId: "r1",
      contestId: c.id,
      agentId: "a1",
      tool: "write",
      reason: "need to patch file",
    });
    const resolved = resolveToolContest({
      runId: "r1",
      contestId: c.id,
      approve: true,
      resolver: "auditor",
    });
    assert.equal(resolved?.status, "approved");
    assert.equal(consumeToolAllowOnce("r1", "a1", "write"), true);
    assert.equal(consumeToolAllowOnce("r1", "a1", "write"), false);
  });

  it("formatContestableDenial includes contest protocol", () => {
    const msg = formatContestableDenial({
      tool: "bash",
      profile: "swarm-read",
      contestId: "abc",
    });
    assert.match(msg, /contestable/i);
    assert.match(msg, /Contest id=abc/);
  });
});
