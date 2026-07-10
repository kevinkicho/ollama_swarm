// Debate stream/cycle helpers — extracted from DebateJudgeRunner.

import type { Agent, AgentManager } from "../services/AgentManager.js";
import type { TranscriptEntry, TranscriptEntrySummary } from "../types.js";
import type { RunConfig } from "./SwarmRunner.js";
import { extractText } from "./extractText.js";
import { promptWithFailoverAuto } from "./promptWithFailoverAuto.js";
import { snapshotLifetimeTokens } from "../services/ollamaProxy.js";
import { OutputEmptyDeadLoopGuard } from "./deadLoopGuard.js";
import { describeSdkError } from "./sdkError.js";
import { deriveProposition, type DerivedProposition } from "./propositionDerive.js";
import { DebateStream } from "./DebateStream.js";
import {
  DEFAULT_PROPOSITION,
  buildDebaterPrompt,
  buildJudgePrompt,
  scanImplementerForNoOp,
  buildImplementerPrompt,
  buildReviewerPrompt,
  buildSignoffPrompt,
  type ParsedDebateVerdict,
  parseDebateVerdict,
  buildCrossStreamJudgePrompt,
  parseCrossStreamPick,
} from "./debatePromptHelpers.js";

export interface DebateStreamsHost {
  manager: AgentManager;
  transcript: TranscriptEntry[];
  proposition: string | undefined;
  logDiag?: (entry: unknown) => void;
  getStopping: () => boolean;
  setEarlyStopDetail: (d: string | undefined) => void;
  appendSystem: (text: string, summary?: unknown) => void;
  checkRoundBudget: (
    cfg: RunConfig,
    unit: string,
    r: number,
    tokenBaseline: ReturnType<typeof snapshotLifetimeTokens>,
  ) => boolean;
  runAgent: (
    agent: Agent,
    prompt: string,
    debateTag?: { role: "pro" | "con" | "judge"; round: number },
    enrichSummary?: (text: string) => TranscriptEntrySummary | undefined,
    agentName?: "swarm" | "swarm-read",
    stream?: DebateStream,
  ) => Promise<void>;
}

export async function runSingleStreamDebate(
host: DebateStreamsHost,
agents: { pro: Agent; con: Agent; judge: Agent },
  proposition: string,
  cfg: RunConfig,
  stream?: DebateStream,
): Promise<ParsedDebateVerdict | null> {
  const { pro, con, judge } = agents;
  // Phase B (Task #94): one preliminary judge pass at the loop
  // midpoint. If the judge says confidence:high we end early —
  // continuing past a confident verdict just burns tokens.
  const earlyCheckRound = cfg.rounds >= 4 ? Math.ceil(cfg.rounds / 2) : 0;
  let finalVerdict: ParsedDebateVerdict | null = null;
  // 2026-05-03 (Phase B): budget + dead-loop guards extracted to shared helpers.
  const tokenBaseline = snapshotLifetimeTokens();
  const deadLoopGuard = new OutputEmptyDeadLoopGuard({
    roleLabel: "agents",
    unit: "round",
  });
  for (let r = 1; r <= cfg.rounds; r++) {
    if (!host.checkRoundBudget(cfg, "round", r, tokenBaseline)) break;

    const isFinalRound = r === cfg.rounds;
    // Track stream-local OR main-transcript additions for the
    // dead-loop guard. Stream-mode reads stream.transcript; legacy
    // single-stream reads host.transcript.
    const transcriptLenBefore = stream
      ? stream.transcript.length
      : host.transcript.length;
    // PRO turn
    await runDebaterTurn(host, pro, "pro", r, cfg.rounds, proposition, isFinalRound, cfg.userDirective, stream);
    if (host.getStopping()) break;
    // CON turn
    await runDebaterTurn(host, con, "con", r, cfg.rounds, proposition, isFinalRound, cfg.userDirective, stream);
    if (host.getStopping()) break;
    // Task #146: dead-loop guard. If both PRO and CON produced empty/junk
    // output this round, count it. After N consecutive empty rounds, break.
    const tail = stream
      ? stream.transcript.slice(transcriptLenBefore)
      : host.transcript.slice(transcriptLenBefore);
    const newEntries = tail.filter((e) => e.role === "agent");
    const dlHit = deadLoopGuard.recordIteration(newEntries);
    if (dlHit.tripped) {
      host.setEarlyStopDetail(dlHit.earlyStopDetail);
      host.appendSystem(
        `Both debaters produced empty/junk output for ${dlHit.consecutive} consecutive rounds — ending debate early${stream ? ` (${stream.id})` : ""}.`,
      );
      break;
    }
    // JUDGE turn (only on the final round, OR mid-loop when we
    // hit the early-check checkpoint).
    if (isFinalRound) {
      finalVerdict = await runJudgeTurn(host, judge, proposition, r, cfg.userDirective, stream);
    } else if (r === earlyCheckRound) {
      finalVerdict = await runJudgeTurn(host, judge, proposition, r, cfg.userDirective, stream);
      if (finalVerdict?.confidence === "high") {
        // Multi-stream mode: each stream may early-stop independently.
        // We DON'T set this.earlyStopDetail in that case (it would
        // misleadingly imply the whole run early-stopped).
        if (!stream) {
          host.setEarlyStopDetail(`judge-confidence-high after round ${r}/${cfg.rounds}`);
        }
        host.appendSystem(
          `Judge reached confidence:high at round ${r}/${cfg.rounds}${stream ? ` (${stream.id})` : ""} — ending debate early.`,
        );
        break;
      }
    }
  }
  return finalVerdict;
}

