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
//
// Unit 39 (2026-04-23): bumped from [4 s, 16 s] to [30 s, 90 s].
// Live smoke runs showed retries firing back-to-back with
// only ~4-16 s of cooling between them, each hitting the same slow
// cloud shard. At [4, 16] the cloud didn't have time to warm; at
// [30, 90] a truly cold shard has a real chance to come online
// before we try again. Budget: 30 + 90 = 120 s backoff on top of
// up to 3 × 600 s (HEADERS_TIMEOUT_MS, Unit 46a) timeouts = ~32 min
// worst case. NOTE: this exceeds the 20-min per-turn watchdog
// (ABSOLUTE_MAX_MS in BlackboardRunner) — the watchdog will abort
// the in-flight attempt before all 3 retries can complete on
// pathological cases. That's intentional: we'd rather lose a stuck
// turn at 20 min than a healthy run at 32 min on retry math.
// Healthy runs are unaffected (succeed on attempt 1; backoff
// never fires).
export const RETRY_BACKOFF_MS: readonly number[] = [30_000, 90_000];

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

// V2 Step 1: Ollama-direct idle timeout means the cloud backend hung
// silently — same condition the V1 SSE path treats as "transient,
// worth a retry" (UND_ERR_BODY_TIMEOUT). Match the message we throw
// from OllamaClient.chat so isRetryableSdkError flags it.
//
// 2026-04-27: added "Ollama HTTP 503" + "overloaded" + "server busy"
// after run 59c66144 crashed on
//   "Ollama HTTP 503: Server overloaded, please retry shortly"
// 503 is a transient capacity hiccup; backoff + retry usually clears
// it within a single 30-90s window. Crashing wastes the whole run.
const RETRYABLE_MESSAGE_PATTERNS: readonly RegExp[] = [
  /Ollama idle timeout/i,
  /health-check timeout/i,
  /Ollama HTTP 503\b/i,
  /Server overloaded/i,
  /\boverloaded\b/i,
  /\bserver\s+busy\b/i,
  // OpenCode / undici: outer message is often bare "fetch failed" with a
  // retryable cause chain — also retry when no cause is surfaced.
  /^fetch failed$/i,
  /OpenCode\b.*\bHTTP 5\d\d\b/i,
  /Ollama HTTP 429\b/i,
  /session usage limit/i,
  /rate limit exceeded/i,
];

/** Provider quota / transport stall — not genuine "no progress" on the task. */
export function isTransientProviderStall(msg: string): boolean {
  if (!msg) return false;
  if (isRetryableSdkError(new Error(msg))) return true;
  return RETRYABLE_MESSAGE_PATTERNS.some((p) => p.test(msg));
}

/** Sidebar + transcript retry label — avoids implying local Ollama is down. */
export function shortRetryReason(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const idle = /Ollama idle timeout: no body data for (\d+)ms/i.exec(msg);
  if (idle) {
    const sec = Math.round(Number(idle[1]) / 1000);
    return `cloud queue: no first token in ${sec}s (other agents may be fine)`;
  }
  if (/UND_ERR_HEADERS_TIMEOUT/i.test(msg)) {
    return "cloud headers timeout (transient; retrying)";
  }
  if (/503|overloaded|server busy/i.test(msg)) {
    return "cloud capacity busy (transient; retrying)";
  }
  if (/^fetch failed$/i.test(msg) || /OpenCode HTTP 5/i.test(msg)) {
    return "provider connection failed (transient; retrying)";
  }
  return msg.length > 96 ? `${msg.slice(0, 93)}…` : msg;
}

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
      // V2 Step 1: also match the Ollama-direct idle-timeout message.
      const msg = cur.message;
      if (msg && RETRYABLE_MESSAGE_PATTERNS.some((p) => p.test(msg))) {
        return true;
      }
      cur = (cur as { cause?: unknown }).cause;
    } else {
      return false;
    }
    depth++;
  }
  return false;
}
