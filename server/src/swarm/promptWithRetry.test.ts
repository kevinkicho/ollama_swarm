import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { promptWithRetry, type RetryInfo } from "./promptWithRetry.js";
import type { Agent } from "../services/AgentManager.js";
import type { SessionProvider } from "../providers/SessionProvider.js";
import { __setTestProviderOverride, __resetProviderSingletons } from "../providers/pickProvider.js";

// Build a fake Agent + install a mock SessionProvider via the
// pickProvider test seam. promptWithRetry routes through the
// SessionProvider abstraction, so tests inject behavior at that layer.
// promptImpl returns the bare assistant text per call (or throws to
// simulate transient/permanent failures).
function makeAgent(promptImpl: (call: number) => Promise<string>): {
  agent: Agent;
  callCount: () => number;
} {
  let n = 0;
  const provider: SessionProvider = {
    id: "ollama",
    async chat(_opts) {
      n += 1;
      const text = await promptImpl(n);
      return { text, elapsedMs: 0, finishReason: "done" };
    },
  };
  __setTestProviderOverride(provider);
  const agent = {
    id: "agent-1",
    index: 1,
    port: 0,
    sessionId: "sess-1",
    model: "test-model",
    cwd: "",
  } as unknown as Agent;
  return { agent, callCount: () => n };
}

beforeEach(() => __resetProviderSingletons());
afterEach(() => __resetProviderSingletons());

// A retryable error per retry.ts's classifier — uses one of the
// recognized codes so isRetryableSdkError returns true.
function transientError(): Error {
  const err = new Error("fetch failed") as Error & { code?: string };
  err.code = "UND_ERR_HEADERS_TIMEOUT";
  return err;
}

function permanentError(): Error {
  const err = new Error("HTTP 401 Unauthorized") as Error & { code?: string };
  err.code = "ERR_BAD_REQUEST";
  return err;
}

// Sleep stub: resolves immediately so tests don't actually wait the
// 4s + 16s backoff. Returns true (sleep completed naturally).
const fastSleep = async (_ms: number, signal: AbortSignal): Promise<boolean> => {
  return !signal.aborted;
};

describe("promptWithRetry — happy path", () => {
  it("returns the SDK-shaped response on first attempt success", async () => {
    const { agent, callCount } = makeAgent(async () => "ok");
    const ctrl = new AbortController();
    const res = await promptWithRetry(agent, "hello", { signal: ctrl.signal, sleep: fastSleep });
    // promptWithRetry wraps the provider's text into the SDK-shaped
    // {data: {parts: [{type:"text", text}]}} so existing callers keep
    // working without per-site shape adaptation.
    assert.deepEqual(res, { data: { parts: [{ type: "text", text: "ok" }] } });
    assert.equal(callCount(), 1);
  });

  it("does not call onRetry when the first attempt succeeds", async () => {
    const { agent } = makeAgent(async () => "ok");
    const ctrl = new AbortController();
    let retryCalls = 0;
    await promptWithRetry(agent, "hi", {
      signal: ctrl.signal,
      sleep: fastSleep,
      onRetry: () => {
        retryCalls += 1;
      },
    });
    assert.equal(retryCalls, 0);
  });
});