// T-Item-2 (2026-05-04): K parallel debate streams. Derives K
// distinct propositions in parallel, creates K DebateStream
// instances (sharing PRO + CON agents), runs all K debates IN
// PARALLEL, then fires ONE cross-stream judge synthesis prompt to
// pick the canonical verdict.
//
// Returns the canonical verdict — picked from the winning stream.
// If cross-stream synthesis fails to parse, falls back to the
// first stream with a non-null verdict.

export async function runMultiStreamDebate(
host: DebateStreamsHost,
agents: { pro: Agent; con: Agent; judge: Agent },
  K: number,
  cfg: RunConfig,
): Promise<ParsedDebateVerdict | null> {
  const { pro, con, judge } = agents;
  host.appendSystem(
    `[T-Item-2 parallel debate streams] K=${K} debates running IN PARALLEL with different propositions; cross-stream judge will pick the canonical verdict.`,
  );
  // Derive K propositions in parallel. The directive is required —
  // without it we have nothing to derive variants from. Falls back
  // to repeating the canonical proposition across streams (rare
  // edge case; multi-stream mostly meaningful with a directive).
  const directiveTrimmed = (cfg.userDirective ?? "").trim();
  const propositions: string[] = [];
  if (directiveTrimmed.length > 0) {
    const candidates: DerivedProposition[] = (
      await Promise.all(
        Array.from({ length: K }, () =>
          deriveProposition({
            agent: judge,
            manager: host.manager,
            directive: directiveTrimmed,
          }),
        ),
      )
    ).filter((c): c is DerivedProposition => c !== null);
    const seen = new Set<string>();
    for (const c of candidates) {
      const key = c.proposition.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      propositions.push(c.proposition);
      if (propositions.length === K) break;
    }
  }
  // Pad if we didn't get K unique candidates (or the directive was
  // empty). Reuse the canonical proposition for the remaining slots.
  const fallback = host.proposition ?? DEFAULT_PROPOSITION;
  while (propositions.length < K) propositions.push(fallback);
  host.appendSystem(
    `[T-Item-2] generated ${propositions.length} stream propositions: ${propositions.map((p, i) => `\n  [stream-${i + 1}] "${p}"`).join("")}`,
  );

  const streams = propositions.map(
    (p, i) => new DebateStream({ id: `stream-${i + 1}`, proposition: p, pro, con }),
  );
  // Run all K debates in parallel. Each call mutates its own stream.
  await Promise.all(
    streams.map((s) =>
      runSingleStreamDebate(host, agents, s.proposition, cfg, s).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        host.appendSystem(`[T-Item-2] ${s.id} failed: ${msg}`);
        return null;
      }),
    ),
  );
  if (host.getStopping()) return null;

  // Cross-stream synthesis: pick the most informative verdict.
  const settled = streams.filter((s) => s.verdict !== null);
  if (settled.length === 0) {
    host.appendSystem(`[T-Item-2] all ${K} streams failed to produce a verdict.`);
    return null;
  }
  if (settled.length === 1) {
    host.appendSystem(
      `[T-Item-2] only 1 stream produced a verdict (${settled[0]!.id}); using it as canonical.`,
    );
    return settled[0]!.verdict;
  }
  const pickedId = await runCrossStreamJudge(host, judge, streams, cfg);
  const winner = streams.find((s) => s.id === pickedId) ?? settled[0]!;
  host.appendSystem(
    `[T-Item-2] cross-stream judge picked ${winner.id} (proposition: "${winner.proposition}") as canonical verdict.`,
  );
  return winner.verdict;
}

