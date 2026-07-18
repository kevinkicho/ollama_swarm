/**
 * Contestable tool denials — agents may challenge profile denials;
 * peer/master review approve|deny via deliberation (not OpenCode SDK UI).
 * OpenCode subprocess was removed E3 2026-04-29; this is the in-process bridge.
 */

import { randomUUID } from "node:crypto";
import type { TranscriptEntrySummary } from "@ollama-swarm/shared/transcriptEntrySummary";
import type { DeliberationSink } from "../swarm/deliberation/deliberationTypes.js";
import { recordDeliberationAsync } from "../swarm/deliberation/deliberationLog.js";
import {
  getToolContestRunSink,
  mergeToolContestSink,
} from "./toolContestSink.js";

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
    // Latest open contest for this agent+tool (tool optional → any open for agent)
    for (const x of [...m.values()].reverse()) {
      if (x.agentId !== input.agentId || x.status !== "open") continue;
      if (!input.tool || x.tool === input.tool) {
        c = x;
        break;
      }
    }
  }
  if (!c || c.status !== "open") return null;
  c.contestReason = input.reason.slice(0, 500);
  return c;
}

/** One agent-emitted contestTool JSON payload (see formatContestableDenial). */
export interface ContestToolEmit {
  contestId?: string;
  tool?: string;
  reason: string;
}

/** Peer/master resolve payload: `{"resolveContest":true,"approve":true,...}`. */
export interface ResolveContestEmit {
  contestId?: string;
  tool?: string;
  approve: boolean;
  reason: string;
}

/**
 * Tools safe to one-shot auto-approve under autoApprove after a contest.
 * bash/run stay operator/peer-gated (host execution).
 */
export const AUTO_APPROVE_CONTEST_TOOLS = new Set([
  "write",
  "edit",
  "propose_hunks",
  "git_status",
  "git_diff",
  "read",
  "list",
  "glob",
  "grep",
  "web_search",
  "web_fetch",
]);

/** Brace-match JSON objects around a key marker in free-form text. */
function extractJsonObjectsNearKey(text: string, key: string): Record<string, unknown>[] {
  if (!text || !text.includes(key)) return [];
  const out: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let i = 0;
  while (i < text.length) {
    const keyIdx = text.indexOf(key, i);
    if (keyIdx < 0) break;
    let start = keyIdx;
    while (start > 0 && text[start] !== "{") start--;
    if (text[start] !== "{") {
      i = keyIdx + 1;
      continue;
    }
    let depth = 0;
    let end = -1;
    let inStr = false;
    let esc = false;
    for (let j = start; j < text.length; j++) {
      const ch = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === "\"") inStr = false;
        continue;
      }
      if (ch === "\"") inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end < 0) {
      i = keyIdx + 1;
      continue;
    }
    const slice = text.slice(start, end + 1);
    i = end + 1;
    if (seen.has(slice)) continue;
    seen.add(slice);
    try {
      const obj = JSON.parse(slice) as Record<string, unknown>;
      if (obj && typeof obj === "object") out.push(obj);
    } catch {
      /* skip */
    }
  }
  return out;
}

/**
 * Extract `{"contestTool":true,...}` objects from free-form assistant text
 * (prose, fences, multi-object). Brace-matched JSON only.
 */
export function extractContestToolRequests(text: string): ContestToolEmit[] {
  const out: ContestToolEmit[] = [];
  for (const obj of extractJsonObjectsNearKey(text, "contestTool")) {
    if (obj.contestTool !== true && obj.contestTool !== "true") continue;
    const reasonRaw = obj.reason ?? obj.why ?? obj.rationale;
    const reason =
      typeof reasonRaw === "string" && reasonRaw.trim()
        ? reasonRaw.trim()
        : "agent contested profile denial";
    const contestId =
      typeof obj.contestId === "string" && obj.contestId.trim()
        ? obj.contestId.trim()
        : undefined;
    const tool =
      typeof obj.tool === "string" && obj.tool.trim() ? obj.tool.trim() : undefined;
    out.push({ contestId, tool, reason: reason.slice(0, 500) });
  }
  return out;
}

/**
 * Extract peer/master `{"resolveContest":true,"approve":true|false,...}` payloads.
 */
