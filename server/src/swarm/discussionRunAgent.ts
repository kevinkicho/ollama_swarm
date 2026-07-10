// Shared discussion agent prompt pipeline — extracted from DiscussionRunnerBase.runDiscussionAgent.

import { randomUUID } from "node:crypto";
import type { Agent, AgentManager } from "../services/AgentManager.js";
import type {
  AgentState,
  SwarmEvent,
  SwarmPhase,
  TranscriptEntry,
  TranscriptEntrySummary,
} from "../types.js";
import type { RunConfig } from "./SwarmRunner.js";
import { startSseAwareTurnWatchdog } from "./sseAwareTurnWatchdog.js";
import { promptWithFailoverAuto } from "./promptWithFailoverAuto.js";
import { extractTextWithDiag, looksLikeJunk, trackPostRetryJunk } from "./extractText.js";
import { retryEmptyResponse } from "./promptAndExtract.js";
import { stripAgentText } from "@ollama-swarm/shared/stripAgentText";
import { getAgentAddendum } from "@ollama-swarm/shared/topology";
import { describeSdkError } from "./sdkError.js";
import { buildCheckpoint, writeCheckpoint } from "./checkpoint.js";
import type { RunAgentOpts } from "./postRoundCritiqueTypes.js";
import { discussionReaderProfile } from "./discussionToolProfile.js";
import {
  makeBufferedToolHandler,
  takePendingToolTrace,
  type ToolTraceEntry,
} from "./toolCallTranscript.js";
import type { ToolResultHook } from "../tools/ToolDispatcher.js";

export interface DiscussionRunAgentHost {
  manager: AgentManager;
  emit: (e: SwarmEvent) => void;
  logDiag?: (entry: unknown) => void;
  transcript: TranscriptEntry[];
  phase: SwarmPhase;
  round: number;
  active: RunConfig | undefined;
  pendingToolTraceByAgent: Map<string, ToolTraceEntry[]>;
  getStopping: () => boolean;
  appendSystem: (text: string, summary?: TranscriptEntrySummary) => void;
  emitAgentState: (s: AgentState) => void;
  buildDiscussionToolCoachHook: (agent: Agent) => ToolResultHook | undefined;
}

