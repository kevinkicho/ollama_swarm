import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { parsePlannerResponse, type PlannerParseResult } from "./planner.js";

function expectOk(
  r: PlannerParseResult,
): asserts r is Extract<PlannerParseResult, { ok: true }> {
  if (!r.ok) assert.fail(`expected ok, got: ${r.reason}`);
}

describe("parsePlannerResponse — happy paths", () => {
  it("parses a flat JSON array", () => {
    const raw = JSON.stringify([
      { description: "Add a CONTRIBUTING doc", expectedFiles: ["CONTRIBUTING.md"] },
      { description: "Rename export in index.js", expectedFiles: ["src/index.js", "src/index.test.js"] },
    ]);
    const r = parsePlannerResponse(raw);
    expectOk(r);
    assert.equal(r.todos.length, 2);
    assert.equal(r.todos[0].description, "Add a CONTRIBUTING doc");
    assert.deepEqual(r.todos[1].expectedFiles, ["src/index.js", "src/index.test.js"]);
    assert.equal(r.dropped.length, 0);
  });

  it("strips ```json fences", () => {
    const raw = '```json\n[{"description":"a","expectedFiles":["x.ts"]}]\n```';
    const r = parsePlannerResponse(raw);
    expectOk(r);
    assert.equal(r.todos.length, 1);
    assert.equal(r.todos[0].description, "a");
  });

  it("strips bare ``` fences", () => {
    const raw = '```\n[{"description":"a","expectedFiles":["x.ts"]}]\n```';
    const r = parsePlannerResponse(raw);
    expectOk(r);
    assert.equal(r.todos.length, 1);
  });

  it("extracts array from surrounding prose", () => {
    const raw = 'Here is the plan: [{"description":"a","expectedFiles":["x.ts"]}] Let me know!';
    const r = parsePlannerResponse(raw);
    expectOk(r);
    assert.equal(r.todos.length, 1);
  });

  it("allows an empty array (planner says nothing to do)", () => {
    const r = parsePlannerResponse("[]");
    expectOk(r);
    assert.equal(r.todos.length, 0);
    assert.equal(r.dropped.length, 0);
  });
});

describe("parsePlannerResponse — rejections", () => {
  it("rejects malformed JSON", () => {
    const r = parsePlannerResponse("{not valid");
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /JSON parse failed/);
  });

  it("rejects a top-level object instead of array", () => {
    const r = parsePlannerResponse('{"description":"a","expectedFiles":["x.ts"]}');
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /top-level JSON array/);
  });

  it("rejects when there are more than 20 valid todos", () => {
    const many = Array.from({ length: 21 }, (_, i) => ({
      description: `task ${i}`,
      expectedFiles: [`f${i}.ts`],
    }));
    const r = parsePlannerResponse(JSON.stringify(many));
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /too many/);
  });
});

describe("parsePlannerResponse — drops invalid items", () => {
  it("drops items missing description and keeps valid ones", () => {
    const raw = JSON.stringify([
      { description: "good", expectedFiles: ["a.ts"] },
      { expectedFiles: ["b.ts"] },
      { description: "good2", expectedFiles: ["c.ts"] },
    ]);
    const r = parsePlannerResponse(raw);
    expectOk(r);
    assert.equal(r.todos.length, 2);
    assert.equal(r.dropped.length, 1);
  });

  it("drops items with more than 2 expectedFiles (atomic-unit rule)", () => {
    const raw = JSON.stringify([
      { description: "ok", expectedFiles: ["a.ts"] },
      { description: "too big", expectedFiles: ["a.ts", "b.ts", "c.ts"] },
    ]);
    const r = parsePlannerResponse(raw);
    expectOk(r);
    assert.equal(r.todos.length, 1);
    assert.equal(r.dropped.length, 1);
    assert.match(r.dropped[0].reason, /expectedFiles/);
  });

  it("drops items with empty expectedFiles list", () => {
    const raw = JSON.stringify([
      { description: "no files", expectedFiles: [] },
      { description: "ok", expectedFiles: ["a.ts"] },
    ]);
    const r = parsePlannerResponse(raw);
    expectOk(r);
    assert.equal(r.todos.length, 1);
    assert.equal(r.dropped.length, 1);
  });

  it("drops items whose description is blank after trim", () => {
    const raw = JSON.stringify([
      { description: "   ", expectedFiles: ["a.ts"] },
      { description: "ok", expectedFiles: ["b.ts"] },
    ]);
    const r = parsePlannerResponse(raw);
    expectOk(r);
    assert.equal(r.todos.length, 1);
    assert.equal(r.dropped.length, 1);
  });

  it("drops items whose expectedFiles include a directory path (trailing / or \\)", () => {
    const raw = JSON.stringify([
      { description: "ok", expectedFiles: ["src/index.ts"] },
      { description: "fwd slash dir", expectedFiles: ["src/"] },
      { description: "backslash dir", expectedFiles: ["src\\"] },
    ]);
    const r = parsePlannerResponse(raw);
    expectOk(r);
    assert.equal(r.todos.length, 1);
    assert.equal(r.dropped.length, 2);
    assert.match(r.dropped[0].reason, /file path, not a directory/);
    assert.match(r.dropped[1].reason, /file path, not a directory/);
  });
});
