// 2026-05-02 (quality levers #1 + #3): tests for the post-deliverable
// critic + next-action extractor. Pure-function tests; the LLM-call
// wrappers (runCriticPass) are exercised end-to-end during sweeps.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildCriticPrompt,
  parseCriticVerdict,
  formatCriticMarkdown,
  extractNextActions,
  formatNextActionsMarkdown,
} from "./qualityPasses.js";

const SAMPLE_RUBRIC = {
  criteria: ["criterion A", "criterion B", "criterion C"],
  deliverableShape: "audit",
  raw: "",
};

describe("buildCriticPrompt", () => {
  it("includes rubric criteria + deliverable shape + the deliverable text", () => {
    const p = buildCriticPrompt("here is my deliverable", SAMPLE_RUBRIC);
    assert.match(p, /1\. criterion A/);
    assert.match(p, /2\. criterion B/);
    assert.match(p, /3\. criterion C/);
    assert.match(p, /DELIVERABLE SHAPE: audit/);
    assert.match(p, /here is my deliverable/);
  });

  it("frames the critic as a finder of gaps, not a reviser", () => {
    const p = buildCriticPrompt("x", SAMPLE_RUBRIC);
    assert.match(p, /find gaps/i);
    assert.match(p, /NOT to revise/i);
  });

  it("truncates very long deliverables to 6000 chars", () => {
    const long = "x".repeat(8000);
    const p = buildCriticPrompt(long, SAMPLE_RUBRIC);
    const block = p.match(/--- BEGIN ---\n([\s\S]*?)\n--- END ---/);
    assert.ok(block);
    assert.equal((block![1].match(/x/g) ?? []).length, 6000);
  });
});

describe("parseCriticVerdict", () => {
  it("parses approved=true with empty weaknesses", () => {
    const r = parseCriticVerdict('{"approved":true,"weaknesses":[],"rationale":"solid"}');
    assert.ok(r);
    assert.equal(r!.approved, true);
    assert.deepEqual(r!.weaknesses, []);
  });

  it("parses approved=false with named weaknesses", () => {
    const r = parseCriticVerdict(
      '{"approved":false,"weaknesses":["gap 1","gap 2"],"rationale":"weak"}',
    );
    assert.ok(r);
    assert.equal(r!.approved, false);
    assert.equal(r!.weaknesses.length, 2);
  });

  it("caps weaknesses at 5 (model padding)", () => {
    const many = JSON.stringify({
      approved: false,
      weaknesses: Array(10).fill("gap"),
      rationale: "x",
    });
    const r = parseCriticVerdict(many);
    assert.ok(r);
    assert.equal(r!.weaknesses.length, 5);
  });

  it("rejects missing approved field", () => {
    assert.equal(parseCriticVerdict('{"weaknesses":[],"rationale":"x"}'), null);
  });

  it("rejects non-boolean approved", () => {
    assert.equal(
      parseCriticVerdict('{"approved":"yes","weaknesses":[],"rationale":"x"}'),
      null,
    );
  });

  it("strips ```json fences", () => {
    const r = parseCriticVerdict(
      '```json\n{"approved":true,"weaknesses":[],"rationale":"good"}\n```',
    );
    assert.ok(r);
    assert.equal(r!.approved, true);
  });

  it("returns null on non-JSON", () => {
    assert.equal(parseCriticVerdict("not json"), null);
    assert.equal(parseCriticVerdict(""), null);
  });
});

describe("formatCriticMarkdown", () => {
  it("renders the approved status + rationale", () => {
    const md = formatCriticMarkdown({
      approved: true,
      weaknesses: [],
      rationale: "solid analysis",
      raw: "",
    });
    assert.match(md, /✓ Approved/);
    assert.match(md, /solid analysis/);
  });

  it("renders weaknesses as bullets when present", () => {
    const md = formatCriticMarkdown({
      approved: false,
      weaknesses: ["no file paths", "vague claim"],
      rationale: "needs evidence",
      raw: "",
    });
    assert.match(md, /⚠ Weaknesses identified/);
    assert.match(md, /- no file paths/);
    assert.match(md, /- vague claim/);
  });

  it("omits the gaps block when weaknesses is empty", () => {
    const md = formatCriticMarkdown({
      approved: true,
      weaknesses: [],
      rationale: "x",
      raw: "",
    });
    assert.doesNotMatch(md, /Specific gaps/);
  });
});

