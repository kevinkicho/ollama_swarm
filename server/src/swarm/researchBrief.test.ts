import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractHttpsUrls,
  isUsableResearchBrief,
  looksLikeWorkerJsonHunks,
} from "./researchBrief.js";

test("looksLikeWorkerJsonHunks — detects hunk arrays", () => {
  const json = '[{"op":"create","file":"x.ts","content":"y"}]';
  assert.equal(looksLikeWorkerJsonHunks(json), true);
  assert.equal(isUsableResearchBrief(json), false);
});

test("isUsableResearchBrief — accepts prose with real URLs or multi-bullet depth", () => {
  const prose = [
    "- Finding one https://stats.bis.org/api with extra context about the portal",
    "- Finding two https://api.stlouisfed.org/fred with more detail for series",
    "- Finding three https://www.imf.org/en/Data closing out the brief body",
  ].join("\n");
  assert.equal(isUsableResearchBrief(prose), true);
});

test("isUsableResearchBrief — toolTraceUrls require intersection (RR-C D6)", () => {
  const brief = [
    "- Official docs at https://api.stlouisfed.org/fred/series",
    "- Also see https://invented-citation.invalid/nope for fluff padding",
  ].join("\n");
  const withTools = isUsableResearchBrief(brief, [
    "https://api.stlouisfed.org/fred/docs",
  ]);
  assert.equal(withTools, true, "host-level match with tool results");
  const noIntersect = isUsableResearchBrief(
    "- Hallucinated https://totally-fake-research.invalid/paper with padding text\n- More words to clear length floor for heuristics only",
    ["https://api.stlouisfed.org/fred"],
  );
  assert.equal(noIntersect, false, "must reject when no URL host matches tools");
});

test("extractHttpsUrls drops placeholder hosts", () => {
  const urls = extractHttpsUrls(
    "see https://example.com/a and https://fred.stlouisfed.org/docs",
  );
  assert.deepEqual(urls, ["https://fred.stlouisfed.org/docs"]);
});