export async function runDiscussionAgentCore(
host: DiscussionRunAgentHost,
agent: Agent,
prompt: string,
opts: RunAgentOpts,
): Promise<string> {
  const agentName = opts.agentName ?? discussionReaderProfile(host.active);
  host.manager.markStatus(agent.id, "thinking", {
    ...(opts.activity?.kind ? { activityKind: opts.activity.kind } : {}),
    ...(opts.activity?.label ? { activityLabel: opts.activity.label } : {}),
    thinkingSince: Date.now(),
  });
  host.emitAgentState({
    id: agent.id,
    index: agent.index,

    sessionId: agent.sessionId,
    status: "thinking",
    thinkingSince: Date.now(),
  });
  opts.stats.countTurn(agent.id);

  const controller = new AbortController();
  const watchdog = startSseAwareTurnWatchdog({
    manager: host.manager,
    sessionId: agent.sessionId,
    controller,
    abortSession: async () => {},
  });

  try {
    const res = await promptWithFailoverAuto(agent, prompt, {
      onTokens: ({ promptTokens, responseTokens }) => opts.stats.recordTokens(agent.id, promptTokens, responseTokens),
      signal: controller.signal,
      manager: host.manager,
      agentName,
      ...(opts.activity ? { activity: opts.activity } : {}),
      webToolsConfig: host.active,
      mcpServers: host.active?.mcpServers,
      onTool: makeBufferedToolHandler(host.pendingToolTraceByAgent, agent.id),
      onToolResultHook: host.buildDiscussionToolCoachHook(agent),
      promptAddendum: getAgentAddendum(host.active?.topology, agent.index),
      logDiag: host.logDiag,
      runId: host.active?.runId,
      describeError: describeSdkError,
      ...(opts.modelOverride && opts.modelOverride !== agent.model
        ? { modelOverride: opts.modelOverride }
        : {}),
      onTiming: ({ attempt, elapsedMs, success }) => {
        opts.stats.onTiming(agent.id, success, elapsedMs);
        host.logDiag?.({
          type: "_prompt_timing",
          preset: host.active?.preset,
          agentId: agent.id,
          agentIndex: agent.index,
          attempt,
          elapsedMs,
          success,
        });
        host.manager.recordPromptComplete(agent.id, { attempt, elapsedMs, success });
        host.emit({
          type: "agent_latency_sample",
          agentId: agent.id,
          agentIndex: agent.index,
          attempt,
          elapsedMs,
          success,
          ts: Date.now(),
        });
      },
      onRetry: ({ attempt, max, reasonShort, delayMs }) => {
        opts.stats.onRetry(agent.id);
        host.appendSystem(
          `[${agent.id}] transport error (${reasonShort}) — retry ${attempt}/${max} in ${Math.round(delayMs / 1000)}s`,
        );
        host.manager.markStatus(agent.id, "retrying", {
          retryAttempt: attempt,
          retryMax: max,
          retryReason: reasonShort,
        });
        host.emitAgentState({
          id: agent.id,
          index: agent.index,
    
          sessionId: agent.sessionId,
          status: "retrying",
          retryAttempt: attempt,
          retryMax: max,
          retryReason: reasonShort,
        });
      },
    });

    const diagCtx = {
      runner: opts.runnerName,
      agentId: agent.id,
      agentIndex: agent.index,
      logDiag: host.logDiag,
      manager: host.manager,
      signal: controller.signal,
      webToolsConfig: host.active,
      mcpServers: host.active?.mcpServers,
      onTool: makeBufferedToolHandler(host.pendingToolTraceByAgent, agent.id),
      promptAddendum: getAgentAddendum(host.active?.topology, agent.index),
      ...(opts.modelOverride && opts.modelOverride !== agent.model
        ? { modelOverride: opts.modelOverride }
        : {}),
      runId: host.active?.runId,
    };
    const extracted = extractTextWithDiag(res, diagCtx);
    let text = extracted.text;
    if ((extracted.isEmpty || looksLikeJunk(text)) && !host.getStopping()) {
      const retryText = await retryEmptyResponse(agent, prompt, agentName, diagCtx);
      if (retryText !== null) text = retryText;
    }
    trackPostRetryJunk(text, {
      agentId: agent.id,
      recordJunkPostRetry: (id, j) => opts.stats.recordJunkPostRetry(id, j),
      appendSystem: (msg) => host.appendSystem(msg),
    });
    const stripped = stripAgentText(text);

    // Compute summary: either from enrichSummary callback, static value, or undefined
    const summary: TranscriptEntrySummary | undefined =
      typeof opts.enrichSummary === "function"
        ? opts.enrichSummary(stripped.finalText)
        : opts.enrichSummary;

    const toolTrace = takePendingToolTrace(host.pendingToolTraceByAgent, agent.id);
    const entry: TranscriptEntry = {
      id: randomUUID(),
      role: "agent",
      agentId: agent.id,
      agentIndex: agent.index,
      text: stripped.finalText || "(empty response)",
      ts: Date.now(),
      ...(summary ? { summary } : {}),
      ...(stripped.thoughts.length > 0 ? { thoughts: stripped.thoughts } : {}),
      ...(stripped.toolCalls.length > 0 ? { toolCalls: stripped.toolCalls } : {}),
      ...(toolTrace ? { toolTrace } : {}),
    };

    // Hook for multiWriter collection or other post-entry logic
    opts.onEntryPushed?.(entry, stripped.finalText);

    host.transcript.push(entry);
    host.emit({ type: "transcript_append", entry });
    // streaming_end is owned by promptWithRetry → markStreamingDone; a second
    // emit here raced ahead of agent_state ready and recreated dock bubbles.
    host.manager.markStatus(agent.id, "ready", { lastMessageAt: entry.ts });
    host.emitAgentState({
      id: agent.id,
      index: agent.index,

      sessionId: agent.sessionId,
      status: "ready",
      lastMessageAt: entry.ts,
    });

    // Direction 6: checkpoint after each agent turn (when configured)
    if (host.active?.runId && host.active?.checkpointing) {
      const ckpt = buildCheckpoint(
        host.active.runId,
        host.phase,
        host.round,
        agent.index,
        host.transcript,
        host.manager.toStates(),
        host.active,
      );
      writeCheckpoint(host.active.localPath, ckpt).catch(() => {});
    }

    return text;
  } catch (err) {
    const msg = watchdog.getAbortReason() ?? describeSdkError(err);
    host.appendSystem(`[${agent.id}] error: ${msg}`);
    host.manager.markStreamingDone(agent.id);
    host.manager.markStatus(agent.id, "failed", { error: msg });
    host.emitAgentState({
      id: agent.id,
      index: agent.index,

      sessionId: agent.sessionId,
      status: "failed",
      error: msg,
    });
    return "";
  } finally {
    watchdog.cancel();
  }
}

/** Subclass must return its preset name (e.g. "Council", "Round-robin").
 *  Used by system messages and the closeOut path.
 *  Replaces magic strings scattered across each runner. */
