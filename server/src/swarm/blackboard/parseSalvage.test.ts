import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildParseSalvagePrompt, PARSE_SALVAGE_PROFILE } from "./parseSalvage.js";

const PARSE_SALVAGE_SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "parseSalvage.ts"),
  "utf8",
);

describe("buildParseSalvagePrompt", () => {
  it("asks for JSON extraction not prose diagnosis", () => {
    const p = buildParseSalvagePrompt({
      kind: "contract",
      parseError: "JSON parse failed",
      rawOutput: "<think>x</think>\n<read path='a.ts' />",
    });
    assert.match(p, /EXTRACT or RECONSTRUCT/);
    assert.doesNotMatch(p, /diagnose WHY/i);
    assert.match(p, /missionStatement/);
  });

  it("uses tool-free swarm profile for emit-only salvage", () => {
    assert.equal(PARSE_SALVAGE_PROFILE, "swarm");
    assert.doesNotMatch(PARSE_SALVAGE_SRC, /resolveToolProfile/);
  });

  it("strips thinking from snippet", () => {
    const p = buildParseSalvagePrompt({
      kind: "planner-todos",
      parseError: "fail",
      rawOutput: "<think>secret</think>[{\"description\":\"d\",\"expectedFiles\":[\"a.js\"]}]",
    });
    assert.doesNotMatch(p, /secret/);
    assert.match(p, /description/);
  });

  it("includes replanner schema for replanner salvage", () => {
    const p = buildParseSalvagePrompt({
      kind: "replanner",
      parseError: "expected object",
      rawOutput: '{"revised":{"description":"x","expectedFiles":["a.ts"]}}',
    });
    assert.match(p, /revised/);
    assert.match(p, /EXTRACT or RECONSTRUCT/);
  });

  it("includes hunk-review schema for gate salvage", () => {
    const p = buildParseSalvagePrompt({
      kind: "hunk-review",
      parseError: "approve must be boolean",
      rawOutput: '{"approve":true,"reason":"looks good"}',
    });
    assert.match(p, /approve/);
  });

  it("includes auditor verdict schema for tier-up salvage", () => {
    const p = buildParseSalvagePrompt({
      kind: "auditor",
      parseError: "JSON parse failed",
      rawOutput: '{"verdicts":[{"id":"c1","status":"unmet","rationale":"x"}]}',
    });
    assert.match(p, /verdicts/);
  });
});