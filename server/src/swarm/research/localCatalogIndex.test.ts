import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  buildLocalCatalogIndex,
  clearLocalCatalogCache,
  localCatalogNotesOnResearchFail,
  lookupLocalCatalog,
  splitMarkdownSections,
  textHasWholeTerm,
} from "./localCatalogIndex.js";

const FRED_SECTION = `
## FRED (Federal Reserve Economic Data)

- Base URL: https://api.stlouisfed.org/fred
- Series endpoint: https://api.stlouisfed.org/fred/series/observations
- Proxy route: /api/fred
- Env: FRED_API_KEY
- Panel: FredCommercialPaperRatesPanel
`.trim();

const BIS_SECTION = `
## BIS (Bank for International Settlements)

- Stats portal: https://stats.bis.org
- SDMX API docs: https://stats.bis.org/api-doc
- Route: functions/src/routes/bis.js
- Panel: BisCreditPanel
`.trim();

const OECD_SECTION = `
## OECD

- Data: https://stats.oecd.org
- API: https://data-explorer.oecd.org
`.trim();

const API_ENDPOINTS_MD = `
# API Endpoints

${FRED_SECTION}

${BIS_SECTION}

${OECD_SECTION}
`.trim();

const GOV_CATALOG_MD = `
# Government API Catalog

## IMF

- https://www.imf.org/en/Data
- SDMX: https://sdmxcentral.imf.org

## FRED notes

Commercial paper and rates series live on FRED (https://fred.stlouisfed.org).
`.trim();

const PANELS_MD = `
# Panels

## FredCommercialPaperRatesPanel

Uses FRED commercial paper series via /api/fred.

## BisCreditPanel

BIS credit statistics panel; data from stats.bis.org.
`.trim();

describe("splitMarkdownSections", () => {
  it("splits ATX headings", () => {
    const sections = splitMarkdownSections("# A\nbody a\n## B\nbody b");
    assert.equal(sections.length, 2);
    assert.equal(sections[0]!.heading, "A");
    assert.match(sections[1]!.body, /body b/);
  });
});

describe("localCatalogIndex", () => {
  let dir: string;

  beforeEach(async () => {
    clearLocalCatalogCache();
    dir = await mkdtemp(path.join(os.tmpdir(), "local-catalog-"));
    await mkdir(path.join(dir, "docs"), { recursive: true });
    await writeFile(path.join(dir, "docs", "API_ENDPOINTS.md"), API_ENDPOINTS_MD, "utf8");
    await writeFile(path.join(dir, "GOVERNMENT_API_CATALOG.md"), GOV_CATALOG_MD, "utf8");
    await writeFile(path.join(dir, "docs", "PANELS.md"), PANELS_MD, "utf8");
  });

  afterEach(async () => {
    clearLocalCatalogCache();
    await rm(dir, { recursive: true, force: true });
  });

  it("builds an index from fixture catalog files", () => {
    const snippets = buildLocalCatalogIndex(dir);
    assert.ok(snippets.length >= 3, `expected multiple sections, got ${snippets.length}`);
    assert.ok(snippets.some((s) => /FRED/i.test(s.heading) || /FRED/i.test(s.body)));
    assert.ok(snippets.some((s) => /BIS/i.test(s.heading) || /BIS/i.test(s.body)));
  });

  it("returns FRED snippets for FRED-related todos", () => {
    const out = lookupLocalCatalog(
      "Research official FRED commercial paper series endpoints for FredCommercialPaperRatesPanel",
      4,
      { catalogRoot: dir },
    );
    assert.ok(out.length > 0, "expected non-empty catalog notes");
    assert.match(out, /LOCAL ENDPOINT CATALOG/);
    assert.match(out, /fred\.stlouisfed|api\.stlouisfed|FRED/i);
    assert.match(out, /API_ENDPOINTS|GOVERNMENT_API|PANELS/i);
  });

  it("returns BIS snippets for BIS-related todos", () => {
    const out = lookupLocalCatalog(
      "literature review of BIS statistics APIs and SDMX credit data",
      3,
      { cloneRoot: dir },
    );
    assert.ok(out.length > 0);
    assert.match(out, /bis\.org|stats\.bis|BIS/i);
  });

  it("returns empty string when no catalog docs exist", async () => {
    const empty = await mkdtemp(path.join(os.tmpdir(), "local-catalog-empty-"));
    try {
      clearLocalCatalogCache();
      const out = lookupLocalCatalog("Research FRED endpoints", 4, { catalogRoot: empty });
      assert.equal(out, "");
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it("returns empty string on zero keyword hits", () => {
    const out = lookupLocalCatalog(
      "Refactor pure TypeScript utility for string padding",
      4,
      { catalogRoot: dir },
    );
    assert.equal(out, "");
  });

  it("returns empty without root or description", () => {
    assert.equal(lookupLocalCatalog("FRED", 4, {}), "");
    assert.equal(lookupLocalCatalog("", 4, { catalogRoot: dir }), "");
  });

  it("localCatalogNotesOnResearchFail matches lookup helper", () => {
    const a = localCatalogNotesOnResearchFail(
      "web research for FRED commercial paper series",
      dir,
      4,
    );
    const b = lookupLocalCatalog("web research for FRED commercial paper series", 4, {
      cloneRoot: dir,
    });
    assert.equal(a, b);
    assert.match(a, /stlouisfed|FRED/i);
  });

  it("catalogRoot wins over cloneRoot", async () => {
    const other = await mkdtemp(path.join(os.tmpdir(), "local-catalog-other-"));
    try {
      await mkdir(path.join(other, "docs"), { recursive: true });
      await writeFile(
        path.join(other, "docs", "API_ENDPOINTS.md"),
        "## OnlyOECD\n- https://stats.oecd.org/unique-oecd-marker\n",
        "utf8",
      );
      clearLocalCatalogCache();
      const out = lookupLocalCatalog("OECD house price endpoints", 2, {
        cloneRoot: dir,
        catalogRoot: other,
      });
      assert.match(out, /unique-oecd-marker/);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it("does not false-positive Alfred→FRED or business→BIS via substring aliases", () => {
    assert.equal(
      lookupLocalCatalog("Rename AlfredPanel helper in the business layer", 4, {
        catalogRoot: dir,
      }),
      "",
      "must not boost FRED/BIS from mid-word substrings",
    );
  });

  it("textHasWholeTerm rejects mid-word matches", () => {
    assert.equal(textHasWholeTerm("alfred panel", "fred"), false);
    assert.equal(textHasWholeTerm("use FRED series", "fred"), true);
    assert.equal(textHasWholeTerm("business metrics", "bis"), false);
    assert.equal(textHasWholeTerm("BIS credit", "bis"), true);
    assert.equal(textHasWholeTerm("bank for international settlements", "bank for international settlements"), true);
  });

  it("clearLocalCatalogCache drops cached indexes", () => {
    buildLocalCatalogIndex(dir);
    clearLocalCatalogCache();
    // Rebuild after wipe should still work (no throw) and find docs.
    const snippets = buildLocalCatalogIndex(dir);
    assert.ok(snippets.length >= 1);
  });
});
