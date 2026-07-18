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
  extractContestToolRequests,
  registerContestToolsFromText,
  publishToolContestEvent,
  formatToolContestLine,
} from "./toolContest.js";
import { setToolContestRunSink, clearToolContestRunSink } from "./toolContestSink.js";

describe("toolContest", () => {
  beforeEach(() => {
    resetToolContests();
    clearToolContestRunSink();
  });

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

  it("extractContestToolRequests finds JSON in prose and fences", () => {
    const id = "cont-1";
    const prose =
      `I need write. ` +
      "```json\n" +
      `{"contestTool":true,"contestId":"${id}","reason":"patch contracts"}\n` +
      "```\n" +
      "Thanks.";
    const found = extractContestToolRequests(prose);
    assert.equal(found.length, 1);
    assert.equal(found[0]!.contestId, id);
    assert.match(found[0]!.reason, /patch contracts/);
  });

  it("registerContestToolsFromText attaches contestReason from agent text", () => {
    const c = openToolContest({
      runId: "r2",
      agentId: "worker-1",
      tool: "bash",
      profile: "swarm-write",
      denyReason: "denied by profile",
    });
    const applied = registerContestToolsFromText({
      runId: "r2",
      agentId: "worker-1",
      text: `{"contestTool":true,"contestId":"${c.id}","reason":"need shell for tsc"}`,
    });
    assert.equal(applied.length, 1);
    assert.equal(applied[0]!.contestReason, "need shell for tsc");
    assert.equal(listOpenContests("r2")[0]!.contestReason, "need shell for tsc");
  });

  it("publishToolContestEvent writes structured transcript via run sink", () => {
    const lines: Array<{ text: string; summary?: { kind: string; phase?: string } }> = [];
    setToolContestRunSink("r3", {
      appendSystem: (text, summary) => {
        lines.push({ text, summary: summary as { kind: string; phase?: string } });
      },
    });
    const c = openToolContest({
      runId: "r3",
      agentId: "a9",
      tool: "write",
      profile: "swarm-read",
      denyReason: "denied",
    });
    publishToolContestEvent({ contest: c, phase: "opened" });
    assert.equal(lines.length, 1);
    assert.match(lines[0]!.text, /tool-contest/i);
    assert.equal(lines[0]!.summary?.kind, "tool_contest");
    assert.equal(lines[0]!.summary?.phase, "opened");
    assert.match(formatToolContestLine(c, "opened"), /OPEN/);
  });
});
