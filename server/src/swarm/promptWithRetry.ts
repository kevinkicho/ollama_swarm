import type { Agent } from "../services/AgentManager.js";
import {
  RETRY_MAX_ATTEMPTS,
  RETRY_BACKOFF_MS,
  isRetryableSdkError,
} from "./blackboard/retry.js";

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
  let lastErr: unknown;
  for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
    const t0 = Date.now();
    try {
      const res = await agent.client.session.prompt({
        path: { id: agent.sessionId },
        body: {
          agent: agentName,
          model: { providerID: "ollama", modelID: agent.model },
          parts: [{ type: "text", text: promptText }],
        },
        signal: opts.signal,
      });
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
}

function defaultDescribeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// Promise-based interruptible sleep. Resolves true if the timeout
// fires naturally, false if the abort signal interrupts it. Mirrors
// BlackboardRunner.interruptibleSleep so behavior is identical.
async function defaultInterruptibleSleep(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
