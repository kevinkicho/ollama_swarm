import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveAbsolutePromptMaxMs } from "./thinkStreamGuardRuntime.js";
import { isPromptGuardAbort } from "@ollama-swarm/shared/thinkGuardErrors";

describe("resolveAbsolutePromptMaxMs", () => {
  it("uses explicit absolute when set", () => {
    assert.equal(resolveAbsolutePromptMaxMs(120_000, 300_000), 300_000);
  });

  it("defaults to max(5×idle, 10m) when only idle wall set", () => {
    assert.equal(resolveAbsolutePromptMaxMs(120_000), 600_000);
    assert.equal(resolveAbsolutePromptMaxMs(30_000), 600_000); // floor 10m
    assert.equal(resolveAbsolutePromptMaxMs(200_000), 1_000_000);
  });

  it("defaults to 15m when no idle wall", () => {
    assert.equal(resolveAbsolutePromptMaxMs(undefined), 900_000);
  });
});

describe("isPromptGuardAbort — absolute wall", () => {
  it("treats absolute wall-clock errors as non-retryable guard aborts", () => {
    assert.equal(
      isPromptGuardAbort(
        new Error("prompt absolute wall-clock exceeded 900000ms (fail-closed hung prompt)"),
      ),
      true,
    );
    assert.equal(
      isPromptGuardAbort(new Error("prompt wall-clock idle exceeded 120000ms (no stream chunks)")),
      true,
    );
  });
});
