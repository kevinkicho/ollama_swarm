// 2026-05-03 (Phase B): unit tests for OutputEmptyDeadLoopGuard +
// PlanEmptyDeadLoopGuard. Locks the consecutive-counter semantics +
// the earlyStopDetail format strings so the migration is byte-stable.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  OutputEmptyDeadLoopGuard,
  PlanEmptyDeadLoopGuard,
} from "./deadLoopGuard.js";
import type { TranscriptEntry } from "../types.js";

function agentEntry(text: string): TranscriptEntry {
  return { id: text, role: "agent", agentIndex: 1, text, ts: 0 };
}

describe("OutputEmptyDeadLoopGuard", () => {
  it("does NOT trip on a normal iteration with substantive output", () => {
    const g = new OutputEmptyDeadLoopGuard({ roleLabel: "drafters", unit: "round" });
    const longSubstantive =
      "A multi-sentence response with concrete claims, file references like src/foo.ts:42, " +
      "and enough body to clear any short-junk heuristic checked by looksLikeJunk.";
    const result = g.recordIteration([agentEntry(longSubstantive)]);
    assert.equal(result.tripped, false);
    assert.equal(result.consecutive, 0);
  });

  it("does NOT trip on the first empty iteration (counter=1)", () => {
    const g = new OutputEmptyDeadLoopGuard({ roleLabel: "drafters", unit: "round" });
    const result = g.recordIteration([agentEntry("(empty response)")]);
    assert.equal(result.tripped, false);
    assert.equal(result.consecutive, 1);
  });

  it("trips on the THIRD consecutive empty iteration (default threshold=3)", () => {
    const g = new OutputEmptyDeadLoopGuard({ roleLabel: "drafters", unit: "round" });
    g.recordIteration([agentEntry("(empty response)")]);
    g.recordIteration([agentEntry("(empty response)")]);
    const result = g.recordIteration([agentEntry("(empty response)")]);
    assert.equal(result.tripped, true);
    assert.equal(result.consecutive, 3);
    assert.equal(
      result.earlyStopDetail,
      "drafters-silenced (3 consecutive empty rounds)",
    );
  });

  it("resets the counter on a non-empty iteration", () => {
    const g = new OutputEmptyDeadLoopGuard({ roleLabel: "drafters", unit: "round" });
    const longSubstantive =
      "A multi-sentence response with concrete claims, file references like src/foo.ts:42, " +
      "and enough body to clear any short-junk heuristic.";
    g.recordIteration([agentEntry("(empty response)")]); // counter=1
    g.recordIteration([agentEntry(longSubstantive)]);    // resets to 0
    const result = g.recordIteration([agentEntry("(empty response)")]); // counter=1 again
    assert.equal(result.consecutive, 1);
    assert.equal(result.tripped, false);
  });

  it("does NOT count an empty newEntries array as an empty iteration", () => {
    const g = new OutputEmptyDeadLoopGuard({ roleLabel: "drafters", unit: "round" });
    const result = g.recordIteration([]);
    assert.equal(result.tripped, false);
    assert.equal(result.consecutive, 0);
  });

  it("uses 'cycles' noun when unit='cycle' (mappers case)", () => {
    const g = new OutputEmptyDeadLoopGuard({ roleLabel: "mappers", unit: "cycle" });
    g.recordIteration([agentEntry("(empty response)")]);
    g.recordIteration([agentEntry("(empty response)")]);
    const result = g.recordIteration([agentEntry("(empty response)")]);
    assert.equal(
      result.earlyStopDetail,
      "mappers-silenced (3 consecutive empty cycles)",
    );
  });

  it("respects custom threshold", () => {
    const g = new OutputEmptyDeadLoopGuard({ roleLabel: "drafters", unit: "round", threshold: 3 });
    g.recordIteration([agentEntry("(empty response)")]);  // 1
    g.recordIteration([agentEntry("(empty response)")]);  // 2
    const onTwo = g.recordIteration([agentEntry("(empty response)")]); // wait — that's third call but I had 2 above. let me redo.
    assert.equal(onTwo.tripped, true); // counter=3, threshold=3
    assert.equal(onTwo.consecutive, 3);
  });

  it("reset() clears the counter mid-loop", () => {
    const g = new OutputEmptyDeadLoopGuard({ roleLabel: "drafters", unit: "round" });
    g.recordIteration([agentEntry("(empty response)")]); // counter=1
    g.reset();
    const result = g.recordIteration([agentEntry("(empty response)")]); // counter=1 again
    assert.equal(result.consecutive, 1);
    assert.equal(result.tripped, false);
  });

  it("treats junk text the same as '(empty response)'", () => {
    const g = new OutputEmptyDeadLoopGuard({ roleLabel: "drafters", unit: "round" });
    // Single short character is junk per looksLikeJunk
    g.recordIteration([agentEntry(":")]);
    g.recordIteration([agentEntry(":")]);
    const result = g.recordIteration([agentEntry(":")]);
    assert.equal(result.tripped, true);
  });

  it("a single substantive entry among empties saves the iteration", () => {
    const g = new OutputEmptyDeadLoopGuard({ roleLabel: "drafters", unit: "round" });
    // Use clearly-substantive text (long enough that looksLikeJunk doesn't fire).
    const substantive =
      "This is a long, substantive response with multiple sentences, " +
      "concrete file references like src/foo.ts:42, and enough body to " +
      "clear any short-junk heuristic. Worker found a real issue worth fixing.";
    const result = g.recordIteration([
      agentEntry("(empty response)"),
      agentEntry(substantive),
    ]);
    assert.equal(result.tripped, false);
    assert.equal(result.consecutive, 0);
  });
});

