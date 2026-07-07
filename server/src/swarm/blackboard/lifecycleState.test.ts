import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isStopping,
  isDraining,
  isActive,
  isTerminal,
  isPromptHaltError,
  type LifecycleState,
  LIFECYCLE_STATES,
} from "./lifecycleState.js";

test("isStopping returns true only for 'stopping'", () => {
  assert.equal(isStopping("stopping"), true);
  assert.equal(isStopping("idle"), false);
  assert.equal(isStopping("running"), false);
  assert.equal(isStopping("draining"), false);
  assert.equal(isStopping("stopped"), false);
});

test("isDraining returns true only for 'draining'", () => {
  assert.equal(isDraining("draining"), true);
  assert.equal(isDraining("idle"), false);
  assert.equal(isDraining("running"), false);
  assert.equal(isDraining("stopping"), false);
  assert.equal(isDraining("stopped"), false);
});

test("isActive returns true for running and draining", () => {
  assert.equal(isActive("running"), true);
  assert.equal(isActive("draining"), true);
  assert.equal(isActive("idle"), false);
  assert.equal(isActive("stopping"), false);
  assert.equal(isActive("stopped"), false);
});

test("isTerminal returns true for idle and stopped", () => {
  assert.equal(isTerminal("idle"), true);
  assert.equal(isTerminal("stopped"), true);
  assert.equal(isTerminal("running"), false);
  assert.equal(isTerminal("draining"), false);
  assert.equal(isTerminal("stopping"), false);
});

test("LIFECYCLE_STATES contains all five states", () => {
  assert.equal(LIFECYCLE_STATES.size, 5);
  assert.equal(LIFECYCLE_STATES.has("idle"), true);
  assert.equal(LIFECYCLE_STATES.has("running"), true);
  assert.equal(LIFECYCLE_STATES.has("draining"), true);
  assert.equal(LIFECYCLE_STATES.has("stopping"), true);
  assert.equal(LIFECYCLE_STATES.has("stopped"), true);
});

test("isPromptHaltError — stop always halts", () => {
  assert.equal(
    isPromptHaltError(new Error("anything"), () => true, () => false),
    true,
  );
});

test("isPromptHaltError — drain halts on abort-shaped errors only", () => {
  const draining = () => true;
  const notStopping = () => false;
  assert.equal(isPromptHaltError(new Error("drain: stuck prompt"), notStopping, draining), true);
  assert.equal(isPromptHaltError(new Error("user stop"), notStopping, draining), true);
  const abortErr = new Error("aborted");
  abortErr.name = "AbortError";
  assert.equal(isPromptHaltError(abortErr, notStopping, draining), true);
  assert.equal(isPromptHaltError(new Error("timeout"), notStopping, draining), false);
  assert.equal(isPromptHaltError(new Error("drain: stuck prompt"), notStopping, () => false), false);
});

test("LifecycleState type narrows correctly", () => {
  const states: LifecycleState[] = ["idle", "running", "draining", "stopping", "stopped"];
  for (const s of states) {
    assert.ok(LIFECYCLE_STATES.has(s), `${s} should be in LIFECYCLE_STATES`);
  }
});