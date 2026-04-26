import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildReflectionPrompt, parseReflectionResponse } from "./runEndReflection.js";

describe("parseReflectionResponse — well-formed responses", () => {
  it("parses a clean JSON envelope", () => {
    const r = parseReflectionResponse(
      JSON.stringify({ score: 7, summary: "good run", lessons: ["a", "b"] }),
    );
    assert.ok(r);
    assert.equal(r!.score, 7);
    assert.equal(r!.summary, "good run");
    assert.deepEqual(r!.lessons, ["a", "b"]);
  });

  it("strips ```json fences", () => {
    const r = parseReflectionResponse(
      '```json\n{"score":5,"summary":"ok","lessons":[]}\n```',
    );
    assert.ok(r);
    assert.equal(r!.score, 5);
    assert.deepEqual(r!.lessons, []);
  });

  it("tolerates prose preamble", () => {
    const r = parseReflectionResponse(
      'Here is the reflection:\n{"score":3,"summary":"shallow","lessons":["next time read README first"]}',
    );
    assert.ok(r);
    assert.equal(r!.score, 3);
  });

  it("clamps score to [1,10]", () => {
    const high = parseReflectionResponse('{"score":15,"summary":"x","lessons":[]}');
    assert.equal(high!.score, 10);
    const low = parseReflectionResponse('{"score":-3,"summary":"x","lessons":[]}');
    assert.equal(low!.score, 1);
  });

  it("rounds non-integer scores", () => {
    const r = parseReflectionResponse('{"score":7.7,"summary":"x","lessons":[]}');
    assert.equal(r!.score, 8);
  });

  it("accepts string-typed scores (model sometimes emits them)", () => {
    const r = parseReflectionResponse('{"score":"7","summary":"x","lessons":[]}');
    assert.equal(r!.score, 7);
  });

  it("trims and slices summary to 200 chars", () => {
    const long = "x".repeat(300);
    const r = parseReflectionResponse(`{"score":5,"summary":"${long}","lessons":[]}`);
    assert.ok(r);
    assert.equal(r!.summary.length, 200);
  });

  it("filters non-string lessons + empties + caps to MAX", () => {
    const lots = Array.from({ length: 20 }, (_, i) => `l${i}`);
    const r = parseReflectionResponse(
      JSON.stringify({ score: 5, summary: "ok", lessons: [...lots, 42, "", "  ", null] as unknown[] }),
    );
    assert.ok(r);
    assert.equal(r!.lessons.length, 8);
    assert.equal(r!.lessons[0], "l0");
  });
});

describe("parseReflectionResponse — failure modes", () => {
  it("returns null on unparseable input", () => {
    assert.equal(parseReflectionResponse("not even json"), null);
    assert.equal(parseReflectionResponse(""), null);
  });

  it("returns null when score is missing", () => {
    assert.equal(
      parseReflectionResponse('{"summary":"missing score","lessons":[]}'),
      null,
    );
  });

  it("returns null when summary is missing or empty", () => {
    assert.equal(parseReflectionResponse('{"score":5,"lessons":[]}'), null);
    assert.equal(
      parseReflectionResponse('{"score":5,"summary":"   ","lessons":[]}'),
      null,
    );
  });

  it("returns null when score is non-numeric", () => {
    assert.equal(
      parseReflectionResponse('{"score":"high","summary":"x","lessons":[]}'),
      null,
    );
  });

  it("returns null when top level is an array", () => {
    assert.equal(
      parseReflectionResponse('[{"score":5,"summary":"x","lessons":[]}]'),
      null,
    );
  });
});

describe("buildReflectionPrompt — content invariants", () => {
  it("includes the preset name and context summary", () => {
    const out = buildReflectionPrompt("council", "ran 4 rounds, converged-high");
    assert.match(out, /"council" swarm preset/);
    assert.match(out, /ran 4 rounds, converged-high/);
  });

  it("specifies the JSON output shape", () => {
    const out = buildReflectionPrompt("council", "x");
    assert.match(out, /"score":/);
    assert.match(out, /"summary":/);
    assert.match(out, /"lessons":/);
    assert.match(out, /no fences, no prose/);
  });

  it("provides a score rubric so the model knows how to scale", () => {
    const out = buildReflectionPrompt("council", "x");
    assert.match(out, /1-2/);
    assert.match(out, /9-10/);
    assert.match(out, /be honest, not generous/);
  });
});
