import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectQuotaExhausted } from "./ollamaProxy.js";

describe("detectQuotaExhausted (Task #137)", () => {
  it("returns null on a normal 200 OK with usage body", () => {
    const body = JSON.stringify({ prompt_eval_count: 100, eval_count: 50 });
    assert.equal(detectQuotaExhausted(200, body), null);
  });

  it("flags status 429 unconditionally", () => {
    const r = detectQuotaExhausted(429, "");
    assert.ok(r);
    assert.match(r!, /429/);
  });

  it("includes a snippet of the body in the 429 reason when present", () => {
    const r = detectQuotaExhausted(429, '{"error":"rate limit exceeded for plan free"}');
    assert.ok(r);
    assert.match(r!, /rate limit/i);
  });

  it("flags status 402 when body looks quota-shaped", () => {
    const r = detectQuotaExhausted(402, '{"error":"weekly limit exceeded"}');
    assert.ok(r);
    assert.match(r!, /402/);
    assert.match(r!, /weekly limit/i);
  });

  it("does NOT flag status 402 when body is unrelated", () => {
    assert.equal(detectQuotaExhausted(402, '{"error":"payment method invalid"}'), null);
  });

  it("flags status 403 when body mentions quota", () => {
    const r = detectQuotaExhausted(403, '{"error":"quota exceeded"}');
    assert.ok(r);
    assert.match(r!, /quota/i);
  });

  it("flags 200-with-error body when the error mentions a quota keyword", () => {
    const r = detectQuotaExhausted(200, '{"error":"You have exceeded your plan limit; please upgrade."}');
    assert.ok(r);
    assert.match(r!, /200-with-error/);
    assert.match(r!, /exceeded/);
  });

  it("does NOT flag 200-with-error when the error is about something else", () => {
    assert.equal(
      detectQuotaExhausted(200, '{"error":"model not found: foo:cloud"}'),
      null,
    );
  });

  it("returns null for streaming-shaped (non-JSON) 200 bodies", () => {
    assert.equal(
      detectQuotaExhausted(200, 'data: {"chunk":"hello"}\n\ndata: [DONE]\n'),
      null,
    );
  });

  it("normalizes whitespace in the reason snippet", () => {
    const r = detectQuotaExhausted(429, "  Too\n  Many   Requests  ");
    assert.ok(r);
    assert.match(r!, /Too Many Requests/);
    assert.doesNotMatch(r!, /\n/);
  });

  it("truncates long bodies in the reason", () => {
    const long = "x".repeat(500);
    const r = detectQuotaExhausted(429, long);
    assert.ok(r);
    assert.ok(r!.length < 200, `reason should be capped, got ${r!.length} chars`);
  });
});
