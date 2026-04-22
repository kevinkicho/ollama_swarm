import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  isRetryableSdkError,
  RETRY_BACKOFF_MS,
  RETRY_MAX_ATTEMPTS,
} from "./retry.js";

// Build an Error whose `code` property is set — mimics what Node/undici
// attach to socket-layer errors.
function errWithCode(name: string, code: string, message = "test"): Error {
  const e = new Error(message);
  e.name = name;
  (e as { code?: string }).code = code;
  return e;
}

function wrap(outer: string, inner: Error): Error {
  const e = new Error(outer);
  (e as { cause?: unknown }).cause = inner;
  return e;
}

describe("isRetryableSdkError", () => {
  it("retries on UND_ERR_HEADERS_TIMEOUT at the top level", () => {
    assert.equal(
      isRetryableSdkError(errWithCode("HeadersTimeoutError", "UND_ERR_HEADERS_TIMEOUT")),
      true,
    );
  });

  it("retries when headers-timeout is nested under a generic 'fetch failed'", () => {
    const inner = errWithCode("HeadersTimeoutError", "UND_ERR_HEADERS_TIMEOUT");
    const outer = wrap("fetch failed", inner);
    assert.equal(isRetryableSdkError(outer), true);
  });

  it("retries on ECONNRESET", () => {
    assert.equal(isRetryableSdkError(errWithCode("Error", "ECONNRESET")), true);
  });

  it("retries on ETIMEDOUT", () => {
    assert.equal(isRetryableSdkError(errWithCode("Error", "ETIMEDOUT")), true);
  });

  it("retries when only the error name signals transport failure (no code)", () => {
    const e = new Error("opaque undici message");
    e.name = "HeadersTimeoutError";
    assert.equal(isRetryableSdkError(e), true);
  });

  it("retries on DNS flake EAI_AGAIN", () => {
    assert.equal(isRetryableSdkError(errWithCode("Error", "EAI_AGAIN")), true);
  });

  it("does NOT retry AbortError — the caller aborted on purpose", () => {
    const e = new Error("aborted");
    e.name = "AbortError";
    assert.equal(isRetryableSdkError(e), false);
  });

  it("does NOT retry a generic Error with no code and no transport name", () => {
    assert.equal(isRetryableSdkError(new Error("boom")), false);
  });

  it("does NOT retry an SDK 400-shaped error (no cause chain code)", () => {
    const e = new Error("Bad Request");
    (e as { status?: number }).status = 400;
    assert.equal(isRetryableSdkError(e), false);
  });

  it("returns false for non-Error throws (strings, null, undefined)", () => {
    assert.equal(isRetryableSdkError("just a string"), false);
    assert.equal(isRetryableSdkError(null), false);
    assert.equal(isRetryableSdkError(undefined), false);
    assert.equal(isRetryableSdkError(42), false);
  });

  it("bounds cause-chain walking to 5 levels (no infinite loop on cycles)", () => {
    const a = new Error("a");
    const b = new Error("b");
    (a as { cause?: unknown }).cause = b;
    (b as { cause?: unknown }).cause = a; // cycle
    // Should return false (no retryable code found) and NOT hang.
    assert.equal(isRetryableSdkError(a), false);
  });
});

describe("retry config", () => {
  it("has exactly 2 backoff delays for 3 total attempts", () => {
    assert.equal(RETRY_MAX_ATTEMPTS, 3);
    assert.equal(RETRY_BACKOFF_MS.length, RETRY_MAX_ATTEMPTS - 1);
  });

  it("delays grow monotonically (exponential-ish)", () => {
    for (let i = 1; i < RETRY_BACKOFF_MS.length; i++) {
      assert.ok(
        RETRY_BACKOFF_MS[i] > RETRY_BACKOFF_MS[i - 1],
        `delay[${i}] should exceed delay[${i - 1}]`,
      );
    }
  });
});
