import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { inferStructuredBrainMode } from "./brainChatMode.js";

describe("inferStructuredBrainMode", () => {
  it("defaults setup prompts to structured", () => {
    assert.equal(inferStructuredBrainMode("recommend a preset for multi-agent coding", {}), true);
  });

  it("allows casual setup greetings as prose-only", () => {
    assert.equal(inferStructuredBrainMode("hi", {}), false);
    assert.equal(inferStructuredBrainMode("thanks!", {}), false);
  });

  it("treats brian alias identity questions as prose-only", () => {
    assert.equal(inferStructuredBrainMode("who is brian?", {}), false);
    assert.equal(inferStructuredBrainMode("what does the brain do?", {}), false);
  });

  it("uses structured for during-run config intent only", () => {
    assert.equal(inferStructuredBrainMode("what is the current phase?", { duringRun: true }), false);
    assert.equal(
      inferStructuredBrainMode("start a follow-up run with more agents", { duringRun: true }),
      true,
    );
  });

  it("structured for affirmatives during run (launch path)", () => {
    assert.equal(inferStructuredBrainMode("yes", { duringRun: true }), true);
    assert.equal(inferStructuredBrainMode("go ahead", { duringRun: true }), true);
  });

  it("structured when user asks to extend runtime limits", () => {
    assert.equal(
      inferStructuredBrainMode("extend wall clock by 15 minutes", { duringRun: true }),
      true,
    );
    assert.equal(
      inferStructuredBrainMode("give the run more time — increase the cap", { duringRun: true }),
      true,
    );
  });
});
