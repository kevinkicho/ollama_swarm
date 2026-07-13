import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyDeferredReconfigToStartFields,
  DEFERRED_RECONFIG_MAX_AGE_MS,
  readDeferredReconfig,
  clearDeferredReconfig,
  writeDeferredReconfig,
} from "./deferredReconfig.js";

describe("applyDeferredReconfigToStartFields", () => {
  it("applies absolute wall-clock and rounds", () => {
    const r = applyDeferredReconfigToStartFields({
      rounds: 3,
      wallClockCapMin: "30",
      patch: { rounds: 8, wallClockCapMin: 120 },
    });
    assert.equal(r.rounds, 8);
    assert.equal(r.wallClockCapMin, "120");
    assert.ok(r.applied.length >= 2);
  });

  it("extends finite rounds and cap", () => {
    const r = applyDeferredReconfigToStartFields({
      rounds: 5,
      wallClockCapMin: "60",
      patch: { extendRounds: 2, extendWallClockCapMin: 15 },
    });
    assert.equal(r.rounds, 7);
    assert.equal(r.wallClockCapMin, "75");
  });

  it("does not close autonomous rounds=0 with extendRounds", () => {
    const r = applyDeferredReconfigToStartFields({
      rounds: 0,
      wallClockCapMin: "0",
      patch: { extendRounds: 3, extendWallClockCapMin: 30 },
    });
    assert.equal(r.rounds, 0);
    assert.equal(r.wallClockCapMin, "30");
  });
});

describe("readDeferredReconfig age gate", () => {
  it("drops expired records", () => {
    // jsdom-less: only run when sessionStorage exists
    if (typeof sessionStorage === "undefined") return;
    writeDeferredReconfig({
      patch: { extendWallClockCapMin: 10 },
      at: Date.now() - DEFERRED_RECONFIG_MAX_AGE_MS - 1,
    });
    assert.equal(readDeferredReconfig(), null);
    clearDeferredReconfig();
  });
});
