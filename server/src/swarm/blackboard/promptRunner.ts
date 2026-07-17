// Extracted from BlackboardRunner.ts — prompt execution subsystem.
// Manages promptAgent (failover+retry+watchdog+streaming) and promptPlannerSafely.
// Takes a narrow context object instead of referencing `this.*`.

import { AgentManager } from "../../services/AgentManager.js";
import type { Agent } from "../../services/AgentManager.js";
import type { AgentState, SwarmEvent, TranscriptEntrySummary } from "../../types.js";
import type { RunConfig } from "../SwarmRunner.js";
import type { ClassifiedError } from "../errorTaxonomy.js";
import type { LifecycleState } from "./lifecycleState.js";
import {
  promptWithFailover,
  type FailoverState,
  type FailoverConfig,
} from "../promptWithFailover.js";
import { describeSdkError } from "../sdkError.js";
import { interruptibleSleep } from "../interruptibleSleep.js";
import {
  ABSOLUTE_MAX_MS,
} from "./BlackboardRunnerConstants.js";
import { config as appConfig } from "../../config.js";
import {
  getAgentAddendum,
  getAgentOllamaOptions,
} from "../../../../shared/src/topology.js";
import type { ProfileName } from "../../tools/ToolDispatcher.js";
import { makeBufferedToolHandler } from "../toolCallTranscript.js";
import { chatOnce, type ChatOnceOpts, type ChatOnceResult } from "../chatOnce.js";
import {
  createThinkGuardHandler,
  isThinkGuardRefereeEligible,
} from "./thinkGuardHandler.js";
import { extractText } from "../extractText.js";
import type { PendingPrompt } from "./runnerUtil.js";
import type { ToolTraceEntry } from "../toolCallTranscript.js";
import type { SwarmControlCenter } from "../control/SwarmControlCenter.js";
import type { ToolResultHook } from "../../tools/ToolDispatcher.js";

export interface PromptContext {
  // --- mutable counter maps (referenced in place) ---
  turnsPerAgent: Map<string, number>;
  promptTokensPerAgent: Map<string, number>;
  responseTokensPerAgent: Map<string, number>;
  attemptsPerAgent: Map<string, number>;
  retriesPerAgent: Map<string, number>;
  latenciesPerAgent: Map<string, number[]>;
  recentLatencySamples: Map<string, Array<{ ts: number; elapsedMs: number; success: boolean; attempt: number }>>;
  errorTracker: ClassifiedError[];
  activeAborts: Set<AbortController>;
  failoverState: FailoverState;
  localOllamaTags: readonly string[];

  // --- field getters / setters ---
  getActive: () => RunConfig | undefined;
  isStopping: () => boolean;
  isDraining: () => boolean;
  setLifecycleState: (v: LifecycleState) => void;
  getTerminationReason: () => string | undefined;
  setTerminationReason: (v: string | undefined) => void;

  // --- runner deps ---
  manager: AgentManager;
  emit: (e: SwarmEvent) => void;
  logDiag: ((record: unknown) => void) | undefined;
  getOllamaBaseUrl: () => string | undefined;

  // --- callbacks ---
  appendSystem: (msg: string, summary?: TranscriptEntrySummary) => void;
  emitAgentState: (s: AgentState) => void;
  extractText: (res: unknown) => string | undefined;
  pendingPromptByAgent?: Map<string, PendingPrompt>;
  pendingToolTraceByAgent: Map<string, ToolTraceEntry[]>;

  // --- static-like config ---
  maxTrackedErrors: number;
  getSwarmControl?: () => SwarmControlCenter;
  getCoachAgent?: () => Agent | undefined;
}

function wrapPromptWithControlHints(
  prompt: string,
  agentId: string,
  ctx: PromptContext,
): string {
  const control = ctx.getSwarmControl?.();
  if (!control) return prompt;
  const agentHint = control.consumeAgentHint(agentId);
  const sessionHint = control.consumeSessionPlannerHint();
  const blocks: string[] = [];
  if (sessionHint) blocks.push(`[Swarm control — session]\n${sessionHint}`);
  if (agentHint) blocks.push(`[Swarm control — tool coach]\n${agentHint}`);
  if (blocks.length === 0) return prompt;
  return `${blocks.join("\n\n")}\n\n[End swarm control]\n\n${prompt}`;
}