describe("extractNextActions", () => {
  it("extracts bullets under a Recommendations header as actions", () => {
    const md = `
# Report

## Findings

The thing is good.

## Recommendations

- Add input validation to src/auth.ts
- Document the retry behavior in README
- Consider migrating to Zod for schema validation
`;
    const actions = extractNextActions(md);
    const texts = actions.map((a) => a.text);
    assert.ok(texts.some((t) => t.includes("Add input validation")));
    assert.ok(texts.some((t) => t.includes("Document the retry behavior")));
    assert.ok(texts.some((t) => t.includes("Consider migrating to Zod")));
  });

  it("classifies priority by leading verb", () => {
    const md = `
## Recommendations

- urgent: ship the auth fix today
- Add tests for edge cases
- Consider using a different model
`;
    const actions = extractNextActions(md);
    const ship = actions.find((a) => a.text.includes("ship the auth"));
    const tests = actions.find((a) => a.text.includes("Add tests"));
    const consider = actions.find((a) => a.text.includes("Consider using"));
    assert.equal(ship?.priority, "high");
    assert.equal(tests?.priority, "medium");
    assert.equal(consider?.priority, "low");
  });

  it("extracts action-verb bullets even outside an action header", () => {
    const md = `
## Findings

Some prose here.

- Refactor the auth flow
- This bullet is just narrative
- Add type checks to the parser
`;
    const actions = extractNextActions(md);
    const texts = actions.map((a) => a.text);
    assert.ok(texts.some((t) => t.includes("Refactor")));
    assert.ok(texts.some((t) => t.includes("Add type checks")));
    assert.ok(!texts.some((t) => t.includes("just narrative")));
  });

  it("captures lines containing 'should' or 'need to'", () => {
    const md = `
## Notes

The team should add monitoring.
We need to update the docs.
`;
    const actions = extractNextActions(md);
    assert.ok(actions.length >= 2);
  });

  it("dedupes identical actions case-insensitively", () => {
    const md = `
## Recommendations

- Add tests
- ADD TESTS
- Add tests
`;
    const actions = extractNextActions(md);
    assert.equal(actions.filter((a) => a.text.toLowerCase().includes("add tests")).length, 1);
  });

  it("caps total actions at 10 to keep section readable", () => {
    const bullets = Array.from({ length: 20 }, (_, i) => `- Add feature ${i}`).join("\n");
    const md = `## Recommendations\n\n${bullets}`;
    const actions = extractNextActions(md);
    assert.ok(actions.length <= 10);
  });

  it("captures source section when available", () => {
    const md = `
## My Recommendations Section

- Add caching layer
`;
    const actions = extractNextActions(md);
    assert.ok(actions[0]);
    assert.equal(actions[0].source, "My Recommendations Section");
  });

  it("returns empty for analysis-only deliverables", () => {
    const md = `
# Report

## Findings

The codebase has 42 files. Tests cover 80%.

## Conclusion

Looks fine.
`;
    const actions = extractNextActions(md);
    assert.equal(actions.length, 0);
  });

  it("handles empty/null input gracefully", () => {
    assert.deepEqual(extractNextActions(""), []);
    assert.deepEqual(extractNextActions("   "), []);
  });
});

describe("formatNextActionsMarkdown", () => {
  it("groups by priority bucket", () => {
    const md = formatNextActionsMarkdown([
      { priority: "high", text: "ship now" },
      { priority: "medium", text: "add tests" },
      { priority: "low", text: "consider X" },
    ]);
    assert.match(md, /\*\*HIGH priority:\*\*/);
    assert.match(md, /\*\*MEDIUM priority:\*\*/);
    assert.match(md, /\*\*LOW priority:\*\*/);
  });

  it("renders source as italics when present", () => {
    const md = formatNextActionsMarkdown([
      { priority: "medium", text: "do thing", source: "Recommendations" },
    ]);
    assert.match(md, /_\(from: Recommendations\)_/);
  });

  it("returns analysis-only placeholder on empty input", () => {
    const md = formatNextActionsMarkdown([]);
    assert.match(md, /no actionable items detected/);
  });
});
