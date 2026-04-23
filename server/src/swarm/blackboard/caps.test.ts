import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  advanceTickAccumulator,
  checkCaps,
  COMMITS_CAP,
  createTickAccumulator,
  MAX_REASONABLE_TICK_DELTA_MS,
  TODOS_CAP,
  WALL_CLOCK_CAP_MS,
  type CapState,
} from "./caps";

function baseState(overrides: Partial<CapState> = {}): CapState {
  return {
    startedAt: 0,
    now: 0,
    committed: 0,
    totalTodos: 0,
    ...overrides,
  };
}

describe("checkCaps", () => {
  it("returns null when nothing is near any cap", () => {
    assert.equal(checkCaps(baseState({ now: 60_000, committed: 5, totalTodos: 10 })), null);
  });

  it("returns null exactly at the boundary minus one ms / one todo / one commit", () => {
    assert.equal(
      checkCaps(baseState({ now: WALL_CLOCK_CAP_MS - 1 })),
      null,
      "wall-clock one ms under cap should pass",
    );
    assert.equal(
      checkCaps(baseState({ committed: COMMITS_CAP - 1 })),
      null,
      "commits one under cap should pass",
    );
    assert.equal(
      checkCaps(baseState({ totalTodos: TODOS_CAP - 1 })),
      null,
      "todos one under cap should pass",
    );
  });

  it("fires the wall-clock cap at the boundary", () => {
    const reason = checkCaps(baseState({ now: WALL_CLOCK_CAP_MS }));
    assert.ok(reason, "should fire");
    assert.match(reason!, /wall-clock cap/);
    // Unit 23: assert against the actual configured cap rather than
    // hardcoding "20 min" — caps.ts may bump the value over time.
    const minutes = Math.round(WALL_CLOCK_CAP_MS / 60_000);
    assert.match(reason!, new RegExp(`${minutes} min`));
  });

  it("fires the wall-clock cap well past the boundary", () => {
    const reason = checkCaps(baseState({ now: WALL_CLOCK_CAP_MS + 5 * 60_000 }));
    assert.match(reason!, /wall-clock cap/);
  });

  it("fires the commits cap at the boundary", () => {
    const reason = checkCaps(baseState({ committed: COMMITS_CAP }));
    assert.match(reason!, /commits cap/);
    assert.match(reason!, new RegExp(String(COMMITS_CAP)));
  });

  it("fires the todos cap at the boundary", () => {
    const reason = checkCaps(baseState({ totalTodos: TODOS_CAP }));
    assert.match(reason!, /todos cap/);
    assert.match(reason!, new RegExp(String(TODOS_CAP)));
  });

  it("prioritizes wall-clock over commits and todos when multiple caps trip", () => {
    const reason = checkCaps(
      baseState({
        now: WALL_CLOCK_CAP_MS,
        committed: COMMITS_CAP,
        totalTodos: TODOS_CAP,
      }),
    );
    assert.match(reason!, /wall-clock cap/, "wall-clock should win the race");
  });

  it("prioritizes commits over todos when only those two trip", () => {
    const reason = checkCaps(
      baseState({ committed: COMMITS_CAP, totalTodos: TODOS_CAP }),
    );
    assert.match(reason!, /commits cap/, "commits should win over todos");
  });

  it("handles a startedAt in the future (clock skew) by reporting elapsed=0", () => {
    // now before startedAt -> elapsed is negative, should NOT fire wall-clock.
    assert.equal(
      checkCaps({ startedAt: 1000, now: 500, committed: 0, totalTodos: 0 }),
      null,
    );
  });

  it("counts exceed equals the cap as firing (>=, not >)", () => {
    // This is the key contract: caps use >=, so a run that writes exactly
    // COMMITS_CAP commits terminates immediately afterward.
    assert.ok(checkCaps(baseState({ committed: COMMITS_CAP })));
    assert.equal(checkCaps(baseState({ committed: COMMITS_CAP - 1 })), null);
  });
});

