#!/usr/bin/env node
// Cross-platform test runner. The previous npm script was
// `OPENCODE_SERVER_PASSWORD=test-only node --import tsx --test <files...>`
// which is bash-only — Windows cmd.exe parses the leading `VAR=value`
// as a literal command name and errors with "is not recognized".
// This wrapper sets the env var on the spawned child regardless of
// shell + carries the test-file list as a single source of truth.

import { spawnSync } from "node:child_process";

// Ensure config.ts's zod schema accepts our test-only env without
// a real .env file. Caller-supplied value wins so a real run with
// the actual password still works.
const env = {
  ...process.env,
  OPENCODE_SERVER_PASSWORD:
    process.env.OPENCODE_SERVER_PASSWORD && process.env.OPENCODE_SERVER_PASSWORD.length > 0
      ? process.env.OPENCODE_SERVER_PASSWORD
      : "test-only",
};

const TEST_FILES = [
  // blackboard/
  "src/swarm/blackboard/prompts/planner.test.ts",
  "src/swarm/blackboard/prompts/worker.test.ts",
  "src/swarm/blackboard/prompts/replanner.test.ts",
  "src/swarm/blackboard/prompts/firstPassContract.test.ts",
  "src/swarm/blackboard/prompts/auditor.test.ts",
  "src/swarm/blackboard/prompts/critic.test.ts",
  "src/swarm/blackboard/prompts/verifier.test.ts",
  "src/swarm/blackboard/prompts/pathValidation.test.ts",
  "src/swarm/blackboard/writeFileAtomic.test.ts",
  "src/swarm/blackboard/diffValidation.test.ts",
  "src/swarm/blackboard/resolveSafe.test.ts",
  "src/swarm/blackboard/caps.test.ts",
  "src/swarm/blackboard/crashSnapshot.test.ts",
  "src/swarm/blackboard/stateSnapshot.test.ts",
  "src/swarm/blackboard/summary.test.ts",
  "src/swarm/blackboard/finalAudit.test.ts",
  "src/swarm/blackboard/retry.test.ts",
  "src/swarm/blackboard/applyHunks.test.ts",
  "src/swarm/blackboard/applyHunksPipeline.test.ts",
  "src/swarm/blackboard/windowFile.test.ts",
  "src/swarm/blackboard/transcriptSummary.test.ts",
  "src/swarm/blackboard/workerRoles.test.ts",
  "src/swarm/blackboard/memoryStore.test.ts",
  "src/swarm/blackboard/RunStateObserver.test.ts",
  "src/swarm/blackboard/TodoQueue.test.ts",
  "src/swarm/blackboard/WorkerPipeline.test.ts",
  "src/swarm/blackboard/v2Adapters.test.ts",
  "src/swarm/blackboard/EventLogReaderV2.test.ts",
  "src/swarm/blackboard/v2Integration.test.ts",
  "src/swarm/blackboard/formatServerSummary.test.ts",
  "src/swarm/blackboard/FindingsLog.test.ts",
  "src/swarm/blackboard/boardBroadcaster.test.ts",
  "src/swarm/blackboard/boardWireCompat.test.ts",
  "src/swarm/blackboard/todoQueueWrappers.test.ts",

  // swarm/ (non-blackboard)
  "src/swarm/roles.test.ts",
  "src/swarm/CouncilRunner.test.ts",
  "src/swarm/OrchestratorWorkerRunner.test.ts",
  "src/swarm/OrchestratorWorkerDeepRunner.test.ts",
  "src/swarm/DebateJudgeRunner.test.ts",
  "src/swarm/MapReduceRunner.test.ts",
  "src/swarm/StigmergyRunner.test.ts",
  "src/swarm/extractText.test.ts",
  "src/swarm/runEndReflection.test.ts",
  "src/swarm/staggerStart.test.ts",
  "src/swarm/sseAwareTurnWatchdog.test.ts",
  "src/swarm/promptWithRetry.test.ts",
  "src/swarm/runStateMachine.test.ts",
  "src/swarm/agentStatsCollector.test.ts",
  "src/swarm/runSummary.test.ts",

  // routes/
  "src/routes/swarm.test.ts",
  "src/routes/v2.test.ts",

  // shared/
  "../shared/src/extractThinkTags.test.ts",
  "../shared/src/extractToolCallMarkers.test.ts",
  "../shared/src/subtaskPart.test.ts",
  "src/swarm/blackboard/buildCommandAllowlist.test.ts",

  // services/
  "src/services/ollamaProxy.test.ts",
  "src/services/OllamaClient.test.ts",
  "src/services/RepoService.test.ts",
  "src/services/pathNormalize.test.ts",
  "src/services/treeKill.test.ts",
  "src/services/treeKillExtras.test.ts",
  "src/services/agentPids.test.ts",
  "src/services/reclaimOrphans.test.ts",
  "src/services/warmup.test.ts",
  "src/services/Orchestrator.test.ts",
];

// Forward CLI args so callers can pass --test-name-pattern etc:
//   node scripts/run-tests.mjs --test-name-pattern=foo
const extraArgs = process.argv.slice(2);

const r = spawnSync(
  process.execPath,
  ["--import", "tsx", "--test", ...extraArgs, ...TEST_FILES],
  { stdio: "inherit", env },
);
process.exit(r.status ?? 1);
