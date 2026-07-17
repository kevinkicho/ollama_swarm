// Round-robin / role-diff convergence + synthesis passes — extracted from RoundRobinRunner.

import { randomUUID } from "node:crypto";
import type { Agent, AgentManager } from "../services/AgentManager.js";
import type {
  AgentState,
  SwarmEvent,
  TranscriptEntry,
} from "../types.js";
import type { RunConfig } from "./SwarmRunner.js";
import type { SwarmRole } from "./roles.js";
import { startSseAwareTurnWatchdog } from "./sseAwareTurnWatchdog.js";
import { promptWithFailoverAuto } from "./promptWithFailoverAuto.js";
import { detectSemanticConvergence } from "./semanticConvergence.js";
import { detectConvergence as detectJaccardConvergence } from "./moaConsensus.js";
import { extractTextWithDiag, looksLikeJunk, trackPostRetryJunk } from "./extractText.js";
import { retryEmptyResponse } from "./promptAndExtract.js";
import { finalizeAgentOutput } from "@ollama-swarm/shared/finalizeAgentOutput";
import { getAgentAddendum } from "@ollama-swarm/shared/topology";
import { describeSdkError } from "./sdkError.js";
import {
  parseConvergenceSignal,
  parseConvergenceSignalLoose,
} from "./convergenceSignal.js";
import {
  buildStructuredSynthesisPrompt,
  buildRoleDiffSynthesisPrompt,
} from "./roundRobinPromptHelpers.js";

export type ConvergenceLevel = "high" | "medium" | "low" | null;

export interface RoundRobinSynthesisHost {
  manager: AgentManager;
  transcript: TranscriptEntry[];
  ollamaBaseUrl: string | undefined;
  getStopping: () => boolean;
  getRoles: () => readonly SwarmRole[] | undefined;
  getTopology: () => RunConfig["topology"] | undefined;
  getProviderFailover: () => RunConfig["providerFailover"] | undefined;
  getRunId: () => string | undefined;
  logDiag?: (entry: unknown) => void;
  stats: {
    countTurn: (id: string) => void;
    recordTokens: (id: string, prompt: number, response: number) => void;
    onTiming: (id: string, success: boolean, elapsedMs: number) => void;
    onRetry: (id: string) => void;
    recordJunkPostRetry: (id: string, junk: boolean) => number;
  };
  appendSystem: (text: string) => void;
  emit: (e: SwarmEvent) => void;
  emitAgentState: (s: AgentState) => void;
}

/** Semantic / Jaccard convergence of last agent's successive turns. */
export async function checkStructuredConvergence(
  host: RoundRobinSynthesisHost,
): Promise<boolean> {
  const agents = host.manager.list();
  if (agents.length === 0) return false;
  // The last agent's turn this round vs last round.
  const agentEntries = host.transcript.filter(
    (e) => e.role === "agent" && e.agentIndex === agents[agents.length - 1].index,
  );
  if (agentEntries.length < 2) return false;
  const current = agentEntries[agentEntries.length - 1].text;
  const prior = agentEntries[agentEntries.length - 2].text;
  if (!current || !prior) return false;
  const ollamaBaseUrl = host.ollamaBaseUrl;
  if (ollamaBaseUrl) {
    const semantic = await detectSemanticConvergence({
      prior,
      current,
      ollamaBaseUrl,
      threshold: 0.85,
    });
    if (semantic !== null) {
      host.appendSystem(
        `[improvement #3] Convergence check: embedding cosine=${semantic.similarity.toFixed(3)} (threshold ${semantic.threshold.toFixed(3)})`,
      );
      return semantic.converged;
    }
  }
  // Fallback: Jaccard when embedding model unavailable
  const verdict = detectJaccardConvergence(prior, current, 0.7);
  host.appendSystem(
    `[improvement #3] Convergence check (Jaccard fallback): jaccard=${verdict.similarity.toFixed(3)} (threshold ${verdict.threshold})`,
  );
  return verdict.converged;
}