function buildToolCoachHook(ctx: PromptContext, agent: Agent): ToolResultHook | undefined {
  const control = ctx.getSwarmControl?.();
  const coach = ctx.getCoachAgent?.() ?? agent;
  const active = ctx.getActive();
  if (!control) return undefined;
  return (info) => {
    if (info.ok) return;
    control.recordToolFailure(agent.id, info.tool, info.error ?? "tool error", info.preview, {
      agent: coach,
      clonePath: active?.localPath,
      runId: active?.runId,
      appendSystem: ctx.appendSystem,
      emit: ctx.emit,
    });
  };
}

export async function promptPlannerSafely(
  ctx: PromptContext,
  primaryAgent: Agent,
  promptText: string,
  agentName: ProfileName = "swarm",
  ollamaFormat?: "json" | Record<string, unknown>,
  activity?: {
    kind?: string;
    label?: string;
    maxToolTurns?: number;
    mode?: "explore" | "emit";
    promptWallClockMs?: number;
  },
): Promise<{ response: string; agentUsed: Agent }> {
  const response = await promptAgent(
    ctx,
    primaryAgent,
    promptText,
    agentName,
    "json",
    ollamaFormat,
    activity,
  );
  return { response, agentUsed: primaryAgent };
}

/**
 * Blackboard streaming tiers (mirror council's single promptWithRetry path):
 *
 * 1. **promptAgent / promptPlannerSafely** — JSON-locked turns (workers, contract,
 *    planner todos). Full retry + failover + agent_activity via promptWithRetry.
 * 2. **chatOnceWithStreaming** — free-form one-shot turns (goal/research pre-passes,
 *    worker literature research). Same dock signals without the retry wrapper.
 *
 * Council discussion presets use DiscussionRunnerBase.runAgent → promptWithFailoverAuto
 * for every turn (tier 1 only). Blackboard splits tiers because pre-passes are
 * intentionally single-shot and must not share the planner session history.
 */
export type ChatStreamingAbort = {
  activeAborts: Set<AbortController>;
  isStopping?: () => boolean;
  isDraining?: () => boolean;
};

export type ChatStreamingSurface = {
  manager: AgentManager;
  emitAgentState: (s: AgentState) => void;
  activity: { kind: string; label: string };
  /** When set, registers an AbortController so stop()/drain() can cancel provider HTTP. */
  abort?: ChatStreamingAbort;
};

function mergeAbortSignals(
  primary: AbortSignal,
  secondary?: AbortSignal,
): AbortSignal {
  if (!secondary) return primary;
  if (typeof AbortSignal !== "undefined" && "any" in AbortSignal) {
    return AbortSignal.any([primary, secondary]);
  }
  return primary;
}

/**
 * Run a one-shot provider chat with the same dock/sidebar signals as promptAgent:
 * agent_activity labels, streaming chunks, and a final streaming_end.
 */
