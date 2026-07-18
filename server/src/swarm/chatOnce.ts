// E3 Phase 3: one-shot chat helper for the 5 direct session.prompt
// callers that bypass promptWithRetry's retry loop (auditorSeedBuilder,
// goalGenerationPrePass, reflectionPasses, runEndReflection,
// promptAndExtract). When USE_SESSION_NO_OPENCODE OR USE_SESSION_PROVIDER
// is set, routes through pickProvider; else falls back to opencode's
// session.prompt for back-compat.
//
// Returns the {data: {parts: [{type, text}]}} SDK shape every existing
// caller already handles, so the migration is a pure call-site swap
// without touching response-extraction code.

import type { Agent, AgentManager } from "../services/AgentManager.js";
import { pickProvider } from "../providers/pickProvider.js";

import { throwChatProviderError } from "./sdkError.js";
import {
  isRetryableSdkError,
  RETRY_BACKOFF_MS,
  RETRY_MAX_ATTEMPTS,
  shortRetryReason,
} from "./blackboard/retry.js";
import { interruptibleSleep } from "./interruptibleSleep.js";
import { ToolDispatcher, defaultToolsForProfile, type ProfileName } from "../tools/ToolDispatcher.js";
import {
  resolveMaxToolTurnsForProfile,
  effectiveToolProfileId,
  type WebToolsConfig,
} from "../../../shared/src/toolProfiles.js";
import {
  defaultPromptWallClockMs,
  workerJsonNudgeForProfile,
} from "../../../shared/src/toolProfiles.js";
import { composePromptGuardSignals } from "./thinkStreamGuardRuntime.js";
import { isPromptGuardAbort } from "@ollama-swarm/shared/thinkGuardErrors";

export interface ChatOnceOpts {
  /** opencode agent profile to invoke under (swarm / swarm-read / swarm-builder / swarm-ui).
   *  Honored only on the legacy SDK path; the provider path doesn't have profiles. */
  agentName: string;
  /** Prompt text to send. */
  promptText: string;
  /**
   * When set, owns sidebar control plane (markStatus thinking → ready) for
   * the duration of this chat — same contract as promptWithRetry.
   */
  manager?: AgentManager;
  /** Activity labels for agent_activity / sidebar (defaults from agentName). */
  activity?: { kind?: string; label?: string };
  /** When true, do not auto markStatus(ready) even if this call opened thinking. */
  keepThinking?: boolean;
  /** Cancel the in-flight call. When undefined, an internal never-fired
   *  AbortController is used (matches legacy behavior of session.prompt
   *  callers that didn't pass a signal). */
  signal?: AbortSignal;
  /** Optional cumulative-text streaming hook (provider path only today). */
  onChunk?: (cumulativeText: string) => void;
  /** Diagnostic logger (provider path only today). */
  logDiag?: (record: unknown) => void;
  /** E3 Phase 4 part 2: when set + provider path, the model gets tools
   *  bound to this clone. Profile (read from agentName) gates which
   *  tools the dispatcher will execute. Without clonePath, no tools
   *  are advertised — the model answers from prompt context only. */
  clonePath?: string;
  /** Tool-call notification callback — fires per dispatch with name + ok + preview. */
  onTool?: (info: { tool: string; ok: boolean; preview: string }) => void;
  /** Constrained-decoding schema — passed straight to provider.chat().
   *  Today only OllamaProvider honors this (via Ollama's `format` param).
   *  When set, the model is constrained to emit output matching this
   *  JSON Schema — no XML pseudo-tool-call markers, no prose preambles,
   *  no JSON repair retries. Pass `"json"` for free-form JSON, pass a
   *  JSON Schema object for strict shape enforcement. */
  format?: "json" | Record<string, unknown>;
  /** runId for correlation and per-run attribution. */
  runId?: string;
  /** When set, upgrades swarm-read → swarm-research for legacy call sites. */
  webToolsConfig?: WebToolsConfig;
  mcpServers?: string;
  /** Explicit tool-loop cap; overrides resolveMaxToolTurnsForProfile when set. */
  maxToolTurns?: number;
  /** Restrict advertised tools for this call (e.g. literature web-only). */
  toolsOverride?: ReadonlyArray<
    | "read"
    | "grep"
    | "glob"
    | "list"
    | "bash"
    | "run"
    | "write"
    | "edit"
    | "propose_hunks"
    | "git_status"
    | "git_diff"
    | "web_search"
    | "web_fetch"
  >;
  /** Inject a user nudge before the Nth tool-loop turn (1-based). */
  toolLoopNudge?: { atTurn: number; message: string };
  /** Fired before a transport retry (attempt >= 2). */
  onRetry?: (info: { attempt: number; max: number; reasonShort: string; delayMs: number }) => void;
  /** Hard wall-clock abort (ms). Defaults from profile when unset. */
  promptWallClockMs?: number;
  /** When false (default), think guard uses hard tier only. */
  refereeOn?: boolean;
  getRefereeOn?: () => boolean;
  minThinkCharsForReferee?: number;
  getMinThinkCharsForReferee?: () => number | undefined;
}

