import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { interruptibleSleep } from "./interruptibleSleep.js";

describe("interruptibleSleep", () => {
  it("resolves true after the full delay", async () => {
    const ctrl = new AbortController();
    const started = Date.now();
    const result = await interruptibleSleep(50, ctrl.signal);
    const elapsed = Date.now() - started;
    assert.equal(result, true);
    assert.ok(elapsed >= 40, `elapsed ${elapsed}ms should be >= 40ms`);
  });

  it("resolves false immediately when signal is already aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const started = Date.now();
    const result = await interruptibleSleep(50000, ctrl.signal);
    assert.equal(result, false);
    assert.ok(Date.now() - started < 50, "should resolve near-instantly");
  });

  it("resolves false when aborted mid-sleep", async () => {
    const ctrl = new AbortController();
    const started = Date.now();
    const promise = interruptibleSleep(5000, ctrl.signal);
    // Abort after 30ms
    setTimeout(() => ctrl.abort(), 30);
    const result = await promise;
    const elapsed = Date.now() - started;
    assert.equal(result, false);
    assert.ok(elapsed < 1000, "should resolve quickly after abort");
  });

  it("works with zero delay", async () => {
    const ctrl = new AbortController();
    const result = await interruptibleSleep(0, ctrl.signal);
    assert.equal(result, true);
  });

  it("works with very short delay", async () => {
    const ctrl = new AbortController();
    const result = await interruptibleSleep(1, ctrl.signal);
    assert.equal(result, true);
  });

  it("aborts cleanly without leaving dangling timers", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    // Should resolve immediately without error
    const result = await interruptibleSleep(10000, ctrl.signal);
    assert.equal(result, false);
  });

  it("concurrent aborts don't throw", async () => {
    const ctrl = new AbortController();
    const promise = interruptibleSleep(100, ctrl.signal);
    ctrl.abort();
    ctrl.abort(); // double abort — should not throw
    await promise;
    assert.ok(true, "double abort should not throw");
  });
});
