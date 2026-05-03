// 2026-05-02 (quality lever #2): tests for rubric-pre-pass.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildRubricPrompt,
  parseRubricResponse,
  formatRubricMarkdown,
  recommendProposerCount,
} from "./rubricPrePass.js";

describe("buildRubricPrompt", () => {
  it("includes the directive verbatim + the JSON-shape instruction", () => {
    const p = buildRubricPrompt("Audit the README for stale claims");
    assert.match(p, /Audit the README for stale claims/);
    assert.match(p, /STRICT JSON/);
    assert.match(p, /deliverableShape/);
    assert.match(p, /criteria/);
  });

  it("explicitly bans meta-criteria and vague rules", () => {
    const p = buildRubricPrompt("anything");
    assert.match(p, /be clear|be helpful/i);
    assert.match(p, /SPECIFIC/);
  });
});

describe("parseRubricResponse", () => {
  it("parses a clean response", () => {
    const r = parseRubricResponse(
      '{"deliverableShape":"audit list","criteria":["names files","cites lines","distinguishes verified vs unverified"]}',
    );
    assert.ok(r);
    assert.equal(r!.deliverableShape, "audit list");
    assert.equal(r!.criteria.length, 3);
  });

  it("strips ```json fences", () => {
    const r = parseRubricResponse(
      '```json\n{"deliverableShape":"x","criteria":["a","b"]}\n```',
    );
    assert.ok(r);
    assert.equal(r!.deliverableShape, "x");
  });

  it("rejects empty criteria array", () => {
    assert.equal(
      parseRubricResponse('{"deliverableShape":"x","criteria":[]}'),
      null,
    );
  });

  it("rejects more than 10 criteria (likely model padding)", () => {
    const many = JSON.stringify({
      deliverableShape: "x",
      criteria: Array(11).fill("c"),
    });
    assert.equal(parseRubricResponse(many), null);
  });

  it("rejects missing deliverableShape", () => {
    assert.equal(
      parseRubricResponse('{"criteria":["a","b"]}'),
      null,
    );
  });

  it("filters out empty/whitespace criteria entries", () => {
    const r = parseRubricResponse(
      '{"deliverableShape":"x","criteria":["real",""," ","also real"]}',
    );
    assert.ok(r);
    assert.deepEqual(r!.criteria, ["real", "also real"]);
  });

  it("returns null on non-JSON", () => {
    assert.equal(parseRubricResponse("not json at all"), null);
    assert.equal(parseRubricResponse(""), null);
    assert.equal(parseRubricResponse(null as unknown as string), null);
  });
});

describe("formatRubricMarkdown", () => {
  it("renders shape + criteria as a bulleted list", () => {
    const md = formatRubricMarkdown({
      deliverableShape: "decision memo",
      criteria: ["names alternatives", "lists tradeoffs", "makes recommendation"],
      raw: "",
    });
    assert.match(md, /\*\*Deliverable shape:\*\* decision memo/);
    assert.match(md, /\*\*Success criteria:\*\*/);
    assert.match(md, /- names alternatives/);
    assert.match(md, /- lists tradeoffs/);
    assert.match(md, /- makes recommendation/);
  });
});

// 2026-05-02 (matrix row #1): advisory auto-tune for proposer count.
describe("recommendProposerCount", () => {
  it("returns 3 (floor) for 1-3 criteria", () => {
    assert.equal(recommendProposerCount({ deliverableShape: "x", criteria: ["a"], raw: "" }), 3);
    assert.equal(recommendProposerCount({ deliverableShape: "x", criteria: ["a", "b"], raw: "" }), 3);
    assert.equal(recommendProposerCount({ deliverableShape: "x", criteria: ["a", "b", "c"], raw: "" }), 3);
  });

  it("returns the count itself for 4-5 criteria", () => {
    assert.equal(recommendProposerCount({ deliverableShape: "x", criteria: ["a", "b", "c", "d"], raw: "" }), 4);
    assert.equal(recommendProposerCount({ deliverableShape: "x", criteria: ["a", "b", "c", "d", "e"], raw: "" }), 5);
  });

  it("caps at 6 for 6+ criteria", () => {
    const six = ["a", "b", "c", "d", "e", "f"];
    assert.equal(recommendProposerCount({ deliverableShape: "x", criteria: six, raw: "" }), 6);
    assert.equal(recommendProposerCount({ deliverableShape: "x", criteria: [...six, "g", "h"], raw: "" }), 6);
  });
});