export function extractResolveContestRequests(text: string): ResolveContestEmit[] {
  const out: ResolveContestEmit[] = [];
  for (const obj of extractJsonObjectsNearKey(text, "resolveContest")) {
    if (obj.resolveContest !== true && obj.resolveContest !== "true") continue;
    const approveRaw = obj.approve ?? obj.allow ?? obj.granted;
    const approve =
      approveRaw === true
      || approveRaw === "true"
      || approveRaw === "approve"
      || approveRaw === "yes";
    const deny =
      approveRaw === false
      || approveRaw === "false"
      || approveRaw === "deny"
      || approveRaw === "no";
    if (!approve && !deny) continue;
    const reasonRaw = obj.reason ?? obj.why ?? obj.rationale;
    const reason =
      typeof reasonRaw === "string" && reasonRaw.trim()
        ? reasonRaw.trim()
        : approve
          ? "peer/master approved contest"
          : "peer/master denied contest";
    const contestId =
      typeof obj.contestId === "string" && obj.contestId.trim()
        ? obj.contestId.trim()
        : undefined;
    const tool =
      typeof obj.tool === "string" && obj.tool.trim() ? obj.tool.trim() : undefined;
    out.push({ contestId, tool, approve, reason: reason.slice(0, 500) });
  }
  return out;
}

/**
 * Trusted hierarchy resolvers (planner / auditor / master labels).
 * Peers (other agents) may also resolve — self-approve is always blocked.
 */
export function isTrustedContestResolver(input: {
  agentId: string;
  profile?: string;
}): boolean {
  const id = (input.agentId || "").toLowerCase();
  const profile = (input.profile || "").toLowerCase();
  if (
    profile.includes("planner")
    || profile.includes("auditor")
    || profile === "swarm-auto"
    || profile === "swarm"
  ) {
    return true;
  }
  if (
    /\b(planner|auditor|master|lead|judge|synthesizer)\b/.test(id)
    || id.includes("agent-0")
    || /^(planner|auditor)\b/.test(id)
  ) {
    return true;
  }
  return false;
}

/**
 * Scan assistant text for contestTool JSON and attach reasons to open contests.
 * Under autoApprove + safe tools, auto one-shot-approve after contest.
 */
export function registerContestToolsFromText(input: {
  runId?: string;
  agentId?: string;
  text?: string;
  sink?: DeliberationSink;
  profile?: string;
}): ToolContest[] {
  const { runId, agentId, text } = input;
  if (!runId || !agentId || !text) return [];
  const applied: ToolContest[] = [];
  const autoApprove = !!getToolContestRunSink(runId)?.autoApprove;
  for (const req of extractContestToolRequests(text)) {
    const c = contestToolDenial({
      runId,
      contestId: req.contestId,
      agentId,
      tool: req.tool ?? "",
      reason: req.reason,
    });
    if (!c) continue;
    applied.push(c);
    publishToolContestEvent({ contest: c, phase: "contested", sink: input.sink });
    // Trusted local runs: auto one-shot for collaboration tools (not bash/run).
    if (autoApprove && AUTO_APPROVE_CONTEST_TOOLS.has(c.tool)) {
      const resolved = resolveToolContest({
        runId,
        contestId: c.id,
        approve: true,
        resolver: "autoApprove",
      });
      if (resolved) {
        publishToolContestEvent({
          contest: resolved,
          phase: "approved",
          sink: input.sink,
        });
      }
    }
  }
  return applied;
}

/**
 * Scan assistant text for peer/master resolveContest JSON.
 * Blocks self-approve; peers and trusted hierarchy may approve|deny.
 */
export function registerResolveContestFromText(input: {
  runId?: string;
  agentId?: string;
  text?: string;
  sink?: DeliberationSink;
  profile?: string;
}): ToolContest[] {
  const { runId, agentId, text } = input;
  if (!runId || !agentId || !text) return [];
  const resolved: ToolContest[] = [];
  for (const req of extractResolveContestRequests(text)) {
    const m = byRun.get(runId);
    if (!m) continue;
    let c: ToolContest | undefined;
    if (req.contestId) c = m.get(req.contestId);
    if (!c || c.status !== "open") {
      for (const x of [...m.values()].reverse()) {
        if (x.status !== "open") continue;
        if (req.tool && x.tool !== req.tool) continue;
        c = x;
        break;
      }
    }
    if (!c || c.status !== "open") continue;
    // Self-approve forbidden — request peer/master or operator.
    if (c.agentId === agentId) continue;
    // Peers always ok; prefer labeling trusted hierarchy in resolver id.
    const trusted = isTrustedContestResolver({
      agentId,
      profile: input.profile,
    });
    const resolverLabel = trusted ? `${agentId}:master` : `${agentId}:peer`;
    // Attach peer reason onto contest before resolve for transcript.
    if (req.reason) c.contestReason = (c.contestReason ?? c.denyReason).slice(0, 300);
    const out = resolveToolContest({
      runId,
      contestId: c.id,
      approve: req.approve,
      resolver: resolverLabel,
    });
    if (!out) continue;
    // Prefer peer reason in transcript when approving.
    if (req.reason) {
      out.contestReason = req.reason.slice(0, 500);
    }
    publishToolContestEvent({
      contest: out,
      phase: req.approve ? "approved" : "denied",
      sink: input.sink,
    });
    resolved.push(out);
  }
  return resolved;
}

