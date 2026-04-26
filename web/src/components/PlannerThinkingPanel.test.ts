// Unit tests for the partial-JSON extractors in PlannerThinkingPanel.
// Run via the web workspace; not required for CI but pins the parser
// behavior so #160's UX doesn't silently break on shape drift.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { _internals, extractPlannerStream } from "./PlannerThinkingPanel";

const { countCriteriaInProgress } = _internals;

describe("countCriteriaInProgress (Task #162)", () => {
  it("returns 0 when criteria array hasn't been opened", () => {
    assert.equal(countCriteriaInProgress(""), 0);
    assert.equal(countCriteriaInProgress('{"missionStatement": "x"'), 0);
    assert.equal(countCriteriaInProgress('{"missionStatement": "x", "criteria":'), 0);
  });

  it("counts each completed criterion once", () => {
    const text = '{"criteria": [{"id":"a"},{"id":"b"},{"id":"c"}]}';
    // 3 closed { } pairs inside the array, plus the array's }. We count
    // every } in the array slice — strings don't contain unescaped }.
    assert.equal(countCriteriaInProgress(text), 3);
  });

  it("does not count } inside string values", () => {
    const text = '{"criteria": [{"id":"a","desc":"contains } inside"}]}';
    assert.equal(countCriteriaInProgress(text), 1);
  });

  it("respects backslash escapes in strings", () => {
    const text = '{"criteria": [{"desc":"escaped \\" then } here"}]}';
    assert.equal(countCriteriaInProgress(text), 1);
  });

  it("counts an in-flight stream including completed and partial", () => {
    // 2 closed criteria + 1 in-flight (no closing brace yet)
    const text = '{"criteria": [{"id":"a"},{"id":"b"},{"id":"c","desc":"in pro';
    assert.equal(countCriteriaInProgress(text), 2);
  });
});

describe("extractPlannerStream (Task #161)", () => {
  it("returns nulls on empty input", () => {
    const r = extractPlannerStream("");
    assert.equal(r.missionStatement, null);
    assert.equal(r.inProgressDescription, null);
    assert.equal(r.inProgressPosition, null);
  });

  it("extracts a fully-closed missionStatement", () => {
    const r = extractPlannerStream('{"missionStatement": "Build a CLI", "criteria":');
    assert.equal(r.missionStatement, "Build a CLI");
  });

  it("returns null missionStatement while value still streaming (no closing quote)", () => {
    const r = extractPlannerStream('{"missionStatement": "Build a CL');
    assert.equal(r.missionStatement, null);
  });

  it("identifies in-flight criterion position correctly", () => {
    // 2 complete criteria, currently writing #3
    const text = '{"criteria": [{"id":"a"},{"id":"b"},{"id":"c","description":"writing now';
    const r = extractPlannerStream(text);
    assert.equal(r.inProgressPosition, 3);
  });

  it("extracts the partial description of the in-flight criterion", () => {
    const text = '{"criteria": [{"id":"c","description":"the in-progress text';
    const r = extractPlannerStream(text);
    assert.equal(r.inProgressPosition, 1);
    assert.equal(r.inProgressDescription, "the in-progress text");
  });

  it("returns nulls for in-progress when between criteria (just closed last one)", () => {
    const text = '{"criteria": [{"id":"a"},{"id":"b"},';
    const r = extractPlannerStream(text);
    assert.equal(r.inProgressPosition, null);
    assert.equal(r.inProgressDescription, null);
  });

  it("handles mission + in-flight criterion together", () => {
    const text =
      '{"missionStatement": "Validate continuous mode", "criteria": [{"id":"a","description":"first one done"},{"id":"b","description":"second in pro';
    const r = extractPlannerStream(text);
    assert.equal(r.missionStatement, "Validate continuous mode");
    assert.equal(r.inProgressPosition, 2);
    assert.equal(r.inProgressDescription, "second in pro");
  });
});
