/**
 * Regression: cycle-1 must not write deliverable / wrap-up before drainTodos.
 * Live run 36632e9e burned ~2h on wrap-up tool thrash with 6 todos never executed.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dirname, "councilRunCycle.ts"), "utf8");

describe("councilRunCycle ordering (36632e9e regression)", () => {
  it("does not import writeCouncilDeliverable or maybeRunWrapUpApply", () => {
    assert.doesNotMatch(SRC, /writeCouncilDeliverable/);
    assert.doesNotMatch(SRC, /maybeRunWrapUpApply/);
    assert.doesNotMatch(SRC, /from "\.\/councilDeliverable\.js"/);
    assert.doesNotMatch(SRC, /from "\.\/wrapUpApplyPhase\.js"/);
  });

  it("documents end-of-run deliverable ownership", () => {
    assert.match(SRC, /End-of-run closeout in CouncilRunner/);
    assert.match(SRC, /drainTodos/);
  });
});
