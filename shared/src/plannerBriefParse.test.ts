import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parsePlannerBrief, plannerBriefSectionCount } from "./plannerBriefParse.js";

describe("parsePlannerBrief", () => {
  it("splits lead-in, title, and H3 sections", () => {
    const text = [
      "Now I have a thorough understanding of the repo. Let me compile the research brief.",
      "",
      "---",
      "",
      "## Research Brief: Government Data Sources",
      "",
      "### 1. Repository Overview",
      "The repo is a React + Vite dashboard.",
      "",
      "### 2. Data Endpoints",
      "- FRED",
      "- World Bank",
    ].join("\n");

    const parsed = parsePlannerBrief(text);
    assert.match(parsed.leadIn, /thorough understanding/);
    assert.equal(parsed.title, "Research Brief: Government Data Sources");
    assert.equal(parsed.sections.length, 2);
    assert.equal(parsed.sections[0]?.title, "1. Repository Overview");
    assert.match(parsed.sections[0]?.body ?? "", /React \+ Vite/);
    assert.equal(parsed.sections[1]?.title, "2. Data Endpoints");
  });

  it("returns empty sections for blank input", () => {
    assert.deepEqual(parsePlannerBrief(""), {
      leadIn: "",
      title: null,
      sections: [],
    });
  });

  it("counts sections for meta tagging", () => {
    const n = plannerBriefSectionCount("## Title\n\n### A\nx\n### B\ny");
    assert.equal(n, 2);
  });
});