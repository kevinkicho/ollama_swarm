import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { collectStreamIntegrityReport } from "./streamIntegrityReport.js";

describe("collectStreamIntegrityReport", () => {
  it("returns undefined for clean short transcripts", () => {
    const r = collectStreamIntegrityReport([
      { role: "system", text: "hello" },
      { role: "agent", text: "short", agentId: "agent-1" },
    ]);
    assert.equal(r, undefined);
  });

  it("aggregates stream-integrity system lines and peaks", () => {
    const r = collectStreamIntegrityReport([
      {
        role: "system",
        text:
          "[stream-integrity] agent-3: collapsed ~100×150c loop (−50000 chars) (raw 60000 → 800)",
        ts: 1,
      },
      { role: "agent", text: "x".repeat(10_000), thoughts: "y".repeat(1000), agentId: "agent-3" },
    ]);
    assert.ok(r);
    assert.equal(r!.anomalyEventCount, 1);
    assert.deepEqual(r!.agentsAffected, ["agent-3"]);
    assert.equal(r!.hadLoopCollapse, true);
    assert.ok(r!.maxAgentTextChars >= 10_000);
  });
});
