import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  appendExplorationCache,
  buildExplorationCacheBlock,
  captureExplorationExcerpt,
  shouldSkipTodosExplore,
} from "./explorationCache.js";

describe("explorationCache", () => {
  it("truncates long excerpts", () => {
    const long = "x".repeat(20_000);
    assert.equal(captureExplorationExcerpt(long).length, 12_000);
  });

  it("replaces same-phase entries", () => {
    const cache = appendExplorationCache(undefined, {
      phase: "contract-explore",
      excerpt: "first",
    });
    const updated = appendExplorationCache(cache, {
      phase: "contract-explore",
      excerpt: "second",
    });
    assert.equal(updated.length, 1);
    assert.equal(updated[0]!.excerpt, "second");
  });

  it("buildExplorationCacheBlock renders entries", () => {
    const block = buildExplorationCacheBlock([
      { phase: "contract-explore", excerpt: "found routes in server/routes", capturedAt: 1 },
    ]);
    assert.match(block, /PRIOR EXPLORE BRIEF/);
    assert.match(block, /found routes/);
  });

  it("shouldSkipTodosExplore when contract brief exists", () => {
    assert.equal(shouldSkipTodosExplore(undefined), false);
    assert.equal(
      shouldSkipTodosExplore([
        { phase: "contract-explore", excerpt: "brief", capturedAt: 1 },
      ]),
      true,
    );
  });
});