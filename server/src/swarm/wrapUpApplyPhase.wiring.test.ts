// T2.2 (2026-05-04): assertion-based test that confirms each opt-in
// runner imports + invokes the shared maybeRunWrapUpApply helper. Runs
// against the source text — keeps the wiring presence checked without
// needing a full runner integration harness.
//
// SCOPE — these 7 runners must wire it (per the brainstorm + T176):
//   council, moa, map-reduce, ow (flat), ow-deep, round-robin
//   (both variants — plain + role-diff branches), debate-judge
//
// 2026-05-04 (T176): debate-judge added. Its legacy implementer/
// reviewer/signoff phase runs under `swarm` profile (denies all
// tools — prose only); the canonical wrap-up apply phase actually
// commits + supports verifyCommand gating.
//
// EXPLICITLY OUT OF SCOPE (must NOT have the wiring):
//   blackboard (already write-capable natively), baseline (already
//   does single-shot apply natively), stigmergy (exploration is
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

const OPT_IN_RUNNERS: ReadonlyArray<{ files: string[]; presetName: string; minWiringSites: number }> = [
  { files: ["CouncilRunner.ts", "councilDeliverable.ts"], presetName: "council", minWiringSites: 1 },
  { files: ["MoaRunner.ts", "moaDeliverableWriter.ts"], presetName: "moa", minWiringSites: 1 },
  { files: ["MapReduceRunner.ts", "mapReduceDeliverableWriter.ts"], presetName: "map-reduce", minWiringSites: 1 },
  { files: ["OrchestratorWorkerRunner.ts"], presetName: "orchestrator-worker", minWiringSites: 1 },
  {
    files: ["OrchestratorWorkerDeepRunner.ts"],
    presetName: "orchestrator-worker-deep",
    minWiringSites: 1,
  },
  // RoundRobinRunner has TWO wiring sites — plain round-robin + role-diff.
  { files: ["RoundRobinRunner.ts"], presetName: "round-robin", minWiringSites: 1 },
  { files: ["RoundRobinRunner.ts"], presetName: "role-diff", minWiringSites: 1 },
  // T176: debate-judge added 2026-05-04 alongside its legacy
  // implementer/reviewer/signoff phase (which is prose-only).
  { files: ["DebateJudgeRunner.ts", "debateDeliverableWriter.ts"], presetName: "debate-judge", minWiringSites: 1 },
];

const OUT_OF_SCOPE_RUNNERS: ReadonlyArray<string> = [
  "blackboard/BlackboardRunner.ts",
  "BaselineRunner.ts",
  "StigmergyRunner.ts",
];

describe("(T2.2) maybeRunWrapUpApply — opt-in runners must wire the helper", () => {
  for (const runner of OPT_IN_RUNNERS) {
    const allSrc = runner.files.map((f) => loadSrc(f)).join("\n\n");
    test(`${runner.files.join(", ")} imports maybeRunWrapUpApply`, () => {
      assert.match(
        allSrc,
        /from "\.\/wrapUpApplyPhase\.js"/,
        `${runner.files.join(", ")} must import from ./wrapUpApplyPhase.js`,
      );
      assert.match(
        allSrc,
        /maybeRunWrapUpApply/,
        `${runner.files.join(", ")} must reference maybeRunWrapUpApply`,
      );
    });

    test(`${runner.files.join(", ")} passes presetName: "${runner.presetName}" to maybeRunWrapUpApply`, () => {
      const pattern = new RegExp(
        `maybeRunWrapUpApply\\([\\s\\S]{0,500}presetName:\\s*"${runner.presetName.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}"`,
      );
      assert.match(
        allSrc,
        pattern,
        `${runner.files.join(", ")} must call maybeRunWrapUpApply with presetName: "${runner.presetName}"`,
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
  const src = loadSrc("RunConfig.ts");
  test("docstring mentions T2.2 + the all-other-presets semantic", () => {
    assert.match(src, /T2\.2/, "docstring should reference T2.2 task");
    assert.match(
      src,
      /All other discussion presets/i,
      "docstring should describe the all-presets behavior",
    );
  });
});
