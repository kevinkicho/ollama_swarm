// T2.2 (2026-05-04): assertion-based test that confirms each opt-in
// runner imports + invokes the shared maybeRunWrapUpApply helper. Runs
// against the source text — keeps the wiring presence checked without
// needing a full runner integration harness.
//
// SCOPE — these 6 runners must wire it (per the brainstorm):
//   council, moa, map-reduce, ow (flat), ow-deep, round-robin
//   (both variants — plain + role-diff branches)
//
// EXPLICITLY OUT OF SCOPE (must NOT have the wiring):
//   blackboard (already write-capable natively), baseline (already
//   does single-shot apply natively), debate-judge (has its own
//   implementer/reviewer/signoff phase), stigmergy (exploration is
//   repo-driven, not action-driven).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadSrc(file: string): string {
  return readFileSync(join(__dirname, file), "utf8");
}

const OPT_IN_RUNNERS: ReadonlyArray<{ file: string; presetName: string; minWiringSites: number }> = [
  { file: "CouncilRunner.ts", presetName: "council", minWiringSites: 1 },
  { file: "MoaRunner.ts", presetName: "moa", minWiringSites: 1 },
  { file: "MapReduceRunner.ts", presetName: "map-reduce", minWiringSites: 1 },
  { file: "OrchestratorWorkerRunner.ts", presetName: "orchestrator-worker", minWiringSites: 1 },
  {
    file: "OrchestratorWorkerDeepRunner.ts",
    presetName: "orchestrator-worker-deep",
    minWiringSites: 1,
  },
  // RoundRobinRunner has TWO wiring sites — plain round-robin + role-diff.
  { file: "RoundRobinRunner.ts", presetName: "round-robin", minWiringSites: 1 },
  { file: "RoundRobinRunner.ts", presetName: "role-diff", minWiringSites: 1 },
];

const OUT_OF_SCOPE_RUNNERS: ReadonlyArray<string> = [
  "blackboard/BlackboardRunner.ts",
  "BaselineRunner.ts",
  "DebateJudgeRunner.ts",
  "StigmergyRunner.ts",
];

describe("(T2.2) maybeRunWrapUpApply — opt-in runners must wire the helper", () => {
  for (const runner of OPT_IN_RUNNERS) {
    test(`${runner.file} imports maybeRunWrapUpApply`, () => {
      const src = loadSrc(runner.file);
      assert.match(
        src,
        /from "\.\/wrapUpApplyPhase\.js"/,
        `${runner.file} must import from ./wrapUpApplyPhase.js`,
      );
      assert.match(
        src,
        /maybeRunWrapUpApply/,
        `${runner.file} must reference maybeRunWrapUpApply`,
      );
    });

    test(`${runner.file} passes presetName: "${runner.presetName}" to maybeRunWrapUpApply`, () => {
      const src = loadSrc(runner.file);
      // Match: maybeRunWrapUpApply({\s*[whatever fields, including presetName: "X"]\s*})
      const pattern = new RegExp(
        `maybeRunWrapUpApply\\([\\s\\S]{0,500}presetName:\\s*"${runner.presetName.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}"`,
      );
      assert.match(
        src,
        pattern,
        `${runner.file} must call maybeRunWrapUpApply with presetName: "${runner.presetName}"`,
      );
    });
  }
});

describe("(T2.2) maybeRunWrapUpApply — out-of-scope runners must NOT wire the helper", () => {
  for (const file of OUT_OF_SCOPE_RUNNERS) {
    test(`${file} does NOT import maybeRunWrapUpApply`, () => {
      const src = loadSrc(file);
      assert.doesNotMatch(
        src,
        /maybeRunWrapUpApply/,
        `${file} must NOT reference maybeRunWrapUpApply (would compete with the runner's native write path)`,
      );
    });
  }
});

describe("(T2.2) RunConfig.executeNextAction docstring covers all-presets semantics", () => {
  const src = loadSrc("SwarmRunner.ts");
  test("docstring mentions T2.2 + the all-other-presets semantic", () => {
    assert.match(src, /T2\.2/, "docstring should reference T2.2 task");
    assert.match(
      src,
      /All other discussion presets/i,
      "docstring should describe the all-presets behavior",
    );
  });
});
