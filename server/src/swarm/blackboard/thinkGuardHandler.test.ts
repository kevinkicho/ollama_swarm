import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ThinkGuardAbortError } from "@ollama-swarm/shared/thinkGuardErrors";
import type { RunConfig } from "../SwarmRunner.js";
import {
  createThinkGuardHandler,
  createDiscussionThinkGuardHandler,
  isDiscussionDraftKind,
  isThinkGuardRefereeEligible,
  resolveRecoveryRefereeOn,
  resolveThinkGuardRefereeOn,
  runRecoveryRefereeCheckpoint,
} from "./thinkGuardHandler.js";

function runCfg(overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    repoUrl: "https://x",
    localPath: "/tmp/x",
    agentCount: 1,
    rounds: 1,
    model: "test",
    preset: "blackboard",
    thinkGuardRefereeEnabled: true,
    thinkGuardRefereeMaxCallsPerRun: 6,
    thinkGuardRefereeCallsUsed: 0,
    ...overrides,
  } as RunConfig;
}

function abortErr(overrides: Partial<ConstructorParameters<typeof ThinkGuardAbortError>[0]> = {}) {
  return new ThinkGuardAbortError({
    tier: 1,
    reason: "think stream exceeded 112,000 chars (soft)",
    partialText: `<think>${"reason ".repeat(50_000)}</think>`,
    thinkChars: 112_000,
    thinkElapsedMs: 90_000,
    ...overrides,
  });
}

describe("isThinkGuardRefereeEligible", () => {
  it("requires explore mode and contract, planner-todos, or replan kind", () => {
    assert.equal(isThinkGuardRefereeEligible({ kind: "contract", mode: "explore" }), true);
    assert.equal(isThinkGuardRefereeEligible({ kind: "planner-todos", mode: "explore" }), true);
    assert.equal(isThinkGuardRefereeEligible({ kind: "replan", mode: "explore" }), true);
    assert.equal(isThinkGuardRefereeEligible({ kind: "contract", mode: "emit" }), false);
    assert.equal(isThinkGuardRefereeEligible({ kind: "worker", mode: "explore" }), false);
  });
});

describe("resolveRecoveryRefereeOn", () => {
  it("allows emit-mode recovery kinds when budget remains", () => {
    assert.equal(resolveRecoveryRefereeOn("planner-todos", runCfg()), true);
    assert.equal(resolveRecoveryRefereeOn("worker", runCfg()), false);
  });
});

describe("runRecoveryRefereeCheckpoint", () => {
  it("invokes referee on planner recovery stall and returns salvage", async () => {
    const systems: string[] = [];
    let cfg = runCfg();
    const result = await runRecoveryRefereeCheckpoint(
      {
        getActive: () => cfg,
        isStopping: () => false,
        isDraining: () => false,
        appendSystem: (m) => systems.push(m),
        kind: "planner-todos",
        label: "planner-todos emit-only retry",
        clonePath: "/tmp/x",
      },
      {
        partialText: `<think>${"loop ".repeat(60_000)}</think>`,
        attempt: 3,
        lastReason: "parse: missing todos array",
      },
    );
    assert.ok(result);
    assert.ok(result!.forceEmit || result!.salvageBrief);
    assert.equal(cfg.thinkGuardRefereeCallsUsed, 1);
    assert.ok(systems.some((s) => s.includes("recovery checkpoint")));
  });
});

describe("resolveThinkGuardRefereeOn", () => {
  it("is false when flag off or budget exhausted", () => {
    const activity = { kind: "contract" as const, mode: "explore" as const };
    assert.equal(resolveThinkGuardRefereeOn(activity, runCfg({ thinkGuardRefereeEnabled: false })), false);
    assert.equal(
      resolveThinkGuardRefereeOn(activity, runCfg({ thinkGuardRefereeCallsUsed: 6 })),
      false,
    );
  });

  it("is false when stopping or draining", () => {
    const activity = { kind: "contract" as const, mode: "explore" as const };
    assert.equal(resolveThinkGuardRefereeOn(activity, runCfg(), { stopping: true }), false);
    assert.equal(resolveThinkGuardRefereeOn(activity, runCfg(), { draining: true }), false);
  });

  it("is true for eligible explore with budget remaining", () => {
    const activity = { kind: "planner-todos" as const, mode: "explore" as const };
    assert.equal(resolveThinkGuardRefereeOn(activity, runCfg()), true);
  });
});