export async function chatOnceWithStreaming(
  agent: Agent,
  surface: ChatStreamingSurface,
  chatOpts: ChatOnceOpts,
): Promise<ChatOnceResult> {
  let sawFirstChunk = false;
  const emitStreaming = () => {
    if (sawFirstChunk) return;
    sawFirstChunk = true;
    surface.manager.emitAgentActivity(agent.id, agent.index, "streaming", {
      kind: surface.activity.kind,
      label: surface.activity.label,
    });
  };

  emitAgentActivity(agent, surface.manager, surface.emitAgentState, {
    kind: surface.activity.kind,
    label: surface.activity.label,
    attempt: 1,
    maxAttempts: 1,
  });

  const priorOnChunk = chatOpts.onChunk;
  const priorOnTool = chatOpts.onTool;
  const onToolLive = (info: { tool: string; ok: boolean; preview: string }) => {
    emitStreaming();
    const toolLabel = info.ok ? info.tool : `${info.tool} (error)`;
    surface.manager.emitAgentActivity(agent.id, agent.index, "streaming", {
      kind: surface.activity.kind,
      label: toolLabel,
    });
    priorOnTool?.(info);
  };
  const controller = new AbortController();
  const abortCtx = surface.abort;
  if (abortCtx) abortCtx.activeAborts.add(controller);
  const promptSignal = mergeAbortSignals(controller.signal, chatOpts.signal);
  try {
    const res = await chatOnce(agent, {
      ...chatOpts,
      signal: promptSignal,
      // Already markStatus'd via emitAgentActivity above — pass manager for
      // retrying labels; keepThinking so settle stays with this surface.
      manager: surface.manager,
      activity: surface.activity,
      keepThinking: true,
      onRetry: ({ attempt, max, reasonShort, delayMs }) => {
        surface.manager.markStatus(agent.id, "retrying", {
          retryAttempt: attempt,
          retryMax: max,
          retryReason: reasonShort,
        });
        surface.emitAgentState({
          id: agent.id,
          index: agent.index,
          port: agent.port,
          sessionId: agent.sessionId,
          status: "retrying",
          retryAttempt: attempt,
          retryMax: max,
          retryReason: reasonShort,
        });
        surface.manager.emitAgentActivity(agent.id, agent.index, "retrying", {
          kind: surface.activity.kind,
          label: surface.activity.label,
          attempt,
          maxAttempts: max,
          reason: reasonShort,
        });
        void delayMs;
      },
      onChunk: (cumulativeText) => {
        emitStreaming();
        surface.manager.recordStreamingText(agent.id, agent.index, cumulativeText);
        priorOnChunk?.(cumulativeText);
      },
      onTool: onToolLive,
    });
    const text = extractText(res) ?? "";
    if (!sawFirstChunk && text.trim().length > 0) {
      emitStreaming();
      surface.manager.recordStreamingText(agent.id, agent.index, text);
    }
    surface.manager.markStreamingDone(agent.id);
    surface.manager.emitAgentActivity(agent.id, agent.index, "done", {});
    surface.manager.markStatus(agent.id, "ready", { lastMessageAt: Date.now() });
    surface.emitAgentState({
      id: agent.id,
      index: agent.index,
      port: agent.port,
      sessionId: agent.sessionId,
      status: "ready",
      lastMessageAt: Date.now(),
    });
    return res;
  } catch (err) {
    surface.manager.markStreamingDone(agent.id);
    surface.manager.markStatus(agent.id, "ready", { lastMessageAt: Date.now() });
    surface.emitAgentState({
      id: agent.id,
      index: agent.index,
      port: agent.port,
      sessionId: agent.sessionId,
      status: "ready",
      lastMessageAt: Date.now(),
    });
    throw err;
  } finally {
    if (abortCtx) abortCtx.activeAborts.delete(controller);
  }
}

