import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_AUTONOMOUS_WALL_CLOCK_MS,
  ensureAutonomousResourceCap,
  resolveEffectiveRounds,
  supportsAutonomousRounds,
} from "./autonomousPresets.js";

test("supportsAutonomousRounds — blackboard + council only", () => {
  assert.equal(supportsAutonomousRounds("blackboard"), true);
  assert.equal(supportsAutonomousRounds("council"), true);
  assert.equal(supportsAutonomousRounds("round-robin"), false);
  assert.equal(supportsAutonomousRounds("moa"), false);
});

test("resolveEffectiveRounds — positive rounds pass through", () => {
  const r = resolveEffectiveRounds({ preset: "round-robin", rounds: 5 });
  assert.deepEqual(r, { ok: true, rounds: 5 });
});

test("resolveEffectiveRounds — rounds=0 ok for council/blackboard", () => {
  assert.deepEqual(resolveEffectiveRounds({ preset: "council", rounds: 0 }), {
    ok: true,
    rounds: 0,
  });
  assert.deepEqual(resolveEffectiveRounds({ preset: "blackboard", rounds: 0 }), {
    ok: true,
    rounds: 0,
  });
});

test("resolveEffectiveRounds — rounds=0 rejected for other presets", () => {
  const r = resolveEffectiveRounds({ preset: "round-robin", rounds: 0 });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /only supported for blackboard and council/);
});

test("resolveEffectiveRounds — continuous only for autonomous presets", () => {
  assert.deepEqual(
    resolveEffectiveRounds({ preset: "council", continuous: true }),
    { ok: true, rounds: 1_000_000 },
  );
  const bad = resolveEffectiveRounds({ preset: "stigmergy", continuous: true });
  assert.equal(bad.ok, false);
});

test("resolveEffectiveRounds — defaults when omitted", () => {
  assert.deepEqual(resolveEffectiveRounds({ preset: "blackboard" }), {
    ok: true,
    rounds: 0,
  });
  assert.deepEqual(resolveEffectiveRounds({ preset: "debate-judge" }), {
    ok: true,
    rounds: 3,
  });
});

test("ensureAutonomousResourceCap — applies 8h default when open-ended and uncapped", () => {
  const r = ensureAutonomousResourceCap({
    preset: "council",
    rounds: 0,
  });
  assert.equal(r.appliedDefault, true);
  if (r.appliedDefault) {
    assert.equal(r.wallClockCapMs, DEFAULT_AUTONOMOUS_WALL_CLOCK_MS);
  }
});

test("ensureAutonomousResourceCap — respects existing token budget", () => {
  const r = ensureAutonomousResourceCap({
    preset: "council",
    rounds: 0,
    tokenBudget: 5_000_000,
  });
  assert.equal(r.appliedDefault, false);
});

test("ensureAutonomousResourceCap — no-op for finite rounds", () => {
  const r = ensureAutonomousResourceCap({
    preset: "council",
    rounds: 3,
  });
  assert.equal(r.appliedDefault, false);
});
