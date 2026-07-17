import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isLiteratureTodo } from "./worker.js";

describe("isLiteratureTodo — eee6718f false-positive fix", () => {
  it("does NOT match panel/API todos that merely say source or paper", () => {
    assert.equal(
      isLiteratureTodo(
        "Create GovernmentDataSourcesDashboardPanel.jsx — fetches government data source health",
      ),
      false,
    );
    assert.equal(
      isLiteratureTodo(
        "server/routes/fred.js: add a 'COMMERCIAL_PAPER' group to SERIES_REGISTRY",
      ),
      false,
    );
    assert.equal(
      isLiteratureTodo(
        "panelRegistry.js: register entries with source: worldbank for gini index",
      ),
      false,
    );
    assert.equal(
      isLiteratureTodo("FredCommercialPaperRatesPanel.jsx: create panel component"),
      false,
    );
  });

  it("matches explicit research / literature todos", () => {
    assert.equal(isLiteratureTodo("literature review of BIS statistics APIs"), true);
    assert.equal(isLiteratureTodo("Research official OECD house price endpoints"), true);
    assert.equal(isLiteratureTodo("web research for FRED commercial paper series"), true);
    assert.equal(isLiteratureTodo("survey papers on SDMX and cite arxiv sources"), true);
  });

  it("matches find/look-up/gather papers phrasing", () => {
    assert.equal(isLiteratureTodo("Find papers on SDMX metadata conventions"), true);
    assert.equal(isLiteratureTodo("Look up literature on central bank digital currencies"), true);
    assert.equal(isLiteratureTodo("Gather sources and cite papers for the IMF CPIS API"), true);
    assert.equal(isLiteratureTodo("Do a literature review of peer-reviewed panel methods"), true);
  });

  it("does not match bare arxiv/citation without research intent", () => {
    // Product / path names should stay false
    assert.equal(isLiteratureTodo("ResearchDashboardPanel.jsx: fix layout"), false);
  });
});
