import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyStallRules,
  ruleStallVerdict,
  shouldInvokeStallArbitrator,
} from "./stallRules.js";
import type { StallBoardSnapshot } from "./types.js";

function snap(partial: Partial<StallBoardSnapshot>): StallBoardSnapshot {
  return {
    open: 0,
    stale: 0,
    skipped: 0,
    committed: 0,
    total: 0,
    unmetCriteria: 0,
    totalCriteria: 0,
    stuckCycles: 0,
    recentStaleReasons: [],
    recentSkipReasons: [],
    recentReplannerSkips: [],
    ...partial,
  };
}

describe("classifyStallRules", () => {
  it("detects transient quota", () => {
    assert.equal(
      classifyStallRules(snap({ providerStall: "Ollama HTTP 429: session usage limit" })),
      "transient-quota",
    );
  });

  it("detects replanner skip storm", () => {
    assert.equal(
      classifyStallRules(
        snap({
          unmetCriteria: 5,
          recentReplannerSkips: ["a", "b", "c"],
        }),
      ),
      "replanner-skip-storm",
    );
  });

  it("detects no-activity", () => {
    assert.equal(
      classifyStallRules(snap({ total: 0, committed: 0, unmetCriteria: 2 })),
      "no-activity",
    );
  });

  it("treats zombie open board as ambiguous after stuckCycles >= 2", () => {
    assert.equal(
      classifyStallRules(
        snap({ open: 3, committed: 0, unmetCriteria: 2, stuckCycles: 2, total: 3 }),
      ),
      "ambiguous",
    );
  });

  it("open board with commits remains healthy", () => {
    assert.equal(
      classifyStallRules(snap({ open: 2, committed: 1, unmetCriteria: 1, total: 5 })),
      "healthy",
    );
  });
});

describe("ruleStallVerdict", () => {
  it("backs off on quota", () => {
    const v = ruleStallVerdict(snap({}), "transient-quota");
    assert.equal(v?.action, "backoff");
    assert.equal(v?.backoffMs, 120_000);
  });

  it("retries on no-activity with planner hint", () => {
    const v = ruleStallVerdict(snap({}), "no-activity");
    assert.equal(v?.action, "retry");
    assert.ok(v?.plannerHint);
    assert.match(v!.rationale, /No board activity/i);
  });

  it("retries on ambiguous when stuckCycles >= 1", () => {
    const v = ruleStallVerdict(snap({ stuckCycles: 1 }), "ambiguous");
    assert.equal(v?.action, "retry");
    assert.ok(v?.plannerHint);
  });

  it("returns null on ambiguous with stuckCycles 0", () => {
    assert.equal(ruleStallVerdict(snap({ stuckCycles: 0 }), "ambiguous"), null);
  });
});

describe("shouldInvokeStallArbitrator", () => {
  it("never for healthy or quota", () => {
    assert.equal(shouldInvokeStallArbitrator(snap({}), "healthy", 0, 6), false);
    assert.equal(shouldInvokeStallArbitrator(snap({}), "transient-quota", 0, 6), false);
  });

  it("invokes for ambiguous/no-activity at stuckCycles >= 1", () => {
    assert.equal(
      shouldInvokeStallArbitrator(snap({ stuckCycles: 1 }), "ambiguous", 0, 6),
      true,
    );
    assert.equal(
      shouldInvokeStallArbitrator(snap({ stuckCycles: 1 }), "no-activity", 0, 6),
      true,
    );
    assert.equal(
      shouldInvokeStallArbitrator(snap({ stuckCycles: 0 }), "no-activity", 0, 6),
      false,
    );
  });

  it("escalates storms only after stuckCycles >= 2", () => {
    assert.equal(
      shouldInvokeStallArbitrator(snap({ stuckCycles: 0 }), "replanner-skip-storm", 0, 6),
      false,
    );
    assert.equal(
      shouldInvokeStallArbitrator(snap({ stuckCycles: 2 }), "skip-storm", 0, 6),
      true,
    );
  });

  it("respects maxCalls", () => {
    assert.equal(
      shouldInvokeStallArbitrator(snap({ stuckCycles: 5 }), "ambiguous", 6, 6),
      false,
    );
  });
});