describe("promptWithRetry — retry on transient", () => {
  it("retries once and succeeds on attempt 2", async () => {
    const { agent, callCount } = makeAgent(async (n) => {
      if (n === 1) throw transientError();
      return "ok-after-retry";
    });
    const ctrl = new AbortController();
    const seen: RetryInfo[] = [];
    const res = await promptWithRetry(agent, "hi", {
      signal: ctrl.signal,
      sleep: fastSleep,
      onRetry: (info) => seen.push(info),
    });
    assert.deepEqual(res, { data: { parts: [{ type: "text", text: "ok-after-retry" }] } });
    assert.equal(callCount(), 2);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].attempt, 2, "onRetry reports the attempt about to start (1-based, so attempt 2)");
    assert.equal(seen[0].max, 3);
    assert.equal(seen[0].delayMs, 30_000, "Unit 39: first backoff before attempt 2 is 30s per RETRY_BACKOFF_MS");
    assert.match(seen[0].reasonShort, /fetch failed|UND_ERR/);
  });

  it("retries twice (attempts 2 and 3) and succeeds on attempt 3", async () => {
    const { agent, callCount } = makeAgent(async (n) => {
      if (n < 3) throw transientError();
      return "ok";
    });
    const ctrl = new AbortController();
    const seen: RetryInfo[] = [];
    await promptWithRetry(agent, "hi", {
      signal: ctrl.signal,
      sleep: fastSleep,
      onRetry: (info) => seen.push(info),
    });
    assert.equal(callCount(), 3);
    assert.equal(seen.length, 2);
    assert.deepEqual(
      seen.map((s) => ({ attempt: s.attempt, delayMs: s.delayMs })),
      [
        { attempt: 2, delayMs: 30_000 },
        { attempt: 3, delayMs: 90_000 },
      ],
    );
  });

  it("throws after RETRY_MAX_ATTEMPTS = 3 attempts on persistent transient errors", async () => {
    const { agent, callCount } = makeAgent(async () => {
      throw transientError();
    });
    const ctrl = new AbortController();
    await assert.rejects(
      () => promptWithRetry(agent, "hi", { signal: ctrl.signal, sleep: fastSleep }),
      /fetch failed/,
    );
    assert.equal(callCount(), 3, "exactly 3 attempts before giving up");
  });
});

describe("promptWithRetry — non-retryable + abort", () => {
  it("does not retry a non-retryable error (e.g. HTTP 4xx)", async () => {
    const { agent, callCount } = makeAgent(async () => {
      throw permanentError();
    });
    const ctrl = new AbortController();
    let retryCalls = 0;
    await assert.rejects(
      () =>
        promptWithRetry(agent, "hi", {
          signal: ctrl.signal,
          sleep: fastSleep,
          onRetry: () => {
            retryCalls += 1;
          },
        }),
      /Unauthorized/,
    );
    assert.equal(callCount(), 1, "permanent error fails on first attempt with no retry");
    assert.equal(retryCalls, 0);
  });

  it("does not retry an AbortError from the SDK", async () => {
    const { agent, callCount } = makeAgent(async () => {
      const e = new Error("aborted") as Error;
      e.name = "AbortError";
      throw e;
    });
    const ctrl = new AbortController();
    await assert.rejects(() =>
      promptWithRetry(agent, "hi", { signal: ctrl.signal, sleep: fastSleep }),
    );
    assert.equal(callCount(), 1);
  });

  it("re-throws the underlying error if signal aborted before next attempt", async () => {
    // Pre-abort the controller; then have the SDK throw a transient.
    // The retry loop checks signal.aborted right after the catch and
    // throws the original error instead of retrying.
    const { agent, callCount } = makeAgent(async () => {
      throw transientError();
    });
    const ctrl = new AbortController();
    ctrl.abort(new Error("user stop"));
    await assert.rejects(
      () => promptWithRetry(agent, "hi", { signal: ctrl.signal, sleep: fastSleep }),
      /fetch failed/,
    );
    assert.equal(callCount(), 1, "no retry attempted because signal was aborted");
  });

  it("throws the underlying error if sleep is interrupted by abort", async () => {
    const { agent, callCount } = makeAgent(async () => {
      throw transientError();
    });
    const ctrl = new AbortController();
    // Sleep stub that returns false (interrupted) without aborting the
    // signal — the helper should still throw, not loop forever.
    const interruptedSleep = async (_ms: number, _sig: AbortSignal): Promise<boolean> => false;
    await assert.rejects(
      () =>
        promptWithRetry(agent, "hi", { signal: ctrl.signal, sleep: interruptedSleep }),
      /fetch failed/,
    );
    assert.equal(callCount(), 1);
  });
});

describe("promptWithRetry — describeError customization", () => {
  it("uses the custom describeError for the reasonShort field", async () => {
    const { agent } = makeAgent(async (n) => {
      if (n === 1) throw transientError();
      return "ok";
    });
    const ctrl = new AbortController();
    let captured = "";
    await promptWithRetry(agent, "hi", {
      signal: ctrl.signal,
      sleep: fastSleep,
      describeError: () => "my-custom-summary",
      onRetry: (info) => {
        captured = info.reasonShort;
      },
    });
    assert.equal(captured, "my-custom-summary");
  });
});
