/**
 * POST /start — start a swarm run (extracted from swarm.ts).
 */

import path from "node:path";
import type { Request, Response, Router } from "express";
import { z } from "zod";
import {
  TopologySchema,
  countAgentsWithRole,
  deriveLegacyFields,
  minWorkerCountForPreset,
  synthesizeTopology,
} from "@ollama-swarm/shared/topology";
import type { Todo } from "../swarm/blackboard/types.js";
import { resolveModels, type ModelDefaults } from "@ollama-swarm/shared/modelConfig";
import { config } from "../config.js";
import { validateContinuousMode } from "./continuousMode.js";
import {
  PLANNING_FAST_PATH_EXCLUDED_PRESETS,
  SUBSTANTIAL_DIRECTIVE_MIN_CHARS,
} from "../swarm/blackboard/planningPolicy.js";
import { StartBody, SwarmRoleSchema } from "./schemas.js";
import { WorkspaceBusyError, type Orchestrator } from "../services/Orchestrator.js";
import { deriveCloneDir, type RepoService } from "../services/RepoService.js";
import { normalizeWslPath } from "../services/pathNormalize.js";
import { preflightDiskCheck } from "../swarm/preflightDiskCheck.js";
import { projectRunCost, exceedsBudget } from "../swarm/preflightCostProjector.js";
import { missingProviderKeysForModels } from "../providers/providerKeyCheck.js";
import {
  healthSummariesForProviders,
  probeWarningsForModels,
  uniqueProvidersForModels,
} from "../providers/providerHealth.js";
import type { createLogger } from "../services/logger.js";

export interface StartRouteDeps {
  log: ReturnType<typeof createLogger>;
  repos: RepoService;
}

