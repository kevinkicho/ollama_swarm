import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ThinkGuardAbortError } from "@ollama-swarm/shared/thinkGuardErrors";
import type { RunConfig } from "../SwarmRunner.js";
import {
  createThinkGuardHandler,
  createDiscussionThinkGuardHandler,
  isDiscussionDraftKind,
  isStreamTriageEligible,
  isThinkGuardRefereeEligible,
  resolveRecoveryTriageOn,
  resolveStreamTriageOn,
  runRecoveryStreamTriage,
} from "./thinkGuardHandler.js";

function runCfg(overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    repoUrl: "https://x",
    localPath: "/tmp/x",
    agentCount: 1,
    rounds: 1,
    model: "test",
    preset: "blackboard",
    ...overrides,
  } as RunConfig;
}

function abortErr(overrides: Partial<ConstructorParameters<typeof ThinkGuardAbortError>[0]> = {}) {
  return new ThinkGuardAbortError({
    tier: 2,
    reason: "think-only stream exceeded 160,000 chars (hard)",
    partialText: `<think>${"reason ".repeat(50_000)}</think>`,
    thinkChars: 160_000,
    thinkElapsedMs: 90_000,
    ...overrides,
  });
}

describe("isStreamTriageEligible", () => {
  it("covers planner, discussion, and worker kinds", () => {
    assert.equal(isStreamTriageEligible({ kind: "contract", mode: "explore" }), true);
    assert.equal(isStreamTriageEligible({ kind: "planner-todos", mode: "emit" }), true);
    assert.equal(isStreamTriageEligible({ kind: "discussion" }), true);
    assert.equal(isStreamTriageEligible({ kind: "worker" }), true);
    assert.equal(isThinkGuardRefereeEligible({ kind: "worker" }), true);
    assert.equal(isStreamTriageEligible({ kind: "unknown" }), false);
  });
});

describe("resolveStreamTriageOn (soft tier)", () => {
  it("is always false — soft-tier referee retired", () => {
    assert.equal(
      resolveStreamTriageOn({ kind: "contract", mode: "explore" }, runCfg()),
      false,
    );
  });
});

describe("resolveRecoveryTriageOn", () => {
  it("allows planner recovery without budget flags", () => {
    assert.equal(resolveRecoveryTriageOn("planner-todos", runCfg()), true);
    assert.equal(resolveRecoveryTriageOn("worker", runCfg()), false);
  });
});

describe("runRecoveryStreamTriage", () => {
  it("deterministically salvages planner recovery stall (no LLM)", async () => {
    const systems: string[] = [];
    const result = await runRecoveryStreamTriage(
      {
        getActive: () => runCfg(),
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
    assert.ok(systems.some((s) => /stream-triage|recovery checkpoint/i.test(s)));
  });
});

describe("createThinkGuardHandler", () => {
  it("returns undefined for unknown activity kinds", () => {
    const handler = createThinkGuardHandler({
      getActive: () => runCfg(),
      isStopping: () => false,
      isDraining: () => false,
      appendSystem: () => {},
      activity: { kind: "mystery", mode: "explore" },
    });
    assert.equal(handler, undefined);
  });

  it("force-emits long think streams without referee LLM", async () => {
    const systems: string[] = [];
    const handler = createThinkGuardHandler({
      getActive: () => runCfg(),
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
    assert.ok(systems.some((s) => s.includes("stream-triage")));
    assert.ok(!systems.some((s) => s.includes("referee reviewing")));
  });

  it("offers one continuation for moderate think aborts", async () => {
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
      partialText: "<think>still exploring the repo layout carefully</think>",
      repetition: null,
    });
    const result = await handler!.handleAbort(err);
    assert.equal(result.type, "continuation_prompt");
    if (result.type === "continuation_prompt") {
      assert.match(result.prompt, /interrupted/i);
      assert.equal(result.verdict.suggestedAction, "extend_budget");
    }
  });

  it("rethrows on hard repetition loop with no salvage", async () => {
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
      partialText: "<think>x</think>",
      repetition: { repeats: 6, rLen: 80 },
    });
    const result = await handler!.handleAbort(err);
    assert.deepEqual(result, { type: "rethrow" });
  });

  it("discussion kind always gets a salvage handler", () => {
    assert.equal(isDiscussionDraftKind("discussion"), true);
    const handler = createThinkGuardHandler({
      getActive: () => runCfg(),
      isStopping: () => false,
      isDraining: () => false,
      appendSystem: () => {},
      activity: { kind: "discussion", mode: "explore", label: "draft r1" },
    });
    assert.ok(handler);
  });

  it("second abort after continuation returns partial (no budget)", async () => {
    const state = { continuationUsed: false };
    const handler = createThinkGuardHandler(
      {
        getActive: () => runCfg(),
        isStopping: () => false,
        isDraining: () => false,
        appendSystem: () => {},
        activity: { kind: "contract", mode: "explore" },
        clonePath: "/tmp/x",
      },
      state,
    );
    assert.ok(handler);
    const err = abortErr({
      thinkChars: 40_000,
      partialText: "<think>still exploring the repo layout carefully</think>",
      repetition: null,
    });
    const first = await handler!.handleAbort(err);
    assert.equal(first.type, "continuation_prompt");
    const second = await handler!.handleAbort(err);
    assert.equal(second.type, "return_partial");
  });
});

describe("createDiscussionThinkGuardHandler", () => {
  it("soft-style abort with partial text → continuation then salvage", async () => {
    const systems: string[] = [];
    const handler = createDiscussionThinkGuardHandler({
      appendSystem: (m) => systems.push(m),
      activity: { kind: "discussion", label: "draft r1" },
    });
    const err = abortErr({
      tier: 1,
      thinkChars: 50_000,
      partialText: "<think>drafting findings about the market panels structure</think>",
      repetition: null,
    });
    const first = await handler.handleAbort(err);
    assert.equal(first.type, "continuation_prompt");
    const second = await handler.handleAbort(err);
    assert.equal(second.type, "return_partial");
    assert.ok(systems.some((s) => /stream-triage/i.test(s)));
  });
});
