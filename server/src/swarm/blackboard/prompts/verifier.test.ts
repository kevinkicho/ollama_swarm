import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  VERIFIER_SYSTEM_PROMPT,
  VERIFIER_VERDICTS,
  buildVerifierUserPrompt,
  parseVerifierResponse,
} from "./verifier.js";

describe("parseVerifierResponse — happy paths", () => {
  for (const verdict of VERIFIER_VERDICTS) {
    it(`accepts a well-formed ${verdict} response`, () => {
      const raw = JSON.stringify({
        verdict,
        evidenceCitation: "src/foo.ts:42-58 — relevant range",
      });
      const r = parseVerifierResponse(raw);
      assert.equal(r.ok, true);
      if (r.ok) {
        assert.equal(r.verifier.verdict, verdict);
        assert.equal(r.verifier.evidenceCitation, "src/foo.ts:42-58 — relevant range");
        assert.equal(r.verifier.rationale, undefined);
      }
    });
  }

  it("preserves an optional rationale when present", () => {
    const raw = JSON.stringify({
      verdict: "partial",
      evidenceCitation: "after.ts:10 — added X but missing Y at line 15",
      rationale: "auth header is added but rate-limit guard from todo is absent",
    });
    const r = parseVerifierResponse(raw);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.verifier.verdict, "partial");
      assert.match(r.verifier.rationale ?? "", /rate-limit/);
    }
  });

  it("strips ```json fences before parsing", () => {
    const raw = '```json\n{"verdict": "verified", "evidenceCitation": "ok"}\n```';
    const r = parseVerifierResponse(raw);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.verifier.verdict, "verified");
  });

  it("tolerates prose before the JSON object (slice between first { and last })", () => {
    const raw = 'Here is my verdict:\n{"verdict": "false", "evidenceCitation": "diff renames foo but todo asks for new export"}';
    const r = parseVerifierResponse(raw);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.verifier.verdict, "false");
  });
});

describe("parseVerifierResponse — failure modes", () => {
  it("rejects empty evidenceCitation", () => {
    const raw = JSON.stringify({ verdict: "verified", evidenceCitation: "" });
    const r = parseVerifierResponse(raw);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /evidenceCitation/);
  });

  it("rejects whitespace-only evidenceCitation", () => {
    const raw = JSON.stringify({ verdict: "verified", evidenceCitation: "   " });
    const r = parseVerifierResponse(raw);
    assert.equal(r.ok, false);
  });

  it("rejects an unknown verdict value", () => {
    const raw = JSON.stringify({
      verdict: "yes-please",
      evidenceCitation: "some citation",
    });
    const r = parseVerifierResponse(raw);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /verdict/);
  });

  it("rejects an array top level", () => {
    const r = parseVerifierResponse('[{"verdict":"verified","evidenceCitation":"x"}]');
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /array/);
  });

  it("rejects malformed JSON with a parse-error message", () => {
    const r = parseVerifierResponse("not even json");
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /JSON parse failed/i);
  });

  it("rejects a missing evidenceCitation field", () => {
    const r = parseVerifierResponse(JSON.stringify({ verdict: "verified" }));
    assert.equal(r.ok, false);
  });

  it("rejects when evidenceCitation exceeds the schema length cap", () => {
    const long = "x".repeat(600);
    const r = parseVerifierResponse(
      JSON.stringify({ verdict: "verified", evidenceCitation: long }),
    );
    assert.equal(r.ok, false);
  });
});

describe("VERIFIER_SYSTEM_PROMPT — content invariants", () => {
  it("names every verdict so the model can pick from the union", () => {
    for (const v of VERIFIER_VERDICTS) {
      assert.match(VERIFIER_SYSTEM_PROMPT, new RegExp(`"${v}"`));
    }
  });

  it("requires evidenceCitation for hallucination resistance", () => {
    assert.match(VERIFIER_SYSTEM_PROMPT, /evidenceCitation/);
    // Must spell out the consequence of a missing citation so the model
    // doesn't try to fake one.
    assert.match(VERIFIER_SYSTEM_PROMPT, /unverifiable/);
  });

  it("disclaims overlap with critic + auditor so the model doesn't double up", () => {
    assert.match(VERIFIER_SYSTEM_PROMPT, /not the critic/i);
    assert.match(VERIFIER_SYSTEM_PROMPT, /not the auditor/i);
  });
});

describe("buildVerifierUserPrompt", () => {
  const baseFiles = [
    { file: "src/foo.ts", before: "before body", after: "after body" },
    { file: "src/bar.ts", before: null, after: "new file body" },
  ];

  it("includes the todo description + expected files header", () => {
    const out = buildVerifierUserPrompt({
      proposingAgentId: "agent-2",
      todoDescription: "add a rate-limit guard to /api/login",
      todoExpectedFiles: ["src/foo.ts", "src/bar.ts"],
      files: baseFiles,
    });
    assert.match(out, /agent-2/);
    assert.match(out, /add a rate-limit guard/);
    assert.match(out, /src\/foo\.ts, src\/bar\.ts/);
  });

  it("renders before/after blocks, marking newly created files explicitly", () => {
    const out = buildVerifierUserPrompt({
      proposingAgentId: "agent-2",
      todoDescription: "x",
      todoExpectedFiles: [],
      files: baseFiles,
    });
    assert.match(out, /BEFORE:\s*\nbefore body/);
    assert.match(out, /AFTER:\s*\nafter body/);
    assert.match(out, /\(file did not exist before\)/);
  });
});
