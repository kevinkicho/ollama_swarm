import type { Agent, AgentManager } from "../services/AgentManager.js";
import { toOpenCodeModelRef } from "../../../shared/src/providers.js";
import {
  RETRY_MAX_ATTEMPTS,
  RETRY_BACKOFF_MS,
  isRetryableSdkError,
} from "./blackboard/retry.js";
import { tokenTracker } from "../services/ollamaProxy.js";
import { chat as ollamaChat } from "../services/OllamaClient.js";
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
    [key: string]: unknown;
  };
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
  // Task #163: capture pre-call lifetime token total so we can emit
  // a delta to opts.onTokens after the call settles.
  const tokensBefore = opts.onTokens ? tokenTracker.total() : null;
  let lastErr: unknown;
  try {
  for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
    const t0 = Date.now();
    try {
      let res: unknown;
      // Task #166 streaming path. RE-ENABLED 2026-04-26 after Task
      // #170 (Path B) found the root cause of the prior failure:
      // SDK's createSseClient bypasses our authedFetch wrapper and
      // uses globalThis.fetch directly → /event returned 401 →
      // SDK retried silently → 0 events delivered. Fix at
      // AgentManager.attachEventStream now passes Authorization
      // header explicitly to event.subscribe(); SSE events flow
      // again, streaming is viable.
      const STREAMING_ENABLED = true;
      // V2 Step 1: when opts.ollamaDirect is provided, route through
      // OllamaClient (direct chunked-HTTP to Ollama, no OpenCode subprocess,
      // no SSE event stream, no per-chunk timeout/probe/reconnect dance).
      // Side-by-side with the SDK path until validated. Once stable, the
      // SDK path will be removed entirely (per docs/ARCHITECTURE-V2.md).
      if (opts.ollamaDirect) {
        const t0Direct = Date.now();
        // Phase 5b of #243: prepend per-agent addendum the same way the
        // SDK path does (see AgentManager.streamPrompt). Keeps behavior
        // identical regardless of transport.
        const addendum = opts.promptAddendum?.trim() ?? "";
        const effectivePromptText = addendum.length > 0
          ? `[Per-agent specialization for this swarm member]\n${addendum}\n[End specialization. Original prompt follows.]\n\n${promptText}`
          : promptText;
        const result = await ollamaChat({
          baseUrl: opts.ollamaDirect.baseUrl,
          model: agent.model,
          messages: [{ role: "user", content: effectivePromptText }],
          signal: opts.signal,
          agentId: agent.id,
          logDiag: opts.logDiag,
          // #233: forward structured-output constraint when caller
          // requested it (parser-strict prompts: contract, todos,
          // auditor verdict, replanner).
          ...(opts.ollamaFormat !== undefined ? { format: opts.ollamaFormat } : {}),
          // Phase 5a of #243: per-agent generation params (temperature,
          // top_p, etc.) from topology row. Ignored when undefined —
          // model uses its built-in defaults.
          ...(opts.ollamaOptions !== undefined ? { options: opts.ollamaOptions } : {}),
          // Default 60s idle timeout matches the V2 spec — if the body
          // goes silent for this long, the model is dead. No probes.
          onChunk: (cumulativeText) => {
            // Surface streaming text into the agent's partial-stream
            // buffer so the UI sees progress just like the SSE path.
            opts.manager?.recordStreamingText(agent.id, agent.index, cumulativeText);
          },
          onTokens: ({ promptTokens, responseTokens }) => {
            // Record into the existing tokenTracker so the usage
            // widget keeps working unchanged.
            tokenTracker.add({
              ts: Date.now(),
              promptTokens,
              responseTokens,
              durationMs: Date.now() - t0Direct,
              model: agent.model,
              path: "/api/chat (direct)",
            });
          },
        });
        // Surface streaming-end like the SDK path so the UI's
        // PersistentStreamBubble flips to "done".
        opts.manager?.markStreamingDone(agent.id);
        res = { data: { parts: [{ type: "text", text: result.text }] } };
      } else if (STREAMING_ENABLED && opts.manager) {
        const text = await opts.manager.streamPrompt(agent, {
          agentName,
          modelID: agent.model,
          promptText,
          signal: opts.signal,
          perChunkTimeoutMs: STREAM_PER_CHUNK_TIMEOUT_MS,
          formatExpect: opts.formatExpect,
          // Phase 5b of #243: forward addendum to the SDK path's
          // streamPrompt — it does the same prepend the ollamaDirect
          // branch does just above.
          promptAddendum: opts.promptAddendum,
        });
        res = { data: { parts: [{ type: "text", text }] } };
      } else {
        // #233 + #234: with v2 SDK we now have proper `format` typing
        // — pass it through when caller requested constrained decoding
        // (parser-strict prompts: contract, todos, auditor verdict).
        // The model's decoder is grammar-constrained to emit JSON for
        // these prompts; XML pseudo-tool-call markers (#231) become
        // impossible at the source, not stripped after-the-fact.
        const sdkFormat = opts.ollamaFormat === "json"
          ? { type: "json_schema" as const, schema: {} }
          : (typeof opts.ollamaFormat === "object" && opts.ollamaFormat !== null
              ? { type: "json_schema" as const, schema: opts.ollamaFormat }
              : undefined);
        res = await agent.client.session.prompt(
          {
            sessionID: agent.sessionId,
            agent: agentName,
            model: toOpenCodeModelRef(agent.model),
            parts: [{ type: "text", text: promptText }],
            ...(sdkFormat ? { format: sdkFormat } : {}),
          },
          { signal: opts.signal },
        );
      }
      opts.onTiming?.({ attempt, elapsedMs: Date.now() - t0, success: true });
      return res;
    } catch (err) {
      opts.onTiming?.({ attempt, elapsedMs: Date.now() - t0, success: false });
      lastErr = err;
      // Watchdog, user stop, or cap already cancelled this turn — do
      // not retry a deliberate abort.
      if (opts.signal.aborted) throw err;
      if (!isRetryableSdkError(err)) throw err;
      if (attempt >= RETRY_MAX_ATTEMPTS) throw err;
      const delayMs = RETRY_BACKOFF_MS[attempt - 1];
      const reasonShort = describe(err);
      opts.onRetry?.({
        attempt: attempt + 1,
        max: RETRY_MAX_ATTEMPTS,
        reasonShort,
        delayMs,
      });
      const completed = await sleep(delayMs, opts.signal);
      if (!completed) throw err;
    }
  }
  // Unreachable in practice: the loop either returns, throws, or
  // re-loops up to RETRY_MAX_ATTEMPTS times. Keep the final throw so
  // TypeScript doesn't infer `Promise<unknown | undefined>`.
  throw lastErr ?? new Error("prompt returned no result");
  } finally {
    if (tokensBefore && opts.onTokens) {
      const tokensAfter = tokenTracker.total();
      opts.onTokens({
        promptTokens: Math.max(0, tokensAfter.promptTokens - tokensBefore.promptTokens),
        responseTokens: Math.max(0, tokensAfter.responseTokens - tokensBefore.responseTokens),
      });
    }
  }
}

function defaultDescribeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

