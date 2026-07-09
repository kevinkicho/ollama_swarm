import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildDraftsTabLiveRows,
  buildRoundsConfigRows,
  formatCouncilRunMode,
  formatCyclePlanningLabel,
} from "./DraftsTabTooltip.js";

describe("formatCouncilRunMode", () => {
  it("describes autonomous mode", () => {
    assert.match(formatCouncilRunMode(0), /until stop/);
  });

  it("describes fixed cycle count", () => {
    assert.equal(formatCouncilRunMode(3), "3 cycles");
    assert.equal(formatCouncilRunMode(1), "1 cycle");
  });
});

describe("formatCyclePlanningLabel", () => {
  it("cycle 1 is 3 debate rounds", () => {
    assert.equal(formatCyclePlanningLabel(1), "3 debate");
  });

  it("cycle 2+ is standup", () => {
    assert.equal(formatCyclePlanningLabel(2), "1 standup");
  });
});

describe("buildRoundsConfigRows", () => {
  it("highlights autonomous cfg", () => {
    const rows = buildRoundsConfigRows(0);
    assert.equal(rows[0]?.accent, "text-emerald-300");
    assert.equal(rows[0]?.highlight, true);
    assert.equal(rows[1]?.accent, undefined);
    assert.equal(rows[1]?.highlight, false);
  });
});

describe("buildDraftsTabLiveRows", () => {
  it("includes mode and cfg.rounds", () => {
    const rows = buildDraftsTabLiveRows(0, []);
    assert.equal(rows.find((r) => r.cells[0] === "mode")?.cells[1], "∞ until stop");
    assert.equal(rows.find((r) => r.cells[0] === "cfg.rounds")?.cells[1], "0");
  });

  it("adds live cycle rows when transcript has cycles", () => {
    const rows = buildDraftsTabLiveRows(0, [
      {
        cycle: 1,
        isDrainOnly: false,
        rounds: new Map(),
        execution: [],
        conformance: null,
        todosDone: 0,
        todosFailed: 0,
        todosSkipped: 0,
        hasCompleteSummary: false,
        maxAgentIndex: 0,
      },
      {
        cycle: 2,
        isDrainOnly: true,
        rounds: new Map(),
        execution: [],
        conformance: null,
        todosDone: 0,
        todosFailed: 0,
        todosSkipped: 0,
        hasCompleteSummary: false,
        maxAgentIndex: 0,
      },
    ]);
    assert.equal(rows.find((r) => r.cells[0] === "cycles")?.cells[1], "2");
    assert.equal(rows.find((r) => r.cells[0] === "current")?.cells[1], "#2 drain");
    assert.equal(rows.find((r) => r.cells[0] === "planning")?.cells[1], "skipped");
  });
});