import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applySoftJsonRepairs,
  stripJsonFences,
  tryParseWithSoftRepairs,
} from "./softJsonRepair.js";
import { extractJsonCandidate, parseJsonEnvelope } from "./parseAgentJson.js";

describe("stripJsonFences", () => {
  it("strips closed ```json fence", () => {
    assert.equal(stripJsonFences('```json\n{"a":1}\n```'), '{"a":1}');
  });

  it("strips unclosed ```json opener (83dc5910)", () => {
    assert.equal(
      stripJsonFences('```json\n{"hunks":[]}'),
      '{"hunks":[]}',
    );
  });
});

describe("applySoftJsonRepairs", () => {
  it("quotes bare keys", () => {
    const got = applySoftJsonRepairs('{op:"replace",file:"a.ts"}');
    assert.equal(got, '{"op":"replace","file":"a.ts"}');
    assert.deepEqual(JSON.parse(got), { op: "replace", file: "a.ts" });
  });

  it("fixes missing brace before key after [ (live 83dc5910)", () => {
    const raw =
      '{"hunks":[op":"replace","file":"a.ts","search":"x","replace":"y"]}';
    const got = applySoftJsonRepairs(raw);
    const parsed = JSON.parse(got);
    assert.equal(parsed.hunks[0].op, "replace");
    assert.equal(parsed.hunks[0].file, "a.ts");
  });

  it("smart quotes", () => {
    const got = applySoftJsonRepairs('{“a”: “b”}');
    assert.deepEqual(JSON.parse(got), { a: "b" });
  });
});

describe("tryParseWithSoftRepairs / parseAgentJson integration", () => {
  it("parses fence + bare-key worker blob", () => {
    const raw =
      '```json\n{"hunks":[op":"replace","file":"a.ts","search":"x","replace":"y"]}\n```';
    const v = tryParseWithSoftRepairs(raw);
    assert.ok(v);
    assert.equal((v as { hunks: unknown[] }).hunks.length, 1);
  });

  it("extractJsonCandidate soft-repairs missing brace", () => {
    const raw =
      '{"hunks":[op":"replace","file":"a.ts","search":"x","replace":"y"]}';
    const c = extractJsonCandidate(raw);
    assert.ok(c);
    assert.equal(c!.tier, "soft-repaired");
    const env = parseJsonEnvelope(raw);
    assert.equal(env.ok, true);
  });

  it("parseJsonEnvelope accepts unclosed fence", () => {
    const raw =
      '```json\n{"hunks":[{"op":"replace","file":"a.ts","search":"x","replace":"y"}]}';
    const env = parseJsonEnvelope(raw);
    assert.equal(env.ok, true);
  });
});