// T-Item-2 (2026-05-04): cross-stream judge. Returns the picked
// stream id or null on failure (caller falls back to first settled).

export async function runCrossStreamJudge(
host: DebateStreamsHost,
judge: Agent,
  streams: readonly DebateStream[],
  cfg: RunConfig,
): Promise<string | null> {
  const prompt = buildCrossStreamJudgePrompt({
    streams: streams.map((s) => ({
      id: s.id,
      proposition: s.proposition,
      verdict: s.verdict,
    })),
    userDirective: cfg.userDirective,
  });
  let raw: string | undefined;
  try {
    // W19 (2026-05-04): swapped to promptWithFailoverAuto for R1 chain.
    const res = await promptWithFailoverAuto(judge, prompt, {
      signal: new AbortController().signal,
      manager: host.manager,
      agentName: "swarm-read",
      describeError: describeSdkError,
    });
    raw = extractText(res) ?? "";
  } catch {
    return null;
  }
  if (!raw) return null;
  const validIds = streams.map((s) => s.id);
  const pick = parseCrossStreamPick(raw, validIds);
  return pick?.winnerStreamId ?? null;
}


export async function runDebaterTurn(
host: DebateStreamsHost,
agent: Agent,
  side: "pro" | "con",
  round: number,
  totalRounds: number,
  proposition: string,
  isFinalRound: boolean,
  userDirective?: string,
  stream?: DebateStream,
): Promise<void> {
  // T-Item-2 (2026-05-04): when a stream is supplied, scope the
  // prompt's transcript view to ONLY this stream's entries (each
  // stream debates a different proposition; cross-feeding their
  // transcripts would have PRO/CON arguing past each other).
  const transcriptView = stream
    ? [...stream.transcript]
    : [...host.transcript];
  const prompt = buildDebaterPrompt({
    side,
    round,
    totalRounds,
    proposition,
    isFinalRound,
    transcript: transcriptView,
    userDirective,
  });
  // Phase 2c: tag so VerdictPanel can group PRO/CON pairs by round.
  await host.runAgent(agent, prompt, { role: side, round }, undefined, "swarm-read", stream);
}

// Task #102: post-verdict "build" round. Three turns total (one
// per agent), only fires when the user opted in via
// cfg.executeNextAction AND the verdict is high/medium confidence
// with a non-tie winner. PRO uses write-capable tools to action
// the verdict's nextAction; CON inspects the changes and flags
// issues; JUDGE signs off (or rejects).

