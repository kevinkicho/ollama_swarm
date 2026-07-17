import { test } from "node:test";
import assert from "node:assert/strict";
import { notifyGuardTrip } from "./guardNotify.js";
import { buildProgressSignature, ProgressStallTracker } from "./progressSignature.js";

test("notifyGuardTrip appends system with brain_suggestion summary + RECONFIG for wall-clock", () => {
  const lines: Array<{ text: string; summary?: unknown }> = [];
  let injected: { title: string; text: string } | undefined;
  notifyGuardTrip({
    kind: "wall-clock",
    detail: "wall-clock cap reached (20 min active)",
    runId: "run-1",
    appendSystem: (text, summary) => lines.push({ text, summary }),
    getBrainService: () => ({
      injectSuggestion: (_id, s) => {
        injected = s;
      },
    }),
  });
  // When Brain inject works, appendSystem is skipped (inject writes transcript).
  assert.equal(lines.length, 0);
  assert.ok(injected);
  assert.match(injected!.text, /\[guard:wall-clock\]/);
  assert.match(injected!.text, /RECONFIG:/);
  assert.match(injected!.text, /extendWallClockCapMin/);
});

test("notifyGuardTrip falls back to appendSystem without Brain", () => {
  const lines: Array<{ text: string; summary?: unknown }> = [];
  notifyGuardTrip({
    kind: "quota",
    detail: "quota",
    runId: "r",
    appendSystem: (text, summary) => lines.push({ text, summary }),
    getBrainService: () => null,
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0]!.text, /\[guard:quota\]/);
  assert.doesNotMatch(lines[0]!.text, /RECONFIG:/);
  assert.equal((lines[0]!.summary as { kind?: string })?.kind, "brain_suggestion");
});

test("notifyGuardTrip empty-execution suggests extendRounds RECONFIG", () => {
  let injected: { title: string; text: string } | undefined;
  notifyGuardTrip({
    kind: "empty-execution",
    detail: "empty-execution: 3 consecutive cycle(s) with 0 standup todos",
    runId: "run-empty",
    appendSystem: () => {},
    getBrainService: () => ({
      injectSuggestion: (_id, s) => {
        injected = s;
      },
    }),
  });
  assert.ok(injected);
  assert.match(injected!.title, /Empty execution/i);
  assert.match(injected!.text, /\[guard:empty-execution\]/);
  assert.match(injected!.text, /RECONFIG:/);
  assert.match(injected!.text, /extendRounds/);
});

test("buildProgressSignature is order-stable for unmet ids", () => {
  const a = buildProgressSignature({ unmetIds: ["c2", "c1"], committed: 1 });
  const b = buildProgressSignature({ unmetIds: ["c1", "c2"], committed: 1 });
  assert.equal(a, b);
});

test("ProgressStallTracker trips after N identical signatures", () => {
  const t = new ProgressStallTracker(3);
  assert.equal(t.record("sig-a").tripped, false);
  assert.equal(t.record("sig-a").tripped, false);
  assert.equal(t.record("sig-a").tripped, true);
  assert.equal(t.record("sig-b").tripped, false);
});