export async function promptAgent(
  ctx: PromptContext,
  agent: Agent,
  prompt: string,
  agentName: ProfileName = "swarm",
  formatExpect: "json" | "free" = "json",
  ollamaFormat?: "json" | Record<string, unknown>,
  activity?: {
    kind?: string;
    label?: string;
    maxToolTurns?: number;
    mode?: "explore" | "emit";
    promptWallClockMs?: number;
  },
): Promise<string> {
  const effectivePrompt = wrapPromptWithControlHints(prompt, agent.id, ctx);
  ctx.turnsPerAgent.set(agent.id, (ctx.turnsPerAgent.get(agent.id) ?? 0) + 1);
  ctx.pendingPromptByAgent?.set(agent.id, {
    text: effectivePrompt,
    ...(activity?.label ? { label: activity.label } : {}),
  });
  const turnStart = Date.now();
  ctx.manager.markStatus(agent.id, "thinking", {
    activityKind: activity?.kind,
    activityLabel: activity?.label,
  });
  ctx.emitAgentState({
    id: agent.id,
    index: agent.index,
    port: agent.port,
    sessionId: agent.sessionId,
    status: "thinking",
    thinkingSince: turnStart,
    activityKind: activity?.kind,
    activityLabel: activity?.label,
  });

  ctx.manager.touchActivity(agent.sessionId, turnStart);

  const controller = new AbortController();
  ctx.activeAborts.add(controller);
  let abortedReason: string | null = null;
  let abortFiredAt = 0;
  let lastVisibilityWarn = 0;
  controller.signal.addEventListener(
    "abort",
    () => {
      const reason = controller.signal.reason;
      abortedReason = reason instanceof Error ? reason.message : "aborted";
      abortFiredAt = Date.now();
    },
    { once: true },
  );

  // No hard ceilings — the model runs until it finishes naturally.
  // If the model is truly stuck, the user sees it in the streaming dock
  // and can stop the run manually.

  try {
    const failoverCfg = buildFailoverConfig(ctx);
    const cfg = ctx.getActive();
    // Soft-tier LLM referee retired — hard think caps only; salvage via deterministic triage.
    const thinkGuardHandlerState = { continuationUsed: false };
    const thinkGuardHandler = isThinkGuardRefereeEligible(activity)
      ? createThinkGuardHandler(
          {
            getActive: ctx.getActive,
            isStopping: ctx.isStopping,
            isDraining: ctx.isDraining,
            appendSystem: ctx.appendSystem,
            logDiag: ctx.logDiag,
            runId: cfg?.runId,
            activity,
            promptExcerpt: prompt.slice(0, 1500),
            signal: controller.signal,
            clonePath: cfg?.localPath,
            formatExpect,
          },
          thinkGuardHandlerState,
        )
      : undefined;
    const res = await promptWithFailover(agent, effectivePrompt, {
      signal: controller.signal,
      manager: ctx.manager,
      runId: cfg?.runId,
      onToolResultHook: buildToolCoachHook(ctx, agent),
      refereeOn: false,
      thinkGuardHandler,
      ...(activity ? { activity } : {}),
      formatExpect,
      ollamaDirect: appConfig.USE_OLLAMA_DIRECT
        ? { baseUrl: ctx.getOllamaBaseUrl() ?? appConfig.OLLAMA_DIRECT_FALLBACK_URL }
        : undefined,
      ...(ollamaFormat !== undefined ? { ollamaFormat } : {}),
      logDiag: ctx.logDiag,
      promptAddendum: getAgentAddendum(ctx.getActive()?.topology, agent.index),
      mcpServers: ctx.getActive()?.mcpServers,
      ollamaOptions: getAgentOllamaOptions(ctx.getActive()?.topology, agent.index),
      onTokens: ({ promptTokens, responseTokens }) => {
        if (promptTokens > 0) ctx.promptTokensPerAgent.set(agent.id, (ctx.promptTokensPerAgent.get(agent.id) ?? 0) + promptTokens);
        if (responseTokens > 0) ctx.responseTokensPerAgent.set(agent.id, (ctx.responseTokensPerAgent.get(agent.id) ?? 0) + responseTokens);
      },
      agentName,
      webToolsConfig: ctx.getActive(),
      ...(activity?.maxToolTurns !== undefined ? { maxToolTurns: activity.maxToolTurns } : {}),
      ...(activity?.promptWallClockMs !== undefined
        ? { promptWallClockMs: activity.promptWallClockMs }
        : {}),
      onTool: makeBufferedToolHandler(ctx.pendingToolTraceByAgent, agent.id),
      describeError: (e) => describeSdkError(e),
      sleep: (ms, sig) => interruptibleSleep(ms, sig),
      onTiming: ({ attempt, elapsedMs, success }) => {
        ctx.attemptsPerAgent.set(
          agent.id,
          (ctx.attemptsPerAgent.get(agent.id) ?? 0) + 1,
        );
        if (success) {
          const lats = ctx.latenciesPerAgent.get(agent.id) ?? [];
          lats.push(elapsedMs);
          ctx.latenciesPerAgent.set(agent.id, lats);
        }
        ctx.logDiag?.({
          type: "_prompt_timing",
          preset: ctx.getActive()?.preset,
          agentId: agent.id,
          agentIndex: agent.index,
          attempt,
          elapsedMs,
          success,
        });
        ctx.manager.recordPromptComplete(agent.id, { attempt, elapsedMs, success });
        const sampleTs = Date.now();
        ctx.emit({
          type: "agent_latency_sample",
          agentId: agent.id,
          agentIndex: agent.index,
          attempt,
          elapsedMs,
          success,
          ts: sampleTs,
        });
        const recent = ctx.recentLatencySamples.get(agent.id) ?? [];
        recent.push({ ts: sampleTs, elapsedMs, success, attempt });
        if (recent.length > 20) recent.splice(0, recent.length - 20);
        ctx.recentLatencySamples.set(agent.id, recent);
      },
      onRetry: ({ attempt, max, reasonShort, delayMs }) => {
        ctx.retriesPerAgent.set(
          agent.id,
          (ctx.retriesPerAgent.get(agent.id) ?? 0) + 1,
        );
        ctx.appendSystem(
          `[${agent.id}] transport error (${reasonShort}) — retry ${attempt}/${max} in ${Math.round(delayMs / 1000)}s`,
        );
        ctx.manager.markStatus(agent.id, "retrying", {
          retryAttempt: attempt,
          retryMax: max,
          retryReason: reasonShort,
        });
        ctx.emitAgentState({
          id: agent.id,
          index: agent.index,
          port: agent.port,
          sessionId: agent.sessionId,
          status: "retrying",
          retryAttempt: attempt,
          retryMax: max,
          retryReason: reasonShort,
        });
      },
    }, ctx.failoverState, failoverCfg, (info) => {
      ctx.errorTracker.push(info.classified);
      if (ctx.errorTracker.length > ctx.maxTrackedErrors) {
        ctx.errorTracker.shift();
      }
      ctx.manager.updateAgentModel(agent.id, info.toModel);
      ctx.appendSystem(
        `[${agent.id}] failover: ${info.fromModel} → ${info.toModel} (${info.reason})`,
      );
      ctx.emit({
        type: "model_shift",
        agentId: agent.id,
        agentIndex: agent.index,
        fromModel: info.fromModel,
        toModel: info.toModel,
        reason: info.reason,
        rawError: info.classified.rawMessage,
      });
    });
    const text = ctx.extractText(res) ?? "";
    // streaming_end owned by promptWithRetry → markStreamingDone
    ctx.manager.markStatus(agent.id, "ready", { lastMessageAt: Date.now() });
    ctx.emitAgentState({
      id: agent.id,
      index: agent.index,
      port: agent.port,
      sessionId: agent.sessionId,
      status: "ready",
      lastMessageAt: Date.now(),
    });
    return text;
  } catch (err) {
    const msg = abortedReason ?? describeSdkError(err);
    const userHalt =
      ctx.isStopping()
      || (ctx.isDraining() && (controller.signal.aborted || /abort|user stop|drain/i.test(msg)));
    if (userHalt) {
      ctx.manager.markStatus(agent.id, "ready", { lastMessageAt: Date.now() });
      ctx.emitAgentState({
        id: agent.id,
        index: agent.index,
        port: agent.port,
        sessionId: agent.sessionId,
        status: "ready",
        lastMessageAt: Date.now(),
      });
    } else {
      ctx.manager.markStatus(agent.id, "failed", { error: msg });
      ctx.emitAgentState({
        id: agent.id,
        index: agent.index,
        port: agent.port,
        sessionId: agent.sessionId,
        status: "failed",
        error: msg,
      });
    }
    throw new Error(msg);
  } finally {
    ctx.activeAborts.delete(controller);
  }
}

