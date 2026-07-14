// councilSynthesis.ts — Synthesis pass for Council preset
// Extracted from CouncilRunner.ts to keep LOC under 500 per file.

import { randomUUID } from "node:crypto";
import type { Agent } from "../services/AgentManager.js";
import type { RunConfig } from "./SwarmRunner.js";
import type { TranscriptEntry } from "../types.js";
import { promptWithFailoverAuto } from "./promptWithFailoverAuto.js";
import { extractProviderText } from "./councilUtils.js";
import { startSseAwareTurnWatchdog } from "./sseAwareTurnWatchdog.js";
import { extractTextWithDiag, looksLikeJunk, trackPostRetryJunk } from "./extractText.js";
import { retryEmptyResponse } from "./promptAndExtract.js";
import { describeSdkError } from "./sdkError.js";
import { buildCouncilSynthesisPrompt } from "./councilPromptHelpers.js";
import { runPostSynthesisCritique } from "./postSynthesisCritique.js";
import { parseConvergenceSignal } from "./convergenceSignal.js";
import { stripAgentText } from "@ollama-swarm/shared/stripAgentText";
import { resolveCouncilToolProfile } from "./toolProfiles.js";
import type { SwarmControlCenter } from "./control/SwarmControlCenter.js";
import { buildCouncilToolCoachHook } from "./control/councilControlHooks.js";
import {
  buildDissentSynthesisPrompt,
  parseDissentSynthesis,
  renderDissentSynthesisMarkdown,
} from "./dissentPreservation.js";
import {
  buildJudgePickPrompt,
  buildVotePrompt,
  buildVoteWinnerPresentPrompt,
  formatVoteTallySummary,
  latestDraftsByAgent,
  parseVoteResponse,
  tallyVotes,
  type VoteRecord,
} from "./councilReconcile.js";


export interface SynthesisContext {
  manager: { list: () => Agent[]; markStatus: (id: string, status: string) => void; recordPromptComplete: (id: string, data: any) => void };
  emit: (event: Record<string, unknown>) => void;
  appendSystem: (msg: string) => void;
  logDiag: (entry: Record<string, unknown>) => void;
  getSwarmControl?: () => SwarmControlCenter;
  getCoachAgent?: () => Agent | undefined;
}

export interface SynthesisStats {
  countTurn: (id: string) => void;
  recordTokens: (id: string, prompt: number, response: number) => void;
  onTiming: (id: string, success: boolean, elapsedMs: number) => void;
  onRetry: (id: string) => void;
  recordJunkPostRetry: (id: string, junk: boolean) => void;
}

