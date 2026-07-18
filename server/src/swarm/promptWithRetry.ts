import type { Agent, AgentManager } from "../services/AgentManager.js";
import {
  RETRY_MAX_ATTEMPTS,
  RETRY_BACKOFF_MS,
  isRetryableSdkError,
  shortRetryReason,
} from "./blackboard/retry.js";
import { throwChatProviderError } from "./sdkError.js";

/** :cloud cold-start p95 can exceed 180s when 4 agents fan out in parallel. */
const CLOUD_FIRST_CHUNK_TIMEOUT_MS = 360_000;
// Do NOT add in-process :cloud admission / slot queues here — see
// docs/decisions.md (2026-07-08: No client-side :cloud admission).
import { recordChatUsage } from "../services/ollamaProxy.js";
import { pickProvider } from "../providers/pickProvider.js";
import { providerGateway } from "../providers/ProviderGateway.js";
import { config } from "../config.js";
import {
  isOllamaFamilyModel,
  OLLAMA_RUN_KEEP_ALIVE,
  ollamaOptionsForRole,
  ollamaThinkForCall,
} from "../providers/ollamaApiExtras.js";
import { ToolDispatcher, defaultToolsForProfile, type ProfileName } from "../tools/ToolDispatcher.js";
import {
  resolveMaxToolTurnsForProfile,
  effectiveToolProfileId,
  defaultPromptWallClockMs,
  workerJsonNudgeForProfile,
  type WebToolsConfig,
} from "../../../shared/src/toolProfiles.js";
import { composePromptGuardSignals } from "./thinkStreamGuardRuntime.js";
import {
  extractThinkGuardAbortError,
  isPromptGuardAbort,
} from "@ollama-swarm/shared/thinkGuardErrors";
import { createThinkGuardSession, type ThinkGuardSession } from "@ollama-swarm/shared/streamThinkGuard";
import type { ThinkGuardHandler } from "./blackboard/thinkGuardHandler.js";


// 2026-04-28: shared interruptible sleep used by both this module's
// retry-backoff and BlackboardRunner. One source of truth.
import { interruptibleSleep as defaultInterruptibleSleep } from "./interruptibleSleep.js";

// Task #166: per-chunk timeout for streamed prompts. If no SSE text
// chunks arrive for this many ms, the model is presumed dead and the
// attempt fails. Replaces undici's blocking 5-min headersTimeout —
// for streamed prompts, "no chunk in 90s" is a much sharper liveness
// signal than "no headers in 5min". Chosen at 90s because heavy
// reasoning models can pause that long mid-generation without being
// stuck (observed on glm-5.1 thinking through 4-criterion audits).
const STREAM_PER_CHUNK_TIMEOUT_MS = 90_000;

// Shared SDK-prompt-with-retry helper.
//
// Unit 16: extracted from BlackboardRunner.promptAgent so every runner
// can share the same retry semantics. Battle test (2026-04-22) showed
// that single-shot prompts in non-blackboard runners lose ~25 turns to
// UND_ERR_HEADERS_TIMEOUT in 60 minutes of runs — same conditions
// blackboard's retry already survived. Same loop, same constants
// (RETRY_MAX_ATTEMPTS = 3; backoff [4 s, 16 s] before attempts 2 and 3).
//
// The helper does the retry; the caller is responsible for everything
// else (status emission, transcript bookkeeping, abort wiring, error
// messaging) via the `onRetry` callback. That keeps `promptWithRetry`
// honest about its scope — it's a transport-level wrapper around
// `session.prompt`, not a runner.

