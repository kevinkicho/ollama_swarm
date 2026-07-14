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
import {
  discussionDraftJsonNudge,
  EXPLORE_MAX_DISCUSSION_DRAFT_TOOL_TURNS,
  DEFAULT_DISCUSSION_DRAFT_PROMPT_WALL_CLOCK_MS,
} from "../../../shared/src/toolProfiles.js";
import { isThinkGuardAbort } from "@ollama-swarm/shared/thinkGuardErrors";
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
import { config as appConfig } from "../config.js";
import { createThinkGuardHandler } from "./blackboard/thinkGuardHandler.js";
import {
  collectPendingMentionsForAgent,
  defaultDiscussionRoleResolver,
  filterMentionsByCooldown,
  injectMentionContractsIntoPrompt,
  parseMentionContracts,
} from "./agentMentionContract.js";

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

function isDiscussionDraftActivity(opts: RunAgentOpts): boolean {
  const kind = opts.activity?.kind;
  return kind === "discussion" || kind === "council-draft" || kind === "draft";
}

function resolvePartialStreamText(host: DiscussionRunAgentHost, agentId: string): string {
  try {
    const partials = host.manager.getPartialStreams?.() ?? {};
    return partials[agentId]?.text ?? "";
  } catch {
    return "";
  }
}

function buildFailedDraftBody(msg: string, partialRaw: string): string {
  const stripped = stripAgentText(partialRaw);
  const final = stripped.finalText.trim();
  if (final.length >= 40) {
    return (
      final
      + `\n\n_(draft incomplete — turn ended: ${msg.slice(0, 180)})_`
    );
  }
  const thinkTail = stripped.thoughts.trim().slice(-1500);
  if (thinkTail.length >= 80) {
    return (
      `_(draft failed: ${msg.slice(0, 180)})_\n\n`
      + `Reasoning salvage:\n${thinkTail}`
    );
  }
  return `_(draft failed: ${msg.slice(0, 240)})_`;
}

function pushDiscussionEntry(
  host: DiscussionRunAgentHost,
  agent: Agent,
  opts: RunAgentOpts,
  rawText: string,
): string {
  const stripped = stripAgentText(rawText);
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

  opts.onEntryPushed?.(entry, stripped.finalText);
  host.transcript.push(entry);
  host.emit({ type: "transcript_append", entry });
  host.manager.markStatus(agent.id, "ready", { lastMessageAt: entry.ts });
  host.emitAgentState({
    id: agent.id,
    index: agent.index,
    sessionId: agent.sessionId,
    status: "ready",
    lastMessageAt: entry.ts,
  });

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

  return stripped.finalText || rawText;
}