export function registerStartRoute(
  r: Router,
  orch: Orchestrator,
  deps: StartRouteDeps,
): void {
  const { log, repos } = deps;

  r.post("/start", async (req: Request, res: Response) => {
    const parsed = StartBody.safeParse(req.body);
    if (!parsed.success) {
      const flat = parsed.error.flatten();
      const msg = flat.fieldErrors
        ? Object.entries(flat.fieldErrors).map(([k, v]) => `${k}: ${(v as string[]).join(", ")}`).join("; ")
        : flat.formErrors.join("; ");
      res.status(400).json({ error: msg || "invalid request body", _detail: flat });
      return;
    }

    const reqId = (req as any).reqId;
    const startLog = log.withContext({ reqId });

    // Attach for correlation in run hub / logger
    (parsed.data as any).reqId = reqId;
    startLog.info('start request received', {
      preset: parsed.data.preset,
    });

    // D12 / C8: fail-closed experimental presets + multi-writer unless opt-in.
    try {
      const { requiresExperimentalAck } = await import(
        "@ollama-swarm/shared/presetMaturity"
      );
      const allowExp = parsed.data.allowExperimental === true;
      if (requiresExperimentalAck(parsed.data.preset) && !allowExp) {
        res.status(400).json({
          error:
            `Preset "${parsed.data.preset}" is experimental/research. ` +
            `Pass allowExperimental: true to start (UI: advanced / experimental badge).`,
          code: "experimental_preset",
          preset: parsed.data.preset,
        });
        return;
      }
      if (parsed.data.writeMode === "multi" && !allowExp) {
        res.status(400).json({
          error:
            'writeMode "multi" is experimental. Pass allowExperimental: true or use single/none.',
          code: "experimental_multi_writer",
        });
        return;
      }
    } catch (err) {
      startLog.warn("experimental maturity gate skipped", {
        err: err instanceof Error ? err.message : String(err),
      });
    }
    // ModelConfig consolidation (2026-05-17): replace scattered ?? chains
    // with a single resolveModels() call. 31 decision points → 1 function.
    const resolvedModels = resolveModels(
      {
        model: parsed.data.model,
        plannerModel: parsed.data.plannerModel,
        workerModel: parsed.data.workerModel,
        auditorModel: parsed.data.auditorModel,
        topology: parsed.data.topology,
        preset: parsed.data.preset,
        dedicatedAuditor: parsed.data.dedicatedAuditor,
      },
      {
        model: config.DEFAULT_MODEL,
        workerModel: config.DEFAULT_WORKER_MODEL,
        auditorModel: config.DEFAULT_AUDITOR_MODEL,
        dedicatedAuditor: config.DEFAULT_DEDICATED_AUDITOR,
      } satisfies ModelDefaults,
    );

    // Agent count and dedicated-auditor flag still come from topology
    // (these are NOT model fields — no consolidation applies).
    const legacy = parsed.data.topology
      ? deriveLegacyFields(parsed.data.topology, parsed.data.preset)
      : null;
    const effAgentCount = legacy?.agentCount ?? parsed.data.agentCount;
    const effDedicatedAuditor = legacy?.dedicatedAuditor ?? parsed.data.dedicatedAuditor;
    // Task #109: map-reduce floor agentCount=4 (1 reducer + 3 mappers).
    // Smaller setups (agentCount=3 = 2 mappers) leave one mapper with a
    // trivially-small slice that the model collapses on; full RCA in
    // run 2bcf662f. The 2-mapper minimum is enforced inside the runner
    // anyway, but rejecting at the schema layer gives a clearer error.
    if (parsed.data.preset === "map-reduce" && effAgentCount < 4) {
      res.status(400).json({
        error: `Map-reduce requires at least 4 agents (1 reducer + 3 mappers). With fewer mappers, slice quality degrades sharply and one mapper typically gets stuck on a tiny slice. Got agentCount=${effAgentCount}.`,
      });
      return;
    }
    // Blackboard needs at least one worker (planner + worker(s) + auditor).
    // agentCount excludes the dedicated auditor, so effAgentCount < 2 means
    // planner-only with zero workers to claim todos.
    if (parsed.data.preset === "blackboard") {
      const minWorkers = minWorkerCountForPreset("blackboard");
      const topoWorkers = parsed.data.topology
        ? countAgentsWithRole(parsed.data.topology, "worker")
        : null;
      if (topoWorkers !== null && topoWorkers < minWorkers) {
        res.status(400).json({
          error: `Blackboard requires at least ${minWorkers} worker agent (planner + worker(s) + auditor). Got ${topoWorkers} worker(s) in topology.`,
        });
        return;
      }
      if (effAgentCount < 1 + minWorkers) {
        res.status(400).json({
          error: `Blackboard requires at least ${1 + minWorkers} non-auditor agents (planner + ≥1 worker). Got agentCount=${effAgentCount}.`,
        });
        return;
      }
    }
    // Council preset: at least 2 drafters for independent drafts; clamp
    // above the preset max to avoid runaway token burn.
    if (parsed.data.preset === "council") {
      const councilMax = 8;
      if (effAgentCount < 2) {
        res.status(400).json({
          error: `Council requires at least 2 agents for independent drafts. Got agentCount=${effAgentCount}.`,
        });
        return;
      }
      if (effAgentCount > councilMax) {
        parsed.data.agentCount = councilMax;
      }
    }
    // Task #131: orchestrator-worker-deep needs at least 1 orchestrator
    // + 1 mid-lead + 2 workers = 4 agents to add coverage over flat OW.
    // Below that, the topology degenerates (mid-lead gets 0-1 workers
    // and the deep tier is just extra latency). Match map-reduce's

    // Server-side guard for /start (including from Brain structured CONFIG).
    // Prevents placeholder paths from structured recs or bad UI state.
    const candidatePath = parsed.data.parentPath || "";
    if (candidatePath && (
      candidatePath.includes("you\\projects") ||
      candidatePath.includes("you/projects") ||
      candidatePath.includes("my-repo") ||
      candidatePath.trim().length < 4
    )) {
      res.status(400).json({
        error: "Please set a real 'Project folder (workspace)' path (the local directory to use/clone into).",
      });
      return;
    }
    // policy: reject at the route layer with a clear message.
    if (parsed.data.preset === "orchestrator-worker-deep" && effAgentCount < 4) {
      res.status(400).json({
        error: `orchestrator-worker-deep requires at least 4 agents (1 orchestrator + 1 mid-lead + 2 workers). With fewer, the deep tier degenerates into flat OW with extra latency. Got agentCount=${effAgentCount}.`,
      });
      return;
    }
    // Task #132: continuous mode safety. Without a budget cap, the
    // runner has no stop signal except user/error — that's an
    // infinite loop the user almost certainly didn't intend. Reject
    // here with a clear message rather than burning tokens.
    const continuousErr = validateContinuousMode({
      continuous: parsed.data.continuous,
      preset: parsed.data.preset,
      tokenBudget: parsed.data.tokenBudget,
      wallClockCapMs: parsed.data.wallClockCapMs,
    });
    if (continuousErr) {
      res.status(400).json({ error: continuousErr });
      return;
    }
    let localPath: string;
    try {
      const rawUrl = parsed.data.repoUrl?.trim() || "";
      // Empty repoUrl: use parentPath as the workspace directly.
      if (!rawUrl) {
        localPath = path.resolve(normalizeWslPath(parsed.data.parentPath));
      } else if (!rawUrl.startsWith("http://") && !rawUrl.startsWith("https://")) {
        localPath = path.resolve(normalizeWslPath(rawUrl));
      } else {
        const parentPath = normalizeWslPath(parsed.data.parentPath);
        localPath = deriveCloneDir(rawUrl, parentPath);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: msg });
      return;
    }
    {
      const { assertUnderWorkspaceRoots } = await import("../services/workspaceRoots.js");
      const rootCheck = assertUnderWorkspaceRoots(localPath);
      if (!rootCheck.ok) {
        res.status(403).json({ error: rootCheck.error });
        return;
      }
      // Also constrain parentPath when cloning under a parent.
      if (parsed.data.parentPath?.trim()) {
        const parentCheck = assertUnderWorkspaceRoots(
          path.resolve(normalizeWslPath(parsed.data.parentPath)),
        );
        if (!parentCheck.ok) {
          res.status(403).json({ error: parentCheck.error });
          return;
        }
      }
    }
    // Task #147: force-restart — stop only runs on THIS workspace, not every
    // concurrent run. Resume / Run-again used to call stopAll() and killed
    // unrelated active runs (stopReason=user).
    if (parsed.data.force === true) {
      try {
        const stopped = await orch.stopRunsOnClonePath(localPath);
        if (stopped.length > 0) {
          startLog.info('force-stop-scoped', { localPath, stopped });
        }
      } catch (err) {
        startLog.warn('force-stop-ignored', { error: err instanceof Error ? err.message : String(err) });
      }
    }
    // R12 wiring (2026-05-04): pre-flight disk check at the parent
    // dir (the clone dir may not exist yet). Refuse if < 2 GB free —
    // a typical clone + run-state + summaries needs at least that
    // much breathing room. statfs unavailable → graceful pass-through.
    const diskParent = path.dirname(localPath);
    const diskCheck = await preflightDiskCheck({ targetPath: diskParent });
    if (!diskCheck.ok) {
      res.status(507).json({
        error: `Insufficient disk space at ${diskParent}: ${diskCheck.reason}`,
      });
      return;
    }
    try {
      // Task #132 + autonomous-preset gate: rounds=0 / continuous only
      // for blackboard + council. Other presets used to run zero cycles
      // (empty for-loop) or silently clamp — reject with a clear 400.
      const { resolveEffectiveRounds } = await import("../swarm/autonomousPresets.js");
      const roundsResolved = resolveEffectiveRounds({
        preset: parsed.data.preset,
        rounds: parsed.data.rounds,
        continuous: parsed.data.continuous,
      });
      if (!roundsResolved.ok) {
        res.status(400).json({ error: roundsResolved.error });
        return;
      }
      const effectiveRounds = roundsResolved.rounds;
      // Fail-closed: autonomous/continuous without any resource cap gets a
      // default 8h wall-clock so the swarm has a stop signal (operator can
      // raise via RECONFIG or setup). Continuous already requires a cap for
      // non-blackboard; rounds=0 was previously open-ended with no guard.
      const { ensureAutonomousResourceCap } = await import("../swarm/autonomousPresets.js");
      const autoCap = ensureAutonomousResourceCap({
        preset: parsed.data.preset,
        rounds: effectiveRounds,
        tokenBudget: parsed.data.tokenBudget,
        wallClockCapMs: parsed.data.wallClockCapMs,
        maxCostUsd: parsed.data.maxCostUsd,
      });
      if (autoCap.appliedDefault) {
        parsed.data.wallClockCapMs = autoCap.wallClockCapMs;
        startLog.info("autonomous-default-wall-clock", {
          wallClockCapMs: autoCap.wallClockCapMs,
          preset: parsed.data.preset,
          rounds: effectiveRounds,
        });
      }
      // R4 wiring (2026-05-04): pre-flight cost projector. When the
      // user has set maxCostUsd AND the projected spend already
      // exceeds it on Day 1, refuse rather than start a run that's
      // guaranteed to halt mid-way on cap:cost. Skipped for continuous
      // (effectiveRounds=1M) since the projection is meaningless
      // there — the maxCostUsd cap is the actual stop signal.
      if (
        parsed.data.maxCostUsd &&
        parsed.data.maxCostUsd > 0 &&
        !parsed.data.continuous
      ) {
        const projection = projectRunCost({
          model: resolvedModels.model,
          totalTurns: effectiveRounds * effAgentCount,
        });
        if (
          exceedsBudget({
            projectedCostUsd: projection.projectedCostUsd,
            costCapUsd: parsed.data.maxCostUsd,
          })
        ) {
          res.status(400).json({
            error: `Projected run cost ($${projection.projectedCostUsd.toFixed(2)}) exceeds maxCostUsd ($${parsed.data.maxCostUsd.toFixed(2)}). Either raise maxCostUsd or shorten the run. ${projection.breakdown}`,
          });
          return;
        }
      }
      const newRunId = await orch.start({
        repoUrl: parsed.data.repoUrl,
        localPath,
        agentCount: effAgentCount,
        rounds: effectiveRounds,
        model: resolvedModels.model,
        preset: parsed.data.preset,
        reqId: (parsed.data as any).reqId, // for correlation in RunEventHub and logs
        // Unit 25: pass user directive through. Already trimmed + 4000-cap-
        // validated by zod. Empty string → undefined already (zod strips).
        userDirective: parsed.data.userDirective && parsed.data.userDirective.length > 0
          ? parsed.data.userDirective
          : undefined,
        // Unit 32: per-preset knobs. Empty/absent → undefined so the
        // runners' fallback logic (DEFAULT_ROLES, env flag,
        // injected-proposition) kicks in cleanly.
        roles:
          parsed.data.roles && parsed.data.roles.length > 0
            ? parsed.data.roles
            : undefined,
        councilContract: parsed.data.councilContract,
        councilSharedExplore: parsed.data.councilSharedExplore,
        councilSharedResearch: parsed.data.councilSharedResearch,
        proposition:
          parsed.data.proposition && parsed.data.proposition.length > 0
            ? parsed.data.proposition
            : undefined,
        ambitionTiers: parsed.data.ambitionTiers,
        critic: parsed.data.critic,
        uiUrl: parsed.data.uiUrl,
        plannerModel: resolvedModels.plannerModel,
        // Blackboard workers default to DEFAULT_WORKER_MODEL (gemma4) so
        // the planner's heavier reasoning model isn't burned on every
        // worker turn. Other presets share `model` across all agents.
        workerModel:
          resolvedModels.workerModel !== resolvedModels.model
            ? resolvedModels.workerModel
            : undefined,
        wallClockCapMs: parsed.data.wallClockCapMs,
        // #296: pre-commit verify command. Threaded into the runner
        // so BlackboardRunner.executeWorkerTodoV2 can construct the
        // verify adapter when present. Other presets ignore.
        verifyCommand: parsed.data.verifyCommand,
        auditorOnlyMutations: parsed.data.auditorOnlyMutations,
        requireAuditorVerification: parsed.data.requireAuditorVerification,
        autoApprove: parsed.data.autoApprove,
        plannerTools: parsed.data.plannerTools,
        webTools: parsed.data.webTools,
        projectGraphContext: parsed.data.projectGraphContext,
        // MCP process spawn is opt-in (SWARM_ALLOW_MCP_SERVERS); default off = RCE harden.
        mcpServers: config.SWARM_ALLOW_MCP_SERVERS ? parsed.data.mcpServers : undefined,
        useLocal: parsed.data.useLocal,
        createdBy: parsed.data.createdBy,
        resumeContract: parsed.data.resumeContract,
        resumeExecutionFromRunId: parsed.data.resumeExecutionFromRunId,
        // Blackboard defaults dedicatedAuditor to ON (env-overridable
        // via DEFAULT_DEDICATED_AUDITOR). Explicit per-run value
        // always wins — including explicit `false` to disable.
        dedicatedAuditor:
          effDedicatedAuditor ??
          (parsed.data.preset === "blackboard"
            ? config.DEFAULT_DEDICATED_AUDITOR
            : undefined),
        // Blackboard auditor defaults to DEFAULT_AUDITOR_MODEL (nemotron)
        // when dedicatedAuditor is on AND no per-run override. Auditor
        // fires rarely so its latency is amortized; cross-criterion
        // synthesis benefits most from the strongest reasoning tier.
        auditorModel:
          resolvedModels.auditorModel !== resolvedModels.model
            ? resolvedModels.auditorModel
            : undefined,
        specializedWorkers: parsed.data.specializedWorkers,
        criticEnsemble: parsed.data.criticEnsemble,
        selfConsistencyK: parsed.data.selfConsistencyK,
        moaAggregatorCount: parsed.data.moaAggregatorCount,
        moaConvergenceThreshold: parsed.data.moaConvergenceThreshold,
        moaProposerModel: parsed.data.moaProposerModel,
        moaAggregatorModel: parsed.data.moaAggregatorModel,
        // T196 + T199 (2026-05-04): per-tier model arrays + extras
        // for the open-weights-parallelism value prop.
        moaProposerModels: parsed.data.moaProposerModels,
        moaAggregationLevels: parsed.data.moaAggregationLevels,
        orchestratorModel: parsed.data.orchestratorModel,
        midLeadModel: parsed.data.midLeadModel,
        dispositionModels: parsed.data.dispositionModels,
        importGraphSlicing: parsed.data.importGraphSlicing,
        crossClusterDiscovery: parsed.data.crossClusterDiscovery,
        streamingReducer: parsed.data.streamingReducer,
        dynamicRoles: parsed.data.dynamicRoles,
        parallelPropositions: parsed.data.parallelPropositions,
        twoStageMoA: parsed.data.twoStageMoA,
        bidirectionalRefinement: parsed.data.bidirectionalRefinement,
        baselineSelfCritique: parsed.data.baselineSelfCritique,
        baselineAttempts: parsed.data.baselineAttempts,
        testDrivenTodos: parsed.data.testDrivenTodos,
        parallelHypothesis: parsed.data.parallelHypothesis,
        chainTo: parsed.data.chainTo,
        adaptiveWorkers: parsed.data.adaptiveWorkers,
        executeNextAction: parsed.data.executeNextAction,
        tokenBudget: parsed.data.tokenBudget,
        maxCostUsd: parsed.data.maxCostUsd,
        // Write mode + conflict policy (UI sends, server now accepts).
        writeMode: parsed.data.writeMode,
        conflictPolicy: parsed.data.conflictPolicy,
        // W13 wiring: per-run failover chain pass-through.
        providerFailover: parsed.data.providerFailover,
        brainModel: parsed.data.brainModel,
        autoGenerateGoals: parsed.data.autoGenerateGoals,
        planningFastPath:
          parsed.data.planningFastPath ??
          (parsed.data.preset === "blackboard"
            && !PLANNING_FAST_PATH_EXCLUDED_PRESETS.has(parsed.data.preset)
            && (parsed.data.userDirective?.trim().length ?? 0) >= SUBSTANTIAL_DIRECTIVE_MIN_CHARS),
        skipContractDerivation: parsed.data.skipContractDerivation,
        planningWallClockCapMs: parsed.data.planningWallClockCapMs,
        autoStretchReflection: parsed.data.autoStretchReflection,
        verifier: parsed.data.verifier,
        useWorkerPipeline: parsed.data.useWorkerPipeline,
        plannerFallbackModel: parsed.data.plannerFallbackModel,
        continuous: parsed.data.continuous,
        autoMemory: parsed.data.autoMemory,
        autoDesignMemory: parsed.data.autoDesignMemory,
        // Phase 4a of #243: store the resolved topology on RunConfig so
        // summary.json can carry it. Synthesized from the legacy fields
        // when the client didn't post one — older clients still get a
        // populated topology, just one derived from preset+count.
        topology:
          parsed.data.topology ??
          synthesizeTopology(parsed.data.preset, effAgentCount, {
            dedicatedAuditor: effDedicatedAuditor,
            plannerModel: resolvedModels.plannerModel,
            workerModel: resolvedModels.workerModel,
            auditorModel: resolvedModels.auditorModel,
          }),
        postRoundCritique: parsed.data.postRoundCritique,
        postSynthesisCritique: parsed.data.postSynthesisCritique,
        workerDispositions: parsed.data.workerDispositions,
        debateAudit: parsed.data.debateAudit,
        debateAuditRounds: parsed.data.debateAuditRounds,
        councilMappers: parsed.data.councilMappers,
        councilMapperRounds: parsed.data.councilMapperRounds,
        pheromoneHotseed: parsed.data.pheromoneHotseed,
        pheromoneHotFiles: parsed.data.pheromoneHotFiles,
        pipeline: parsed.data.pipeline,
        rubricGrading: parsed.data.rubricGrading,
        checkpointing: parsed.data.checkpointing,
        failurePatternSeed: parsed.data.failurePatternSeed,
        preserveDissent: parsed.data.preserveDissent,
        selfCritique: parsed.data.selfCritique,
        swapSidesBiasCheck: parsed.data.swapSidesBiasCheck,
        pheromoneDecay: parsed.data.pheromoneDecay,
        midCycleBroadcast: parsed.data.midCycleBroadcast,
        bestOfNTurn: parsed.data.bestOfNTurn,
        dynamicRolePicker: parsed.data.dynamicRolePicker,
        mentionContracts: parsed.data.mentionContracts,
        preflightDryRun: parsed.data.preflightDryRun,
        hunkRag: parsed.data.hunkRag,
        councilReconcile: parsed.data.councilReconcile,
        stigmergyOnBlackboard: parsed.data.stigmergyOnBlackboard,
      });
      res.json({
        ok: true,
        runId: newRunId,
        navigateTo: `/runs/${encodeURIComponent(newRunId)}`,
        status: orch.statusForRun(newRunId) ?? orch.status(),
      });
    } catch (err) {
      if (err instanceof WorkspaceBusyError) {
        res.status(409).json({
          error: err.message,
          code: err.code,
          activeRunId: err.activeRunId,
          localPath: err.localPath,
        });
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      const status = msg.includes("Concurrent-run cap reached") ? 409 : 500;
      res.status(status).json({ error: msg });
    }
  });

  // R6 wiring (2026-05-04): when SWARM_DRAIN_ON_STOP is ON, the
  // first /stop click drains (finish current turn); a second click
  // within 5s hard-kills. Tracked at module scope per-process — a
  // single user clicking Stop twice is the canonical case. With the
  // flag OFF (default), every click hard-kills as before.
}
