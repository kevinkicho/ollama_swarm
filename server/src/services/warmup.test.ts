import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { WARMUP_PROMPT_TEXT } from "./AgentManager.js";

// Unit 17 ships a warmup prompt sent at spawn + an env toggle to
// disable it. The actual session.prompt call is a thin SDK wrapper —
// not worth mocking the SDK in a unit test for the sake of asserting
// "we called the function." What IS worth locking down: the prompt
// text stays trivial (no token bloat) and the env toggle parses the
// common falsy strings so users can opt out.

describe("WARMUP_PROMPT_TEXT", () => {
  it("is a non-empty short string (we don't want to send a heavy prompt during warmup)", () => {
    assert.ok(WARMUP_PROMPT_TEXT.length > 0);
    assert.ok(WARMUP_PROMPT_TEXT.length < 100, `warmup prompt should be tiny, got ${WARMUP_PROMPT_TEXT.length} chars`);
  });
});

// The AGENT_WARMUP_ENABLED schema lives in config.ts but config.ts
// auto-parses process.env at import time, which couples it to the
// test runner's environment. We re-declare the same schema fragment
// here to test the parse semantics in isolation.
const ToggleSchema = z
  .enum(["true", "false", "1", "0", "yes", "no"])
  .default("true")
  .transform((v) => v === "true" || v === "1" || v === "yes");

describe("AGENT_WARMUP_ENABLED env toggle", () => {
  it("defaults to true when unset", () => {
    assert.equal(ToggleSchema.parse(undefined), true);
  });

  it("accepts explicit truthy values", () => {
    assert.equal(ToggleSchema.parse("true"), true);
    assert.equal(ToggleSchema.parse("1"), true);
    assert.equal(ToggleSchema.parse("yes"), true);
  });

  it("accepts explicit falsy values", () => {
    assert.equal(ToggleSchema.parse("false"), false);
    assert.equal(ToggleSchema.parse("0"), false);
    assert.equal(ToggleSchema.parse("no"), false);
  });

  it("rejects unrecognized strings (so a typo doesn't silently disable warmup)", () => {
    assert.throws(() => ToggleSchema.parse("disabled"));
    assert.throws(() => ToggleSchema.parse("off"));
  });
});
