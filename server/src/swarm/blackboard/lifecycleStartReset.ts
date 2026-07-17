// Per-run state reset at the top of lifecycle start() — extracted from lifecycleRunner.

import type { LifecycleContext } from "./lifecycleRunner.js";
import { config as appConfig } from "../../config.js";
import { startApplyIntegrityTracking } from "../applyIntegrityStats.js";
import { startCycleIntegrityTracking } from "../cycleIntegrityStats.js";
import { clearLocalCatalogCache } from "../research/localCatalogIndex.js";
import { startResearchBudget } from "../research/researchBudget.js";

/**
 * Clear all prior-run mutable fields so start() begins from a clean slate.
 * Does not clone/spawn; only resets trackers and lifecycle markers.
 */
export function resetLifecycleStateForStart(ctx: LifecycleContext, cfg: import("../SwarmRunner.js").RunConfig): void {
  ctx.setTranscript([]);
  ctx.setLifecycleState("running");
  ctx.setRound(0);
  ctx.setRunStartedAt(undefined);
  ctx.setTokenBaselineForRun(undefined);
  ctx.setTickAccumulator(undefined);
  ctx.setPaused(false);
  ctx.setPauseStartedAt(undefined);
  ctx.setTotalPausedMs(0);
  if (ctx.getPauseProbeTimer()) {
    clearTimeout(ctx.getPauseProbeTimer()!);
    ctx.setPauseProbeTimer(undefined);
  }
  ctx.setDrainStartedAt(undefined);
  if (ctx.getDrainWatcherTimer()) {
    clearInterval(ctx.getDrainWatcherTimer()!);
    ctx.setDrainWatcherTimer(undefined);
  }
  ctx.setWasDrained(false);
  ctx.setUserStopRequested(false);
  ctx.setPlanningStartedAt(undefined);
  ctx.setPlanningSubphase(undefined);
  ctx.clearExplorationCache();
  ctx.setContractDerivationFailure(undefined);
  ctx.setStartupCrashMessage(undefined);
  ctx.setTerminationReason(undefined);
  ctx.getErrorTracker().length = 0;
  ctx.setFailoverState({ modelHealth: new Map() });
  ctx.setLocalOllamaTags([]);
  ctx.setSubscriberPaused(false);
  ctx.setMemoryPaused(false);
  ctx.setLastMemoryPressureLevel("ok");
  if (appConfig.SWARM_DEGRADATION_FALLBACK) {
    ctx.discoverLocalOllamaTags().catch((err) => {
      ctx.appendSystem(
        `⚠ lifecycle discoverLocalOllamaTags: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }
  ctx.clearStateSnapshotScheduler();
  ctx.setGitPorcelainAtRunStart("");
  ctx.setRunBootedAt(Date.now());
  // Fresh clone docs per run (avoid stale index across consecutive runs).
  clearLocalCatalogCache();
  startApplyIntegrityTracking(cfg.runId);
  startCycleIntegrityTracking(cfg.runId);
  startResearchBudget(cfg.runId);
  {
    const plannerModel = cfg.plannerModel ?? cfg.model;
    const workerModel = cfg.workerModel ?? cfg.model;
    const dividerText = [
      "▸▸RUN-START▸▸",
      `runId=${cfg.runId ?? ""}`,
      `preset=${cfg.preset ?? ""}`,
      `plannerModel=${plannerModel}`,
      `workerModel=${workerModel}`,
      `agentCount=${cfg.agentCount ?? ""}`,
      `repoUrl=${cfg.repoUrl ?? ""}`,
    ].join("|");
    ctx.appendSystem(dividerText);
    ctx.initRunControl(cfg.runId ?? "");
    ctx.initBrainOverseer(cfg.runId ?? "");
  }
  ctx.setStaleEventCount(0);
  ctx.getTurnsPerAgent().clear();
  ctx.getAttemptsPerAgent().clear();
  ctx.getCommitsPerAgent().clear();
  ctx.getLinesAddedPerAgent().clear();
  ctx.getLinesRemovedPerAgent().clear();
  ctx.getRejectedAttemptsPerAgent().clear();
  ctx.getJsonRepairsPerAgent().clear();
  ctx.getPromptErrorsPerAgent().clear();
  ctx.getPromptTokensPerAgent().clear();
  ctx.getResponseTokensPerAgent().clear();
  ctx.getRetriesPerAgent().clear();
  ctx.getLatenciesPerAgent().clear();
  ctx.setAgentRoster([]);
  ctx.setContract(undefined);
  ctx.setAuditInvocations(0);
  ctx.setCompletionDetail(undefined);
  ctx.setCurrentTier(0);
  ctx.setTiersCompleted(0);
  ctx.setTierHistory([]);
  ctx.setTierStartedAt(undefined);
  ctx.setTierUpFailures(0);
  ctx.setActive(cfg);
  ctx.v2ObserverReset();
  ctx.v2ObserverApply({ type: "start", ts: ctx.getRunBootedAt()! });
  ctx.clearTodoQueue();
  ctx.clearFindings();
  ctx.getHypothesisGroupAborts().clear();
  ctx.getFileCommitCounts().clear();
  ctx.getHypothesisDeferralTimestamps().clear();
}
