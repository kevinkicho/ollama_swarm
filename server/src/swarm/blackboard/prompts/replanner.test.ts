import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { parseReplannerResponse, type ReplannerParseResult } from "./replanner.js";

function expectRevised(
  r: ReplannerParseResult,
): asserts r is Extract<ReplannerParseResult, { ok: true; action: "revised" }> {
  if (!r.ok) assert.fail(`expected ok, got: ${r.reason}`);
  if (r.action !== "revised") assert.fail(`expected action=revised, got: ${r.action}`);
}

function expectSkip(
  r: ReplannerParseResult,
): asserts r is Extract<ReplannerParseResult, { ok: true; action: "skip" }> {
  if (!r.ok) assert.fail(`expected ok, got: ${r.reason}`);
  if (r.action !== "skip") assert.fail(`expected action=skip, got: ${r.action}`);
}

describe("parseReplannerResponse — happy paths", () => {
  it("parses a revised shape", () => {
    const raw = JSON.stringify({
      revised: {
        description: "Shrink the README intro to one paragraph",
        expectedFiles: ["README.md"],
      },
    });
    const r = parseReplannerResponse(raw);
    expectRevised(r);
    assert.equal(r.description, "Shrink the README intro to one paragraph");
    assert.deepEqual(r.expectedFiles, ["README.md"]);
  });

  it("parses a skip shape", () => {
    const raw = JSON.stringify({ skip: true, reason: "README already has the section" });
    const r = parseReplannerResponse(raw);
    expectSkip(r);
    assert.equal(r.reason, "README already has the section");
  });

  it("accepts 2 expectedFiles in a revised shape", () => {
    const raw = JSON.stringify({
      revised: {
        description: "Rename the exported symbol",
        expectedFiles: ["src/index.ts", "src/index.test.ts"],
      },
    });
    const r = parseReplannerResponse(raw);
    expectRevised(r);
    assert.deepEqual(r.expectedFiles, ["src/index.ts", "src/index.test.ts"]);
  });

  it("strips ```json fences", () => {
    const raw = '```json\n{"revised":{"description":"a","expectedFiles":["x.ts"]}}\n```';
    const r = parseReplannerResponse(raw);
    expectRevised(r);
    assert.equal(r.description, "a");
  });

  it("strips bare ``` fences", () => {
    const raw = '```\n{"skip":true,"reason":"done"}\n```';
    const r = parseReplannerResponse(raw);
    expectSkip(r);
  });

  it("extracts object from surrounding prose", () => {
    const raw = 'Here is the replan: {"skip":true,"reason":"not needed"} Let me know!';
    const r = parseReplannerResponse(raw);
    expectSkip(r);
    assert.equal(r.reason, "not needed");
  });
});

describe("parseReplannerResponse — rejections", () => {
  it("rejects malformed JSON", () => {
    const r = parseReplannerResponse("{not valid");
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /JSON parse failed/);
  });

  it("rejects a top-level array", () => {
    const r = parseReplannerResponse('[{"skip":true,"reason":"x"}]');
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /top-level JSON object/);
  });

  it("rejects an object with neither revised nor skip", () => {
    const r = parseReplannerResponse('{"description":"a","expectedFiles":["x.ts"]}');
    assert.equal(r.ok, false);
  });

  it("rejects skip with reason blank after trim", () => {
    const r = parseReplannerResponse('{"skip":true,"reason":"   "}');
    assert.equal(r.ok, false);
  });

  it("rejects skip with skip=false (must be literal true)", () => {
    const r = parseReplannerResponse('{"skip":false,"reason":"x"}');
    assert.equal(r.ok, false);
  });

  it("rejects revised missing description", () => {
    const r = parseReplannerResponse('{"revised":{"expectedFiles":["x.ts"]}}');
    assert.equal(r.ok, false);
  });

  it("rejects revised with more than 2 expectedFiles", () => {
    const r = parseReplannerResponse(
      '{"revised":{"description":"a","expectedFiles":["a.ts","b.ts","c.ts"]}}',
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /expectedFiles/);
  });

  it("rejects revised with empty expectedFiles", () => {
    const r = parseReplannerResponse('{"revised":{"description":"a","expectedFiles":[]}}');
    assert.equal(r.ok, false);
  });

  it("rejects revised with description blank after trim", () => {
    const r = parseReplannerResponse(
      '{"revised":{"description":"   ","expectedFiles":["x.ts"]}}',
    );
    assert.equal(r.ok, false);
  });
});
