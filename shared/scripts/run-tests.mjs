#!/usr/bin/env node
// Cross-platform test runner for the shared workspace.
// Mirrors server/scripts/run-tests.mjs: explicit file list + CI flags so
// GitHub Actions doesn't hang on leaked timers/handles after the last PASS.

import { spawnSync } from "node:child_process";

const TEST_FILES = [
  "src/applyIntegrityReport.test.ts",
  "src/cycleIntegrityReport.test.ts",
  "src/brainAlias.test.ts",
  "src/drainEligibility.test.ts",
  "src/explorationCache.test.ts",
  "src/extractJson.test.ts",
  "src/extractThinkTags.test.ts",
  "src/extractToolCallMarkers.test.ts",
  "src/modelConfig.test.ts",
  "src/panelConvention.test.ts",
  "src/parseAgentJson.test.ts",
  "src/parseThinkingDisplay.test.ts",
  "src/plannerBriefParse.test.ts",
  "src/planningSeed.test.ts",
  "src/providers.test.ts",
  "src/replanPolicy.test.ts",
  "src/streamThinkGuard.test.ts",
  "src/stripAgentText.test.ts",
  "src/summarizeAgentJson.test.ts",
  "src/thinkGuardBudget.test.ts",
  "src/thinkGuardErrors.test.ts",
  "src/thinkGuardReferee.test.ts",
  "src/toolLoopStuck.test.ts",
  "src/toolProfiles.test.ts",
  "src/topology.test.ts",
  "src/workerHunks.test.ts",
  "src/wsProtocol.test.ts",
  "src/swarmControl/controlAdvice.test.ts",
  "src/swarmControl/replannerSkipGrounding.test.ts",
  "src/swarmControl/stallRules.test.ts",
];

const extraArgs = process.argv.slice(2);

// CI bypass: disable per-test-file process isolation (slow on shared runners).
// --test-force-exit: leaked timers/servers keep the loop alive after the last
// assertion when all files share one process — server run-tests.mjs documents
// the same hang on CI run #25113724147.
const ciFlags =
  process.env.CI === "true" ? ["--test-isolation=none", "--test-force-exit"] : [];

const r = spawnSync(
  process.execPath,
  ["--import", "tsx", "--test", ...ciFlags, ...extraArgs, ...TEST_FILES],
  { stdio: "inherit", env: process.env },
);
process.exit(r.status ?? 1);