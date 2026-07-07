// Extracted from BlackboardRunner.ts — prompt execution subsystem.
// Manages promptAgent (failover+retry+watchdog+streaming) and promptPlannerSafely.
// Takes a narrow context object instead of referencing `this.*`.

import { AgentManager } from "../../services/AgentManager.js";
import type { Agent } from "../../services/AgentManager.js";
import type { AgentState, SwarmEvent, TranscriptEntrySummary } from "../../types.js";
import type { RunConfig } from "../SwarmRunner.js";
import type { ClassifiedError } from "../errorTaxonomy.js";
import { config } from "../../config.js";
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
import { makeWebToolHandler } from "../toolCallTranscript.js";

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
  getConsecutiveLoopDetections: () => number;
  setConsecutiveLoopDetections: (v: number) => void;
  getLastLoopWarningAtTurn: () => number;
  setLastLoopWarningAtTurn: (v: number) => void;

  // --- runner deps ---
  manager: AgentManager;
  emit: (e: SwarmEvent) => void;
  logDiag: ((record: unknown) => void) | undefined;
  getOllamaBaseUrl: () => string | undefined;

  // --- callbacks ---
  appendSystem: (msg: string, summary?: TranscriptEntrySummary) => void;
  emitAgentState: (s: AgentState) => void;
  extractText: (res: unknown) => string | undefined;

  // --- static-like config ---
  maxTrackedErrors: number;
}

export async function promptPlannerSafely(
  ctx: PromptContext,
  primaryAgent: Agent,
  promptText: string,
  agentName: ProfileName = "swarm",
  ollamaFormat?: "json" | Record<string, unknown>,
): Promise<{ response: string; agentUsed: Agent }> {
  const response = await promptAgent(ctx, primaryAgent, promptText, agentName, "json", ollamaFormat);
  return { response, agentUsed: primaryAgent };
}

export async function promptAgent(
  ctx: PromptContext,
  agent: Agent,
  prompt: string,
  agentName: ProfileName = "swarm",
  formatExpect: "json" | "free" = "json",
  ollamaFormat?: "json" | Record<string, unknown>,
): Promise<string> {
  ctx.turnsPerAgent.set(agent.id, (ctx.turnsPerAgent.get(agent.id) ?? 0) + 1);
  ctx.manager.markStatus(agent.id, "thinking");
  const turnStart = Date.now();
  ctx.emitAgentState({
    id: agent.id,
    index: agent.index,
    port: agent.port,
    sessionId: agent.sessionId,
    status: "thinking",
    thinkingSince: turnStart,
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
    const res = await promptWithFailover(agent, prompt, {
      signal: controller.signal,
      manager: ctx.manager,
      formatExpect,
      intraStreamLoop: true,
      ollamaDirect: config.USE_OLLAMA_DIRECT
        ? { baseUrl: ctx.getOllamaBaseUrl() ?? config.OLLAMA_DIRECT_FALLBACK_URL }
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
      onTool: makeWebToolHandler(ctx.appendSystem, agent.id),
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
    ctx.emit({ type: "agent_streaming_end", agentId: agent.id });
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
    ctx.emit({ type: "agent_streaming_end", agentId: agent.id });
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
    const baseUrl = (ctx.getOllamaBaseUrl() ?? config.OLLAMA_TAGS_FALLBACK_URL).replace(/\/v1\/?$/, "");
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
