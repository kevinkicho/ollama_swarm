import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { promises as fs, readFileSync } from "node:fs";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { TopologySchema, deriveLegacyFields, synthesizeTopology } from "@ollama-swarm/shared/topology";
import { resolveModels, type ModelDefaults } from "@ollama-swarm/shared/modelConfig";
import { config } from "../config.js";
import { validateContinuousMode } from "./continuousMode.js";
import {
  validate,
  MemoryStorePostBody,
  MemoryStoreDeleteParams,
  ClonePathQuery,
  PreflightQuery,
  RunSummaryQuery,
  OutcomeStatsQuery,
  OutcomeRecommendQuery,
  CheckpointsParams,
  CheckpointFileParams,
  TimelineParams,
  SayPerRunBody,
  RunsQuery,
} from "./schemas.js";
import type { Orchestrator } from "../services/Orchestrator.js";
import { deriveCloneDir, RepoService } from "../services/RepoService.js";
import { normalizeWslPath } from "../services/pathNormalize.js";
import { preflightDiskCheck } from "../swarm/preflightDiskCheck.js";
import { projectRunCost, exceedsBudget } from "../swarm/preflightCostProjector.js";
import { decideStopAction } from "../swarm/drainStopPolicy.js";
import { SwarmRoleSchema, StartBody, SayBody, OpenBody } from './schemas.js';

// `parentPath` is the folder the user points at on the setup form; the repo
// is cloned into `<parentPath>/<repo-name-from-URL>`. The older name
// `localPath` (which meant "the full clone path") survives internally as
// `RunConfig.localPath` — the route handler resolves parent+name and passes
// the full path downstream.

