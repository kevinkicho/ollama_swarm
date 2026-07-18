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
  "src/swarm/blackboard/prompts/jsonSchemas.test.ts",
  "src/swarm/blackboard/prompts/auditor.test.ts",
  "src/swarm/blackboard/prompts/driftGuard.test.ts",
  "src/swarm/blackboard/prompts/hunkReview.test.ts",
  "src/swarm/blackboard/boardRestore.test.ts",
  "src/swarm/blackboard/endpointCatalogContext.test.ts",
  "src/swarm/blackboard/contextBuilders.test.ts",
  "src/swarm/blackboard/parseSalvage.test.ts",
  "src/swarm/blackboard/replanSalvage.test.ts",
  "src/swarm/blackboard/prompts/critic.test.ts",
  "src/swarm/blackboard/prompts/verifier.test.ts",
  "src/swarm/blackboard/prompts/pathValidation.test.ts",
  "src/swarm/blackboard/writeFileAtomic.test.ts",
  "src/swarm/blackboard/diffValidation.test.ts",
  "src/swarm/blackboard/hunkVoting.test.ts",
  "src/swarm/blackboard/hunkJudgePrompt.test.ts",
  "src/swarm/blackboard/resolveSafe.test.ts",
  "src/swarm/blackboard/caps.test.ts",
  "src/swarm/blackboard/crashSnapshot.test.ts",
  "src/swarm/blackboard/stateSnapshot.test.ts",
  "src/swarm/blackboard/summary.test.ts",
  "src/swarm/blackboard/runDeliverables.test.ts",
  "src/swarm/blackboard/gitRunDelta.test.ts",
  "src/swarm/blackboard/finalAudit.test.ts",
  "src/swarm/blackboard/retry.test.ts",
  "src/swarm/blackboard/applyHunks.test.ts",
  "src/swarm/blackboard/applyMissReport.test.ts",
  "src/swarm/grounding/mergeAnchors.test.ts",
  "src/swarm/emptyExecutionGuard.test.ts",
  "src/swarm/research/researchBudget.test.ts",
  "src/swarm/applyOrGroundedRepair.test.ts",
  "src/swarm/blackboard/applyHunksPipeline.test.ts",
  "src/swarm/blackboard/windowFile.test.ts",
  "src/swarm/blackboard/transcriptSummary.test.ts",
  "src/swarm/blackboard/workerRoles.test.ts",
  "src/swarm/blackboard/memoryStore.test.ts",
  "src/swarm/blackboard/RunStateObserver.test.ts",
  "src/swarm/blackboard/lifecycleState.test.ts",
  "src/swarm/blackboard/TodoQueue.test.ts",
  "src/swarm/blackboard/WorkerPipeline.test.ts",
  "src/swarm/blackboard/workerSelfConsistency.test.ts",
  "src/swarm/blackboard/eventLogIndex.test.ts",
  "src/swarm/blackboard/v2Adapters.test.ts",
  "src/swarm/blackboard/EventLogReaderV2.test.ts",
  "src/swarm/blackboard/v2Integration.test.ts",
  "src/swarm/blackboard/formatServerSummary.test.ts",
  "src/swarm/blackboard/FindingsLog.test.ts",
  "src/swarm/blackboard/boardBroadcaster.test.ts",
  "src/swarm/blackboard/boardWireCompat.test.ts",
  "src/swarm/blackboard/todoQueueWrappers.test.ts",
  "src/swarm/blackboard/siblingRetry.test.ts",
  "src/swarm/blackboard/userChatContext.test.ts",

  // swarm/ (non-blackboard)
  "src/swarm/roles.test.ts",
  "src/swarm/CouncilRunner.test.ts",
  "src/swarm/councilContractDraft.test.ts",
  "src/swarm/OrchestratorWorkerRunner.test.ts",
  "src/swarm/OrchestratorWorkerDeepRunner.test.ts",
  "src/swarm/DebateJudgeRunner.test.ts",
  "src/swarm/MapReduceRunner.test.ts",
  "src/swarm/MoaRunner.test.ts",
  "src/swarm/moaConsensus.test.ts",
  "src/swarm/StigmergyRunner.test.ts",
  "src/swarm/StigmergyRunner.stripAnnotation.test.ts",
  "src/swarm/BaselineRunner.test.ts",
  "src/swarm/BaselineSwarmHarness.test.ts",
  "src/swarm/DebateStream.test.ts",
  "src/swarm/blackboard/hypothesisGrouping.test.ts",
  "src/swarm/dynamicModelRoute.test.ts",
  "src/swarm/selfCritique.test.ts",
  "src/swarm/failurePatternSeed.test.ts",
  "src/swarm/agentMentionContract.test.ts",
  "src/swarm/bestOfNTurn.test.ts",
  "src/swarm/dissentPreservation.test.ts",
  "src/swarm/dynamicRolePicker.test.ts",
  "src/swarm/swapSidesBiasCheck.test.ts",
  "src/swarm/pheromoneDecay.test.ts",
  "src/swarm/midCycleBroadcast.test.ts",
  "src/swarm/preflightDryRun.test.ts",
  "src/swarm/hunkRag.test.ts",
  "src/swarm/hunkRagStore.test.ts",
  "src/swarm/presetRouter.test.ts",
  "src/swarm/rubricGrading.test.ts",
  "src/swarm/outcomeScorer.test.ts",
  "src/services/AgentManager.killAgent.test.ts",
  "src/services/Orchestrator.multiTenant.test.ts",
  "src/services/Orchestrator.concurrent.integration.test.ts",
  "src/ws/broadcast.test.ts",
  "src/ws/reconnect.test.ts",
  "src/swarm/councilReconcile.test.ts",
  "src/swarm/councilSkipReconcile.test.ts",
  "src/swarm/councilPathCanonicalize.test.ts",
  "src/swarm/councilExecutionResume.test.ts",
  "src/swarm/councilProgressLedger.test.ts",
  "src/swarm/councilLedgerReconcile.test.ts",
  "src/swarm/councilAuditor.test.ts",
  "src/swarm/discussionStopReason.test.ts",
  "src/swarm/councilStandupFallback.test.ts",
  "src/swarm/councilDecisions.test.ts",
  "src/swarm/councilTodoClassify.test.ts",
  "src/swarm/councilWorkerRunner.test.ts",
  "src/swarm/councilSettlementPolicy.test.ts",
  "src/swarm/productiveProgress.test.ts",
  "src/swarm/stopReasonSurface.test.ts",
  "src/swarm/extractText.test.ts",
  "src/swarm/runEndReflection.test.ts",
  "src/swarm/staggerStart.test.ts",

  "src/swarm/sseAwareTurnWatchdog.test.ts",
  "src/swarm/promptWithRetry.test.ts",
  "src/swarm/researchBrief.test.ts",
  "src/swarm/research/localCatalogIndex.test.ts",
  "src/swarm/runStateMachine.test.ts",
  "src/swarm/agentStatsCollector.test.ts",
  "src/swarm/runSummary.test.ts",
  "src/swarm/applyIntegrityStats.test.ts",
  // 2026-05-02–05-03: previously orphaned (added but never registered here).
  "src/swarm/propositionDerive.test.ts",
  "src/swarm/roleDiffDeliverable.test.ts",
  // 2026-05-03 (Phase A): shared-layer helpers.
  "src/swarm/directivePromptHelpers.test.ts",
  "src/swarm/listProjectTree.test.ts",
  "src/swarm/councilDecisions.prompt.test.ts",
  "src/swarm/convergenceSignal.test.ts",
  // 2026-05-03 (Phase B): loop guard helpers.
  "src/swarm/loopGuards.test.ts",
  "src/swarm/deadLoopGuard.test.ts",
  // 2026-05-03 (Phase C): writeSummary helper.
  "src/swarm/discussionWriteSummary.test.ts",
  // 2026-05-03 (Phase D): finally close-out helper.
  "src/swarm/runFinallyHooks.test.ts",
  "src/swarm/runReconfig.test.ts",
  "src/swarm/brainChatMode.test.ts",
  // 2026-05-04 (T2.1): wrap-up apply phase + wiring assertions.
  "src/swarm/wrapUpApplyPhase.test.ts",
  "src/swarm/wrapUpApplyPhase.wiring.test.ts",
  // 2026-05-04 (T197): import-graph helper for smart slicing + cross-cluster.
  "src/swarm/importGraph.test.ts",
  // 2026-05-04 (T199): LLM-driven dynamic role catalog.
  "src/swarm/dynamicRoleCatalog.test.ts",
  // 2026-05-04 (T199): test-scaffolding generator for blackboard.
  "src/swarm/testScaffolding.test.ts",
  // 2026-05-04 (R17): structured error taxonomy.
  "src/swarm/errorTaxonomy.test.ts",
  // 2026-05-04 (R1): provider-failover decision helper.
  "src/swarm/providerFailover.test.ts",
  // 2026-05-04 (R2): exponential quota-probe back-off.
  "src/swarm/quotaProbeBackoff.test.ts",
  // 2026-05-04 (R3): cloud → local degradation fallback.
  "src/swarm/degradationFallback.test.ts",
  // 2026-05-04 (R4): pre-flight cost projector.
  "src/swarm/preflightCostProjector.test.ts",
  // 2026-05-04 (R5): auto-resume decision policy.
  "src/swarm/autoResumeDecision.test.ts",
  // 2026-05-04 (R6): drain-by-default stop policy.
  "src/swarm/drainStopPolicy.test.ts",
  // 2026-05-04 (R7): subscriber-driven pause policy.
  "src/swarm/subscriberPausePolicy.test.ts",
  // 2026-05-04 (R8): cross-process clone lock.
  "src/swarm/cloneLock.test.ts",
  "src/swarm/blackboard/workerFileConflict.test.ts",
  // 2026-05-04 (R10): proactive model-health tracker.
  "src/swarm/modelHealthTracker.test.ts",
  // 2026-05-04 (R11): universal JSON repair.
  "src/swarm/repairJson.test.ts",
  // 2026-05-04 (R12): pre-flight disk-space check.
  "src/swarm/preflightDiskCheck.test.ts",
  // 2026-05-04 (R13): memory-pressure backpressure.
  "src/swarm/memoryPressure.test.ts",
  // 2026-05-04 (R14): bounded swarm-memory pruner.
  "src/swarm/memoryStorePruner.test.ts",
  // 2026-05-04 (R15): auto-RCA on non-clean stop.
  "src/swarm/autoRca.test.ts",
  // 2026-05-04 (R16): per-run health score.
  "src/swarm/runHealthScore.test.ts",
  // 2026-05-04 (W13/W14/W15): provider-failover wrapper around promptWithRetry.
  "src/swarm/promptWithFailover.test.ts",

  // routes/
  "src/routes/swarm.test.ts",
  "src/routes/runStopDrainHandlers.test.ts",
  "src/routes/v2.test.ts",
  "src/routes/smoke.test.ts",

  // shared/
  "../shared/src/extractThinkTags.test.ts",
  "../shared/src/extractToolCallMarkers.test.ts",
  "../shared/src/wsProtocol.test.ts",
  "../shared/src/modelConfig.test.ts",
  "../shared/src/summarizeAgentJson.test.ts",
  "../shared/src/stripAgentText.test.ts",
  "../shared/src/extractJson.test.ts",
  "../shared/src/parseAgentJson.test.ts",
  "../shared/src/providers.test.ts",
  "../shared/src/drainEligibility.test.ts",
  "../shared/src/explorationCache.test.ts",
  "../shared/src/planningSeed.test.ts",
  "../shared/src/topology.test.ts",
  "../shared/src/workerHunks.test.ts",
  "../shared/src/swarmControl/stallRules.test.ts",
  "../shared/src/swarmControl/replannerSkipGrounding.test.ts",
  "src/swarm/control/SwarmControlCenter.test.ts",
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
  "src/services/ConformanceMonitor.test.ts",
  "src/projectGraph/projectGraph.test.ts",
  "src/services/AmendmentsBuffer.test.ts",
  "src/services/EmbeddingDriftMonitor.test.ts",
  "src/services/CostTracker.test.ts",
  "src/services/AgentManager.usage.test.ts",
  "src/providers/providers.test.ts",
  "src/providers/structuredFormat.test.ts",
  "src/providers/discoverModels.test.ts",
  "src/providers/providers.test.extended.ts",
  "src/providers/ProviderGateway.test.ts",
  "src/providers/providerKeyCheck.test.ts",
  "src/providers/providerHealth.test.ts",
  "src/providers/openCodeProvider.test.ts",
  "src/services/Session.test.ts",
  "src/tools/ToolDispatcher.test.ts",

  // web/ (state + event reducer)
  "../web/src/state/applyEvent.test.ts",

  // swarm/ DiscussionRunnerBase lifecycle
  "src/swarm/DiscussionRunnerBase.test.ts",

  // blackboard/ BlackboardRunner lifecycle
  "src/swarm/blackboard/BlackboardRunner.lifecycle.test.ts",
  "src/swarm/blackboard/planningPolicy.test.ts",
  "src/swarm/blackboard/thinkGuardHandler.test.ts",

  // middleware/
  "src/middleware/securityHeaders.test.ts",
  "src/middleware/requestLogger.test.ts",
  "src/middleware/apiVersion.test.ts",
  "src/middleware/errorHandler.test.ts",
  "src/middleware/rateLimiter.test.ts",
  "src/middleware/cors.test.ts",
  "src/middleware/compression.test.ts",
  "src/middleware/staticServing.test.ts",

  // web/ — previously orphaned (existed on disk but never registered).
  "../web/src/components/PlannerThinkingPanel.test.ts",
  "../web/src/hooks/useReplayState.test.ts",
  "../web/src/lib/costBreakdown.test.ts",
  "../web/src/lib/stopControls.test.ts",
  "../web/src/state/store.test.ts",
  "../web/src/state/transcriptMerge.test.ts",
  "../web/src/state/swarmStoreHydrate.test.ts",
  "../web/src/components/agentPalette.test.ts",
  "../web/src/components/useSegmentSplitter.test.ts",
  "../web/src/components/transcript/JsonBubbles.test.ts",
  "../web/src/components/transcript/AgentThinking.test.ts",

  "../web/src/components/transcript/compactPipelineStatus.test.ts",
  "../web/src/components/transcript/streamDisplayMetrics.test.ts",
  "../web/src/components/transcript/councilSynthesisParse.test.ts",
  "../web/src/components/drafts/councilCycleAggregate.test.ts",
  "../web/src/components/drafts/councilDraftParse.test.ts",
  "../web/src/components/drafts/DraftsTabTooltip.test.ts",
  "../web/src/components/setup/RecentRuns.test.ts",

  // 2026-05-18: new unit tests for previously untested modules (+73 tests).
  "src/swarm/sdkError.test.ts",
  "src/swarm/interruptibleSleep.test.ts",
  "src/swarm/blackboard/prompts/lenientParse.test.ts",
  "src/swarm/blackboard/runnerHelpers.test.ts",
  // 2026-05-18: registered after verifying pass (22 + 26 + 7 = 55 tests).
  "src/services/RunStatePersister.test.ts",
  "src/services/RunsScanner.test.ts",
  "src/services/runSummaryDiscovery.test.ts",
  "src/services/crashSummaryRecovery.test.ts",
  "src/swarm/RoundRobinRunner.test.ts",
  "src/swarm/blackboard/BlackboardRunner.hunkRepair.test.ts",

  // 2026-05-18: new tests for previously untested modules.
  "src/swarm/blackboard/truncate.test.ts",
  "src/swarm/sdkError.test.ts",
  "src/swarm/blackboard/goalListParser.test.ts",

  // 2026-05-17: previously orphaned (existed on disk but never registered).
  "src/swarm/blackboard/coverageGap.test.ts",
  "src/swarm/blackboard/diffCritic.test.ts",
  "src/swarm/blackboard/prDescription.test.ts",
  "src/swarm/blackboard/todoRollback.test.ts",
  "src/swarm/blackboard/brainOverseer/brainService.test.ts",
  "src/swarm/chatReceipt.test.ts",
  "src/swarm/deliverable.test.ts",
  "src/swarm/moaContextGather.test.ts",
  "src/swarm/qualityPasses.test.ts",
  "src/swarm/reconcileHunks.test.ts",
  "src/swarm/rubricPrePass.test.ts",
  "src/swarm/semanticConvergence.test.ts",
  "src/swarm/stigmergyExplorationGap.test.ts",
  "src/swarm/synthesizerHunks.test.ts",
];

// Forward CLI args so callers can pass --test-name-pattern etc:
//   node scripts/run-tests.mjs --test-name-pattern=foo
const extraArgs = process.argv.slice(2);

// CI bypass: disable per-test-file process isolation in CI (slow on
// shared runners — 70 cold node spawns = 20+ min on ubuntu-latest).
// Local dev keeps default isolation. Tests don't share global state
// (each spins its own tmpdir + adapters) so this is safe.
//
// --test-force-exit: when isolation is off, all 70 test files share
// one process. A leaked setInterval (ConformanceMonitor poll) or
// unclosed http.Server (ollamaProxy test) keeps the loop alive past
// the last assertion — locally that's hidden because each file gets
// its own process that exits anyway. CI run #25113724147 hung 40 min
// after the last visible PASS event for exactly this reason.
const ciFlags =
  process.env.CI === "true" ? ["--test-isolation=none", "--test-force-exit"] : [];

const r = spawnSync(
  process.execPath,
  ["--import", "tsx", "--test", ...ciFlags, ...extraArgs, ...TEST_FILES],
  { stdio: "inherit", env },
);
process.exit(r.status ?? 1);