export interface PromptWithRetryOptions {
  // Abort signal used both for the inner SDK call and to interrupt the
  // backoff sleep between attempts. If the signal aborts, the helper
  // throws the latest underlying error rather than retrying.
  signal: AbortSignal;
  // Optional hook fired BEFORE the next attempt's sleep. Caller uses this
  // to surface retry state (transcript line, AgentStatus = "retrying").
  // If omitted, retries happen silently.
  onRetry?: (info: RetryInfo) => void;
  // How to describe an SDK error in one line (for the `reasonShort`
  // field on RetryInfo). Defaults to err.message.
  describeError?: (err: unknown) => string;
  // Override the sleep function — mainly for tests. Returns true if the
  // sleep completed naturally, false if interrupted by the signal.
  sleep?: (ms: number, signal: AbortSignal) => Promise<boolean>;
  // Unit 19: optional hook fired after every attempt (success or failure)
  // with the wall-clock elapsed time of that attempt. Lets runners log
  // per-call latency for post-run extraction. Caller writes to the diag
  // log channel; the helper itself doesn't touch logging.
  onTiming?: (info: TimingInfo) => void;
  // Unit 20: which OpenCode agent profile to use. Defaults to "swarm"
  // (the no-tools profile blackboard workers need so they return JSON
  // diffs instead of editing files via tools). Discussion-only presets
  // pass "swarm-read" so their agents can actually use the file-read /
  // grep / glob tools that their prompts ask them to use.
  agentName?: string;
  // Task #163 (2026-04-26): per-call token accounting. Fired in the
  // finally block AFTER the call resolves (or throws), with the delta
  // tokenTracker recorded during the call's wall-clock window.
  // CAVEAT: tokenTracker is global; for parallel runners (council, OW
  // workers, MR mappers), the delta includes tokens from concurrent
  // calls — per-agent attribution is approximate. For sequential
  // runners it's exact. Run-level totals (computed at summary time
  // from tokenTracker.recent filtered by run window) stay accurate
  // either way.
  onTokens?: (info: { promptTokens: number; responseTokens: number }) => void;
  // Task #166: when present, fire prompts via the SSE-streaming path
  // (manager.streamPrompt) instead of the blocking session.prompt.
  // Eliminates the UND_ERR_HEADERS_TIMEOUT failure mode by making
  // per-chunk arrival the liveness signal instead of total-response
  // arrival. Backwards-compatible: callers that don't pass a manager
  // keep the old blocking behavior.
  manager?: AgentManager;
  // Task #196: format expectation. When "json", AgentManager runs an
  // early-format sniff after EARLY_FORMAT_SNIFF_BYTES of streamed text.
  // If the head contains no JSON markers, abort early. Catches the
  // wrong-format hallucination class within ~10s instead of running to
  // the absolute turn cap (1200s).
  formatExpect?: "json" | "free";
  // V2 Step 1: when set, route through OllamaClient (direct chunked-HTTP
  // to Ollama) instead of the OpenCode SDK path. Caller passes baseUrl
  // explicitly to avoid module-load-time config import (keeps this
  // module unit-testable). When unset/false, the SDK path is used.
  ollamaDirect?: { baseUrl: string };
  // Task #233 (2026-04-27 evening): Ollama structured-output passthrough.
  // When set + ollamaDirect path is taken, the model's decoder is
  // grammar-constrained to emit output matching the schema. Use "json"
  // for any valid JSON object, or pass a JSON Schema for strict
  // validation. Closes the XML pseudo-tool-call leak (#231) at the
  // source: the model literally cannot emit `<` for parser-strict
  // prompts. Ignored on the SDK path until that path also routes
  // through Ollama natively.
  ollamaFormat?: "json" | Record<string, unknown>;
  // V2 Step 1: optional diag logger threaded into OllamaClient so the
  // V2 path's call-start events land in the same logs/current.jsonl as
  // existing AgentManager diag entries. Lets us count V2 path uses
  // regardless of whether the call eventually produced tokens.
  logDiag?: (record: unknown) => void;
  // Phase 5b of #243: per-agent system-prompt addendum from the
  // topology row. Forwarded to AgentManager.streamPrompt where it's
  // prepended to the user prompt with a clear framing block. The
  // ollamaDirect path applies the same prepend so behavior is
  // identical regardless of transport. When undefined / empty,
  // prompt text passes through unchanged (pre-Phase-5 behavior).
  promptAddendum?: string;
  // Phase 5a of #243: per-agent Ollama generation parameters from
  // the topology row. Today this carries `temperature`; the schema
  // is open-ended so future per-agent knobs (top_p, repeat_penalty)
  // land here too. Effective only on the ollamaDirect path — the
  // SDK path drops these because session.prompt has no per-call
  // generation-options field. See AgentManager.streamPrompt for the
  // matching SDK-side comment.
  ollamaOptions?: {
    temperature?: number;
    top_p?: number;
    num_ctx?: number;
    num_predict?: number;
    [key: string]: unknown;
  };
  /**
   * Ollama-only keep_alive (api.md). Ignored for OpenCode / Anthropic / OpenAI
   * (promptWithRetry only attaches when isOllamaFamilyModel).
   */
  ollamaKeepAlive?: string | number;
  /**
   * Ollama-only think mode. Ignored for non-Ollama providers.
   * Default: false for JSON format without tools; else model default.
   */
  ollamaThink?: boolean | "low" | "medium" | "high" | "max";
  // PR-6/7: per-run attribution for quota + gateway scheduling.
  runId?: string;
  // T193 (2026-05-04): per-call model override. When set, replaces
  // agent.model for THIS prompt only. Used by round-robin's
  // disposition-tuned models lever (Critic/Gap-finder routed to
  // reasoning-tier; Builder/Synthesizer routed to coding-tier).
  // The agent's spawn-time model stays as the default; this is an
  // override scope of one call.
  modelOverride?: string;
  /** MCP servers string (e.g. "fetch=..." or "search=...") for tool-augmented profiles. Forwarded via any-cast in impl. */
  mcpServers?: string;
  /** Swarm control center — repeated tool failures trigger coach hints. */
  onToolResultHook?: import("../tools/ToolDispatcher.js").ToolResultHook;
  /** When set, upgrades swarm-read → swarm-research for discussion runners. */
  webToolsConfig?: WebToolsConfig;
  /** When set, overrides resolveMaxToolTurnsForProfile for this call (planning phases). */
  maxToolTurns?: number;
  /** Fired for each tool dispatch so runners can log web_tool transcript entries. */
  onTool?: (info: { tool: string; ok: boolean; preview: string }) => void;
  /** Optional metadata for agent_activity events when manager is set. */
  activity?: { kind?: string; label?: string; activityId?: string; mode?: "explore" | "emit" };
  /**
   * When true, promptWithRetry will not auto markStatus(ready) at settle even
   * if it opened the thinking session. Callers that chain multi-step work on
   * the same agent set this (rare). Default: false — prompt layer owns lifecycle.
   */
  keepThinking?: boolean;
  /** Hard wall-clock abort (ms). Defaults from profile when unset. */
  promptWallClockMs?: number;
  /** Post-abort think-stream referee (blackboard explore only). */
  thinkGuardHandler?: ThinkGuardHandler;
  refereeOn?: boolean;
  /** Live re-read so mid-run RECONFIG can enable referee on an in-flight stream. */
  getRefereeOn?: () => boolean;
  minThinkCharsForReferee?: number;
  getMinThinkCharsForReferee?: () => number | undefined;
  /** Tool-loop nudge before turn N (1-based). Worker profile gets a default when unset. */
  toolLoopNudge?: { atTurn: number; message: string };
  /** Override think-only char cap for JSON format sniff (emit-biased defaults apply by activity). */
  jsonThinkOnlyMaxChars?: number;
}

