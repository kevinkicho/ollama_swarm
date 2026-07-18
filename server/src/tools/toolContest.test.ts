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
  extractResolveContestRequests,
  registerContestToolsFromText,
  registerResolveContestFromText,
  publishToolContestEvent,
  formatToolContestLine,
  isTrustedContestResolver,
  formatOpenContestsPromptBlock,
  withOpenContestsPromptContext,
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

  it("peer resolveContest approves and grants one-shot; self-approve blocked", () => {
    const c = openToolContest({
      runId: "r4",
      agentId: "worker-1",
      tool: "write",
      profile: "swarm-read",
      denyReason: "denied",
    });
    contestToolDenial({
      runId: "r4",
      contestId: c.id,
      agentId: "worker-1",
      tool: "write",
      reason: "need write",
    });
    // Self cannot approve
    const self = registerResolveContestFromText({
      runId: "r4",
      agentId: "worker-1",
      text: `{"resolveContest":true,"contestId":"${c.id}","approve":true,"reason":"self"}`,
    });
    assert.equal(self.length, 0);
    assert.equal(listOpenContests("r4").length, 1);
    // Peer can approve
    const peer = registerResolveContestFromText({
      runId: "r4",
      agentId: "planner",
      profile: "swarm-planner",
      text: `{"resolveContest":true,"contestId":"${c.id}","approve":true,"reason":"ok for contract"}`,
    });
    assert.equal(peer.length, 1);
    assert.equal(peer[0]!.status, "approved");
    assert.match(peer[0]!.resolver ?? "", /planner/);
    assert.equal(listOpenContests("r4").length, 0);
    assert.equal(consumeToolAllowOnce("r4", "worker-1", "write"), true);
  });

  it("autoApprove run auto one-shots safe tools after contest", () => {
    setToolContestRunSink("r5", { autoApprove: true });
    const c = openToolContest({
      runId: "r5",
      agentId: "w1",
      tool: "edit",
      profile: "swarm-write",
      denyReason: "denied",
    });
    const applied = registerContestToolsFromText({
      runId: "r5",
      agentId: "w1",
      text: `{"contestTool":true,"contestId":"${c.id}","reason":"fix typo"}`,
    });
    assert.equal(applied.length, 1);
    assert.equal(listOpenContests("r5").length, 0);
    assert.equal(consumeToolAllowOnce("r5", "w1", "edit"), true);
  });

  it("autoApprove does not auto-allow bash contests", () => {
    setToolContestRunSink("r6", { autoApprove: true });
    const c = openToolContest({
      runId: "r6",
      agentId: "w1",
      tool: "bash",
      profile: "swarm-read",
      denyReason: "denied",
    });
    registerContestToolsFromText({
      runId: "r6",
      agentId: "w1",
      text: `{"contestTool":true,"contestId":"${c.id}","reason":"need shell"}`,
    });
    assert.equal(listOpenContests("r6").length, 1);
    assert.equal(consumeToolAllowOnce("r6", "w1", "bash"), false);
  });

  it("isTrustedContestResolver recognizes planner/auditor", () => {
    assert.equal(isTrustedContestResolver({ agentId: "x", profile: "swarm-planner" }), true);
    assert.equal(isTrustedContestResolver({ agentId: "auditor-1" }), true);
    assert.equal(isTrustedContestResolver({ agentId: "worker-2", profile: "swarm-write" }), false);
  });

  it("extractResolveContestRequests parses approve/deny", () => {
    const found = extractResolveContestRequests(
      `ok {"resolveContest":true,"contestId":"c1","approve":false,"reason":"unsafe"}`,
    );
    assert.equal(found.length, 1);
    assert.equal(found[0]!.approve, false);
  });

  it("formatOpenContestsPromptBlock lists peer and own contests for resolvers", () => {
    openToolContest({
      runId: "r7",
      agentId: "worker-1",
      tool: "write",
      profile: "swarm-read",
      denyReason: "denied write",
    });
    openToolContest({
      runId: "r7",
      agentId: "planner",
      tool: "bash",
      profile: "swarm-planner",
      denyReason: "denied bash",
    });
    const forPlanner = formatOpenContestsPromptBlock({
      runId: "r7",
      agentId: "planner",
      profile: "swarm-planner",
    });
    assert.match(forPlanner, /OPEN TOOL CONTESTS/);
    assert.match(forPlanner, /worker-1/);
    assert.match(forPlanner, /resolveContest/);
    assert.match(forPlanner, /trusted hierarchy/i);
    // Own denial: contest protocol, not self-approve
    assert.match(forPlanner, /Your open denials/);
    assert.match(forPlanner, /contestTool/);

    const empty = formatOpenContestsPromptBlock({
      runId: "none",
      agentId: "x",
    });
    assert.equal(empty, "");

    const wrapped = withOpenContestsPromptContext("PLAN TODOS", {
      runId: "r7",
      agentId: "worker-2",
    });
    assert.match(wrapped, /OPEN TOOL CONTESTS/);
    assert.match(wrapped, /PLAN TODOS/);
  });
});
