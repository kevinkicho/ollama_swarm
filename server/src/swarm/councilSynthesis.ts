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

export interface SynthesisContext {
  manager: { list: () => Agent[]; markStatus: (id: string, status: string) => void; recordPromptComplete: (id: string, data: any) => void };
  emit: (event: Record<string, unknown>) => void;
  appendSystem: (msg: string) => void;
  logDiag: (entry: Record<string, unknown>) => void;
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

  const prompt = buildCouncilSynthesisPrompt(cfg.rounds, transcript, cfg.userDirective, committedFiles, ambitionTier, cfg.localPath, repoFiles, codeContextExcerpts);
  const controller = new AbortController();
  const watchdog = startSseAwareTurnWatchdog({
    manager: ctx.manager,
    sessionId: lead.sessionId,
    controller,
    abortSession: async () => {},
  });

  try {
    const onTokens = ({ promptTokens, responseTokens }: { promptTokens: number; responseTokens: number }) => stats.recordTokens(lead.id, promptTokens, responseTokens);
    const res = await promptWithFailoverAuto(lead, prompt, {
      onTokens,
      signal: controller.signal,
      manager: ctx.manager,
      agentName: "swarm-read",
      promptAddendum: "",
      describeError: describeSdkError,
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
    };
    const extracted = extractTextWithDiag(res, diagCtx);
    let text = extracted.text;
    if ((extracted.isEmpty || looksLikeJunk(text)) && !stopping) {
      const retryText = await retryEmptyResponse(lead, prompt, "swarm-read", diagCtx);
      if (retryText !== null) text = retryText;
    }

    trackPostRetryJunk(text, {
      agentId: lead.id,
      recordJunkPostRetry: (id, j) => stats.recordJunkPostRetry(id, j),
      appendSystem: (msg) => ctx.appendSystem(msg),
    });

    const isJunkSynthesis = looksLikeJunk(text) || extracted.isEmpty;
    if (cfg.postSynthesisCritique && !isJunkSynthesis && text.length > 0) {
      const proposals = transcript
        .filter(e => e.role === "agent")
        .slice(-ctx.manager.list().length)
        .map(e => ({ workerId: `agent-${e.agentIndex}`, text: e.text }));
      const criticAgent = ctx.manager.list()[0] ?? lead;
      const revised = await runPostSynthesisCritique({
        synthesis: text,
        proposals,
        criticAgent,
        manager: ctx.manager,
        appendSystem: (txt) => ctx.appendSystem(txt),
        stopping,
        runDiscussionAgent,
        stats: stats as any,
        presetName: "council",
      });
      text = revised;
    }

    const stripped = { finalText: text, thoughts: [] as string[], toolCalls: [] as unknown[] };
    const entry: TranscriptEntry = {
      id: randomUUID(),
      role: "agent",
      agentId: lead.id,
      agentIndex: lead.index,
      text: stripped.finalText || "(empty response)",
      ts: Date.now(),
      summary: isJunkSynthesis
        ? undefined
        : { kind: "council_synthesis", rounds: cfg.rounds },
      ...(stripped.thoughts.length > 0 ? { thoughts: stripped.thoughts } : {}),
      ...(stripped.toolCalls.length > 0 ? { toolCalls: stripped.toolCalls } : {}),
    };
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