// Mirrors what `agent.client.session.prompt` returns so callers don't
// need to branch on shape. Only `text` parts are populated by the
// provider path; tool-use parts arrive in Phase 4 part 2.
export interface ChatOnceResult {
  data: {
    parts: Array<{ type: "text"; text: string }>;
  };
}

async function chatOnceOnce(
  agent: Agent,
  opts: ChatOnceOpts,
): Promise<ChatOnceResult> {
  const baseSignal = opts.signal ?? new AbortController().signal;
  // E3 Phase 5: provider path is the only path. Legacy SDK fallback gone.
  {
    const t0 = Date.now();
    const { provider, modelId } = pickProvider(agent.model);
    // E3 Phase 4 part 2: bind tools to the dispatcher when clonePath
    // is supplied AND the agent profile grants any tools.
    const profileForTools: ProfileName | null =
      opts.agentName === "swarm"
        || opts.agentName === "swarm-read"
        || opts.agentName === "swarm-planner"
        || opts.agentName === "swarm-builder"
        || opts.agentName === "swarm-builder-research"
        || opts.agentName === "swarm-auto"
        || opts.agentName === "swarm-research"
        ? effectiveToolProfileId(opts.agentName, opts.webToolsConfig) as ProfileName
        : opts.agentName === "swarm-ui"
          ? effectiveToolProfileId("swarm-read", opts.webToolsConfig) as ProfileName
          : null;
    const wallClockMs = opts.promptWallClockMs ?? defaultPromptWallClockMs(profileForTools);
    const toolLoopNudge = opts.toolLoopNudge ?? workerJsonNudgeForProfile(profileForTools);
    const { signal, wrapOnChunk, cleanup: guardCleanup } = composePromptGuardSignals(baseSignal, {
      wallClockMs,
      refereeOn: opts.refereeOn === true,
      getRefereeOn: opts.getRefereeOn,
      minThinkCharsForReferee: opts.minThinkCharsForReferee,
      getMinThinkCharsForReferee: opts.getMinThinkCharsForReferee,
    });
    // Default clonePath to agent.cwd (set by AgentManager.spawnAgent /
    // spawnAgent) so callers don't have to plumb it through
    // explicitly. Override via opts.clonePath when needed.
    const clonePath = opts.clonePath ?? agent.cwd;
    // maxToolTurns <= 0 means emit-only: no tool iterations. Callers often
    // still pass a tool-capable profile (replan/worker emit). If tools stay
    // attached with maxToolTurns=0, Ollama's tool loop runs 0 turns and
    // fails with "tool loop exceeded 0 turns" without ever generating text
    // (runs 3d0aceba / a12daea8 replan permanent-skips).
    const emitOnlyNoTools = opts.maxToolTurns !== undefined && opts.maxToolTurns <= 0;
    const tools = emitOnlyNoTools
      ? []
      : opts.toolsOverride && opts.toolsOverride.length > 0
        ? [...opts.toolsOverride]
        : clonePath && profileForTools
          ? defaultToolsForProfile(profileForTools)
          : [];
    const mcp = opts.mcpServers || undefined;
    const dispatcher = clonePath && profileForTools && tools.length > 0
      ? new ToolDispatcher(profileForTools, clonePath, mcp, agent.id, undefined, opts.runId)
      : undefined;
    const exploreToolCap = opts.maxToolTurns ?? (profileForTools
      ? resolveMaxToolTurnsForProfile(
          profileForTools as import("../../../shared/src/toolProfiles.js").ToolProfileId,
        )
      : undefined);
    let result;
    try {
    result = await provider.chat({
      model: modelId,
      messages: [{ role: "user", content: opts.promptText }],
      signal,
      agentId: agent.id,
      logDiag: opts.logDiag,
      runId: opts.runId,
      ...(wrapOnChunk(opts.onChunk) ? { onChunk: wrapOnChunk(opts.onChunk) } : {}),
      ...(opts.toolLoopNudge ?? toolLoopNudge ? { toolLoopNudge: opts.toolLoopNudge ?? toolLoopNudge } : {}),
      ...(wallClockMs ? { promptWallClockMs: wallClockMs } : {}),
      ...(tools.length > 0 ? { tools } : {}),
      ...(dispatcher ? { dispatcher } : {}),
      ...(opts.onTool ? { onTool: opts.onTool } : {}),
      ...(opts.maxToolTurns !== undefined
        ? { maxToolTurns: opts.maxToolTurns }
        : exploreToolCap !== undefined
          ? { maxToolTurns: exploreToolCap }
          : {}),
      ...(opts.format !== undefined ? { format: opts.format } : {}),
    });
    } finally {
      guardCleanup();
    }
    const { recordChatUsage } = await import("../services/ollamaProxy.js");
    recordChatUsage({
      promptTokens: result.usage?.promptTokens,
      responseTokens: result.usage?.responseTokens,
      promptText: opts.promptText,
      responseText: result.text,
      durationMs: Date.now() - t0,
      model: agent.model,
      path: `/sdk-direct (${provider.id})`,
      runId: opts.runId,
    });
    if (result.finishReason === "error") {
      throwChatProviderError(
        result.errorMessage ?? "chatOnce: provider error",
        result.errorCause,
      );
    }
    if (result.finishReason === "aborted") {
      throw new Error("aborted");
    }
    // Free-text contestTool / resolveContest JSON (profile denials).
    if (opts.runId && result.text) {
      try {
        const { scanAgentContestMessages } = await import("../tools/toolContest.js");
        scanAgentContestMessages({
          runId: opts.runId,
          agentId: agent.id,
          text: result.text,
          profile: opts.agentName,
        });
      } catch {
        /* best-effort */
      }
    }
    return { data: { parts: [{ type: "text", text: result.text }] } };
  }
}