export async function runDiscussionAgentCore(
  host: DiscussionRunAgentHost,
  agent: Agent,
  prompt: string,
  opts: RunAgentOpts,
): Promise<string> {
  const agentName = opts.agentName ?? discussionReaderProfile(host.active);
  const draftMode = isDiscussionDraftActivity(opts);
  const activity = {
    kind: opts.activity?.kind ?? (draftMode ? "discussion" : undefined),
    label: opts.activity?.label,
    mode: opts.activity?.mode ?? (draftMode ? ("explore" as const) : undefined),
  };

  // Q3: inject pending @-mention contracts when enabled.
  let effectivePrompt = prompt;
  if (host.active?.mentionContracts) {
    try {
      const agents = host.manager.list();
      const resolveRole = defaultDiscussionRoleResolver(agents);
      const pending = collectPendingMentionsForAgent({
        transcript: host.transcript,
        agentIndex: agent.index,
        resolveRole,
      });
      effectivePrompt = injectMentionContractsIntoPrompt({
        prompt,
        pending,
        includeInstruction: true,
      });
      if (pending.length > 0) {
        host.appendSystem(
          `[mentionContracts] agent-${agent.index} has ${pending.length} pending ask(s)`,
        );
      }
    } catch {
      // best-effort — never block the turn
    }
  }

  // markStatus is the single control-plane write (state + activity waiting).
  // Do not follow with a partial emitAgentState — that used to wipe labels.
  host.manager.markStatus(agent.id, "thinking", {
    ...(activity.kind ? { activityKind: activity.kind } : {}),
    ...(activity.label ? { activityLabel: activity.label } : {}),
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
    const getRefereeOn = () =>
      host.active?.thinkGuardRefereeEnabled ?? appConfig.THINK_GUARD_REFEREE_ENABLED === true;

    // Discussion drafts: salvage partial on think-guard instead of silent fail.
    const thinkGuardHandler = createThinkGuardHandler({
      getActive: () => host.active,
      isStopping: () => host.getStopping(),
      isDraining: () => false,
      appendSystem: (t) => host.appendSystem(t),
      logDiag: host.logDiag,
      runId: host.active?.runId,
      activity: {
        kind: activity.kind ?? "discussion",
        label: activity.label,
        mode: activity.mode ?? "explore",
      },
      promptExcerpt: effectivePrompt.slice(0, 2000),
      signal: controller.signal,
      clonePath: host.active?.localPath,
    });

    const res = await promptWithFailoverAuto(agent, effectivePrompt, {
      onTokens: ({ promptTokens, responseTokens }) =>
        opts.stats.recordTokens(agent.id, promptTokens, responseTokens),
      signal: controller.signal,
      manager: host.manager,
      agentName,
      activity: {
        kind: activity.kind ?? "discussion",
        label: activity.label,
        mode: activity.mode,
      },
      webToolsConfig: host.active,
      mcpServers: host.active?.mcpServers,
      onTool: makeBufferedToolHandler(host.pendingToolTraceByAgent, agent.id),
      onToolResultHook: host.buildDiscussionToolCoachHook(agent),
      promptAddendum: getAgentAddendum(host.active?.topology, agent.index),
      logDiag: host.logDiag,
      runId: host.active?.runId,
      describeError: describeSdkError,
      refereeOn: getRefereeOn(),
      getRefereeOn,
      minThinkCharsForReferee: host.active?.thinkGuardRefereeMinThinkChars,
      getMinThinkCharsForReferee: () => host.active?.thinkGuardRefereeMinThinkChars,
      thinkGuardHandler,
      // Emit-biased draft rounds: fewer tool turns + earlier "write draft now" nudge.
      ...(draftMode
        ? {
            maxToolTurns: EXPLORE_MAX_DISCUSSION_DRAFT_TOOL_TURNS,
            toolLoopNudge: discussionDraftJsonNudge(),
            promptWallClockMs: DEFAULT_DISCUSSION_DRAFT_PROMPT_WALL_CLOCK_MS,
          }
        : {}),
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
      const retryText = await retryEmptyResponse(agent, effectivePrompt, agentName, diagCtx);
      if (retryText !== null) text = retryText;
    }
    trackPostRetryJunk(text, {
      agentId: agent.id,
      recordJunkPostRetry: (id, j) => opts.stats.recordJunkPostRetry(id, j),
      appendSystem: (msg) => host.appendSystem(msg),
    });

    const finalText = pushDiscussionEntry(host, agent, opts, text);

    // Q3: surface newly emitted mention contracts (cooldown-gated noise).
    if (host.active?.mentionContracts) {
      try {
        const emitted = parseMentionContracts(finalText).map((m) => ({
          ...m,
          fromAgentIndex: agent.index,
        }));
        if (emitted.length > 0) {
          const recentPairs: Array<{ fromIndex: number; to: string }> = [];
          for (const e of host.transcript) {
            if (e.role !== "agent" || typeof e.agentIndex !== "number") continue;
            if (e.agentIndex === agent.index && e.text === finalText) continue;
            for (const m of parseMentionContracts(e.text ?? "")) {
              recentPairs.push({ fromIndex: e.agentIndex, to: m.to });
            }
          }
          const gated = filterMentionsByCooldown(emitted, recentPairs);
          if (gated.length > 0) {
            host.appendSystem(
              `[mentionContracts] agent-${agent.index} filed ${gated.length} ask(s): `
              + gated.map((m) => `→${m.to}`).join(", "),
            );
          }
        }
      } catch {
        /* ignore */
      }
    }

    return finalText;
  } catch (err) {
    const msg = watchdog.getAbortReason() ?? describeSdkError(err);
    host.appendSystem(`[${agent.id}] error: ${msg}`);
    host.manager.markStreamingDone(agent.id, { preservePartial: true });

    // Always post a draft bubble when this turn was a discussion draft —
    // silent missing rounds were worse than a partial/failed draft.
    const partialFromGuard = isThinkGuardAbort(err) ? err.partialText : "";
    const partialFromStream = resolvePartialStreamText(host, agent.id);
    const partialRaw =
      (partialFromStream && partialFromStream.length >= (partialFromGuard?.length ?? 0)
        ? partialFromStream
        : partialFromGuard) || partialFromStream || "";

    if (opts.enrichSummary || draftMode) {
      const body = buildFailedDraftBody(msg, partialRaw);
      host.appendSystem(
        `[${agent.id}] salvage draft posted (${body.length} chars) after error.`,
      );
      return pushDiscussionEntry(host, agent, opts, body);
    }

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
