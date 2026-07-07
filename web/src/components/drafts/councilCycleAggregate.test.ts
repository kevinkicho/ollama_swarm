import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  aggregateCouncilCycles,
  cycleShowsExecCounts,
} from "./councilCycleAggregate.js";
import type { TranscriptEntry } from "../../types.js";

function sys(text: string, ts = 1): TranscriptEntry {
  return { id: `s-${ts}`, role: "system", text, ts };
}

describe("aggregateCouncilCycles", () => {
  it("records hasCompleteSummary for 0/0/0 drain cycles", () => {
    const cycles = aggregateCouncilCycles([
      sys("═══ Council cycle 14 ═══"),
      sys("[execution] Complete: 0 done, 0 failed, 0 skipped."),
    ]);
    assert.equal(cycles.length, 1);
    assert.equal(cycles[0].hasCompleteSummary, true);
    assert.equal(cycles[0].todosDone, 0);
    assert.equal(cycles[0].todosFailed, 0);
    assert.equal(cycles[0].todosSkipped, 0);
    assert.equal(cycleShowsExecCounts(cycles[0]), true);
  });

  it("parses non-zero Complete summary for header counts", () => {
    const cycles = aggregateCouncilCycles([
      sys("═══ Council cycle 15 ═══"),
      sys("[execution] Complete: 1 done, 3 failed, 2 skipped."),
    ]);
    assert.equal(cycles[0].todosDone, 1);
    assert.equal(cycles[0].todosFailed, 3);
    assert.equal(cycles[0].todosSkipped, 2);
    assert.equal(cycleShowsExecCounts(cycles[0]), true);
  });

  it("orders cycles by transcript appearance (caller sorts for display)", () => {
    const cycles = aggregateCouncilCycles([
      sys("═══ Council cycle 1 ═══"),
      sys("═══ Council cycle 2 ═══"),
    ]);
    assert.deepEqual(cycles.map((c) => c.cycle), [1, 2]);
    const newestFirst = [...cycles].sort((a, b) => b.cycle - a.cycle);
    assert.equal(newestFirst[0].cycle, 2);
  });
});