/** One-shot chat with the same transport retry semantics as promptWithRetry. */
export async function chatOnce(
  agent: Agent,
  opts: ChatOnceOpts,
): Promise<ChatOnceResult> {
  const signal = opts.signal ?? new AbortController().signal;
  let lastErr: unknown;

  // Control-plane ownership (fail-closed sidebar honesty for headless paths).
  const defaultKind = opts.activity?.kind ?? "prompt";
  const defaultLabel =
    opts.activity?.label?.trim()
    || (opts.activity?.kind ? String(opts.activity.kind) : undefined)
    || (opts.agentName.startsWith("swarm-")
      ? opts.agentName.replace(/^swarm-/, "")
      : undefined)
    || "prompt";
  let ownedStatus = false;
  const canMark =
    opts.manager
    && typeof opts.manager.markStatus === "function";
  if (canMark && opts.keepThinking !== true) {
    const mgr = opts.manager!;
    const cur =
      typeof mgr.getState === "function" ? mgr.getState(agent.id) : undefined;
    if (cur?.status !== "thinking" && cur?.status !== "retrying") {
      mgr.markStatus(agent.id, "thinking", {
        activityKind: defaultKind,
        activityLabel: defaultLabel,
        thinkingSince: Date.now(),
      });
      ownedStatus = true;
    }
  }
  const settleOwnedStatus = () => {
    if (!ownedStatus || !canMark || !opts.manager) return;
    ownedStatus = false;
    const mgr = opts.manager;
    const cur =
      typeof mgr.getState === "function" ? mgr.getState(agent.id) : undefined;
    if (!cur || cur.status === "thinking" || cur.status === "retrying") {
      mgr.markStatus(agent.id, "ready", { lastMessageAt: Date.now() });
    }
  };

  try {
    for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
      try {
        if (attempt > 1 && canMark) {
          opts.manager!.markStatus(agent.id, "retrying", {
            retryAttempt: attempt,
            retryMax: RETRY_MAX_ATTEMPTS,
            retryReason: shortRetryReason(lastErr),
          });
        }
        const res = await chatOnceOnce(agent, { ...opts, signal });
        settleOwnedStatus();
        return res;
      } catch (err) {
        lastErr = err;
        if (signal.aborted || isPromptGuardAbort(err)) {
          settleOwnedStatus();
          throw err;
        }
        if (!isRetryableSdkError(err)) {
          settleOwnedStatus();
          throw err;
        }
        if (attempt >= RETRY_MAX_ATTEMPTS) {
          settleOwnedStatus();
          throw err;
        }
        const delayMs = RETRY_BACKOFF_MS[attempt - 1];
        opts.onRetry?.({
          attempt: attempt + 1,
          max: RETRY_MAX_ATTEMPTS,
          reasonShort: shortRetryReason(err),
          delayMs,
        });
        const completed = await interruptibleSleep(delayMs, signal);
        if (!completed) {
          settleOwnedStatus();
          throw err;
        }
      }
    }
    settleOwnedStatus();
    throw lastErr ?? new Error("chatOnce: no result");
  } catch (err) {
    settleOwnedStatus();
    throw err;
  }
}