// Unit 27: tick accumulator — the host-sleep-proof clock driver that
// replaces `Date.now() - runStartedAt` in checkAndApplyCaps.
describe("advanceTickAccumulator", () => {
  it("advances by the raw delta on a normal-sized tick", () => {
    const prev = createTickAccumulator(1_000);
    const { next, jumpMs } = advanceTickAccumulator(prev, 3_500);
    assert.equal(next.activeElapsedMs, 2_500, "clamped delta = 2.5 s");
    assert.equal(next.lastTickAt, 3_500, "lastTickAt advances to now");
    assert.equal(jumpMs, 0, "no jump detected on a 2.5 s tick");
  });

  it("accumulates across multiple normal ticks", () => {
    let acc = createTickAccumulator(1_000);
    ({ next: acc } = advanceTickAccumulator(acc, 3_500)); //  +2.5 s
    ({ next: acc } = advanceTickAccumulator(acc, 6_000)); //  +2.5 s
    ({ next: acc } = advanceTickAccumulator(acc, 8_000)); //  +2.0 s
    assert.equal(acc.activeElapsedMs, 7_000);
    assert.equal(acc.lastTickAt, 8_000);
  });

  it("clamps a host-sleep-sized jump to MAX_REASONABLE_TICK_DELTA_MS", () => {
    const prev = createTickAccumulator(1_000);
    // Simulate an 8-hour laptop sleep between ticks.
    const eightHoursLater = 1_000 + 8 * 60 * 60_000;
    const { next, jumpMs } = advanceTickAccumulator(prev, eightHoursLater);
    assert.equal(
      next.activeElapsedMs,
      MAX_REASONABLE_TICK_DELTA_MS,
      "accumulator takes at most MAX_REASONABLE_TICK_DELTA_MS per tick",
    );
    assert.equal(next.lastTickAt, eightHoursLater, "lastTickAt still jumps to now");
    assert.equal(
      jumpMs,
      8 * 60 * 60_000 - MAX_REASONABLE_TICK_DELTA_MS,
      "jumpMs = raw - clamped",
    );
  });

  it("clamps a delta exactly at the boundary to the boundary (no jump)", () => {
    const prev = createTickAccumulator(0);
    const { next, jumpMs } = advanceTickAccumulator(
      prev,
      MAX_REASONABLE_TICK_DELTA_MS,
    );
    assert.equal(next.activeElapsedMs, MAX_REASONABLE_TICK_DELTA_MS);
    assert.equal(jumpMs, 0, "exactly at the boundary is still within range");
  });

  it("reports a jump when delta is one ms past the boundary", () => {
    const prev = createTickAccumulator(0);
    const { next, jumpMs } = advanceTickAccumulator(
      prev,
      MAX_REASONABLE_TICK_DELTA_MS + 1,
    );
    assert.equal(next.activeElapsedMs, MAX_REASONABLE_TICK_DELTA_MS);
    assert.equal(jumpMs, 1);
  });

  it("clamps a backwards clock (negative delta) to 0", () => {
    const prev = createTickAccumulator(10_000);
    const { next, jumpMs } = advanceTickAccumulator(prev, 5_000);
    assert.equal(next.activeElapsedMs, 0, "no forward progress from a backwards clock");
    assert.equal(next.lastTickAt, 5_000, "lastTickAt still takes 'now' so we don't lock up");
    assert.equal(jumpMs, 0, "backwards skew isn't a forward-jump");
  });

  it("is pure — same inputs always produce same outputs", () => {
    const prev = createTickAccumulator(1_000);
    const a = advanceTickAccumulator(prev, 4_000);
    const b = advanceTickAccumulator(prev, 4_000);
    assert.deepEqual(a.next, b.next);
    assert.equal(a.jumpMs, b.jumpMs);
  });

  it("integrates with checkCaps when passed as startedAt:0 + now:activeElapsedMs", () => {
    // Simulates how BlackboardRunner.checkAndApplyCaps uses the accumulator.
    // A single 8-hour host sleep should NOT trip the wall-clock cap — it
    // should contribute only MAX_REASONABLE_TICK_DELTA_MS.
    let acc = createTickAccumulator(0);
    const eightHoursLater = 8 * 60 * 60_000;
    ({ next: acc } = advanceTickAccumulator(acc, eightHoursLater));
    const reason = checkCaps({
      startedAt: 0,
      now: acc.activeElapsedMs,
      committed: 0,
      totalTodos: 0,
    });
    assert.equal(reason, null, "8-h host sleep does not trip the wall-clock cap");
  });
});
