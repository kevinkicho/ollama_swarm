import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ThinkGuardAbortError,
  createThinkGuardSession,
  extractThinkGuardAbortError,
  isPromptGuardAbort,
  isThinkGuardAbort,
} from "./thinkGuardErrors.js";

describe("ThinkGuardAbortError", () => {
  it("is detected by isThinkGuardAbort", () => {
    const err = new ThinkGuardAbortError({
      tier: 2,
      reason: "think stream exceeded",
      partialText: "<think>loop</think>",
      thinkChars: 160_000,
      thinkElapsedMs: 120_000,
    });
    assert.equal(isThinkGuardAbort(err), true);
    assert.equal(isPromptGuardAbort(err), true);
  });
});

describe("extractThinkGuardAbortError", () => {
  it("reads abort from signal reason", () => {
    const err = new ThinkGuardAbortError({
      tier: 2,
      reason: "hard cap",
      partialText: "x",
      thinkChars: 1,
      thinkElapsedMs: 1,
    });
    const session = createThinkGuardSession();
    const signal = { reason: err } as AbortSignal;
    assert.equal(extractThinkGuardAbortError(session, signal), err);
  });

  it("falls back to session lastTrip", () => {
    const session = createThinkGuardSession();
    session.cumulativeText = "partial";
    session.lastTrip = {
      tier: 1,
      reason: "soft tier",
      metrics: { thinkChars: 50_000, thinkElapsedMs: 40_000, repetition: null },
    };
    const extracted = extractThinkGuardAbortError(session, { reason: undefined } as AbortSignal);
    assert.ok(extracted);
    assert.equal(extracted!.partialText, "partial");
    assert.equal(extracted!.tier, 1);
  });
});

describe("isPromptGuardAbort", () => {
  it("matches legacy message patterns", () => {
    assert.equal(isPromptGuardAbort(new Error("think-only stream wall-clock exceeded")), true);
    assert.equal(isPromptGuardAbort(new Error("unrelated")), false);
  });
});