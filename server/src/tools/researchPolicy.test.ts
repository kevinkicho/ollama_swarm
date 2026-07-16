import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  looksLikeLocalRepoPath,
  preflightResearchTool,
  preflightWebFetch,
  preflightWebSearch,
} from "./researchPolicy.js";

describe("looksLikeLocalRepoPath", () => {
  it("detects repo-relative paths", () => {
    assert.equal(looksLikeLocalRepoPath("src/data/panelRegistry.js"), true);
    assert.equal(looksLikeLocalRepoPath("C:\\Users\\kevin\\repo\\a.ts"), true);
    assert.equal(looksLikeLocalRepoPath("https://stats.bis.org/api"), false);
  });
});

describe("preflightWebFetch", () => {
  it("blocks placeholder github raw URLs", () => {
    const r = preflightWebFetch({
      url: "https://raw.githubusercontent.com/your-org/your-repo/main/src/data/panelRegistry.js",
    });
    assert.ok(r && !r.ok);
    assert.match(r!.error, /placeholder|local/i);
  });

  it("blocks file:// and bare local paths", () => {
    assert.ok(preflightWebFetch({ url: "file:///src/data/panelRegistry.js" }) && !preflightWebFetch({ url: "file:///x" })!.ok);
    const local = preflightWebFetch({ url: "src/data/panelRegistry.js" });
    assert.ok(local && !local.ok);
    assert.match(local!.error, /read/i);
  });

  it("allows real https URLs", () => {
    assert.equal(preflightWebFetch({ url: "https://stats.bis.org/api/v2" }), null);
  });
});

describe("preflightWebSearch", () => {
  it("blocks placeholder github searches", () => {
    const r = preflightWebSearch({
      query: "panelRegistry.js site:github.com your-org your-repo",
    });
    assert.ok(r && !r.ok);
  });

  it("allows normal research queries", () => {
    assert.equal(preflightWebSearch({ query: "BIS SDMX API documentation site:bis.org" }), null);
  });
});

describe("preflightResearchTool", () => {
  it("routes by tool name", () => {
    assert.ok(preflightResearchTool("web_fetch", { url: "src/x.js" }));
    assert.equal(preflightResearchTool("read", { path: "src/x.js" }), null);
  });
});