export function buildFailoverConfig(ctx: PromptContext): FailoverConfig {
  const chain = ctx.getActive()?.providerFailover ?? appConfig.SWARM_PROVIDER_FAILOVER;
  return {
    failoverChain: chain,
    localTags: appConfig.SWARM_DEGRADATION_FALLBACK ? ctx.localOllamaTags : [],
    localPreferred: appConfig.SWARM_DEGRADATION_PREFERRED,
    enableHealthSwap: appConfig.SWARM_MODEL_HEALTH_SWAP,
  };
}

export async function discoverLocalOllamaTags(ctx: PromptContext): Promise<void> {
  try {
    const baseUrl = (ctx.getOllamaBaseUrl() ?? appConfig.OLLAMA_TAGS_FALLBACK_URL).replace(/\/v1\/?$/, "");
    const r = await fetch(`${baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) return;
    const body = (await r.json()) as { models?: Array<{ name?: string }> };
    const tags = (body.models ?? [])
      .map((m) => m.name)
      .filter((n): n is string => typeof n === "string" && n.length > 0);
    ctx.localOllamaTags = tags;
  } catch {
    // discovery failed -> R3 stays disabled
  }
}

export function markPlannerStatus(
  planner: Agent,
  status: "thinking" | "ready",
  manager: AgentManager,
  emitAgentState: (s: AgentState) => void,
): void {
  manager.markStatus(planner.id, status);
  emitAgentState({
    id: planner.id,
    index: planner.index,
    port: planner.port,
    sessionId: planner.sessionId,
    status,
    ...(status === "thinking" ? { thinkingSince: Date.now() } : { lastMessageAt: Date.now() }),
  });
}

/** Surface planner phase in sidebar + agent_activity control plane. */
export function emitAgentActivity(
  agent: Agent,
  manager: AgentManager,
  emitAgentState: (s: AgentState) => void,
  activity: {
    kind: string;
    label: string;
    attempt: number;
    maxAttempts: number;
    mode?: "explore" | "emit";
  },
): void {
  const label = `${activity.label}${activity.mode === "emit" ? " · emit-only" : ""}`;
  manager.markStatus(agent.id, "thinking", {
    activityKind: activity.kind,
    activityLabel: label,
    activityAttempt: activity.attempt,
    activityMaxAttempts: activity.maxAttempts,
  });
  emitAgentState({
    id: agent.id,
    index: agent.index,
    port: agent.port,
    sessionId: agent.sessionId,
    status: "thinking",
    thinkingSince: Date.now(),
    activityKind: activity.kind,
    activityLabel: label,
    activityAttempt: activity.attempt,
    activityMaxAttempts: activity.maxAttempts,
  });
}
