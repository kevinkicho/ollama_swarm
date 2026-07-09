import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyStallRules, ruleStallVerdict } from "./stallRules.js";
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
});

describe("ruleStallVerdict", () => {
  it("backs off on quota", () => {
    const v = ruleStallVerdict(snap({}), "transient-quota");
    assert.equal(v?.action, "backoff");
    assert.equal(v?.backoffMs, 120_000);
  });
});