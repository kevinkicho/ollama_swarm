import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseCouncilCycleText, parseCouncilStageText } from "./CouncilCycleDivider";

describe("parseCouncilCycleText", () => {
  it("parses full cycle header", () => {
    const s = parseCouncilCycleText("═══ Council cycle 1 ═══");
    assert.ok(s);
    assert.equal(s!.cycle, 1);
    assert.equal(s!.executionOnly, false);
  });

  it("parses execution-only cycle header", () => {
    const s = parseCouncilCycleText("═══ Council cycle 2 — draining 10 pending todo(s) ═══");
    assert.ok(s);
    assert.equal(s!.cycle, 2);
    assert.equal(s!.executionOnly, true);
    assert.equal(s!.pendingTodos, 10);
  });
});

describe("parseCouncilStageText", () => {
  it("parses discussion stage", () => {
    const s = parseCouncilStageText("Analysis — 3 round(s)", 1);
    assert.equal(s?.stage, "discussion");
    assert.equal(s?.detail, "3 rounds");
  });

  it("parses audit stage", () => {
    const s = parseCouncilStageText("[audit] LLM audit: 2/12 criteria met, 10 new todo(s).", 2);
    assert.equal(s?.stage, "audit");
    assert.match(s?.detail ?? "", /2\/12/);
  });
});