// Unit 32: preset-specific knob shape for role-diff's custom roles list.
// Max 16 roles (DEFAULT_ROLES has 7; we give headroom without letting the
// user stuff an unbounded transcript of guidance into every prompt).
export function swarmRouter(orch: Orchestrator): Router {
  const r = Router();
  // Stateless helper — RepoService methods we use here (dirExists,
  // cloneStats) don't touch orchestrator state, so a fresh instance is
  // fine and avoids threading orch.opts.repos through.
  const repos = new RepoService();
  // R6 wiring (2026-05-04): tracks the wall-clock of the last
  // /api/swarm/stop click for the double-click-within-5s detection.
  // null until the first click; carried inside the closure so it's
  // bounded to the router's lifetime.
  let lastStopClickAt: number | null = null;

  r.get("/status", (_req: Request, res: Response) => {
    res.json(orch.status());
  });

  // T-Item-MultiTenant Phase 4 (2026-05-04): list all currently active
  // runs (server-wide, not parent-dir-scoped). Distinct from
  // /api/swarm/runs which lists historical run summaries from a
  // parent directory. Multi-tenant aware UIs use this to show "all
  // runs in flight" across the host.
  r.get("/active-runs", (_req: Request, res: Response) => {
    res.json({ runs: orch.listActiveRuns() });
  });

  // T-Item-Recovery (2026-05-04): runs the persister wrote a snapshot
  // for that didn't reach a terminal phase. The user sees these on
  // server startup so they can decide whether to manually inspect
  // (today) or auto-resume (when that lands). Excludes runs the
  // orchestrator already has active in memory.
  r.get("/recoverable-runs", (_req: Request, res: Response) => {
    res.json({ runs: orch.listRecoverableRuns() });
  });

  // T-Item-Recover (2026-05-04): kick a fresh run using the cfg saved
  // in a recoverable snapshot. Returns 200 with the new runId + the
  // prior transcript (so the UI can surface what happened before).
  // 400 on schema-too-old; 404 on unknown runId; 5xx on start failure.
  r.post("/recover/:runId", async (req: Request, res: Response) => {
    const originalRunId = String(req.params.runId);
    try {
      const result = await orch.recoverRun(originalRunId);
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Heuristic status mapping: snapshot-not-found / schema-too-old
      // → 4xx; everything else (start failure, etc.) → 500.
      if (/no recoverable snapshot/i.test(msg)) {
        res.status(404).json({ error: msg });
      } else if (/predates schema v2|cannot auto-resume/i.test(msg)) {
        res.status(400).json({ error: msg });
      } else {
        res.status(500).json({ error: msg });
      }
    }
  });

  // T-Item-MultiTenant Phase 5 (2026-05-04): per-run status snapshot.
  // 404 when the runId isn't in the active map. Mirrors GET /status
  // shape but scoped to one run.
  r.get("/runs/:runId/status", (req: Request, res: Response) => {
    const runId = String(req.params.runId);
    const status = orch.statusForRun(runId);
    if (!status) {
      res.status(404).json({ error: "runId not found" });
      return;
    }
    res.json(status);
  });

  // Cascade stats: stale reasons, commit tiers, hunk/parse quality.
  // Aggregated from TodoQueue entries for the live run.
  r.get("/runs/:runId/stats", (req: Request, res: Response) => {
    const runId = String(req.params.runId);
    const status = orch.statusForRun(runId);
    if (!status) {
      res.status(404).json({ error: "runId not found" });
      return;
    }
    const board = status.board;
    const counts = board?.counts;
    const todos = board?.todos ?? [];

    const staleness: Record<string, number> = {};
    const commits: Record<string, number> = {};
    for (const t of todos) {
      if ((t as any).staleReason) staleness[(t as any).staleReason] = (staleness[(t as any).staleReason] ?? 0) + 1;
      if ((t as any).commitTier) commits[(t as any).commitTier] = (commits[(t as any).commitTier] ?? 0) + 1;
    }

    const totalTodos = (counts?.committed ?? 0) + (counts?.stale ?? 0) + (counts?.skipped ?? 0);
    const cascadeEfficiency = totalTodos > 0 ? Math.round(((counts?.committed ?? 0) / totalTodos) * 1000) / 10 : 0;
    const EST_MEAN_TURN_MS = 15_000;
    const wastedWallClockSec = Math.round(((counts?.stale ?? 0) * EST_MEAN_TURN_MS) / 1000);

    const hunkMetrics = {
      firstTry: (commits["parse"] ?? 0) + (commits["repair"] ?? 0) + (commits["brain"] ?? 0) + (commits["sibling"] ?? 0),
      hunkRepair: commits["hunk-repair"] ?? 0,
      hunkFail: staleness["hunk-fail"] ?? 0,
    };

    const parseMetrics = {
      parseFails: staleness["parse"] ?? 0,
      repairFails: staleness["repair"] ?? 0,
      brainFails: staleness["brain"] ?? 0,
      siblingFails: staleness["sibling"] ?? 0,
      declined: staleness["declined"] ?? 0,
      hunkEmpty: staleness["hunk-empty"] ?? 0,
    };

    res.json({
      runId,
      cascadeEfficiency,
      wastedWallClockSec,
      staleness,
      commits,
      hunk: hunkMetrics,
      parse: parseMetrics,
    });
  });

  // T-Item-MultiTenant Phase 5 (2026-05-04): per-run user inject.
  r.post("/runs/:runId/say", validate(SayPerRunBody, "body"), (req: Request, res: Response) => {
    const runId = String(req.params.runId);
    const { text, intent, targetAgent } = req.body as unknown as z.infer<typeof SayPerRunBody>;
    const normalizedIntent =
      intent === "suggest" || intent === "ask" ? intent : "steer";
    const ok = orch.injectUserForRun(runId, text, {
      intent: normalizedIntent,
      ...(targetAgent ? { targetAgent } : {}),
    });
    if (!ok) {
      res.status(404).json({ error: "runId not active" });
      return;
    }
    res.json({ ok: true });
  });

  // T-Item-MultiTenant Phase 5 (2026-05-04): per-run stop.
  r.post("/runs/:runId/stop", async (req: Request, res: Response) => {
    const runId = String(req.params.runId);
    const ok = await orch.stopRun(runId);
    if (!ok) {
      res.status(404).json({ error: "runId not active" });
      return;
    }
    res.json({ ok: true });
  });

  // Preflight check (2026-04-24): lets the SetupForm preview whether a
  // Start will CLONE fresh or RESUME an existing clone BEFORE the user
  // commits. Keeps the decision visible instead of only surfacing
  // post-start via CloneBanner + the "Resuming existing clone..."
  // transcript line.
  //
  // Contract:
  //   GET /api/swarm/preflight?repoUrl=...&parentPath=...
  //   → 200 { destPath, exists, isGitRepo, alreadyPresent,
  //           priorCommits, priorChangedFiles, priorUntrackedFiles,
  //           blocker?: "not-git-repo" }
  //   → 400 on bad inputs (missing fields, unparseable URL)
  //
  // Mirrors RepoService.clone's decision logic without actually
  // cloning: if destPath exists + has .git, alreadyPresent=true + we
  // also include cloneStats. If destPath exists but is NOT a git repo,
  // we flag blocker="not-git-repo" — clone() would reject this with
  // "Destination is not empty and is not a git repo". If destPath
  // doesn't exist, alreadyPresent=false and a fresh clone would happen.
  r.get("/preflight", validate(PreflightQuery, "query"), async (req: Request, res: Response) => {
    const { repoUrl, parentPath: rawParentPath } = req.query as unknown as z.infer<typeof PreflightQuery>;
    // WSL ↔ Windows boundary: clients under /mnt/c send WSL-style
    // paths; on Windows we must re-spell them as <DRIVE>:\... or
    // path.resolve will create a parallel C:\mnt\c\... tree.
    const parentPath = normalizeWslPath(rawParentPath);
    let destPath: string;
    try {
      const trimmed = (repoUrl ?? "").trim();
      if (!trimmed) {
        // No repo URL: parentPath IS the workspace
        destPath = path.resolve(normalizeWslPath(parentPath));
      } else if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
        destPath = path.resolve(normalizeWslPath(trimmed));
      } else {
        destPath = deriveCloneDir(trimmed, parentPath);
      }
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : "could not derive clone directory",
      });
      return;
    }
    const exists = await repos.dirExists(destPath);
    if (!exists) {
      res.json({
        destPath,
        exists: false,
        isGitRepo: false,
        alreadyPresent: false,
        priorCommits: 0,
        priorChangedFiles: 0,
        priorUntrackedFiles: 0,
      });
      return;
    }
    const isGitRepo = await repos.dirExists(path.join(destPath, ".git"));
    const isLocalPath = !repoUrl.startsWith("http://") && !repoUrl.startsWith("https://");
    if (!isGitRepo && !isLocalPath) {
      // Non-empty non-git dir — clone() would reject unless force=true.
      // Surface as a blocker so the SetupForm can warn before Start.
      res.json({
        destPath,
        exists: true,
        isGitRepo: false,
        alreadyPresent: false,
        priorCommits: 0,
        priorChangedFiles: 0,
        priorUntrackedFiles: 0,
        blocker: "not-git-repo",
      });
      return;
    }
    const stats = await repos.cloneStats(destPath);
    res.json({
      destPath,
      exists: true,
      isGitRepo: true,
      alreadyPresent: true,
      priorCommits: stats.commits,
      priorChangedFiles: stats.changedFiles,
      priorUntrackedFiles: stats.untrackedFiles,
    });
  });

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
    console.log(`[diag-route] parsed.data.userDirective=${parsed.data.userDirective ? `"${parsed.data.userDirective.slice(0, 80)}…"` : "undefined"}, parsed.data.autoGenerateGoals=${parsed.data.autoGenerateGoals}`);
    // Task #147: force-restart path. When the caller sets force=true, we
    // pre-emptively stop any existing runner so the new start always gets
    // a clean slot. Recovers from the "stuck-orchestrator" state observed
    // in smoke tour 2026-04-25 (map-reduce's spawn took >60s, the script's
    // curl gave up, but the server-side runner kept holding the slot,
    // cascading "A swarm is already running" to every subsequent preset).
    // Best-effort: stop errors are swallowed since the new start will
    // surface its own error if the orchestrator is truly broken.
    if (parsed.data.force === true) {
      try {
        await orch.stop();
      } catch (err) {
        console.warn('[swarm] force-stop-ignored:', err instanceof Error ? err.message : String(err));
      }
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
    // Council preset: always exactly 3 agents. 3 is the sweet spot for
    // diverse independent drafts without excessive token burn. Fewer
    // than 3 reduces diversity; more than 3 adds cost without meaningful
    // improvement in coverage.
    if (parsed.data.preset === "council" && effAgentCount !== 3) {
      if (effAgentCount < 3) {
        res.status(400).json({
          error: `Council requires at least 3 agents. With fewer, draft diversity collapses and the council degenerates into a single-agent analysis. Got agentCount=${effAgentCount}.`,
        });
        return;
      }
      // Silently clamp to 3 when > 3
      parsed.data.agentCount = 3;
    }
    // Task #131: orchestrator-worker-deep needs at least 1 orchestrator
    // + 1 mid-lead + 2 workers = 4 agents to add coverage over flat OW.
    // Below that, the topology degenerates (mid-lead gets 0-1 workers
    // and the deep tier is just extra latency). Match map-reduce's
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
      // Task #132: continuous mode replaces rounds with an effectively-
      // unbounded value (1M). The runners see this same cfg.rounds in
      // their for-loop, but a budget cap is guaranteed to stop the run
      // long before round 1M. Avoids touching every runner's loop.
      // If the user explicitly set rounds=0 (blackboard autonomous mode),
      // honor that over the continuous override so tierRunner can detect
      // autonomous mode via active?.rounds === 0.
      const explicitRounds = parsed.data.rounds;
      const effectiveRounds = explicitRounds === 0
        ? 0
        : parsed.data.continuous
          ? 1_000_000
          : (explicitRounds ?? (parsed.data.preset === "blackboard" ? 0 : 3));
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
      await orch.start({
        repoUrl: parsed.data.repoUrl,
        localPath,
        agentCount: effAgentCount,
        rounds: effectiveRounds,
        model: resolvedModels.model,
        preset: parsed.data.preset,
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
        plannerTools: parsed.data.plannerTools,
        useLocal: parsed.data.useLocal,
        createdBy: parsed.data.createdBy,
        resumeContract: parsed.data.resumeContract,
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
      });
      res.json({ ok: true, status: orch.status() });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // R6 wiring (2026-05-04): when SWARM_DRAIN_ON_STOP is ON, the
  // first /stop click drains (finish current turn); a second click
  // within 5s hard-kills. Tracked at module scope per-process — a
  // single user clicking Stop twice is the canonical case. With the
  // flag OFF (default), every click hard-kills as before.
  r.post("/stop", async (_req: Request, res: Response) => {
    try {
      if (config.SWARM_DRAIN_ON_STOP) {
        const decision = decideStopAction({
          now: Date.now(),
          lastStopAt: lastStopClickAt,
        });
        lastStopClickAt = Date.now();
        if (decision.action === "drain") {
          await orch.drain();
          res.json({ ok: true, action: "drain", reason: decision.reason });
          return;
        }
      }
      await orch.stop();
      res.json({ ok: true, action: "kill" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // #299: mid-run directive amend. The user submits an addendum
  // (typically when the conformance gauge drops) and the orchestrator
  // appends it to the active run's amendments buffer. Each runner
  // reads via opts.getAmendments(runId) on its next prompt cycle —
  // the nudge takes effect at the next turn boundary, not instantly.
  // Returns 404 when no run is active or the runId doesn't match.
  const AmendBody = z.object({
    runId: z.string().min(1).max(40),
    text: z.string().trim().min(1).max(1000),
  });
  r.post("/amend", async (req: Request, res: Response) => {
    const parsed = AmendBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const stored = orch.addAmendment(parsed.data.runId, parsed.data.text);
    if (!stored) {
      res.status(404).json({ error: "No active run with that runId, or text was empty" });
      return;
    }
    // Broadcast happens inside orch.addAmendment via opts.emit so
    // all WS clients see the directive_amended event in realtime.
    res.json({ ok: true, amendment: stored });
  });

  // Task #167: soft-stop. Workers finish currently-claimed todos
  // (no in-flight commits get lost), no new claims, then escalate
  // to hard stop. Backstopped at 3 min — user can press hard /stop
  // to escalate immediately. For non-blackboard presets, falls
  // through to hard /stop (orchestrator handles the dispatch).
  r.post("/drain", async (_req: Request, res: Response) => {
    try {
      await orch.drain();
      res.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  r.post("/say", (req: Request, res: Response) => {
    const parsed = SayBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    orch.injectUser(parsed.data.text, {
      intent: parsed.data.intent ?? "steer",
      ...(parsed.data.targetAgent ? { targetAgent: parsed.data.targetAgent } : {}),
    });
    res.json({ ok: true });
  });

  // Unit 52c + 52e: open a run's clone path in the OS file manager
  // (Windows Explorer / macOS Finder / xdg-open on Linux). Locked
  // down to the orchestrator's CURRENT clone path OR a sibling
  // directory in the same parent (prior runs from the run-history
  // dropdown — Unit 52e). The parent constraint is the
  // path-traversal guard: the LAN can't coax this endpoint into
  // opening arbitrary filesystem locations.
  r.post("/open", async (req: Request, res: Response) => {
    const parsed = OpenBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const requested = path.resolve(normalizeWslPath(parsed.data.path));
    const status = orch.status();
    const activeClone = status.localPath ? path.resolve(status.localPath) : null;
    if (!activeClone) {
      res.status(403).json({ error: "open: no active run; nothing to compare against" });
      return;
    }
    const activeParent = path.dirname(activeClone);
    const requestedParent = path.dirname(requested);
    const isActive = requested === activeClone;
    const isSibling = requestedParent === activeParent && requested !== activeParent;
    if (!isActive && !isSibling) {
      res.status(403).json({
        error: "open: requested path is not the active clone or a sibling of it",
      });
      return;
    }
    try {
      // Verify it actually exists before shelling out — saves us a
      // confusing OS-level error and lets us return a clean 404.
      const stat = await fs.stat(requested);
      if (!stat.isDirectory()) {
        res.status(400).json({ error: "open: path is not a directory" });
        return;
      }
    } catch (err) {
      console.warn('[swarm] open-stat-failed:', err instanceof Error ? err.message : String(err));
      res.status(404).json({ error: "open: path does not exist" });
      return;
    }
    try {
      openInOsFileManager(requested);
      res.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `open: spawn failed (${msg})` });
    }
  });

  // Unit 52e: list prior runs discoverable in the active run's
  // parent directory. Each entry carries the headline summary fields
  // so the UI dropdown + modal can render without further fetches.
  // Returns 200 with an empty list when no run is active or the
  // parent dir is unreadable — never throws.
  r.get("/runs", async (req: Request, res: Response) => {
    const status = orch.status();
    // 2026-04-24: when idle (no active run, status.localPath
    // undefined), fall back to the orchestrator's cached
    // lastParentPath so the dropdown stays useful between runs.
    // Without this fallback the dropdown was empty whenever the user
    // wasn't mid-run — which is most of the time.
    const activeParent = status.localPath
      ? path.dirname(path.resolve(status.localPath))
      : orch.getLastParentPath();
    // #238 (2026-04-28): when ?includeOtherParents=true, also scan
    // every parent path the orchestrator has tracked. Lets the UI
    // show prior runs even when the active parent is fresh (per the
    // option-C UX: clone-scoped first + a footer link surfacing the
    // global view).
    const includeOtherParents =
      typeof req.query.includeOtherParents === "string" &&
      req.query.includeOtherParents.toLowerCase() === "true";
    const parentsToScan = new Set<string>();
    if (activeParent) parentsToScan.add(activeParent);
    // Also scan the project's logs/ directory and its subdirectories
    // (runs are stored in logs/{runId}/)
    if (activeParent) {
      const projectDir = status.localPath ? path.dirname(path.resolve(status.localPath)) : null;
      if (projectDir) {
        const logsDir = path.join(projectDir, "logs");
        try {
          const stat = await fs.stat(logsDir);
          if (stat.isDirectory()) {
            // Scan each logs/{runId}/ subdirectory
            const logEntries = await fs.readdir(logsDir);
            for (const entry of logEntries) {
              const entryPath = path.join(logsDir, entry);
              try {
                const entryStat = await fs.stat(entryPath);
                if (entryStat.isDirectory()) {
                  parentsToScan.add(entryPath);
                }
              } catch { /* skip */ }
            }
          }
        } catch { /* logs/ doesn't exist — fine */ }
      }
    }
    if (includeOtherParents) {
      for (const p of orch.getKnownParentPaths()) parentsToScan.add(p);
    }
    if (parentsToScan.size === 0) {
      res.json({ runs: [], parents: [] });
      return;
    }
    const activeClone = status.localPath ? path.resolve(status.localPath) : null;
    const activeRunId = status.runConfig?.preset
      ? status.runId ?? null
      : null;
    const runs: RunSummaryDigest[] = [];
    const parentsScanned: string[] = [];
    for (const parent of parentsToScan) {
      let entries: string[];
      try {
        entries = await fs.readdir(parent);
      } catch (err) {
        console.warn('[swarm] readdir-parent-failed:', err instanceof Error ? err.message : String(err));
        continue;
      }
      parentsScanned.push(parent);
      for (const name of entries) {
        const cloneDir = path.join(parent, name);
        let stat: import("node:fs").Stats;
        try {
          stat = await fs.stat(cloneDir);
        } catch (err) {
          console.warn('[swarm] stat-cloneDir-failed:', err instanceof Error ? err.message : String(err));
          continue;
        }
        if (!stat.isDirectory()) continue;
        // 2026-04-24: surface EVERY per-run summary (summary-<iso>.json),
        // not just the latest. A target run 8 times now contributes 8
        // dropdown rows instead of 1.
        const digests = await readAllRunDigests(cloneDir, name);
        for (const d of digests) {
          // Active = the run whose clonePath matches AND whose runId
          // matches the orchestrator's current runId. Without the runId
          // check, every prior run on the active target's clone dir
          // would falsely flag as "active".
          d.isActive = activeClone !== null && cloneDir === activeClone && d.runId !== undefined && d.runId === activeRunId;
          // #238: tag each digest with its parent so the UI can group
          // by parent in the cross-parent view.
          (d as RunSummaryDigest & { parentPath?: string }).parentPath = parent;
          runs.push(d);
        }
      }
    }
    // Newest first by startedAt (descending). Falls back to dir name
    // when startedAt is missing (shouldn't happen with a real
    // summary, but defensive).
    runs.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
    res.json({ runs, parents: parentsScanned });
  });

  // Single full-summary fetch for the history modal (2026-04-24).
  // Lookup by clonePath + runId — the modal already knows both from
  // its digest, so we don't need to scan everything again.
  // Returns the entire summary.json contents (RunSummary shape +
  // contract / agent stats), not a thin digest.
  //
  // Defensive on bad inputs: 400 on missing params, 404 if the
  // matching summary file doesn't exist or doesn't carry the
  // requested runId, 500 on unexpected I/O.
  r.get("/run-summary", validate(RunSummaryQuery, "query"), async (req: Request, res: Response) => {
    const { clonePath, runId } = req.query as unknown as z.infer<typeof RunSummaryQuery>;
    let entries: string[];
    try {
      entries = await fs.readdir(clonePath);
    } catch (err) {
      console.warn('[swarm] readdir-clonePath-failed:', err instanceof Error ? err.message : String(err));
      res.status(404).json({ error: "clonePath not readable" });
      return;
    }
    // Try per-run files first (canonical), then summary.json fallback.
    const candidates = [
      ...entries.filter((e) => /^summary-.+\.json$/.test(e)),
      "summary.json",
    ];
    for (const e of candidates) {
      let raw: string;
      try {
        raw = await fs.readFile(path.join(clonePath, e), "utf8");
      } catch (err) {
        console.warn('[swarm] read-summary-file-failed:', err instanceof Error ? err.message : String(err));
        continue;
      }
      let parsed: Record<string, unknown>;
      try {
        const tmp = JSON.parse(raw);
        if (typeof tmp !== "object" || tmp === null) continue;
        parsed = tmp as Record<string, unknown>;
      } catch (err) {
        console.warn('[swarm] parse-summary-json-failed:', err instanceof Error ? err.message : String(err));
        continue;
      }
      // If runId requested, only return the matching summary. If not
      // requested, return the first parseable (typically the latest).
      if (runId && parsed.runId !== runId) continue;
      res.json(parsed);
      return;
    }
    res.status(404).json({ error: "no matching summary found" });
  });

  // Task #152: read .swarm-memory.jsonl for a clone. Returns the parsed
  // entries (newest first by ts), or [] if missing. Cheap — file is
  // capped at 1 MB by memoryStore's prune logic. Used by the UI memory-
  // log sidebar to surface lessons learned across prior runs.
  r.get("/memory", validate(ClonePathQuery, "query"), async (req: Request, res: Response) => {
    const { clonePath, includeOtherParents: includeOther } = req.query as unknown as z.infer<typeof ClonePathQuery>;
    const includeOtherParents = includeOther === true;
    const clonesToScan: string[] = [clonePath];
    const otherClones: string[] = [];
    if (includeOtherParents) {
      const cloneName = path.basename(clonePath);
      const activeParent = path.dirname(path.resolve(clonePath));
      for (const parent of orch.getKnownParentPaths()) {
        if (parent === activeParent) continue;
        // Look for the same target clone name under each other parent.
        const candidate = path.join(parent, cloneName);
        try {
          const stat = await fs.stat(candidate);
          if (stat.isDirectory()) {
            clonesToScan.push(candidate);
            otherClones.push(candidate);
          }
        } catch (err) {
          console.warn('[swarm] stat-other-parent-clone-failed:', err instanceof Error ? err.message : String(err));
        }
      }
    }
    const entries: Array<Record<string, unknown> & { _sourceClone?: string }> = [];
    let primaryEntries = 0;
    let otherParentEntries = 0;
    for (const dir of clonesToScan) {
      const memPath = path.join(dir, ".swarm-memory.jsonl");
      let raw: string;
      try {
        raw = await fs.readFile(memPath, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
        // Other read errors on a SECONDARY clone shouldn't fail the
        // whole request — primary clone errors propagate as before.
        if (dir !== clonePath) continue;
        res.status(500).json({ error: (err as Error).message });
        return;
      }
      for (const line of raw.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          const obj = JSON.parse(t);
          if (obj && typeof obj === "object") {
            entries.push({ ...obj, _sourceClone: dir });
            if (dir === clonePath) primaryEntries++;
            else otherParentEntries++;
          }
        } catch (err) {
          console.warn('[swarm] parse-memory-line-failed:', err instanceof Error ? err.message : String(err));
        }
      }
    }
    entries.sort((a, b) => Number(b.ts ?? 0) - Number(a.ts ?? 0));
    // #240: surface counts so the UI can render "5 entries from this
    // clone + 12 from 3 other clones" without re-counting client-side.
    res.json({
      entries,
      ...(includeOtherParents
        ? { primaryEntries, otherParentEntries, otherClones }
        : {}),
    });
  });

  // Direction 1 Phase 2: outcome history + preset recommendation.
  r.get("/outcome/stats", validate(OutcomeStatsQuery, "query"), async (req: Request, res: Response) => {
    try {
    const { clonePath } = req.query as unknown as z.infer<typeof OutcomeStatsQuery>;
    const { readOutcomeHistory: readHistory, computeStats: computeOutcomeStats } = await import("../swarm/outcomeHistory.js");
    const outcomes = await readHistory(clonePath);
    const stats = computeOutcomeStats(outcomes);
    const result: Record<string, unknown> = {};
    for (const [preset, stat] of stats) {
      result[preset] = stat;
    }
    res.json({ outcomes: outcomes.length, stats: result });
    } catch (e) { res.status(500).json({ error: "outcome/stats unavailable", detail: (e as Error).message }); }
  });

  r.get("/outcome/recommend", validate(OutcomeRecommendQuery, "query"), async (req: Request, res: Response) => {
    try {
    const { directive, clonePath } = req.query as unknown as z.infer<typeof OutcomeRecommendQuery>;
    const { recommendPreset: recommend, readOutcomeHistory: readHistory } = await import("../swarm/outcomeHistory.js");
    const { suggestAdaptiveParams } = await import("../swarm/adaptiveParams.js");
    const outcomes = clonePath ? await readHistory(clonePath) : [];
    const recommendation = recommend(directive, outcomes);
    const adaptive = suggestAdaptiveParams(recommendation.preset as import("../swarm/SwarmRunner.js").PresetId, outcomes);
    res.json({ ...recommendation, adaptiveParams: adaptive });
    } catch (e) { res.status(500).json({ error: "outcome/recommend unavailable", detail: (e as Error).message }); }
  });

  // Direction 6: checkpoint listing + read.
  r.get("/checkpoints/:runId", validate(CheckpointsParams, "params"), validate(ClonePathQuery, "query"), async (req: Request, res: Response) => {
    try {
    const { runId } = req.params as unknown as z.infer<typeof CheckpointsParams>;
    const { clonePath } = req.query as unknown as z.infer<typeof ClonePathQuery>;
    const { listCheckpoints } = await import("../swarm/checkpoint.js");
    const checkpoints = await listCheckpoints(clonePath, runId);
    res.json({ runId, checkpoints });
    } catch (e) { res.status(500).json({ error: "checkpoints unavailable", detail: (e as Error).message }); }
  });

  r.get("/checkpoints/:runId/:fileName", validate(CheckpointFileParams, "params"), validate(ClonePathQuery, "query"), async (req: Request, res: Response) => {
    try {
    const { runId, fileName } = req.params as unknown as z.infer<typeof CheckpointFileParams>;
    const { clonePath } = req.query as unknown as z.infer<typeof ClonePathQuery>;
    const { readCheckpoint } = await import("../swarm/checkpoint.js");
    const checkpoint = await readCheckpoint(clonePath, runId, fileName);
    if (!checkpoint) {
      res.status(404).json({ error: "Checkpoint not found" });
      return;
    }
    res.json(checkpoint);
    } catch (e) { res.status(500).json({ error: "checkpoint read unavailable", detail: (e as Error).message }); }
  });

  // Direction 6 Phase 2: event timeline.
  r.get("/timeline/:runId", validate(TimelineParams, "params"), validate(ClonePathQuery, "query"), async (req: Request, res: Response) => {
    try {
    const { runId } = req.params as unknown as z.infer<typeof TimelineParams>;
    const { clonePath } = req.query as unknown as z.infer<typeof ClonePathQuery>;
    const { getTimeline } = await import("../swarm/timeline.js");
    const timeline = await getTimeline(clonePath, runId);
    if (!timeline) {
      res.status(404).json({ error: "No event log found for this run" });
      return;
    }
    res.json(timeline);
    } catch (e) { res.status(500).json({ error: "timeline unavailable", detail: (e as Error).message }); }
  });

  // Direction 5: persistent memory store CRUD.
  r.get("/memory-store", validate(ClonePathQuery, "query"), async (req: Request, res: Response) => {
    try {
    const { clonePath } = req.query as unknown as z.infer<typeof ClonePathQuery>;
    const { loadMemoryStore } = await import("../memory/MemoryStore.js");
    const store = await loadMemoryStore(clonePath);
    res.json({ entries: store.snapshot() });
    } catch (e) { res.status(500).json({ error: "memory-store unavailable", detail: (e as Error).message }); }
  });

  r.post("/memory-store", validate(MemoryStorePostBody, "body"), async (req: Request, res: Response) => {
    try {
    const { key, value, tags, clonePath } = req.body as unknown as z.infer<typeof MemoryStorePostBody>;
    const { loadMemoryStore } = await import("../memory/MemoryStore.js");
    const store = await loadMemoryStore(clonePath);
    store.store(key, value, tags, "user");
    await store.flush();
    res.json({ ok: true, key });
    } catch (e) { res.status(500).json({ error: "memory-store write failed", detail: (e as Error).message }); }
  });

  r.delete("/memory-store/:key", validate(MemoryStoreDeleteParams, "params"), validate(ClonePathQuery, "query"), async (req: Request, res: Response) => {
    try {
    const { key } = req.params as unknown as z.infer<typeof MemoryStoreDeleteParams>;
    const { clonePath } = req.query as unknown as z.infer<typeof ClonePathQuery>;
    const { loadMemoryStore } = await import("../memory/MemoryStore.js");
    const store = await loadMemoryStore(clonePath);
    const deleted = store.forget(key);
    await store.flush();
    res.json({ ok: true, deleted });
    } catch (e) { res.status(500).json({ error: "memory-store delete failed", detail: (e as Error).message }); }
  });

  return r;
}

// Unit 52e: thin digest of a run's summary for the history dropdown.
// Strict subset of RunSummary's surface — anything bigger goes via a
// follow-up modal fetch (or we just open the folder).
interface RunSummaryDigest {
  name: string;
  clonePath: string;
  preset: string;
  model: string;
  startedAt: number;
  endedAt: number;
  wallClockMs: number;
  stopReason?: string;
  commits?: number;
  totalTodos?: number;
  hasContract: boolean;
  isActive: boolean;
  // Task #36: runId from summary.json (absent on pre-task-36 writes).
  // Enables click-to-copy in the dropdown that matches the live
  // IdentityStrip chip so transcript references like "run 7302..."
  // can be located in the history list.
  runId?: string;
  // Phase 4a of #243: topology surfaced in the dropdown row so users
  // can scan agent specs at a glance. Optional — older summaries
  // don't have it, in which case the row shows "—".
  topology?: import("../../../shared/src/topology.js").Topology;
}

function parseSummaryToDigest(
  raw: string,
  cloneDir: string,
  name: string,
): RunSummaryDigest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn('[swarm] parse-summary-digest-failed:', err instanceof Error ? err.message : String(err));
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.preset !== "string" || typeof obj.startedAt !== "number") return null;
  const contract = obj.contract as Record<string, unknown> | undefined;
  // Phase 4a of #243: parse topology from summary.json if present.
  // Permissive — a malformed topology doesn't fail the digest, just
  // skips the field. The schema would catch it if we re-validated,
  // but since the dropdown can fall back to "—" we just trust it.
  const topology =
    obj.topology &&
    typeof obj.topology === "object" &&
    Array.isArray((obj.topology as { agents?: unknown }).agents)
      ? (obj.topology as RunSummaryDigest["topology"])
      : undefined;
  return {
    name,
    clonePath: cloneDir,
    preset: obj.preset,
    model: typeof obj.model === "string" ? obj.model : "(unknown)",
    startedAt: obj.startedAt,
    endedAt: typeof obj.endedAt === "number" ? obj.endedAt : 0,
    wallClockMs: typeof obj.wallClockMs === "number" ? obj.wallClockMs : 0,
    stopReason: typeof obj.stopReason === "string" ? obj.stopReason : undefined,
    commits: typeof obj.commits === "number" ? obj.commits : undefined,
    totalTodos: typeof obj.totalTodos === "number" ? obj.totalTodos : undefined,
    hasContract: contract !== undefined && Array.isArray(contract.criteria),
    isActive: false,
    runId: typeof obj.runId === "string" ? obj.runId : undefined,
    topology,
  };
}

// 2026-04-24: returns one digest per RUN in this cloneDir, not just
// per cloneDir. Reads every `summary-<iso>.json` (per-run, never
// overwritten — Unit 49) and falls back to bare `summary.json`
// (latest pointer) only when no per-run file exists. Dedups by
// (runId || startedAt) so a legacy clone whose latest pointer
// happens to match a per-run file isn't counted twice.
//
// Previously the route only returned ONE digest per cloneDir (the
// latest), so a target run 8 times appeared as a single dropdown
// row with the most recent stats. Surfacing all per-run summaries
// gives the user true historical visibility into the framework's
// behavior across multiple iterations on the same target.
async function readAllRunDigests(
  cloneDir: string,
  name: string,
): Promise<RunSummaryDigest[]> {
  const digests: RunSummaryDigest[] = [];
  const seen = new Set<string>();
  const dedupKey = (d: RunSummaryDigest) => d.runId ?? `t:${d.startedAt}`;

  // Per-run files first — these are the source of truth, written once
  // at run-end and never touched again.
  let perRun: string[] = [];
  try {
    const all = await fs.readdir(cloneDir);
    perRun = all.filter((e) => /^summary-.+\.json$/.test(e));
  } catch (err) {
    console.warn('[swarm] readdir-cloneDir-digests-failed:', err instanceof Error ? err.message : String(err));
    // unreadable cloneDir — return empty
    return [];
  }
  for (const e of perRun) {
    let raw: string;
    try {
      raw = await fs.readFile(path.join(cloneDir, e), "utf8");
    } catch (err) {
      console.warn('[swarm] read-perRun-summary-failed:', err instanceof Error ? err.message : String(err));
      continue;
    }
    const d = parseSummaryToDigest(raw, cloneDir, name);
    if (!d) continue;
    const k = dedupKey(d);
    if (seen.has(k)) continue;
    seen.add(k);
    digests.push(d);
  }

  // Fallback: bare summary.json (the latest pointer). On modern
  // clones this duplicates one of the per-run files above and the
  // dedup catches it. On legacy clones with no per-run files, this
  // is the only way to see the run at all.
  let latestRaw: string | null = null;
  try {
    latestRaw = await fs.readFile(path.join(cloneDir, "summary.json"), "utf8");
  } catch (err) {
    console.warn('[swarm] read-summary-pointer-failed:', err instanceof Error ? err.message : String(err));
    // no latest pointer — fine
  }
  if (latestRaw !== null) {
    const d = parseSummaryToDigest(latestRaw, cloneDir, name);
    if (d) {
      const k = dedupKey(d);
      if (!seen.has(k)) {
        seen.add(k);
        digests.push(d);
      }
    }
  }

  return digests;
}

// True iff this Node process is running inside WSL2 — Linux uname,
// but the kernel string includes "microsoft". We treat WSL2 as a
// distinct platform from native Linux because xdg-open is rarely
// installed there but explorer.exe is always reachable.
function isWsl2(): boolean {
  if (process.platform !== "linux") return false;
  if (process.env.WSL_DISTRO_NAME) return true;
  try {
    const release = readFileSync("/proc/version", "utf8");
    return /microsoft/i.test(release);
  } catch (err) {
    console.warn('[swarm] read-proc-version-failed:', err instanceof Error ? err.message : String(err));
    return false;
  }
}

// Cross-platform "show this directory in the user's file manager."
// Detached + unref so the spawned process doesn't keep the dev
// server alive as a child. stdio ignored so a slow file-manager
// startup doesn't block our HTTP response.
//
// All branches attach an `error` handler to the spawned child so an
// ENOENT (handler binary not installed) becomes a logged warning
// instead of an uncaughtException that takes the dev server down.
// The HTTP response has already been sent by the time the spawn
// errors, so there's nothing to surface back to the caller — we just
// want to fail safe.
function openInOsFileManager(absPath: string): void {
  const opts = { detached: true, stdio: "ignore" as const };

  // WSL2 → use Windows Explorer via the wslpath-converted path.
  // Falls back to a no-op if wslpath isn't on PATH (rare; ships
  // with every WSL2 distro by default).
  if (isWsl2()) {
    const winPath = wslPathToWindows(absPath) ?? absPath;
    const child = spawn("explorer.exe", [winPath], opts);
    child.on("error", (err) => {
      console.warn(`[open] explorer.exe spawn failed in WSL2: ${err.message}`);
    });
    child.unref();
    return;
  }

  if (process.platform === "win32") {
    // `start "" <path>` opens the path in Explorer on Windows. The
    // empty title arg is REQUIRED — without it `start` treats the
    // path as the title.
    const child = spawn("cmd", ["/c", "start", "", absPath], opts);
    child.on("error", (err) => {
      console.warn(`[open] cmd /c start spawn failed: ${err.message}`);
    });
    child.unref();
    return;
  }

  if (process.platform === "darwin") {
    const child = spawn("open", [absPath], opts);
    child.on("error", (err) => {
      console.warn(`[open] open(1) spawn failed: ${err.message}`);
    });
    child.unref();
    return;
  }

  // Native Linux — xdg-open is the standard. If it's not installed
  // (minimal containers, headless boxes), the error handler swallows
  // the ENOENT instead of crashing the process.
  const child = spawn("xdg-open", [absPath], opts);
  child.on("error", (err) => {
    console.warn(
      `[open] xdg-open spawn failed: ${err.message}. Install xdg-utils to enable open-in-file-manager.`,
    );
  });
  child.unref();
}

// Convert a WSL2 Linux path to its Windows-visible form via the
// `wslpath` utility. Returns null on any failure (utility missing,
// non-zero exit, empty stdout) so callers can fall back gracefully.
// Synchronous because we already do filesystem I/O around it and the
// utility returns instantly.
function wslPathToWindows(linuxPath: string): string | null {
  try {
    const result = spawnSync("wslpath", ["-w", linuxPath], { encoding: "utf8" });
    if (result.status !== 0) return null;
    const out = (result.stdout ?? "").trim();
    return out.length > 0 ? out : null;
  } catch (err) {
    console.warn('[swarm] wslpath-failed:', err instanceof Error ? err.message : String(err));
    return null;
  }
}