export interface RetryInfo {
  // The attempt that's ABOUT to start (1-based, but onRetry is only
  // ever called for attempts >= 2). Useful for "retry 2/3" UI strings.
  attempt: number;
  max: number;
  reasonShort: string;
  delayMs: number;
}

// Unit 19: per-attempt wall-clock timing surfaced after EVERY attempt
// (success or failure). The caller writes this to whatever diagnostic
// channel it owns; the helper just provides the numbers.
export interface TimingInfo {
  // The attempt that just finished (1-based).
  attempt: number;
  // Wall-clock ms from the moment we called session.prompt to the
  // moment it returned (success) or threw (failure).
  elapsedMs: number;
  // True if the attempt resolved normally; false if it threw.
  success: boolean;
}

export async function promptWithRetry(
  agent: Agent,
  promptText: string,
  opts: PromptWithRetryOptions,
): Promise<unknown> {
  const describe = opts.describeError ?? defaultDescribeError;
  const sleep = opts.sleep ?? defaultInterruptibleSleep;
  const agentName = opts.agentName ?? "swarm";
  // Agent-stats attribution: fire onTokens once with the same amounts we
  // ledgered via recordChatUsage (no finally-block tracker delta — that
  // double-counted and polluted parallel runs).
  let lastErr: unknown;
  // Default kind/label so sidebar never shows bare "thinking" when callers
  // pass manager without activity metadata (headless-adjacent paths).
  const defaultKind = opts.activity?.kind ?? "prompt";
  const defaultLabel =
    opts.activity?.label?.trim()
    || (opts.activity?.kind ? String(opts.activity.kind) : undefined)
    || (agentName.startsWith("swarm-") ? agentName.replace(/^swarm-/, "") : undefined)
    || "prompt";
  const activityMeta = {
    ...opts.activity,
    kind: defaultKind,
    label: defaultLabel,
  };
  let session = opts.manager?.resolvePromptActivity(agent.id, agent.index, activityMeta) ?? {
    activityId: activityMeta.activityId ?? `${agent.id}-${Date.now()}`,
    kind: activityMeta.kind,
    label: activityMeta.label,
    emitQueued: true,
  };
  const emitActivity = (
    phase: "queued" | "waiting" | "streaming" | "retrying" | "done",
    extra: { attempt?: number; reason?: string } = {},
  ) => {
    opts.manager?.emitAgentActivity(agent.id, agent.index, phase, {
      activityId: session.activityId,
      kind: session.kind ?? activityMeta.kind,
      label: session.label ?? activityMeta.label,
      maxAttempts: RETRY_MAX_ATTEMPTS,
      ...extra,
    });
  };

  // Prompt layer owns control plane when the caller has not already marked
  // the agent busy. Closes the "stream dock live / sidebar ready" gap for
  // any path that only passes manager without markStatus.
  let ownedStatus = false;
  const canMark =
    opts.manager
    && typeof (opts.manager as { markStatus?: unknown }).markStatus === "function";
  if (canMark && opts.keepThinking !== true) {
    const mgr = opts.manager as AgentManager;
    const cur =
      typeof mgr.getState === "function" ? mgr.getState(agent.id) : undefined;
    if (cur?.status !== "thinking" && cur?.status !== "retrying") {
      mgr.markStatus(agent.id, "thinking", {
        ...(session.kind ? { activityKind: session.kind } : {}),
        ...(session.label ? { activityLabel: session.label } : {}),
        thinkingSince: Date.now(),
      });
      ownedStatus = true;
      // markStatus already emitted waiting activity — keep session ids in sync
      const pa =
        typeof mgr.getPromptActivity === "function"
          ? mgr.getPromptActivity(agent.id)
          : undefined;
      if (pa) {
        session = {
          activityId: pa.activityId,
          kind: pa.kind ?? session.kind,
          label: pa.label ?? session.label,
          emitQueued: false,
        };
      }
    }
  }

  const settleOwnedStatus = () => {
    if (!ownedStatus || !canMark || !opts.manager) return;
    ownedStatus = false;
    const mgr = opts.manager as AgentManager;
    const cur =
      typeof mgr.getState === "function" ? mgr.getState(agent.id) : undefined;
    if (!cur || cur.status === "thinking" || cur.status === "retrying") {
      mgr.markStatus(agent.id, "ready", { lastMessageAt: Date.now() });
    }
  };

  for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
    const t0 = Date.now();
    if (attempt > 1 && opts.manager) {
      session.activityId = opts.manager.renewPromptActivity(agent.id, agent.index, attempt);
    } else if (attempt === 1 && session.emitQueued && opts.manager) {
      opts.manager.emitAgentActivity(agent.id, agent.index, "waiting", {
        activityId: session.activityId,
        kind: session.kind,
        label: session.label,
        maxAttempts: RETRY_MAX_ATTEMPTS,
        attempt,
      });
    }
    try {
      let res: unknown;
      let sawFirstChunk = false;
      // E3 Phase 5 cleanup pt 4: USE_SESSION_PROVIDER + ollamaDirect +
      // streamPrompt + session.prompt branches DELETED. The provider
      // path is now the only path. opencode subprocess + SDK gone.
      {
        const t0Provider = Date.now();
        const addendum = opts.promptAddendum?.trim() ?? "";
        const effectivePromptText = addendum.length > 0
          ? `[Per-agent specialization for this swarm member]\n${addendum}\n[End specialization. Original prompt follows.]\n\n${promptText}`
          : promptText;
        // T193: prefer modelOverride when set (used by round-robin
        // disposition-tuned routing). Falls back to agent.model.
        const effectiveModel = opts.modelOverride ?? agent.model;
        // E3 Phase 4 part 2: bind tools to a dispatcher when the agent
        // has a clone-rooted cwd AND the profile (from agentName) grants
        // any tools. Workers ("swarm") get nothing; planner/auditor
        // ("swarm-read") get read-side tools; build-style TODOs
        // ("swarm-builder") additionally get bash. Without this the
        // model answers from prompt context only — fine for some
        // discussion presets but harmful for the planner that needs to
        // grep before posting TODOs.
        const profileForTools: ProfileName | null =
          agentName === "swarm"
            || agentName === "swarm-read"
            || agentName === "swarm-planner"
            || agentName === "swarm-builder"
            || agentName === "swarm-builder-research"
            || agentName === "swarm-research"
            || agentName === "swarm-write"
            || agentName === "swarm-auto"
            ? effectiveToolProfileId(agentName, opts.webToolsConfig) as ProfileName
            : null;
        const tools = profileForTools && agent.cwd ? defaultToolsForProfile(profileForTools) : [];
        const mcp = (opts as any).mcpServers || undefined;
        const dispatcher = tools.length > 0 && profileForTools && agent.cwd
          ? new ToolDispatcher(
              profileForTools,
              agent.cwd,
              mcp,
              agent.id,
              opts.onToolResultHook,
              opts.runId,
            )
          : undefined;
        const exploreToolCap = opts.maxToolTurns ?? (profileForTools
          ? resolveMaxToolTurnsForProfile(
              profileForTools as import("../../../shared/src/toolProfiles.js").ToolProfileId,
            )
          : undefined);
        const wallClockMs = opts.promptWallClockMs ?? defaultPromptWallClockMs(profileForTools);
        const toolLoopNudge = opts.toolLoopNudge ?? workerJsonNudgeForProfile(profileForTools);
        const isCloud = effectiveModel.includes(":cloud");
        const guardSession: ThinkGuardSession = createThinkGuardSession();
        let chatPrompt = effectivePromptText;
        let continuationUsed = false;
        type ProviderChatResult = {
          text: string;
          finishReason: string;
          errorMessage?: string;
          errorCause?: unknown;
        };
        let result: ProviderChatResult | undefined;

        const runOneGuardedChat = async (promptBody: string): Promise<ProviderChatResult> => {
          const { signal: guardedSignal, wrapOnChunk, cleanup: guardCleanup } =
            composePromptGuardSignals(opts.signal, {
              wallClockMs,
              refereeOn: opts.refereeOn === true,
              getRefereeOn: opts.getRefereeOn,
              minThinkCharsForReferee: opts.minThinkCharsForReferee,
              getMinThinkCharsForReferee: opts.getMinThinkCharsForReferee,
              activityKind: opts.activity?.kind,
              activityMode: opts.activity?.mode,
              session: guardSession,
              // Wire formatExpect into the live stream guard (was unused on Ollama path).
              formatExpect: opts.formatExpect,
              ...(opts.jsonThinkOnlyMaxChars !== undefined
                ? { jsonThinkOnlyMaxChars: opts.jsonThinkOnlyMaxChars }
                : {}),
            });
          // Ollama-only extras (keep_alive / think / role options). Never set
          // for OpenCode/Anthropic/OpenAI — those providers ignore unknown
          // fields but we still omit `ollama` entirely so they cannot break.
          const useOllamaExtras = isOllamaFamilyModel(effectiveModel);
          const ollamaRoleOptions = useOllamaExtras
            ? ollamaOptionsForRole(
                opts.activity?.kind ?? agentName,
                opts.ollamaOptions,
              )
            : undefined;
          const chatOpts = {
            modelString: effectiveModel,
            runId: opts.runId,
            messages: [{ role: "user" as const, content: promptBody }],
            signal: guardedSignal,
            agentId: agent.id,
            logDiag: opts.logDiag,
            ...(isCloud ? { firstChunkTimeoutMs: CLOUD_FIRST_CHUNK_TIMEOUT_MS } : {}),
            // Top-level options still used by some providers; Ollama merges
            // with opts.ollama.options below.
            ...(opts.ollamaOptions !== undefined && !useOllamaExtras
              ? { options: opts.ollamaOptions }
              : {}),
            ...(useOllamaExtras
              ? {
                  ollama: {
                    keepAlive: opts.ollamaKeepAlive ?? OLLAMA_RUN_KEEP_ALIVE,
                    think: ollamaThinkForCall({
                      hasJsonFormat: opts.ollamaFormat !== undefined,
                      tools: tools.length > 0,
                      explicit: opts.ollamaThink,
                    }),
                    ...(ollamaRoleOptions && Object.keys(ollamaRoleOptions).length > 0
                      ? { options: ollamaRoleOptions }
                      : {}),
                  },
                }
              : {}),
            onChunk: wrapOnChunk((cumulativeText: string) => {
              if (!sawFirstChunk) {
                sawFirstChunk = true;
                emitActivity("streaming", { attempt });
              }
              opts.manager?.recordStreamingText(agent.id, agent.index, cumulativeText);
            }),
            ...(tools.length > 0 ? { tools } : {}),
            ...(dispatcher ? { dispatcher } : {}),
            ...(opts.onTool || opts.manager
              ? {
                  onTool: (info: { tool: string; ok: boolean; preview: string }) => {
                    if (!sawFirstChunk) {
                      sawFirstChunk = true;
                      emitActivity("streaming", { attempt });
                    }
                    const toolLabel = info.ok ? info.tool : `${info.tool} (error)`;
                    opts.manager?.emitAgentActivity(agent.id, agent.index, "streaming", {
                      activityId: session.activityId,
                      kind: session.kind ?? opts.activity?.kind,
                      label: toolLabel,
                      maxAttempts: RETRY_MAX_ATTEMPTS,
                      attempt,
                    });
                    opts.onTool?.(info);
                  },
                }
              : {}),
            ...(exploreToolCap !== undefined ? { maxToolTurns: exploreToolCap } : {}),
            ...(toolLoopNudge ? { toolLoopNudge } : {}),
            ...(wallClockMs ? { promptWallClockMs: wallClockMs } : {}),
            ...(opts.ollamaFormat !== undefined ? { format: opts.ollamaFormat } : {}),
          };
          try {
            const { provider: pickedProvider, modelId } = pickProvider(effectiveModel);
            const r = config.PROVIDER_GATEWAY
              ? await providerGateway.chat(chatOpts)
              : await pickedProvider.chat({ ...chatOpts, model: modelId });
            // Single record site for both gateway + direct paths. Cloud
            // streams often omit usage — estimate from text when needed.
            const recorded = recordChatUsage({
              promptTokens: r.usage?.promptTokens,
              responseTokens: r.usage?.responseTokens,
              promptText: promptBody,
              responseText: r.text,
              durationMs: Date.now() - t0Provider,
              model: effectiveModel,
              path: config.PROVIDER_GATEWAY
                ? `/gateway (${pickedProvider.id})`
                : `/sdk-direct (${pickedProvider.id})`,
              runId: opts.runId,
            });
            // Always notify agent-stats (even estimated) so summary
            // tokensIn/Out stop being null on cloud models.
            if (opts.onTokens && (recorded.promptTokens > 0 || recorded.responseTokens > 0)) {
              opts.onTokens({
                promptTokens: recorded.promptTokens,
                responseTokens: recorded.responseTokens,
              });
            }
            if (r.finishReason === "aborted") {
              const guardErr = extractThinkGuardAbortError(guardSession, guardedSignal);
              if (guardErr && opts.thinkGuardHandler) {
                const action = await opts.thinkGuardHandler.handleAbort(guardErr);
                if (action.type === "return_partial") {
                  opts.manager?.markStreamingDone(agent.id, { preservePartial: true });
                  return { text: action.text, finishReason: "salvaged" };
                }
                if (action.type === "continuation_prompt" && !continuationUsed) {
                  continuationUsed = true;
                  guardSession.budgetExtended = true;
                  chatPrompt = action.prompt;
                  sawFirstChunk = false;
                  return { text: "", finishReason: "continuation" };
                }
              }
              opts.manager?.markStreamingDone(agent.id);
              throw guardErr ?? new Error("aborted");
            }
            // Free-text contestTool / resolveContest JSON (profile denials).
            if (opts.runId && r.text) {
              try {
                const { scanAgentContestMessages } = await import("../tools/toolContest.js");
                scanAgentContestMessages({
                  runId: opts.runId,
                  agentId: agent.id,
                  text: r.text,
                  profile: agentName,
                });
              } catch {
                /* best-effort */
              }
            }
            return r;
          } finally {
            guardCleanup();
          }
        };

        do {
          result = await runOneGuardedChat(chatPrompt);
        } while (result.finishReason === "continuation");

        if (!sawFirstChunk && result.text.trim().length > 0) {
          sawFirstChunk = true;
          emitActivity("streaming", { attempt });
          opts.manager?.recordStreamingText(agent.id, agent.index, result.text);
        }
        if (result.finishReason !== "salvaged") {
          opts.manager?.markStreamingDone(agent.id);
        }
        if (result.finishReason === "error") {
          // Discussion drafts: keep partial model text when tool-loop / provider
          // errors instead of discarding it (silent missing council rounds).
          const isDiscussion =
            opts.activity?.kind === "discussion"
            || opts.activity?.kind === "council-draft"
            || opts.activity?.kind === "draft";
          const salvage = (result.text ?? "").trim();
          if (isDiscussion && salvage.length >= 40) {
            opts.manager?.recordStreamingText(agent.id, agent.index, result.text);
            opts.manager?.markStreamingDone(agent.id, { preservePartial: true });
            res = {
              data: {
                parts: [{
                  type: "text",
                  text:
                    salvage
                    + `\n\n_(draft incomplete — ${String(result.errorMessage ?? "provider error").slice(0, 160)})_`,
                }],
              },
            };
          } else {
            throwChatProviderError(
              result.errorMessage ?? "session provider chat error",
              result.errorCause,
            );
          }
        } else {
          res = { data: { parts: [{ type: "text", text: result.text }] } };
        }
      }
      // When we own status, markStatus(ready) emits activity done.
      // Otherwise emit done so dock/sidebar can demote without waiting for the runner.
      if (ownedStatus) {
        settleOwnedStatus();
      } else {
        emitActivity("done", { attempt });
      }
      opts.onTiming?.({ attempt, elapsedMs: Date.now() - t0, success: true });
      return res;
    } catch (err) {
      opts.onTiming?.({ attempt, elapsedMs: Date.now() - t0, success: false });
      lastErr = err;
      // Watchdog, user stop, or cap already cancelled this turn — do
      // not retry a deliberate abort.
      if (opts.signal.aborted || isPromptGuardAbort(err)) {
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
      const friendly = shortRetryReason(err);
      const customized = describe(err);
      const reasonShort =
        /cloud queue|cloud capacity busy|cloud headers timeout/i.test(friendly)
          ? friendly
          : customized;
      emitActivity("retrying", { attempt: attempt + 1, reason: reasonShort });
      opts.onRetry?.({
        attempt: attempt + 1,
        max: RETRY_MAX_ATTEMPTS,
        reasonShort,
        delayMs,
      });
      const completed = await sleep(delayMs, opts.signal);
      if (!completed) {
        settleOwnedStatus();
        throw err;
      }
    }
  }
  // Unreachable in practice: the loop either returns, throws, or
  // re-loops up to RETRY_MAX_ATTEMPTS times. Keep the final throw so
  // TypeScript doesn't infer `Promise<unknown | undefined>`.
  settleOwnedStatus();
  throw lastErr ?? new Error("prompt returned no result");
}

function defaultDescribeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}



