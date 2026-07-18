/**
 * Contestable tool denials — agents may challenge profile denials;
 * peer/master review approve|deny via deliberation (not OpenCode SDK UI).
 * OpenCode subprocess was removed E3 2026-04-29; this is the in-process bridge.
 */

import { randomUUID } from "node:crypto";
import type { DeliberationSink } from "../swarm/deliberation/deliberationTypes.js";
import { recordDeliberationAsync } from "../swarm/deliberation/deliberationLog.js";

export type ToolContestStatus = "open" | "approved" | "denied";

export interface ToolContest {
  id: string;
  runId: string;
  agentId: string;
  tool: string;
  profile: string;
  denyReason: string;
  contestReason?: string;
  status: ToolContestStatus;
  createdAt: number;
  resolvedAt?: number;
  resolver?: string;
}

const byRun = new Map<string, Map<string, ToolContest>>();
/** One-shot allows after master approve: key = runId|agentId|tool */
const allowOnce = new Map<string, number>();

function runMap(runId: string): Map<string, ToolContest> {
  let m = byRun.get(runId);
  if (!m) {
    m = new Map();
    byRun.set(runId, m);
  }
  return m;
}

function allowKey(runId: string, agentId: string, tool: string): string {
  return `${runId}|${agentId}|${tool}`;
}

export function resetToolContests(runId?: string): void {
  if (runId) {
    byRun.delete(runId);
    for (const k of [...allowOnce.keys()]) {
      if (k.startsWith(runId + "|")) allowOnce.delete(k);
    }
  } else {
    byRun.clear();
    allowOnce.clear();
  }
}

/** After peer/master approve, next dispatch of this tool for agent is allowed once. */
export function grantToolAllowOnce(runId: string, agentId: string, tool: string): void {
  allowOnce.set(allowKey(runId, agentId, tool), Date.now());
}

export function consumeToolAllowOnce(
  runId: string | undefined,
  agentId: string | undefined,
  tool: string,
): boolean {
  if (!runId || !agentId) return false;
  const k = allowKey(runId, agentId, tool);
  if (!allowOnce.has(k)) return false;
  allowOnce.delete(k);
  return true;
}

export function openToolContest(input: {
  runId: string;
  agentId: string;
  tool: string;
  profile: string;
  denyReason: string;
}): ToolContest {
  const c: ToolContest = {
    id: randomUUID(),
    runId: input.runId,
    agentId: input.agentId,
    tool: input.tool,
    profile: input.profile,
    denyReason: input.denyReason,
    status: "open",
    createdAt: Date.now(),
  };
  runMap(input.runId).set(c.id, c);
  return c;
}

export function contestToolDenial(input: {
  runId: string;
  contestId?: string;
  agentId: string;
  tool: string;
  reason: string;
}): ToolContest | null {
  const m = byRun.get(input.runId);
  if (!m) return null;
  let c: ToolContest | undefined;
  if (input.contestId) c = m.get(input.contestId);
  if (!c) {
    // Latest open contest for this agent+tool
    for (const x of [...m.values()].reverse()) {
      if (x.agentId === input.agentId && x.tool === input.tool && x.status === "open") {
        c = x;
        break;
      }
    }
  }
  if (!c || c.status !== "open") return null;
  c.contestReason = input.reason.slice(0, 500);
  return c;
}

export function resolveToolContest(input: {
  runId: string;
  contestId: string;
  approve: boolean;
  resolver: string;
}): ToolContest | null {
  const c = byRun.get(input.runId)?.get(input.contestId);
  if (!c || c.status !== "open") return null;
  c.status = input.approve ? "approved" : "denied";
  c.resolvedAt = Date.now();
  c.resolver = input.resolver;
  if (input.approve) {
    grantToolAllowOnce(input.runId, c.agentId, c.tool);
  }
  return c;
}

export function listOpenContests(runId: string): ToolContest[] {
  const m = byRun.get(runId);
  if (!m) return [];
  return [...m.values()].filter((c) => c.status === "open");
}

/** Agent-facing denial text with contest protocol. */
export function formatContestableDenial(input: {
  tool: string;
  profile: string;
  contestId: string;
}): string {
  return (
    `tool "${input.tool}" denied by profile "${input.profile}" ` +
    `(contestable). Contest id=${input.contestId}. ` +
    `To contest: ask a peer/master to approve, or emit JSON ` +
    `{"contestTool":true,"contestId":"${input.contestId}","reason":"why this tool is needed"}. ` +
    `Prefer write/edit/git_status on builder profiles, or use working-tree collaboration. ` +
    `Path sandbox denials are not contestable.`
  );
}

export function recordDenialDeliberation(
  contest: ToolContest,
  sink: DeliberationSink,
): void {
  recordDeliberationAsync(
    {
      runId: contest.runId,
      layer: "control",
      subject: `tool-denial:${contest.tool}`,
      claim: contest.denyReason.slice(0, 400),
      proposer: contest.agentId,
      validator: `profile:${contest.profile}`,
      verdict: "challenge",
      validationReason: `contestable denial contestId=${contest.id}`,
      evidence: [contest.tool, contest.profile],
      related: { agentIndex: undefined },
    },
    sink,
  );
}

export function recordContestResolutionDeliberation(
  contest: ToolContest,
  sink: DeliberationSink,
): void {
  recordDeliberationAsync(
    {
      runId: contest.runId,
      layer: "hierarchy",
      subject: `tool-contest:${contest.tool}`,
      claim: contest.contestReason ?? contest.denyReason,
      proposer: contest.agentId,
      validator: contest.resolver ?? "master",
      verdict: contest.status === "approved" ? "approve" : "deny",
      validationReason: `tool contest ${contest.status}`,
      evidence: [contest.tool, contest.id],
    },
    sink,
  );
}
