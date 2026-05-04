// Q8 (2026-05-04): tests for pheromone decay + saturation cap.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decayInterest,
  isSaturated,
  pickNextFileWithDecay,
  DEFAULT_DECAY_RATE,
  DEFAULT_MAX_REVISITS,
} from "./pheromoneDecay.js";
import type { PheromoneState } from "./pheromoneDecay.js";

function state(overrides: Partial<PheromoneState> = {}): PheromoneState {
  return {
    visits: 1,
    avgInterest: 5,
    avgConfidence: 5,
    latestNote: "",
    ...overrides,
  };
}

test("decayInterest — 0 rounds elapsed → no change", () => {
  const got = decayInterest(state({ avgInterest: 8 }), 0);
  assert.equal(got.avgInterest, 8);
});

test("decayInterest — multiplicative decay over rounds", () => {
  const got = decayInterest(state({ avgInterest: 10 }), 1, 0.5);
  assert.equal(got.avgInterest, 5);
});

test("decayInterest — 20 rounds at default rate fades 8 → ~0.5", () => {
  const got = decayInterest(state({ avgInterest: 8 }), 20, DEFAULT_DECAY_RATE);
  assert.ok(got.avgInterest < 1, `expected < 1, got ${got.avgInterest}`);
  assert.ok(got.avgInterest > 0.1, `expected > 0.1, got ${got.avgInterest}`);
});

test("decayInterest — does not mutate input", () => {
  const input = state({ avgInterest: 8 });
  decayInterest(input, 5);
  assert.equal(input.avgInterest, 8);
});

test("isSaturated — at cap → true", () => {
  assert.equal(isSaturated(state({ visits: DEFAULT_MAX_REVISITS })), true);
});

test("isSaturated — below cap → false", () => {
  assert.equal(isSaturated(state({ visits: DEFAULT_MAX_REVISITS - 1 })), false);
});

test("isSaturated — over cap → true (defensive)", () => {
  assert.equal(isSaturated(state({ visits: DEFAULT_MAX_REVISITS + 5 })), true);
});

test("pickNextFileWithDecay — empty candidates → null", () => {
  const got = pickNextFileWithDecay({
    candidates: [],
    currentRound: 1,
  });
  assert.equal(got, null);
});

test("pickNextFileWithDecay — all-saturated → null", () => {
  const got = pickNextFileWithDecay({
    candidates: [
      { path: "a", state: state({ visits: 99 }), lastVisitedRound: 1 },
      { path: "b", state: state({ visits: 99 }), lastVisitedRound: 2 },
    ],
    currentRound: 5,
  });
  assert.equal(got, null);
});

test("pickNextFileWithDecay — picks highest-scoring eligible", () => {
  const got = pickNextFileWithDecay({
    candidates: [
      {
        path: "low-interest",
        state: state({ visits: 1, avgInterest: 2, avgConfidence: 5 }),
        lastVisitedRound: 1,
      },
      {
        path: "high-interest",
        state: state({ visits: 1, avgInterest: 9, avgConfidence: 5 }),
        lastVisitedRound: 1,
      },
    ],
    currentRound: 1,
  });
  assert.equal(got?.path, "high-interest");
});

test("pickNextFileWithDecay — decay drops a stale-but-high-interest file below a fresh moderate one", () => {
  // "stale-high" was rated 9 long ago; "fresh-moderate" was rated 6
  // recently. After decay, fresh-moderate should win.
  const got = pickNextFileWithDecay({
    candidates: [
      {
        path: "stale-high",
        state: state({ visits: 1, avgInterest: 9, avgConfidence: 5 }),
        lastVisitedRound: 1, // 19 rounds ago
      },
      {
        path: "fresh-moderate",
        state: state({ visits: 1, avgInterest: 6, avgConfidence: 5 }),
        lastVisitedRound: 19, // last round
      },
    ],
    currentRound: 20,
  });
  assert.equal(got?.path, "fresh-moderate");
});

test("pickNextFileWithDecay — high-confidence files get a boost", () => {
  const got = pickNextFileWithDecay({
    candidates: [
      {
        path: "low-conf-high-int",
        state: state({ visits: 1, avgInterest: 7, avgConfidence: 2 }),
        lastVisitedRound: 1,
      },
      {
        path: "high-conf-mid-int",
        state: state({ visits: 1, avgInterest: 6, avgConfidence: 8 }),
        lastVisitedRound: 1,
      },
    ],
    currentRound: 1,
  });
  // high-conf-mid-int: 6 × 1.2 = 7.2; low-conf-high-int: 7 × 0.5 = 3.5
  // → high-conf-mid-int wins
  assert.equal(got?.path, "high-conf-mid-int");
});

test("pickNextFileWithDecay — saturation filter excludes cap-hit files", () => {
  const got = pickNextFileWithDecay({
    candidates: [
      {
        path: "saturated-but-interesting",
        state: state({ visits: 99, avgInterest: 9, avgConfidence: 9 }),
        lastVisitedRound: 1,
      },
      {
        path: "fresh-moderate",
        state: state({ visits: 1, avgInterest: 5, avgConfidence: 5 }),
        lastVisitedRound: 1,
      },
    ],
    currentRound: 1,
  });
  assert.equal(got?.path, "fresh-moderate");
});

test("pickNextFileWithDecay — tie broken by lowest visits, then by path order", () => {
  const got = pickNextFileWithDecay({
    candidates: [
      {
        path: "z",
        state: state({ visits: 3, avgInterest: 5, avgConfidence: 5 }),
        lastVisitedRound: 1,
      },
      {
        path: "a",
        state: state({ visits: 3, avgInterest: 5, avgConfidence: 5 }),
        lastVisitedRound: 1,
      },
      {
        path: "b",
        state: state({ visits: 1, avgInterest: 5, avgConfidence: 5 }),
        lastVisitedRound: 1,
      },
    ],
    currentRound: 1,
  });
  assert.equal(got?.path, "b", "lower visits beats path order");
});
