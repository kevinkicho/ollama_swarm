/**
 * Aggregate peer ```deliberate``` stances so synthesis / votes can
 * honor deny vs approve instead of treating all drafts equally.
 */

import { parseDeliberateEnvelopes, type DeliberateStance } from "./deliberationProtocol.js";

export interface PeerDeliberationStanceRecord {
  fromAgentIndex: number;
  subject: string;
  claim: string;
  stance: DeliberateStance;
  why: string;
  /** Best-effort target agent index parsed from subject/to. */
  targetAgentIndex: number | null;
}

export interface PeerDraftStanding {
  agentIndex: number;
  approves: number;
  denies: number;
  challenges: number;
  validates: number;
  /** True when denies > approves (and at least one deny). */
  peerRejected: boolean;
  /** True when approves > denies and approves >= 1. */
  peerSupported: boolean;
  notes: string[];
}

const AGENT_RE = /agent[- ]?(\d+)/i;

export function extractTargetAgentIndex(envelope: {
  subject: string;
  to?: string;
  claim: string;
}): number | null {
  for (const s of [envelope.to, envelope.subject, envelope.claim]) {
    if (!s) continue;
    const m = AGENT_RE.exec(s);
    if (m) return Number.parseInt(m[1]!, 10);
  }
  return null;
}

/** Collect deliberate envelopes from agent transcript entries. */
export function collectPeerStancesFromTranscript(
  entries: readonly { role?: string; agentIndex?: number; text?: string }[],
): PeerDeliberationStanceRecord[] {
  const out: PeerDeliberationStanceRecord[] = [];
  for (const e of entries) {
    if (e.role !== "agent" || typeof e.agentIndex !== "number") continue;
    const text = e.text ?? "";
    for (const env of parseDeliberateEnvelopes(text)) {
      out.push({
        fromAgentIndex: e.agentIndex,
        subject: env.subject,
        claim: env.claim,
        stance: env.stance,
        why: env.why,
        targetAgentIndex: extractTargetAgentIndex(env),
      });
    }
  }
  return out;
}

/**
 * Per-drafter standing from peer stances. Unmentioned agents get zeros
 * (neither rejected nor supported).
 */
export function standingsFromPeerStances(
  agentIndexes: readonly number[],
  stances: readonly PeerDeliberationStanceRecord[],
): PeerDraftStanding[] {
  const byAgent = new Map<number, PeerDraftStanding>();
  for (const idx of agentIndexes) {
    byAgent.set(idx, {
      agentIndex: idx,
      approves: 0,
      denies: 0,
      challenges: 0,
      validates: 0,
      peerRejected: false,
      peerSupported: false,
      notes: [],
    });
  }

  for (const s of stances) {
    const target = s.targetAgentIndex;
    if (target == null || !byAgent.has(target)) continue;
    // Self-stances don't count toward peer validation.
    if (target === s.fromAgentIndex) continue;
    const row = byAgent.get(target)!;
    if (s.stance === "approve") row.approves++;
    else if (s.stance === "deny") row.denies++;
    else if (s.stance === "challenge") row.challenges++;
    else if (s.stance === "validate") row.validates++;
    const note = `agent-${s.fromAgentIndex} ${s.stance}: ${s.why || s.claim}`.slice(0, 160);
    if (row.notes.length < 6) row.notes.push(note);
  }

  for (const row of byAgent.values()) {
    row.peerRejected = row.denies > 0 && row.denies > row.approves;
    row.peerSupported = row.approves > 0 && row.approves >= row.denies;
  }

  return agentIndexes.map((i) => byAgent.get(i)!);
}

/** Markdown block for synthesis / vote prompts. Empty when no peer stances. */
export function formatPeerStandingBlock(standings: readonly PeerDraftStanding[]): string {
  const interesting = standings.filter(
    (s) => s.approves + s.denies + s.challenges + s.validates > 0,
  );
  if (interesting.length === 0) return "";
  const lines = [
    "=== PEER REASON VALIDATION (from ```deliberate``` envelopes) ===",
    "Honor peer deny/challenge: do NOT treat peer-rejected drafts as consensus winners",
    "unless stronger evidence overturns the denies. Prefer peer-supported drafts.",
    "",
  ];
  for (const s of interesting) {
    const flag = s.peerRejected
      ? "PEER-REJECTED"
      : s.peerSupported
        ? "peer-supported"
        : "mixed";
    lines.push(
      `agent-${s.agentIndex}: ${flag} (approve=${s.approves} deny=${s.denies} challenge=${s.challenges} validate=${s.validates})`,
    );
    for (const n of s.notes.slice(0, 3)) {
      lines.push(`  - ${n}`);
    }
  }
  lines.push("=== end peer reason validation ===");
  return lines.join("\n");
}

/**
 * For vote tallies: filter out peer-rejected winners when a non-rejected
 * alternative exists. Pure — returns adjusted winner index or original.
 */
export function preferNonRejectedWinner(
  winnerIndex: number | null,
  standings: readonly PeerDraftStanding[],
  validIndexes: readonly number[],
): { winnerIndex: number | null; overridden: boolean; reason?: string } {
  if (winnerIndex == null) return { winnerIndex: null, overridden: false };
  const byIdx = new Map(standings.map((s) => [s.agentIndex, s]));
  const win = byIdx.get(winnerIndex);
  if (!win?.peerRejected) return { winnerIndex, overridden: false };

  // Prefer peer-supported, else any non-rejected among valid.
  const supported = validIndexes.filter((i) => byIdx.get(i)?.peerSupported);
  if (supported.length > 0) {
    const alt = Math.min(...supported);
    return {
      winnerIndex: alt,
      overridden: true,
      reason: `agent-${winnerIndex} peer-rejected; promoting peer-supported agent-${alt}`,
    };
  }
  const clean = validIndexes.filter((i) => !byIdx.get(i)?.peerRejected);
  if (clean.length > 0) {
    const alt = Math.min(...clean);
    return {
      winnerIndex: alt,
      overridden: true,
      reason: `agent-${winnerIndex} peer-rejected; promoting non-rejected agent-${alt}`,
    };
  }
  return {
    winnerIndex,
    overridden: false,
    reason: `agent-${winnerIndex} peer-rejected but no alternative draft`,
  };
}
