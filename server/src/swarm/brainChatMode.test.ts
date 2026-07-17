import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { inferStructuredBrainMode } from "./brainChatMode.js";

describe("inferStructuredBrainMode", () => {
  it("defaults setup prompts to structured", () => {
    assert.equal(
      inferStructuredBrainMode("analyze research papers on superconductors", {}),
      true,
    );
  });

  it("allows casual setup greetings as prose-only", () => {
    assert.equal(inferStructuredBrainMode("hi", {}), false);
  });

  it("treats brian alias identity questions as prose-only", () => {
    assert.equal(inferStructuredBrainMode("who are you?", {}), false);
    assert.equal(inferStructuredBrainMode("what is brian?", {}), false);
  });

  it("uses structured for during-run config intent only", () => {
    assert.equal(
      inferStructuredBrainMode("what are agents doing right now?", { duringRun: true }),
      false,
    );
    assert.equal(
      inferStructuredBrainMode("amend the directive to focus on tests", { duringRun: true }),
      true,
    );
  });

  it("structured for affirmatives during run (launch path)", () => {
    assert.equal(inferStructuredBrainMode("yes", { duringRun: true }), true);
  });

  it("structured when user asks to extend runtime limits", () => {
    assert.equal(
      inferStructuredBrainMode("extend the wall-clock cap by 15 minutes", { duringRun: true }),
      true,
    );
    assert.equal(
      inferStructuredBrainMode("give the run more time ΓÇö increase the cap", { duringRun: true }),
      true,
    );
  });

  it("structured when user asks about think-guard referee budget", () => {
    assert.equal(
      inferStructuredBrainMode("enable the think guard referee and add more calls", { duringRun: true }),
      true,
    );
    assert.equal(
      inferStructuredBrainMode("agent 1 is stuck in a reasoning loop ΓÇö increase referee tail", { duringRun: true }),
      true,
    );
  });
});
