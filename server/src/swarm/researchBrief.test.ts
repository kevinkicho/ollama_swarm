import { test } from "node:test";
import assert from "node:assert/strict";
import { isUsableResearchBrief, looksLikeWorkerJsonHunks } from "./researchBrief.js";

test("looksLikeWorkerJsonHunks — detects hunk arrays", () => {
  const json = '[{"op":"create","file":"x.ts","content":"y"}]';
  assert.equal(looksLikeWorkerJsonHunks(json), true);
  assert.equal(isUsableResearchBrief(json), false);
});

test("isUsableResearchBrief — accepts prose with URLs", () => {
  const prose = [
    "- Finding one https://example.com/a with extra context",
    "- Finding two https://example.com/b with more detail",
    "- Finding three https://example.com/c closing out the brief",
  ].join("\n");
  assert.equal(isUsableResearchBrief(prose), true);
});