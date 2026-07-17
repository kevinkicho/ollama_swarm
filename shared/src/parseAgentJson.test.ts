import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractJsonCandidate,
  isPureThinkNoJson,
  parseJsonEnvelope,
} from "./parseAgentJson.js";

describe("extractJsonCandidate", () => {
  it("returns direct tier for bare JSON", () => {
    const r = extractJsonCandidate('{"a":1}');
    assert.ok(r);
    assert.equal(r!.tier, "direct");
    assert.equal(r!.json, '{"a":1}');
  });

  it("extracts JSON after think block", () => {
    const r = extractJsonCandidate(
      '<think>plan</think>\n{"missionStatement":"m","criteria":[]}',
    );
    assert.ok(r);
    assert.match(r!.json, /missionStatement/);
    assert.ok(r!.tier === "normalized" || r!.tier === "extracted");
  });

  it("extracts JSON after XML pseudo-tool calls", () => {
    const r = extractJsonCandidate(
      "<read path='src/foo.ts' />\n[{\"description\":\"x\",\"expectedFiles\":[\"a.js\"]}]",
    );
    assert.ok(r);
    assert.match(r!.json, /description/);
  });

  it("returns null for prose only", () => {
    assert.equal(extractJsonCandidate("just thinking about the repo"), null);
  });
});

describe("parseJsonEnvelope", () => {
  it("parses array after think prefix", () => {
    const r = parseJsonEnvelope(
      '<think>todo list</think>\n[{"description":"fix","expectedFiles":["a.ts"]}]',
    );
    assert.equal(r.ok, true);
    if (r.ok) assert.ok(Array.isArray(r.value));
  });

  it("labels pure <think> as format/provider failure (2964afe8)", () => {
    const raw =
      "<think>We need to implement the FAO route carefully with all edge cases…";
    assert.equal(isPureThinkNoJson(raw), true);
    const r = parseJsonEnvelope(raw);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.reason, /format\/provider/i);
      assert.match(r.reason, /failover candidate/i);
    }
  });

  it("does not flag think+JSON as pure think", () => {
    const raw = '<think>plan</think>\n{"hunks":[]}';
    assert.equal(isPureThinkNoJson(raw), false);
    const r = parseJsonEnvelope(raw);
    assert.equal(r.ok, true);
  });
});
