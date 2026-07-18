import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseDeliberateEnvelopes } from "./deliberateParse";

describe("parseDeliberateEnvelopes", () => {
  it("parses a closed deliberate fence (2010479c shape)", () => {
    const text = [
      "```deliberate",
      "subject: Agent 1's issue report",
      "claim: src/hub/DataProvider.jsx is truncated",
      "stance: validate",
      "why: Confirmed by reading the file",
      "evidence: src/hub/DataProvider.jsx",
      "to: agent-1",
      "```",
    ].join("\n");
    const envs = parseDeliberateEnvelopes(text);
    assert.equal(envs.length, 1);
    assert.equal(envs[0]!.stance, "validate");
    assert.equal(envs[0]!.to, "agent-1");
    assert.ok(envs[0]!.evidence.includes("src/hub/DataProvider.jsx"));
  });

  it("parses unclosed fence salvage", () => {
    const text =
      "```deliberate\nsubject: x\nclaim: y\nstance: approve\nwhy: z\nevidence: a.ts";
    const envs = parseDeliberateEnvelopes(text);
    assert.equal(envs.length, 1);
    assert.equal(envs[0]!.stance, "approve");
  });
});