describe("createThinkGuardHandler", () => {
  it("returns undefined when not eligible", () => {
    const handler = createThinkGuardHandler({
      getActive: () => runCfg(),
      isStopping: () => false,
      isDraining: () => false,
      appendSystem: () => {},
      activity: { kind: "worker", mode: "explore" },
    });
    assert.equal(handler, undefined);
  });

  it("rethrows on second abort after budget consumed in first handleAbort", async () => {
    let cfg = runCfg({ thinkGuardRefereeMaxCallsPerRun: 1, thinkGuardRefereeCallsUsed: 0 });
    const handler = createThinkGuardHandler({
      getActive: () => cfg,
      isStopping: () => false,
      isDraining: () => false,
      appendSystem: () => {},
      activity: { kind: "contract", mode: "explore" },
      clonePath: "/tmp/x",
    });
    assert.ok(handler);
    await handler!.handleAbort(abortErr({ thinkChars: 105_000, partialText: "<think>" + "a".repeat(105_000) + "</think>" }));
    const second = await handler!.handleAbort(abortErr());
    assert.deepEqual(second, { type: "rethrow" });
  });

  it("rule-based fallback returns partial for long think streams", async () => {
    const systems: string[] = [];
    let cfg = runCfg();
    const handler = createThinkGuardHandler({
      getActive: () => cfg,
      isStopping: () => false,
      isDraining: () => false,
      appendSystem: (m) => systems.push(m),
      activity: { kind: "contract", mode: "explore", label: "contract derivation" },
      clonePath: "/tmp/x",
    });
    assert.ok(handler);
    const err = abortErr({ thinkChars: 105_000, partialText: "<think>" + "x".repeat(105_000) + "</think>" });
    const result = await handler!.handleAbort(err);
    assert.equal(result.type, "return_partial");
    if (result.type === "return_partial") {
      assert.equal(result.text, err.partialText);
      assert.equal(result.verdict.verdict, "ready_to_emit");
    }
    assert.equal(cfg.thinkGuardRefereeCallsUsed, 1);
    assert.ok(systems.some((s) => s.includes("referee reviewing")));
  });

  it("rule-based fallback offers continuation for slow progress", async () => {
    const handler = createThinkGuardHandler({
      getActive: () => runCfg(),
      isStopping: () => false,
      isDraining: () => false,
      appendSystem: () => {},
      activity: { kind: "planner-todos", mode: "explore" },
      clonePath: "/tmp/x",
    });
    assert.ok(handler);
    const err = abortErr({
      thinkChars: 40_000,
      partialText: "<think>still exploring</think>",
      repetition: null,
    });
    const result = await handler!.handleAbort(err);
    assert.equal(result.type, "continuation_prompt");
    if (result.type === "continuation_prompt") {
      assert.match(result.prompt, /interrupted/i);
      assert.equal(result.verdict.suggestedAction, "extend_budget");
    }
  });

  it("rule-based fallback rethrows on hard repetition loop", async () => {
    const handler = createThinkGuardHandler({
      getActive: () => runCfg(),
      isStopping: () => false,
      isDraining: () => false,
      appendSystem: () => {},
      activity: { kind: "contract", mode: "explore" },
      clonePath: "/tmp/x",
    });
    assert.ok(handler);
    const err = abortErr({
      thinkChars: 50_000,
      repetition: { repeats: 6, rLen: 80 },
    });
    const result = await handler!.handleAbort(err);
    assert.deepEqual(result, { type: "rethrow" });
  });

  it("discussion kind always gets a salvage handler (no referee gate)", () => {
    assert.equal(isDiscussionDraftKind("discussion"), true);
    const handler = createThinkGuardHandler({
      getActive: () => runCfg({ thinkGuardRefereeEnabled: false }),
      isStopping: () => false,
      isDraining: () => false,
      appendSystem: () => {},
      activity: { kind: "discussion", mode: "explore", label: "draft r1" },
    });
    assert.ok(handler);
  });
});

describe("createDiscussionThinkGuardHandler", () => {
  it("soft abort with partial text → continuation then salvage", async () => {
    const systems: string[] = [];
    const handler = createDiscussionThinkGuardHandler({
      appendSystem: (m) => systems.push(m),
      activity: { kind: "discussion", label: "draft r1" },
    });
    const err = abortErr({
      tier: 1,
      thinkChars: 20_000,
      partialText: "<think>auditing streamlit indentation</think>\n{\"issues\":[]}",
    });
    const first = await handler.handleAbort(err);
    assert.equal(first.type, "continuation_prompt");
    const second = await handler.handleAbort(err);
    assert.equal(second.type, "return_partial");
    if (second.type === "return_partial") {
      assert.match(second.text, /issues/);
    }
    assert.ok(systems.some((s) => /discussion/i.test(s)));
  });

  it("hard loop with almost no text → rethrow", async () => {
    const handler = createDiscussionThinkGuardHandler({
      appendSystem: () => {},
    });
    const err = abortErr({
      tier: 2,
      thinkChars: 50_000,
      partialText: "xx",
      repetition: { repeats: 6, rLen: 40 },
    });
    const result = await handler.handleAbort(err);
    assert.deepEqual(result, { type: "rethrow" });
  });
});