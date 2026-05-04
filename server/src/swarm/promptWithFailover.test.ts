// W13 + W14 + W15 (2026-05-04): tests for promptWithFailover.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  promptWithFailover,
  type FailoverState,
  type FailoverConfig,
  type PromptFn,
} from "./promptWithFailover.js";

// Minimal Agent stub — promptWithFailover only uses agent.model + id.
function fakeAgent(model: string): any {
  return {
    id: "a1",
    index: 1,
    model,
    cwd: "/tmp/x",
  };
}

function emptyState(): FailoverState {
  return {
    modelHealth: new Map(),
  };
}

function baseOpts(): any {
  return {
    signal: new AbortController().signal,
  };
}

/** Build a stub PromptFn that records every call + returns/throws based
 *  on a predicate keyed by modelOverride. */
function makeStub(
  decide: (modelOverride: string | undefined, callIdx: number) => unknown | Error,
): { fn: PromptFn; calls: Array<{ modelOverride: string | undefined }> } {
  const calls: Array<{ modelOverride: string | undefined }> = [];
  const fn: PromptFn = async (_agent, _text, opts) => {
    calls.push({ modelOverride: opts.modelOverride });
    const r = decide(opts.modelOverride, calls.length - 1);
    if (r instanceof Error) throw r;
    return r;
  };
  return { fn, calls };
}

test("promptWithFailover — success first try → no failover", async () => {
  const { fn, calls } = makeStub(() => "ok");
  const state = emptyState();
  const cfg: FailoverConfig = { failoverChain: [], promptFn: fn };
  const out = await promptWithFailover(
    fakeAgent("glm-5.1:cloud"),
    "test",
    baseOpts(),
    state,
    cfg,
  );
  assert.equal(out, "ok");
  assert.equal(calls.length, 1);
  assert.equal(state.modelHealth.get("glm-5.1:cloud")?.length, 1);
  assert.equal(state.modelHealth.get("glm-5.1:cloud")?.[0]?.success, true);
});

test("promptWithFailover — quota error → swaps to next chain model", async () => {
  const { fn, calls } = makeStub((modelOverride) => {
    if (modelOverride === "glm-5.1:cloud") return new Error("rate limit exceeded (429)");
    return "ok-from-fallback";
  });
  const state = emptyState();
  const cfg: FailoverConfig = {
    failoverChain: ["claude-haiku-4-5"],
    promptFn: fn,
  };
  const swaps: any[] = [];
  const out = await promptWithFailover(
    fakeAgent("glm-5.1:cloud"),
    "test",
    baseOpts(),
    state,
    cfg,
    (info) => swaps.push(info),
  );
  assert.equal(out, "ok-from-fallback");
  assert.equal(calls.length, 2);
  assert.equal(swaps.length, 1);
  assert.equal(swaps[0]!.fromModel, "glm-5.1:cloud");
  assert.equal(swaps[0]!.toModel, "claude-haiku-4-5");
  assert.equal(swaps[0]!.classified.category, "quota");
});

test("promptWithFailover — auth error → swaps to next chain model", async () => {
  const { fn } = makeStub((modelOverride) => {
    if (modelOverride === "anthropic/claude-opus-4-7") return new Error("Unauthorized 401");
    return "ok";
  });
  const state = emptyState();
  const cfg: FailoverConfig = {
    failoverChain: ["glm-5.1:cloud"],
    promptFn: fn,
  };
  const out = await promptWithFailover(
    fakeAgent("anthropic/claude-opus-4-7"),
    "test",
    baseOpts(),
    state,
    cfg,
  );
  assert.equal(out, "ok");
});

test("promptWithFailover — exhausted chain → R3 local fallback", async () => {
  const { fn } = makeStub((modelOverride) => {
    if (modelOverride === "llama3:8b") return "ok-local";
    return new Error("rate limit (429)");
  });
  const state = emptyState();
  const cfg: FailoverConfig = {
    failoverChain: [], // R1 chain empty
    localTags: ["llama3:8b", "phi3:3.8b"],
    promptFn: fn,
  };
  const swaps: any[] = [];
  const out = await promptWithFailover(
    fakeAgent("anthropic/claude-opus-4-7"),
    "test",
    baseOpts(),
    state,
    cfg,
    (info) => swaps.push(info),
  );
  assert.equal(out, "ok-local");
  assert.equal(swaps.length, 1);
  assert.equal(swaps[0]!.toModel, "llama3:8b"); // largest by inferParamSize
});

test("promptWithFailover — terminal error (cap) → no swap, throws", async () => {
  const { fn } = makeStub(() => new Error("wall-clock cap reached"));
  const state = emptyState();
  const cfg: FailoverConfig = {
    failoverChain: ["claude-haiku-4-5"],
    promptFn: fn,
  };
  await assert.rejects(
    promptWithFailover(fakeAgent("glm-5.1:cloud"), "x", baseOpts(), state, cfg),
    /wall-clock cap reached/,
  );
  // Only the primary model attempted — failover skipped on cap.
  assert.equal(state.modelHealth.size, 1);
});