/** Final synthesis pass for the no-roles structured-deliberation case. */
export async function runStructuredSynthesisPass(
  host: RoundRobinSynthesisHost,
  cfg: RunConfig,
): Promise<ConvergenceLevel> {
  const agents = host.manager.list();
  const lead = agents.find((a) => a.index === 1);
  if (!lead) return null;
  if (host.getStopping()) return null;
  host.manager.markStatus(lead.id, "thinking");
  host.emitAgentState({
    id: lead.id,
    index: lead.index,
    port: lead.port,
    sessionId: lead.sessionId,
    status: "thinking",
    thinkingSince: Date.now(),
  });
  host.stats.countTurn(lead.id);
  host.appendSystem(`[improvement #4] Synthesizing structured deliberation (agent-${lead.index})…`);
  const prompt = buildStructuredSynthesisPrompt(cfg.rounds, host.transcript, cfg.userDirective);
  const controller = new AbortController();
  const watchdog = startSseAwareTurnWatchdog({
    manager: host.manager,
    sessionId: lead.sessionId,
    controller,
    abortSession: async () => {},
  });
  try {
    const res = (await promptWithFailoverAuto(lead, prompt, {
      signal: controller.signal,
      manager: host.manager,
      onTokens: ({ promptTokens, responseTokens }) => host.stats.recordTokens(lead.id, promptTokens, responseTokens),
      agentName: "swarm-read",
      promptAddendum: getAgentAddendum(host.getTopology(), lead.index),
      describeError: (e) => describeSdkError(e),
    }, host.getProviderFailover())) as { data: { parts: Array<{ type: "text"; text: string }> } };
    const text = (res?.data?.parts?.find((p) => p.type === "text")?.text ?? "").trim();
    if (text.length === 0) {
      host.appendSystem(`[improvement #4] Synthesis returned empty response; skipping.`);
      return null;
    }
    const stripped = finalizeAgentOutput(text, { role: "general" });
    const entry: TranscriptEntry = {
      id: randomUUID(),
      role: "agent",
      agentId: lead.id,
      agentIndex: lead.index,
      text: stripped.finalText || "(empty response)",
      ts: Date.now(),
      // Tag with the existing role_diff_synthesis kind so the UI
      // renders distinctively. role_diff_synthesis was the natural
      // home; the disposition rotation is the structured-deliberation
      // analog of role-diff's specialized roles. Could add a
      // dedicated kind later.
      summary: { kind: "role_diff_synthesis", rounds: cfg.rounds, roles: 0 },
      ...(stripped.thoughts.length > 0 ? { thoughts: stripped.thoughts } : {}),
      ...(stripped.toolCalls.length > 0 ? { toolCalls: stripped.toolCalls } : {}),
    };
    host.transcript.push(entry);
    host.emit({ type: "transcript_append", entry });
    // 2026-05-03 (Phase A): convergence parser unified to shared module.
    // The synthesis-pass path historically used a looser scanner (anywhere
    // in text, not just trailing lines) so we keep that behavior here via
    // parseConvergenceSignalLoose. The role-diff path below uses the strict
    // trailing-3-lines parser via parseConvergenceSignal.
    return parseConvergenceSignalLoose(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    host.appendSystem(`[improvement #4] Synthesis prompt failed (${msg})`);
    return null;
  } finally {
    watchdog.cancel();
    host.manager.markStatus(lead.id, "ready");
    host.emitAgentState({
      id: lead.id,
      index: lead.index,
      port: lead.port,
      sessionId: lead.sessionId,
      status: "ready",
    });
  }
}

/** Role-diff synthesis pass. Tagged "role_diff_synthesis" for the UI. */
export async function runRoleDiffSynthesisPass(
  host: RoundRobinSynthesisHost,
  cfg: RunConfig,
): Promise<ConvergenceLevel> {
  const roles = host.getRoles();
  if (!roles) return null;
  const agents = host.manager.list();
  const lead = agents.find((a) => a.index === 1);
  if (!lead) return null;
  host.manager.markStatus(lead.id, "thinking");
  host.emitAgentState({
    id: lead.id,
    index: lead.index,
    port: lead.port,
    sessionId: lead.sessionId,
    status: "thinking",
    thinkingSince: Date.now(),
  });
  host.stats.countTurn(lead.id);
  host.appendSystem(`Synthesizing role-diff findings (agent-${lead.index})…`);

  const prompt = buildRoleDiffSynthesisPrompt(roles, host.transcript);
  // 2026-04-27: SSE-aware watchdog (see startSseAwareTurnWatchdog).
  const controller = new AbortController();
  const watchdog = startSseAwareTurnWatchdog({
    manager: host.manager,
    sessionId: lead.sessionId,
    controller,
    abortSession: async () => {},
  });
  try {
    const res = await promptWithFailoverAuto(lead, prompt, {
      signal: controller.signal,
      manager: host.manager,
      onTokens: ({ promptTokens, responseTokens }) => host.stats.recordTokens(lead.id, promptTokens, responseTokens),
      agentName: "swarm-read",
      // Phase 5b of #243: per-agent addendum from the topology row.
      promptAddendum: getAgentAddendum(host.getTopology(), lead.index),
      describeError: (e) => describeSdkError(e),
      onTiming: ({ attempt, elapsedMs, success }) => {
        host.stats.onTiming(lead.id, success, elapsedMs);
        host.manager.recordPromptComplete(lead.id, { attempt, elapsedMs, success });
        host.emit({
          type: "agent_latency_sample",
          agentId: lead.id,
          agentIndex: lead.index,
          attempt,
          elapsedMs,
          success,
          ts: Date.now(),
        });
      },
      onRetry: ({ attempt, max, reasonShort, delayMs }) => {
        host.stats.onRetry(lead.id);
        host.appendSystem(
          `[${lead.id}] transport error (${reasonShort}) — retry ${attempt}/${max} in ${Math.round(delayMs / 1000)}s`,
        );
      },
    }, host.getProviderFailover());
    const diagCtx = {
      runner: "role-diff",
      agentId: lead.id,
      agentIndex: lead.index,
      logDiag: host.logDiag,
      manager: host.manager,
      signal: controller.signal,
      runId: host.getRunId(),
    };
    const extracted = extractTextWithDiag(res, diagCtx);
    let text = extracted.text;
    if ((extracted.isEmpty || looksLikeJunk(text)) && !host.getStopping()) {
      const retryText = await retryEmptyResponse(lead, prompt, "swarm-read", diagCtx);
      if (retryText !== null) text = retryText;
    }
    // Task #115: track Pattern 8 stuck-loop, warn on threshold.
    trackPostRetryJunk(text, {
      agentId: lead.id,
      recordJunkPostRetry: (id, j) => host.stats.recordJunkPostRetry(id, j),
      appendSystem: (msg) => host.appendSystem(msg),
    });
    // Task #108: defensive guard — see CouncilRunner.runSynthesisPass.
    const isJunkSynthesis = looksLikeJunk(text) || extracted.isEmpty;
    // #230: strip <think> + XML pseudo-tool-call markers first.
    const strippedSyn = finalizeAgentOutput(text, { role: "general" });
    const entry: TranscriptEntry = {
      id: randomUUID(),
      role: "agent",
      agentId: lead.id,
      agentIndex: lead.index,
      text: strippedSyn.finalText || "(empty response)",
      ts: Date.now(),
      summary: isJunkSynthesis
        ? undefined
        : { kind: "role_diff_synthesis", rounds: cfg.rounds, roles: roles.length },
      ...(strippedSyn.thoughts.length > 0 ? { thoughts: strippedSyn.thoughts } : {}),
      ...(strippedSyn.toolCalls.length > 0 ? { toolCalls: strippedSyn.toolCalls } : {}),
    };
    host.transcript.push(entry);
    host.emit({ type: "transcript_append", entry });
    if (isJunkSynthesis) {
      host.appendSystem(
        `[${lead.id}] role-diff synthesis text is degenerate (${text.length} chars) — kept in transcript but NOT tagged as canonical synthesis.`,
      );
      return null;
    }
    return parseConvergenceSignal(text);
  } catch (err) {
    host.appendSystem(
      `[${lead.id}] role-diff synthesis failed (${err instanceof Error ? err.message : String(err)}); skipping consolidation.`,
    );
    return null;
  } finally {
    watchdog.cancel();
    host.manager.markStatus(lead.id, "ready");
    host.emitAgentState({
      id: lead.id,
      index: lead.index,
      port: lead.port,
      sessionId: lead.sessionId,
      status: "ready",
      lastMessageAt: Date.now(),
    });
  }
}

