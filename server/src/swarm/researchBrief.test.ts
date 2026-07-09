import { test } from "node:test";
import assert from "node:assert/strict";
import { isUsableResearchBrief } from "./researchBrief.js";

test("isUsableResearchBrief rejects intent-only stubs", () => {
  const stub =
    "I'll start by exploring the repository structure and then search external references. Let me gather the necessary information.";
  assert.equal(isUsableResearchBrief(stub), false);
});

test("isUsableResearchBrief accepts bullet findings with URLs", () => {
  const brief = [
    "- Project docs: https://example.com/docs/architecture",
    "- Reference implementation: https://example.org/repo/readme",
    "- Issue tracker context: https://example.net/issues/42",
  ].join("\n");
  assert.equal(isUsableResearchBrief(brief), true);
});

test("isUsableResearchBrief strips think tags before judging", () => {
  const raw = `<think>planning</think>
- API overview: https://api.example.com/v1
- Auth guide: https://docs.example.com/auth`;
  assert.equal(isUsableResearchBrief(raw), true);
});