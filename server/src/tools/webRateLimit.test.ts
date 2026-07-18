/**
 * RR-C §8: atomic web rate limit (mutex + separate search/fetch clocks).
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  applyWebRateLimit,
  _resetWebRateLimitForTests,
} from "./webTools.js";

describe("applyWebRateLimit (RR-C §8)", () => {
  beforeEach(() => {
    _resetWebRateLimitForTests({ searchMs: 50, fetchMs: 50 });
  });

  it("serializes concurrent same-kind calls (no stampede past lastCall)", async () => {
    // Seed lastCall so subsequent waits are real.
    await applyWebRateLimit("search");
    const t0 = Date.now();
    await Promise.all([
      applyWebRateLimit("search"),
      applyWebRateLimit("search"),
      applyWebRateLimit("search"),
    ]);
    const elapsed = Date.now() - t0;
    // With mutex: ~50+50+50ms. Without: all wait once (~50ms) then stamp together.
    assert.ok(
      elapsed >= 130,
      `expected ≥130ms under mutex, got ${elapsed}ms (racy lastCall?)`,
    );
  });

  it("keeps independent search vs fetch clocks", async () => {
    await applyWebRateLimit("search");
    const t0 = Date.now();
    await applyWebRateLimit("fetch");
    const elapsed = Date.now() - t0;
    // Fetch should not wait for search interval.
    assert.ok(
      elapsed < 40,
      `fetch after search should be free, took ${elapsed}ms`,
    );
  });

  it("still spaces sequential same-kind calls", async () => {
    await applyWebRateLimit("fetch");
    const t0 = Date.now();
    await applyWebRateLimit("fetch");
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= 40, `expected ≥40ms gap, got ${elapsed}ms`);
  });

  it("spaces concurrent mixed kinds only within each kind", async () => {
    await applyWebRateLimit("search");
    await applyWebRateLimit("fetch");
    const t0 = Date.now();
    await Promise.all([
      applyWebRateLimit("search"),
      applyWebRateLimit("fetch"),
    ]);
    const elapsed = Date.now() - t0;
    // One wait per kind in parallel under one mutex: ~50ms, not 100ms race-free
    // worst case still bounded; both must complete after their own interval.
    assert.ok(elapsed >= 40, `expected ≥40ms, got ${elapsed}ms`);
    assert.ok(elapsed < 200, `expected <200ms (parallel kinds), got ${elapsed}ms`);
  });
});