/**
 * Scan assistant text for both contestTool and resolveContest envelopes.
 */
export function scanAgentContestMessages(input: {
  runId?: string;
  agentId?: string;
  text?: string;
  sink?: DeliberationSink;
  profile?: string;
}): { contested: ToolContest[]; resolved: ToolContest[] } {
  return {
    contested: registerContestToolsFromText(input),
    resolved: registerResolveContestFromText(input),
  };
}

export type ToolContestPhase = "opened" | "contested" | "approved" | "denied";

/** One-line operator text for transcript / logs. */
export function formatToolContestLine(
  contest: ToolContest,
  phase: ToolContestPhase,
): string {
  const who = contest.agentId;
  const tool = contest.tool;
  if (phase === "opened") {
    return (
      `[tool-contest] OPEN · ${who} · ${tool} (profile ${contest.profile}) ` +
      `id=${contest.id.slice(0, 8)} — contestable profile denial`
    );
  }
  if (phase === "contested") {
    const why = (contest.contestReason ?? "").slice(0, 120);
    return (
      `[tool-contest] CONTESTED · ${who} · ${tool} id=${contest.id.slice(0, 8)}` +
      (why ? ` — ${why}` : "")
    );
  }
  const verdict = phase === "approved" ? "APPROVED (one-shot allow)" : "DENIED";
  const by = contest.resolver ?? "operator";
  return `[tool-contest] ${verdict} · ${who} · ${tool} by ${by} id=${contest.id.slice(0, 8)}`;
}

function contestSummary(
  contest: ToolContest,
  phase: ToolContestPhase,
): Extract<TranscriptEntrySummary, { kind: "tool_contest" }> {
  return {
    kind: "tool_contest",
    phase,
    contestId: contest.id,
    tool: contest.tool,
    agentId: contest.agentId,
    profile: contest.profile,
    reason: (contest.contestReason ?? contest.denyReason).slice(0, 240),
    ...(contest.resolver ? { resolver: contest.resolver } : {}),
  };
}

/**
 * Surface a contest lifecycle step: structured transcript bubble + deliberation
 * WS/JSONL (via registry sink when call-site has no runner).
 */
export function publishToolContestEvent(input: {
  contest: ToolContest;
  phase: ToolContestPhase;
  sink?: DeliberationSink;
}): void {
  const { contest, phase } = input;
  const reg = getToolContestRunSink(contest.runId);
  const line = formatToolContestLine(contest, phase);
  const summary = contestSummary(contest, phase);
  try {
    reg?.appendSystem?.(line, summary);
  } catch {
    /* best-effort */
  }

  const delibSink = mergeToolContestSink(contest.runId, input.sink);
  // Avoid duplicate plain-text system lines from recordDeliberation.
  const sinkNoPlain: DeliberationSink = {
    ...delibSink,
    appendSystem: undefined,
  };

  if (phase === "opened") {
    recordDenialDeliberation(contest, sinkNoPlain);
  } else if (phase === "contested") {
    recordDeliberationAsync(
      {
        runId: contest.runId,
        layer: "control",
        subject: `tool-contest:${contest.tool}`,
        claim: (contest.contestReason ?? contest.denyReason).slice(0, 400),
        proposer: contest.agentId,
        validator: `profile:${contest.profile}`,
        verdict: "challenge",
        validationReason: `agent contested contestId=${contest.id}`,
        evidence: [contest.tool, contest.id],
      },
      sinkNoPlain,
    );
  } else {
    recordContestResolutionDeliberation(contest, sinkNoPlain);
  }
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
    `To contest: emit JSON ` +
    `{"contestTool":true,"contestId":"${input.contestId}","reason":"why this tool is needed"}. ` +
    `Peer/master approve (not self): ` +
    `{"resolveContest":true,"contestId":"${input.contestId}","approve":true,"reason":"why allow once"}. ` +
    `Operator can also approve in Run resilience → Contests. ` +
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
    mergeToolContestSink(contest.runId, sink),
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
    mergeToolContestSink(contest.runId, sink),
  );
}
