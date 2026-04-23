import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkCaps,
  COMMITS_CAP,
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