test("promptWithFailover — exhausts maxSwaps → throws latest error", async () => {
  const { fn, calls } = makeStub(() => new Error("rate limit"));
  const state = emptyState();
  const cfg: FailoverConfig = {
    failoverChain: ["m1", "m2", "m3", "m4", "m5"],
    maxSwaps: 2,
    promptFn: fn,
  };
  await assert.rejects(
    promptWithFailover(fakeAgent("primary"), "x", baseOpts(), state, cfg),
    /rate limit/,
  );
  // primary + 2 swaps = 3 calls before maxSwaps caps us
  assert.equal(calls.length, 3);
});

test("promptWithFailover — R10 health swap fires before degraded model is even tried", async () => {
  const { fn, calls } = makeStub(() => "ok");
  const state = emptyState();
  // Pre-populate health: 5 failures on the primary
  state.modelHealth.set(
    "primary-model",
    Array.from({ length: 5 }, () => ({ success: false, ts: 1000 })),
  );
  const cfg: FailoverConfig = {
    failoverChain: ["fallback-model"],
    enableHealthSwap: true,
    promptFn: fn,
  };
  const swaps: any[] = [];
  const out = await promptWithFailover(
    fakeAgent("primary-model"),
    "x",
    baseOpts(),
    state,
    cfg,
    (info) => swaps.push(info),
  );
  assert.equal(out, "ok");
  // Only one prompt call — to the FALLBACK, not the primary
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.modelOverride, "fallback-model");
  assert.equal(swaps.length, 1);
  assert.match(swaps[0]!.reason, /R10 proactive/);
});

test("promptWithFailover — health tracker records both successes and failures", async () => {
  let n = 0;
  const { fn } = makeStub((modelOverride) => {
    n += 1;
    if (modelOverride === "primary" && n === 1) return new Error("rate limit");
    return "ok";
  });
  const state = emptyState();
  const cfg: FailoverConfig = {
    failoverChain: ["secondary"],
    promptFn: fn,
  };
  await promptWithFailover(fakeAgent("primary"), "x", baseOpts(), state, cfg);
  assert.equal(state.modelHealth.get("primary")?.length, 1);
  assert.equal(state.modelHealth.get("primary")?.[0]?.success, false);
  assert.equal(state.modelHealth.get("secondary")?.length, 1);
  assert.equal(state.modelHealth.get("secondary")?.[0]?.success, true);
});

test("promptWithFailover — degraded model NOT swapped when chain empty AND no local fallback", async () => {
  const { fn, calls } = makeStub(() => "ok");
  const state = emptyState();
  state.modelHealth.set(
    "primary",
    Array.from({ length: 5 }, () => ({ success: false, ts: 1 })),
  );
  const cfg: FailoverConfig = {
    failoverChain: [],
    enableHealthSwap: true,
    promptFn: fn,
    // No localTags either
  };
  await promptWithFailover(fakeAgent("primary"), "x", baseOpts(), state, cfg);
  // No swap happened — primary was tried as-is
  assert.equal(calls[0]!.modelOverride, "primary");
});

test("promptWithFailover — health swap respects R3 localTags fallback", async () => {
  const { fn, calls } = makeStub(() => "ok");
  const state = emptyState();
  state.modelHealth.set(
    "anthropic/claude-opus-4-7",
    Array.from({ length: 5 }, () => ({ success: false, ts: 1 })),
  );
  const cfg: FailoverConfig = {
    failoverChain: [],
    localTags: ["llama3:8b"],
    enableHealthSwap: true,
    promptFn: fn,
  };
  await promptWithFailover(
    fakeAgent("anthropic/claude-opus-4-7"),
    "x",
    baseOpts(),
    state,
    cfg,
  );
  assert.equal(calls[0]!.modelOverride, "llama3:8b");
});

test("promptWithFailover — empty failoverChain + no localTags + no health swap → behaves like a plain promptWithRetry call", async () => {
  const { fn, calls } = makeStub(() => "passthrough");
  const state = emptyState();
  const cfg: FailoverConfig = { failoverChain: [], promptFn: fn };
  const out = await promptWithFailover(
    fakeAgent("solo"),
    "x",
    baseOpts(),
    state,
    cfg,
  );
  assert.equal(out, "passthrough");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.modelOverride, "solo");
});

test("promptWithFailover — modelHealth accumulates across calls (R10 cumulative state)", async () => {
  const { fn, calls } = makeStub((modelOverride) => {
    if (modelOverride === "primary") return new Error("rate limit");
    return "ok";
  });
  const state = emptyState();
  const cfg: FailoverConfig = {
    failoverChain: ["secondary"],
    promptFn: fn,
  };
  await promptWithFailover(fakeAgent("primary"), "x", baseOpts(), state, cfg);
  // After call 1: primary has 1 failure, secondary has 1 success.
  assert.equal(state.modelHealth.get("primary")?.length, 1);
  assert.equal(state.modelHealth.get("secondary")?.length, 1);
  // Call 2: each call gets a fresh triedThisCall set, so the chain
  // is fully available again. Primary fails, swap to secondary,
  // secondary succeeds.
  const out2 = await promptWithFailover(
    fakeAgent("primary"),
    "x",
    baseOpts(),
    state,
    cfg,
  );
  assert.equal(out2, "ok");
  assert.equal(calls.length, 4);
  // After call 2: primary has 2 failures, secondary has 2 successes.
  assert.equal(state.modelHealth.get("primary")?.length, 2);
  assert.equal(state.modelHealth.get("secondary")?.length, 2);
});