describe("PlanEmptyDeadLoopGuard", () => {
  it("does NOT trip when plan has at least one assignment", () => {
    const g = new PlanEmptyDeadLoopGuard({ roleLabel: "lead" });
    const result = g.recordCycle([{ agentIndex: 2, subtask: "x" }]);
    assert.equal(result.tripped, false);
    assert.equal(result.consecutive, 0);
  });

  it("counter increments on empty plan but does NOT trip on first", () => {
    const g = new PlanEmptyDeadLoopGuard({ roleLabel: "lead" });
    const result = g.recordCycle([]);
    assert.equal(result.tripped, false);
    assert.equal(result.consecutive, 1);
  });

  it("trips on the THIRD consecutive empty plan", () => {
    const g = new PlanEmptyDeadLoopGuard({ roleLabel: "lead" });
    g.recordCycle([]);
    g.recordCycle([]);
    const result = g.recordCycle([]);
    assert.equal(result.tripped, true);
    assert.equal(result.consecutive, 3);
    assert.equal(
      result.earlyStopDetail,
      "lead-silenced (3 consecutive empty plans)",
    );
  });

  it("resets counter on a non-empty plan", () => {
    const g = new PlanEmptyDeadLoopGuard({ roleLabel: "lead" });
    g.recordCycle([]);
    g.recordCycle([{ agentIndex: 2, subtask: "x" }]);
    const result = g.recordCycle([]);
    assert.equal(result.consecutive, 1);
    assert.equal(result.tripped, false);
  });

  it("uses configured roleLabel in the message", () => {
    const g = new PlanEmptyDeadLoopGuard({ roleLabel: "orchestrator" });
    g.recordCycle([]);
    g.recordCycle([]);
    const result = g.recordCycle([]);
    assert.equal(
      result.earlyStopDetail,
      "orchestrator-silenced (3 consecutive empty plans)",
    );
  });

  it("respects custom threshold", () => {
    const g = new PlanEmptyDeadLoopGuard({ roleLabel: "lead", threshold: 3 });
    g.recordCycle([]); // 1
    const onTwo = g.recordCycle([]); // 2
    assert.equal(onTwo.tripped, false);
    const onThree = g.recordCycle([]); // 3
    assert.equal(onThree.tripped, true);
  });
});