export async function runNextActionPhase(
host: DebateStreamsHost,
pro: Agent,
  con: Agent,
  judge: Agent,
  proposition: string,
  verdict: ParsedDebateVerdict,
  userDirective?: string,
): Promise<void> {
  host.appendSystem(
    `Build phase: PRO will implement the next-action recommendation; CON reviews; JUDGE signs off.`,
    { kind: "next_action_phase", role: "announcement" },
  );

  // Implementer (PRO with write tools)
  if (host.getStopping()) return;
  const implPrompt = buildImplementerPrompt(proposition, verdict, userDirective);
  await host.runAgent(
    pro,
    implPrompt,
    undefined,
    () => ({ kind: "next_action_phase", role: "implementer" }),
    "swarm",
  );

  // Task #135: scan the implementer's last entry for evidence of
  // actual edits (CHANGED: lines or src-path:line citations). When
  // missing, log a structured diagnostic so the next signoff-rejection
  // failure has data to RCA from. Doesn't retry — the reviewer +
  // signoff still see the text and can call it out, this is purely
  // observability for now.
  const lastImpl = host.transcript[host.transcript.length - 1];
  if (lastImpl?.role === "agent") {
    const noopHints = scanImplementerForNoOp(lastImpl.text);
    if (noopHints.likelyNoOp) {
      host.logDiag?.({
        type: "debate_implementer_noop_suspected",
        agentId: lastImpl.agentId,
        reasons: noopHints.reasons,
        textLen: lastImpl.text.length,
        ts: Date.now(),
      });
      host.appendSystem(
        `Implementer warning: response shows no evidence of edits (${noopHints.reasons.join(", ")}). Reviewer/signoff may reject.`,
        { kind: "next_action_phase", role: "announcement" },
      );
    }
  }

  // Reviewer (CON, read-only)
  if (host.getStopping()) return;
  const reviewerPrompt = buildReviewerPrompt(proposition, verdict, [...host.transcript], userDirective);
  await host.runAgent(
    con,
    reviewerPrompt,
    undefined,
    () => ({ kind: "next_action_phase", role: "reviewer" }),
  );

  // Signoff (JUDGE, read-only)
  if (host.getStopping()) return;
  const signoffPrompt = buildSignoffPrompt(proposition, verdict, [...host.transcript], userDirective);
  await host.runAgent(
    judge,
    signoffPrompt,
    undefined,
    () => ({ kind: "next_action_phase", role: "signoff" }),
  );
}

// T199 (2026-05-04): rank N candidate propositions + return the
// winning index. Judge fires one dedicated prompt that lists the
// candidates + asks for the most informative pick + rationale.
// Returns null on any failure (caller falls back to first-non-fallback).

export async function runJudgeTurn(
host: DebateStreamsHost,
judge: Agent,
  proposition: string,
  round: number,
  userDirective?: string,
  stream?: DebateStream,
): Promise<ParsedDebateVerdict | null> {
  // T-Item-2 (2026-05-04): scope transcript view to this stream when
  // running a stream-local judge turn.
  const transcriptView = stream
    ? [...stream.transcript]
    : [...host.transcript];
  const prompt = buildJudgePrompt({ proposition, transcript: transcriptView, userDirective });
  // Task #81: try to parse the JUDGE response as a structured
  // verdict and upgrade the summary tag. Falls back to plain
  // debate_turn if JSON parse fails — the freeform text still
  // lands in the transcript.
  // Task #94: capture the parsed verdict so the loop can use
  // confidence:high as an early-stop signal.
  let parsed: ParsedDebateVerdict | null = null;
  await host.runAgent(
    judge,
    prompt,
    { role: "judge", round },
    (text) => {
      parsed = parseDebateVerdict(text);
      if (!parsed) return undefined;
      return { kind: "debate_verdict", round, ...parsed };
    },
    "swarm-read",
    stream,
  );
  if (parsed && stream) stream.verdict = parsed;
  return parsed;
}

// Phase 2c: transcript tag so the VerdictPanel can identify each
// turn's role + round without guessing by agent-index order.
// Task #81: enrichSummary lets the caller (e.g. runJudgeTurn)
// post-process the text and upgrade the basic debate_turn tag to
// a richer kind like debate_verdict.
// Task #102: agentName param defaults to "swarm-read" (preserves
// existing discussion-only behavior) — debate/judge turns pass it
// through; the post-verdict implementer turn passes "swarm" to get
// file-edit tools.
