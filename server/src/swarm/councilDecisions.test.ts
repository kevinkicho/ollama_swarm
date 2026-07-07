import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dirname, "councilDecisions.ts"), "utf8");

test("councilDecisions — uses listRepoFiles for path grounding", () => {
  assert.doesNotMatch(SRC, /listSourceFiles/, "must not use ts/js-only listSourceFiles");
  assert.match(SRC, /listRepoFiles/, "must use full repo file listing");
});

test("councilDecisions — contract-aware dedup guard", () => {
  assert.match(SRC, /filesGuardedByUnmetCriteria/, "must guard dedup when unmet criteria reference files");
  assert.match(SRC, /contract\?: ExitContract/, "must accept optional contract parameter");
});

test("councilDecisions — path grounding warns instead of drops", () => {
  assert.match(SRC, /\[path grounding\] Warned on/, "must log warnings not drops for suspicious paths");
});