export async function runSynthesisPass(
  cfg: RunConfig,
  transcript: TranscriptEntry[],
  stopping: boolean,
  stats: SynthesisStats,
  runDiscussionAgent: (agent: Agent, prompt: string, opts: any) => Promise<string>,
  ctx: SynthesisContext,
  committedFiles?: string[],
  ambitionTier?: number,
  repoFiles?: string[],
  codeContextExcerpts?: ReadonlyArray<{ path: string; excerpt: string }>,
): Promise<"high" | "medium" | "low" | null> {
  const agents = ctx.manager.list();
  const lead = agents.find((a) => a.index === 1);
  if (!lead) return null;

  ctx.manager.markStatus(lead.id, "thinking");
  ctx.emit({
    type: "agent_state",
    id: lead.id,
    index: lead.index,
    sessionId: lead.sessionId,
    status: "thinking",
    thinkingSince: Date.now(),
  });
  stats.countTurn(lead.id);
  ctx.appendSystem(`Synthesizing council consensus (agent-${lead.index})…`);

  // Q5: opt-in three-section synthesis (majority / minority / open Qs).
  // councilReconcile: "judge" = lead picks one; "vote" = ballots then present winner.
  let prompt: string;
  const recentDrafts = () =>
    transcript
      .filter((e) => e.role === "agent" && typeof e.agentIndex === "number")
      .slice(-Math.max(3, cfg.agentCount * 2))
      .map((e) => ({ agentIndex: e.agentIndex as number, text: e.text }));

  if (cfg.preserveDissent) {
    const drafts = recentDrafts();
    prompt = buildDissentSynthesisPrompt({
      question: cfg.userDirective?.trim() || "Synthesize the council discussion.",
      drafts,
      userDirective: cfg.userDirective,
    });
    ctx.appendSystem("[Q5] Dissent-preserving synthesis prompt (majority + minority + open questions).");
  } else if (cfg.councilReconcile === "judge") {
    const drafts = recentDrafts();
    prompt = buildJudgePickPrompt({
      drafts,
      userDirective: cfg.userDirective,
    });
    ctx.appendSystem("[councilReconcile=judge] Lead picks ONE draft as canonical (not merge).");
  } else if (cfg.councilReconcile === "vote" && !stopping) {
    const drafts = latestDraftsByAgent(recentDrafts());
    const validIndexes = drafts.map((d) => d.agentIndex);
    if (drafts.length < 2) {
      ctx.appendSystem(
        "[councilReconcile=vote] Fewer than 2 drafts — falling back to revise+merge synthesis.",
      );
      prompt = buildCouncilSynthesisPrompt(
        cfg.rounds,
        transcript,
        cfg.userDirective,
        committedFiles,
        ambitionTier,
        cfg.localPath,
        repoFiles,
        codeContextExcerpts,
        cfg.model,
      );
    } else {
      ctx.appendSystem(
        `[councilReconcile=vote] Collecting ballots from ${drafts.length} drafter(s)…`,
      );
      const votes: VoteRecord[] = [];
      for (const voter of agents) {
        if (stopping) break;
        // Only agents who produced a draft cast a ballot.
        if (!validIndexes.includes(voter.index)) continue;
        const votePrompt = buildVotePrompt({
          voterIndex: voter.index,
          drafts,
          userDirective: cfg.userDirective,
        });
        ctx.manager.markStatus(voter.id, "thinking");
        ctx.emit({
          type: "agent_state",
          id: voter.id,
          index: voter.index,
          sessionId: voter.sessionId,
          status: "thinking",
          thinkingSince: Date.now(),
        });
        stats.countTurn(voter.id);
        try {
          const voteCtrl = new AbortController();
          const voteRes = await promptWithFailoverAuto(voter, votePrompt, {
            signal: voteCtrl.signal,
            manager: ctx.manager as any,
            agentName: resolveCouncilToolProfile(cfg),
            webToolsConfig: cfg,
            activity: { kind: "council", label: "vote" },
            promptAddendum: "",
            describeError: describeSdkError,
            runId: cfg.runId,
            onTokens: ({
              promptTokens,
              responseTokens,
            }: {
              promptTokens: number;
              responseTokens: number;
            }) => stats.recordTokens(voter.id, promptTokens, responseTokens),
            onTiming: ({
              attempt,
              elapsedMs,
              success,
            }: {
              attempt: number;
              elapsedMs: number;
              success: boolean;
            }) => {
              stats.onTiming(voter.id, success, elapsedMs);
              ctx.manager.recordPromptComplete(voter.id, {
                attempt,
                elapsedMs,
                success,
              });
            },
            onRetry: () => stats.onRetry(voter.id),
          });
          const raw =
            extractProviderText(voteRes)
            || extractTextWithDiag(voteRes, {
              runner: "council",
              agentId: voter.id,
              agentIndex: voter.index,
              logDiag: ctx.logDiag,
            }).text;
          const parsed = parseVoteResponse(raw, voter.index);
          votes.push({
            voterIndex: voter.index,
            votedForIndex: parsed.votedForIndex,
            rationale: parsed.rationale,
          });
          ctx.appendSystem(
            parsed.votedForIndex != null
              ? `[vote] agent-${voter.index} → agent-${parsed.votedForIndex}${
                  parsed.rationale ? ` (${parsed.rationale.slice(0, 80)})` : ""
                }`
              : `[vote] agent-${voter.index} abstained (parse fail or self-vote)`,
          );
        } catch (err) {
          votes.push({
            voterIndex: voter.index,
            votedForIndex: null,
            rationale: "",
          });
          ctx.appendSystem(
            `[vote] agent-${voter.index} failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        } finally {
          ctx.manager.markStatus(voter.id, "idle");
          ctx.emit({
            type: "agent_state",
            id: voter.id,
            index: voter.index,
            sessionId: voter.sessionId,
            status: "idle",
          });
        }
      }

      const tally = tallyVotes(votes, validIndexes);
      const tallySummary = formatVoteTallySummary(tally);
      ctx.appendSystem(`[councilReconcile=vote] Tally: ${tallySummary}`);

      if (tally.winnerIndex != null) {
        const winnerDraft = drafts.find((d) => d.agentIndex === tally.winnerIndex);
        if (winnerDraft) {
          prompt = buildVoteWinnerPresentPrompt({
            winnerIndex: tally.winnerIndex,
            winnerText: winnerDraft.text,
            tallySummary,
            userDirective: cfg.userDirective,
          });
          ctx.appendSystem(
            `[councilReconcile=vote] Winner agent-${tally.winnerIndex} — lead presents winning draft.`,
          );
        } else {
          prompt = buildCouncilSynthesisPrompt(
            cfg.rounds,
            transcript,
            cfg.userDirective,
            committedFiles,
            ambitionTier,
            cfg.localPath,
            repoFiles,
            codeContextExcerpts,
            cfg.model,
          );
          ctx.appendSystem(
            "[councilReconcile=vote] Winner draft missing — falling back to revise+merge.",
          );
        }
      } else {
        prompt = buildCouncilSynthesisPrompt(
          cfg.rounds,
          transcript,
          cfg.userDirective,
          committedFiles,
          ambitionTier,
          cfg.localPath,
          repoFiles,
          codeContextExcerpts,
          cfg.model,
        );
        ctx.appendSystem(
          "[councilReconcile=vote] No decisive winner — falling back to revise+merge synthesis.",
        );
      }
    }
  } else {
    prompt = buildCouncilSynthesisPrompt(cfg.rounds, transcript, cfg.userDirective, committedFiles, ambitionTier, cfg.localPath, repoFiles, codeContextExcerpts, cfg.model);
  }

  // Vote ballots may have left the lead idle — restore synthesis status.
  ctx.manager.markStatus(lead.id, "thinking");
  ctx.emit({
    type: "agent_state",
    id: lead.id,
    index: lead.index,
    sessionId: lead.sessionId,
    status: "thinking",
    thinkingSince: Date.now(),
  });

  const controller = new AbortController();
  const watchdog = startSseAwareTurnWatchdog({
    manager: ctx.manager as any,
    sessionId: lead.sessionId,
    controller,
    abortSession: async () => {},
  });

  try {
    const onTokens = ({ promptTokens, responseTokens }: { promptTokens: number; responseTokens: number }) => stats.recordTokens(lead.id, promptTokens, responseTokens);
    const res = await promptWithFailoverAuto(lead, prompt, {
      onTokens,
      signal: controller.signal,
      manager: ctx.manager as any,
      agentName: resolveCouncilToolProfile(cfg),
      webToolsConfig: cfg,
      activity: {
        kind: "council",
        label: cfg.councilReconcile === "vote" ? "synthesis-vote-winner" : "synthesis",
      },
      promptAddendum: "",
      describeError: describeSdkError,
      onToolResultHook: buildCouncilToolCoachHook(lead, {
        getSwarmControl: ctx.getSwarmControl,
        getCoachAgent: ctx.getCoachAgent,
        clonePath: cfg.localPath,
        runId: cfg.runId,
        manager: ctx.manager as any,
        appendSystem: ctx.appendSystem,
        emit: ctx.emit as (e: import("../types.js").SwarmEvent) => void,
      }),
      runId: cfg.runId,
      onTiming: ({ attempt, elapsedMs, success }: { attempt: number; elapsedMs: number; success: boolean }) => {
        stats.onTiming(lead.id, success, elapsedMs);
        ctx.manager.recordPromptComplete(lead.id, { attempt, elapsedMs, success });
        ctx.emit({
          type: "agent_latency_sample",
          agentId: lead.id,
          agentIndex: lead.index,
          attempt,
          elapsedMs,
          success,
          ts: Date.now(),
        });
      },
      onRetry: ({ attempt, max, reasonShort, delayMs }: { attempt: number; max: number; reasonShort: string; delayMs: number }) => {
        stats.onRetry(lead.id);
        ctx.appendSystem(
          `[${lead.id}] transport error (${reasonShort}) — retry ${attempt}/${max} in ${Math.round(delayMs / 1000)}s`,
        );
      },
    });

    const diagCtx = {
      runner: "council",
      agentId: lead.id,
      agentIndex: lead.index,
      logDiag: ctx.logDiag,
      manager: ctx.manager as import("../services/AgentManager.js").AgentManager,
      signal: controller.signal,
    };
    const extracted = extractTextWithDiag(res, diagCtx);
    let text = extracted.text;
    if ((extracted.isEmpty || looksLikeJunk(text)) && !stopping) {
      const retryText = await retryEmptyResponse(
        lead,
        prompt,
        resolveCouncilToolProfile(cfg),
        diagCtx,
      );
      if (retryText !== null) text = retryText;
    }

    trackPostRetryJunk(text, {
      agentId: lead.id,
      recordJunkPostRetry: (id, j) => { stats.recordJunkPostRetry(id, j); return 0; },
      appendSystem: (msg) => ctx.appendSystem(msg),
    });

    if (cfg.preserveDissent && text) {
      const parsedDissent = parseDissentSynthesis(text);
      if (parsedDissent) {
        text = renderDissentSynthesisMarkdown(parsedDissent);
        ctx.appendSystem("[Q5] Parsed dissent-preserving synthesis into majority/minority/open-questions sections.");
      }
    }

    const isJunkSynthesis = looksLikeJunk(text) || extracted.isEmpty;
    if (cfg.postSynthesisCritique && !isJunkSynthesis && text.length > 0) {
      const proposals = transcript
        .filter(e => e.role === "agent")
        .slice(-ctx.manager.list().length)
        .map(e => ({ workerId: `agent-${e.agentIndex}`, text: e.text }));
      const criticAgent = ctx.manager.list().find((a) => a.index === 1) ?? lead;
      const revised = await runPostSynthesisCritique({
        synthesis: text,
        proposals,
        criticAgent,
        manager: ctx.manager as any,
        appendSystem: (txt) => ctx.appendSystem(txt),
        stopping,
        runDiscussionAgent,
        stats: stats as any,
        presetName: "council",
      });
      text = revised;
    }

    const stripped = stripAgentText(text);
    const entry: TranscriptEntry = {
      id: randomUUID(),
      role: "agent",
      agentId: lead.id,
      agentIndex: lead.index,
      text: stripped.finalText || "(empty response)",
      ts: Date.now(),
      summary: isJunkSynthesis
        ? undefined
        : { kind: "council_synthesis", rounds: cfg.rounds } as any,
      ...(stripped.thoughts.length > 0 ? { thoughts: stripped.thoughts } : {}),
      ...(stripped.toolCalls.length > 0 ? { toolCalls: stripped.toolCalls } : {}),
    } as TranscriptEntry;
    transcript.push(entry);
    ctx.emit({ type: "transcript_append", entry });

    if (isJunkSynthesis) {
      ctx.appendSystem(
        `[${lead.id}] synthesis text is degenerate (${text.length} chars) — kept in transcript but NOT tagged as canonical synthesis.`,
      );
      return null;
    }

    return parseConvergenceSignal(text);
  } catch (err) {
    ctx.appendSystem(
      `[${lead.id}] synthesis failed (${err instanceof Error ? err.message : String(err)}); skipping consolidation.`,
    );
    return null;
  } finally {
    watchdog.cancel();
    ctx.manager.markStatus(lead.id, "ready");
    ctx.emit({
      type: "agent_state",
      id: lead.id,
      index: lead.index,
      sessionId: lead.sessionId,
      status: "ready",
      lastMessageAt: Date.now(),
    });
  }
}
