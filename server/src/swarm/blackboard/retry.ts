// Bounded retry for OpenCode SDK prompt calls.
//
// Phase 11c v4 crashed on the first planner turn when Ollama's cloud
// responded with a single UND_ERR_HEADERS_TIMEOUT — 0 commits, 0 todos,
// 9 min wall-clock burned. One transient network hiccup killed the
// whole run because we had no retry at the prompt boundary.
//
// This file is the pure-function side of the fix. The runner integrates
// it around `agent.client.session.prompt(...)` in promptAgent.
//
// What counts as retryable: only transport-class failures where a second
// attempt has a real shot of succeeding. We do NOT retry:
//   - AbortError (user stop or watchdog — we intentionally killed it)
//   - HTTP 4xx from the SDK (auth, schema, bad request — retry won't fix)
//   - Anything we can't classify (fail closed — surface the error instead
//     of hiding it behind silent retries)

export const RETRY_MAX_ATTEMPTS = 3;

// Delays BEFORE attempts 2 and 3 (no delay before attempt 1).
// Budget: 4 + 16 = 20s of backoff on top of up to 3 × ~5min undici
// timeouts = ~15min worst case — fits inside the 20min per-turn watchdog.
export const RETRY_BACKOFF_MS: readonly number[] = [4_000, 16_000];

// Undici + Node.js network error codes that are worth a second try.
const RETRYABLE_CODES = new Set<string>([
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN", // DNS transient
]);

// Undici sometimes surfaces the class name without a `.code` on the
// outer Error — match on those too so we don't miss the case where the
// shape varies by node/undici version.
const RETRYABLE_NAMES = new Set<string>([
  "HeadersTimeoutError",
  "BodyTimeoutError",
  "ConnectTimeoutError",
  "SocketError",
]);

export function isRetryableSdkError(err: unknown): boolean {
  // Intentional cancellations — don't retry.
  if (err instanceof Error && err.name === "AbortError") return false;

  let cur: unknown = err;
  let depth = 0;
  while (cur && depth < 5) {
    if (cur instanceof Error) {
      const code = (cur as { code?: unknown }).code;
      if (typeof code === "string" && RETRYABLE_CODES.has(code)) return true;
      if (RETRYABLE_NAMES.has(cur.name)) return true;
      cur = (cur as { cause?: unknown }).cause;
    } else {
      return false;
    }
    depth++;
  }
  return false;
}
