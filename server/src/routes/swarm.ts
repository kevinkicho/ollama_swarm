import { spawn, spawnSync } from "node:child_process";
import { createLogger } from "../services/logger.js";
import path from "node:path";
import { promises as fs, readFileSync } from "node:fs";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { TopologySchema, deriveLegacyFields, synthesizeTopology } from "@ollama-swarm/shared/topology";
import { BRAIN_ALIAS_USER_NOTE, resolveBrainAgentId } from "@ollama-swarm/shared/brainAlias";
import type { Todo } from "../swarm/blackboard/types.js";
import { resolveModels, type ModelDefaults } from "@ollama-swarm/shared/modelConfig";
import { config } from "../config.js";
import { validateContinuousMode } from "./continuousMode.js";
import { tokenTracker } from "../services/ollamaProxy.js";
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
  ProjectGraphQuery,
  BrainApplyBody,
  BrainRejectBody,
  StatusQuery,
  LegacyRunBody,
} from "./schemas.js";
import { assertAllowedClonePath } from "./clonePathGuard.js";
import { resolveLegacyActiveRunId } from "./legacyRunResolve.js";
import { scanForRunDigests } from "../services/RunsScanner.js";
import { WorkspaceBusyError, type Orchestrator } from "../services/Orchestrator.js";
import { pickProvider } from "../providers/pickProvider.js";
import { deriveCloneDir, RepoService } from "../services/RepoService.js";
import { normalizeWslPath } from "../services/pathNormalize.js";
import { preflightDiskCheck } from "../swarm/preflightDiskCheck.js";
import { projectRunCost, exceedsBudget } from "../swarm/preflightCostProjector.js";
import { decideStopAction } from "../swarm/drainStopPolicy.js";
import { SwarmRoleSchema, StartBody, SayBody, OpenBody } from "./schemas.js";
import { buildPresetGuideString, buildOptionsTable } from "../swarm/presetGuide.js";
import { extractJsonFromText, extractLabeledJson } from "../../../shared/src/extractJson.js";

function guardClonePath(
  orch: Orchestrator,
  res: Response,
  clonePath: string,
): string | null {
  const guard = assertAllowedClonePath(orch, clonePath);
  if (!guard.ok) {
    res.status(guard.status).json({ error: guard.error });
    return null;
  }
  return guard.resolved;
}
import { missingProviderKeysForModels } from "../providers/providerKeyCheck.js";
import {
  healthSummariesForProviders,
  probeWarningsForModels,
  uniqueProvidersForModels,
} from "../providers/providerHealth.js";

// `parentPath` is the folder the user points at on the setup form; the repo
// is cloned into `<parentPath>/<repo-name-from-URL>`. The older name
// `localPath` (which meant "the full clone path") survives internally as
// `RunConfig.localPath` — the route handler resolves parent+name and passes
// the full path downstream.

// Unit 32: preset-specific knob shape for role-diff's custom roles list.
// Max 16 roles (DEFAULT_ROLES has 7; we give headroom without letting the
// user stuff an unbounded transcript of guidance into every prompt).
export function swarmRouter(orch: Orchestrator): Router {
  const log = createLogger();
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

  r.get("/status", validate(StatusQuery, "query"), (req: Request, res: Response) => {
    const { runId } = req.query as unknown as z.infer<typeof StatusQuery>;
    if (runId) {
      const status = orch.statusForRun(runId);
      if (!status) {
        res.status(404).json({ error: "runId not found" });
        return;
      }
      res.json(status);
      return;
    }
    const resolved = resolveLegacyActiveRunId(orch);
    if (!resolved.ok) {
      if (resolved.status === 409) {
        res.status(409).json({ error: resolved.error, runIds: resolved.runIds });
        return;
      }
      res.json(orch.status());
      return;
    }
    const status = orch.statusForRun(resolved.runId);
    res.json(status ?? orch.status());
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
    for (const t of todos as Todo[]) {
      if (t.staleReason) staleness[t.staleReason] = (staleness[t.staleReason] ?? 0) + 1;
      if (t.commitTier) commits[t.commitTier] = (commits[t.commitTier] ?? 0) + 1;
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
      ...(targetAgent ? { targetAgent: resolveBrainAgentId(targetAgent) } : {}),
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
    const query = req.query as unknown as z.infer<typeof PreflightQuery>;
    const { repoUrl, parentPath: rawParentPath } = query;
    const preflightModels = [query.model, query.plannerModel, query.workerModel, query.auditorModel].filter(
      (m): m is string => typeof m === "string" && m.trim().length > 0,
    );
    const providerWarnings = missingProviderKeysForModels(preflightModels);
    const providerHealth = healthSummariesForProviders(uniqueProvidersForModels(preflightModels));
    const providerProbeWarnings = probeWarningsForModels(preflightModels);
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
        providerWarnings,
        providerHealth,
        providerProbeWarnings,
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
        providerWarnings,
        providerHealth,
        providerProbeWarnings,
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
      providerWarnings,
      providerHealth,
      providerProbeWarnings,
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

    const reqId = (req as any).reqId;
    const startLog = log.withContext({ reqId });

    // Attach for correlation in run hub / logger
    (parsed.data as any).reqId = reqId;
    startLog.info('start request received', {
      preset: parsed.data.preset,
    });
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
        plannerTools: parsed.data.plannerTools,
        webTools: parsed.data.webTools,
        projectGraphContext: parsed.data.projectGraphContext,
        mcpServers: parsed.data.mcpServers,
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
  r.post("/stop", async (req: Request, res: Response) => {
    const bodyParsed = LegacyRunBody.safeParse(req.body ?? {});
    const runId = bodyParsed.success ? bodyParsed.data.runId : undefined;
    const resolved = resolveLegacyActiveRunId(orch, runId);
    if (!resolved.ok) {
      res.status(resolved.status).json({
        error: resolved.error,
        ...(resolved.runIds ? { runIds: resolved.runIds } : {}),
      });
      return;
    }
    try {
      if (config.SWARM_DRAIN_ON_STOP) {
        const decision = decideStopAction({
          now: Date.now(),
          lastStopAt: lastStopClickAt,
        });
        lastStopClickAt = Date.now();
        if (decision.action === "drain") {
          const ok = await orch.drainRun(resolved.runId);
          if (!ok) {
            res.status(404).json({ error: "runId not active" });
            return;
          }
          res.json({ ok: true, action: "drain", reason: decision.reason });
          return;
        }
      }
      const ok = await orch.stopRun(resolved.runId);
      if (!ok) {
        res.status(404).json({ error: "runId not active" });
        return;
      }
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
  r.post("/drain", async (req: Request, res: Response) => {
    const bodyParsed = LegacyRunBody.safeParse(req.body ?? {});
    const runId = bodyParsed.success ? bodyParsed.data.runId : undefined;
    const resolved = resolveLegacyActiveRunId(orch, runId);
    if (!resolved.ok) {
      res.status(resolved.status).json({
        error: resolved.error,
        ...(resolved.runIds ? { runIds: resolved.runIds } : {}),
      });
      return;
    }
    try {
      const ok = await orch.drainRun(resolved.runId);
      if (!ok) {
        res.status(404).json({ error: "runId not active" });
        return;
      }
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
    const resolved = resolveLegacyActiveRunId(orch, parsed.data.runId);
    if (!resolved.ok) {
      res.status(resolved.status).json({
        error: resolved.error,
        ...(resolved.runIds ? { runIds: resolved.runIds } : {}),
      });
      return;
    }
    const ok = orch.injectUserForRun(resolved.runId, parsed.data.text, {
      intent: parsed.data.intent ?? "steer",
      ...(parsed.data.targetAgent
        ? { targetAgent: resolveBrainAgentId(parsed.data.targetAgent) }
        : {}),
    });
    if (!ok) {
      res.status(404).json({ error: "runId not active" });
      return;
    }
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
  r.get("/runs", validate(RunsQuery, "query"), async (req: Request, res: Response) => {
    const query = req.query as unknown as z.infer<typeof RunsQuery>;
    const status = orch.status();
    // Always respect explicit ?parentPath= from frontend.
    // Fall back to active run's parent, then cached lastParentPath.
    const activeParent = query.parentPath
      ? normalizeWslPath(query.parentPath)
      : (status.localPath ? path.dirname(path.resolve(status.localPath)) : null)
        ?? orch.getLastParentPath();
    const includeOtherParents = query.includeOtherParents === true;
    const parentsToScan = new Set<string>();
    if (activeParent) parentsToScan.add(activeParent);
    // Also scan the project's logs/ directory and its subdirectories
    // (runs are stored in logs/{runId}/). Use activeParent which respects
    // the frontend's ?parentPath= even when no run is active.
    if (activeParent) {
      const logsDir = activeParent.endsWith("/logs") || activeParent.endsWith("\\logs")
        ? activeParent
        : path.join(activeParent, "logs");
      try {
        const stat = await fs.stat(logsDir);
        if (stat.isDirectory()) {
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

    // For any clone-like dirs under the scanned parents, also scan their
    // internal logs/ subdirs for per-run summary locations (logs/<runshort>/).
    // This ensures we discover summaries even when parentPath points to
    // a project root or clone parent (not just directly to a clone's logs).
    const initialParents = [...parentsToScan];
    for (const p of initialParents) {
      const clogs = path.join(p, "logs");
      try {
        const st = await fs.stat(clogs);
        if (st.isDirectory()) {
          const subs = await fs.readdir(clogs);
          for (const s of subs) {
            const sp = path.join(clogs, s);
            try {
              if ((await fs.stat(sp)).isDirectory()) parentsToScan.add(sp);
            } catch {}
          }
        }
      } catch {}
    }
    if (includeOtherParents) {
      for (const p of orch.getKnownParentPaths()) parentsToScan.add(p);
    }
    if (parentsToScan.size === 0) {
      // Broader default when nothing is known (e.g. fresh start, no active run, no ?parentPath):
      // scan cwd + its logs/ + any known parents from the orchestrator.
      const cwd = process.cwd();
      parentsToScan.add(cwd);
      const cwdLogs = path.join(cwd, 'logs');
      parentsToScan.add(cwdLogs);
      for (const p of orch.getKnownParentPaths()) parentsToScan.add(p);
      const last = orch.getLastParentPath();
      if (last) parentsToScan.add(last);
    }
    const activeClone = status.localPath ? path.resolve(status.localPath) : null;
    const activeRunId = status.runConfig?.preset
      ? status.runId ?? null
      : null;

    // Delegated to extracted RunsScanner service (deeper refactor of parent-scanning logic)
    const { runs, parentsScanned } = await scanForRunDigests(parentsToScan, {
      activeClone,
      activeRunId,
    });

    res.json({ runs, parents: parentsScanned });
  });

  r.get("/project-graph", validate(ProjectGraphQuery, "query"), async (req: Request, res: Response) => {
    if (!config.PROJECT_GRAPH_ENABLED) {
      res.status(404).json({ error: "project graph disabled" });
      return;
    }
    const query = req.query as unknown as z.infer<typeof ProjectGraphQuery>;
    const { collectParentsToScan } = await import("../projectGraph/collectParents.js");
    const { getProjectGraph } = await import("../projectGraph/service.js");
    const parentsToScan = await collectParentsToScan(orch, query.parentPath);
    const status = orch.status();
    const activeClone = status.localPath ? path.resolve(status.localPath) : null;
    const activeRunId = status.runId ?? null;
    if (query.clonePath) {
      const resolved = guardClonePath(orch, res, query.clonePath);
      if (!resolved) return;
    }
    const result = await getProjectGraph({
      parentPath: query.parentPath,
      clonePath: query.clonePath,
      refresh: query.refresh === true,
      includeGit: query.includeGit,
      includeStructure: query.includeStructure,
      refreshLayers: query.refreshLayers === true,
      parentsToScan,
      activeClone,
      activeRunId,
    });
    if (!result) {
      res.status(404).json({ error: "no workspace resolved for project graph" });
      return;
    }
    res.json(result);
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
    const resolvedClone = guardClonePath(orch, res, clonePath);
    if (!resolvedClone) return;
    // Look for summaries in the clone root (legacy) or under logs/ (current write location).
    let summaryBase = resolvedClone;
    let entries: string[] = [];
    try {
      entries = await fs.readdir(resolvedClone);
    } catch (err) {
      console.warn('[swarm] readdir-clonePath-failed:', err instanceof Error ? err.message : String(err));
      res.status(404).json({ error: "clonePath not readable" });
      return;
    }
    // Prefer files under logs/ if present (where writeRunSummary puts them).
    const logsPath = path.join(resolvedClone, "logs");
    const summaryFilePaths: string[] = [];
    try {
      const logsEntries = await fs.readdir(logsPath);
      if (logsEntries.some((e) => /^summary/.test(e))) {
        summaryBase = logsPath;
        entries = logsEntries;
      }
      // Collect direct summary files
      for (const e of entries) {
        if (/^summary(?:-.*)?\.json$/.test(e)) {
          summaryFilePaths.push(path.join(summaryBase, e));
        }
      }
      // Also search inside per-run subdirs under logs/ e.g. logs/<run-short-id>/
      // where actual per-run summaries live for this clone.
      for (const sub of logsEntries) {
        const subDir = path.join(logsPath, sub);
        try {
          const subStat = await fs.stat(subDir);
          if (subStat.isDirectory()) {
            const subEnts = await fs.readdir(subDir);
            for (const e of subEnts) {
              if (/^summary(?:-.*)?\.json$/.test(e)) {
                summaryFilePaths.push(path.join(subDir, e));
              }
            }
          }
        } catch {}
      }
    } catch {
      // no logs/ dir or unreadable — fall back to root
    }
    // Also direct root summaries
    try {
      for (const e of entries) {
        if (/^summary(?:-.*)?\.json$/.test(e)) {
          const p = path.join(resolvedClone, e);
          if (!summaryFilePaths.includes(p)) summaryFilePaths.push(p);
        }
      }
      const rootSum = path.join(resolvedClone, "summary.json");
      // will be checked via read
    } catch {}
    // Try per-run files first (canonical), then summary.json fallback.
    // Use full paths we collected. Sort by basename descending so we prefer
    // the most recently written timestamped summary (the final aggregated one
    // from PipelineRunner) over older per-phase ones. This ensures
    // the history view gets the most complete transcript + final run summary.
    let candidates = summaryFilePaths.length > 0 ? [...summaryFilePaths] : ["summary.json"];
    candidates = candidates.sort((a, b) =>
      path.basename(b).localeCompare(path.basename(a))
    );
    // Prefer the outer summary (has full transcript + agents)
    // over sub-phase summaries (e.g. council-only with fewer agents).
    let best: { file: string; parsed: any; score: number } | null = null;
    for (const e of candidates) {
      let raw: string;
      try {
        // e may be basename (relative to summaryBase) or already a full path from subdir scan
        const filePath = path.isAbsolute(e) ? e : path.join(summaryBase, e);
        raw = await fs.readFile(filePath, "utf8");
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
      // Tolerant of short vs full runId.
      if (runId && parsed.runId !== runId &&
          !(typeof parsed.runId === 'string' && (parsed.runId.startsWith(runId) || runId.startsWith(parsed.runId)))) {
        continue;
      }
      // Load brain chat history from sibling state snapshot if available (original behavior)
      // Load brain chat history from sibling state snapshot if available
      try {
        const statePath = path.join(resolvedClone, '..', `${parsed.runId || path.basename(resolvedClone)}.run-state.json`); // approx
        // Note: for promises fs, use sync for exists in this context or adjust
        const fsSync = require('node:fs');
        if (fsSync.existsSync(statePath)) {
          const stateRaw = await fs.readFile(statePath, 'utf8');
          const state = JSON.parse(stateRaw);
          if (state.brainChatHistory) {
            parsed.brainChatHistory = state.brainChatHistory;
          }
        }
      } catch {}
      // Dedicated per-run brain history file (preferred if present)
      try {
        const fsSync = require('node:fs');
        const dedicatedPath = path.join(process.cwd(), 'logs', String(parsed.runId || ''), 'brain-chat.json');
        if (fsSync.existsSync(dedicatedPath)) {
          const rawHist = await fs.readFile(dedicatedPath, 'utf8');
          const hist = JSON.parse(rawHist);
          if (Array.isArray(hist)) parsed.brainChatHistory = hist;
        }
      } catch {}
      res.json(parsed);
      return;
    }

    // Fallback when a parentPath (or workspace) was passed as clonePath but runId is known:
    // walk immediate subdirectories (the project clones) and their logs/ for a summary
    // matching the runId. This makes review links generated from recent-runs (which
    // sometimes store parentPath) or stale caches still work without 404.
    if (runId) {
      try {
        let subEntries: string[] = [];
        try { subEntries = await fs.readdir(resolvedClone); } catch {}
        for (const sub of subEntries) {
          const subDir = path.join(resolvedClone, sub);
          let st: any;
          try { st = await fs.stat(subDir); } catch { continue; }
          if (!st.isDirectory()) continue;
          // Check sub/logs/ or the sub itself for summaries. Also descend one more level
          // for logs/<runid>/summary files.
          const candidatesDirs = [subDir, path.join(subDir, "logs")];
          for (const base of candidatesDirs) {
            let ents: string[] = [];
            try { ents = await fs.readdir(base); } catch { continue; }
            for (const e of ents) {
              const full = path.join(base, e);
              if (/^summary(?:-.*)?\.json$/.test(e)) {
                // direct summary file
                try {
                  const raw = await fs.readFile(full, "utf8");
                  const p = JSON.parse(raw);
                  if (p && typeof p === "object" && (!p.runId || p.runId === runId ||
                      (typeof p.runId === "string" && (p.runId.startsWith(runId) || runId.startsWith(p.runId))))) {
                    // re-apply ...
                    try {
                      const fsSync = require("node:fs");
                      const dedicatedPath = path.join(process.cwd(), "logs", String(p.runId || ""), "brain-chat.json");
                      if (fsSync.existsSync(dedicatedPath)) {
                        const rawHist = await fs.readFile(dedicatedPath, "utf8");
                        const hist = JSON.parse(rawHist);
                        if (Array.isArray(hist)) p.brainChatHistory = hist;
                      }
                    } catch {}
                    res.json(p);
                    return;
                  }
                } catch {}
              } else {
                // perhaps a subdir like <runid>, check inside it for summary
                try {
                  const subSt = await fs.stat(full);
                  if (subSt.isDirectory()) {
                    const subEnts = await fs.readdir(full);
                    for (const se of subEnts) {
                      if (/^summary(?:-.*)?\.json$/.test(se)) {
                        try {
                          const raw = await fs.readFile(path.join(full, se), "utf8");
                          const p = JSON.parse(raw);
                          if (p && typeof p === "object" && (!p.runId || p.runId === runId || (typeof p.runId==='string' && (p.runId.startsWith(runId)||runId.startsWith(p.runId))))) {
                            res.json(p); return;
                          }
                        } catch {}
                      }
                    }
                  }
                } catch {}
              }
            }
          }
        }
      } catch {}
    }

    res.status(404).json({ error: "no matching summary found" });
  });

  // Task #152: read .swarm-memory.jsonl for a clone. Returns the parsed
  // entries (newest first by ts), or [] if missing. Cheap — file is
  // capped at 1 MB by memoryStore's prune logic. Used by the UI memory-
  // log sidebar to surface lessons learned across prior runs.
  r.get("/memory", validate(ClonePathQuery, "query"), async (req: Request, res: Response) => {
    const { clonePath, includeOtherParents: includeOther } = req.query as unknown as z.infer<typeof ClonePathQuery>;
    const resolvedClone = guardClonePath(orch, res, clonePath);
    if (!resolvedClone) return;
    const includeOtherParents = includeOther === true;
    const clonesToScan: string[] = [resolvedClone];
    const otherClones: string[] = [];
    if (includeOtherParents) {
      const cloneName = path.basename(resolvedClone);
      const activeParent = path.dirname(path.resolve(resolvedClone));
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
        if (dir !== resolvedClone) continue;
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
            if (dir === resolvedClone) primaryEntries++;
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
    const resolvedClone = guardClonePath(orch, res, clonePath);
    if (!resolvedClone) return;
    const { readOutcomeHistory: readHistory, computeStats: computeOutcomeStats } = await import("../swarm/outcomeHistory.js");
    const outcomes = await readHistory(resolvedClone);
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
    let outcomes: Awaited<ReturnType<typeof readHistory>> = [];
    if (clonePath) {
      const resolvedClone = guardClonePath(orch, res, clonePath);
      if (!resolvedClone) return;
      outcomes = await readHistory(resolvedClone);
    }
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
    const resolvedClone = guardClonePath(orch, res, clonePath);
    if (!resolvedClone) return;
    const { listCheckpoints } = await import("../swarm/checkpoint.js");
    const checkpoints = await listCheckpoints(resolvedClone, runId);
    res.json({ runId, checkpoints });
    } catch (e) { res.status(500).json({ error: "checkpoints unavailable", detail: (e as Error).message }); }
  });

  r.get("/checkpoints/:runId/:fileName", validate(CheckpointFileParams, "params"), validate(ClonePathQuery, "query"), async (req: Request, res: Response) => {
    try {
    const { runId, fileName } = req.params as unknown as z.infer<typeof CheckpointFileParams>;
    const { clonePath } = req.query as unknown as z.infer<typeof ClonePathQuery>;
    const resolvedClone = guardClonePath(orch, res, clonePath);
    if (!resolvedClone) return;
    const { readCheckpoint } = await import("../swarm/checkpoint.js");
    const checkpoint = await readCheckpoint(resolvedClone, runId, fileName);
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
    const resolvedClone = guardClonePath(orch, res, clonePath);
    if (!resolvedClone) return;
    const { getTimeline } = await import("../swarm/timeline.js");
    const timeline = await getTimeline(resolvedClone, runId);
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
    const resolvedClone = guardClonePath(orch, res, clonePath);
    if (!resolvedClone) return;
    const { loadMemoryStore } = await import("../memory/MemoryStore.js");
    const store = await loadMemoryStore(resolvedClone);
    res.json({ entries: store.snapshot() });
    } catch (e) { res.status(500).json({ error: "memory-store unavailable", detail: (e as Error).message }); }
  });

  r.post("/memory-store", validate(MemoryStorePostBody, "body"), async (req: Request, res: Response) => {
    try {
    const { key, value, tags, clonePath } = req.body as unknown as z.infer<typeof MemoryStorePostBody>;
    const resolvedClone = guardClonePath(orch, res, clonePath);
    if (!resolvedClone) return;
    const { loadMemoryStore } = await import("../memory/MemoryStore.js");
    const store = await loadMemoryStore(resolvedClone);
    store.store(key, value, tags, "user");
    await store.flush();
    res.json({ ok: true, key });
    } catch (e) { res.status(500).json({ error: "memory-store write failed", detail: (e as Error).message }); }
  });

  r.delete("/memory-store/:key", validate(MemoryStoreDeleteParams, "params"), validate(ClonePathQuery, "query"), async (req: Request, res: Response) => {
    try {
    const { key } = req.params as unknown as z.infer<typeof MemoryStoreDeleteParams>;
    const { clonePath } = req.query as unknown as z.infer<typeof ClonePathQuery>;
    const resolvedClone = guardClonePath(orch, res, clonePath);
    if (!resolvedClone) return;
    const { loadMemoryStore } = await import("../memory/MemoryStore.js");
    const store = await loadMemoryStore(resolvedClone);
    const deleted = store.forget(key);
    await store.flush();
    res.json({ ok: true, deleted });
    } catch (e) { res.status(500).json({ error: "memory-store delete failed", detail: (e as Error).message }); }
  });

  // Extracted: Brain routes (P7 + FAB chat/suggest/history + during-run support).
  // Deeper extraction step: shrinks main swarmRouter by ~180 lines of brain surface.
  // Further: could move to server/src/routes/brainRoutes.ts exporting registerBrainRoutes.
  registerBrainRoutes(r, orch);

  return r;
}

function registerBrainRoutes(r: Router, orch: Orchestrator) {
  // P7: Brain health endpoint
  r.get("/brain/health", async (_req: Request, res: Response) => {
    await orch.whenBrainReady();
    const brainService = orch.getBrainService();
    if (!brainService) {
      res.json({ status: "not-initialized" });
      return;
    }
    const health = brainService.getBrainHealth();
    res.json({
      ...health,
      proxyPressure: (tokenTracker as any).pressure ? (tokenTracker as any).pressure() : null,
    });
  });

  // P7: Brain activity timeline
  r.get("/brain/activity", (_req: Request, res: Response) => {
    const brainService = orch.getBrainService();
    if (!brainService) {
      res.json({ activities: [] });
      return;
    }
    res.json({ activities: brainService.getRecentActivities() });
  });

  // P7: Brain run insights / analyses (formerly "proposals")
  r.get("/brain/proposals", async (_req: Request, res: Response) => {
    const brainService = orch.getBrainService();
    if (!brainService) {
      res.json({ proposals: [] });
      return;
    }
    const proposals = await brainService.getAllProposals();
    res.json({ proposals });
  });

  // P7: Apply brain proposal — SYSTEM PATCHING DISABLED.
  // Brain now serves as librarian/master-admin for run analysis only.
  r.post("/brain/apply", validate(BrainApplyBody, "body"), async (_req: Request, res: Response) => {
    res.status(410).json({
      success: false,
      error: "System patching has been removed. Brain now provides run analysis and librarian functions only (initialize/start/finish/review/analyze runs).",
    });
  });

  // P7: Reject brain proposal
  r.post("/brain/reject", validate(BrainRejectBody, "body"), async (req: Request, res: Response) => {
    await orch.whenBrainReady();
    const brainService = orch.getBrainService();
    if (!brainService) {
      res.status(500).json({ error: "Brain service not initialized" });
      return;
    }
    const { proposalId, reason, clonePath } = req.body as z.infer<typeof BrainRejectBody>;
    let resolvedClone: string | undefined;
    if (clonePath) {
      const guarded = guardClonePath(orch, res, clonePath);
      if (!guarded) return;
      resolvedClone = guarded;
    }
    const result = await brainService.rejectProposal(proposalId, reason, resolvedClone);
    if (!result.success) {
      const status = result.error === "Proposal not found" ? 404 : 400;
      res.status(status).json({ success: false, error: result.error });
      return;
    }
    res.json({ success: true, message: "Proposal rejected" });
  });

  // Persist brain chat history to disk (alongside run summary via snapshot)
  r.post("/brain/chat-history", (req: Request, res: Response) => {
    const { runId, history } = req.body || {};
    if (runId && Array.isArray(history)) {
      (orch as any).setBrainChatHistory?.(runId, history);
      res.json({ ok: true });
    } else {
      res.status(400).json({ error: "runId and history array required" });
    }
  });

  // Real /brain/suggest route that calls injectSuggestion for proactive Brain suggestions
  r.post("/brain/suggest", async (req: Request, res: Response) => {
    await orch.whenBrainReady();
    const brainService = orch.getBrainService();
    if (!brainService) {
      return res.status(500).json({ error: "Brain service not initialized" });
    }
    const { runId, title, text, category } = req.body || {};
    if (!runId || !title || !text) {
      return res.status(400).json({ error: "runId, title, and text are required" });
    }
    if (brainService.injectSuggestion) {
      brainService.injectSuggestion(runId, { title, text, category });
      res.json({ success: true, message: "Suggestion injected" });
    } else {
      res.status(501).json({ error: "injectSuggestion not available" });
    }
  });

  // Brain chat: conversational interface to configure and start swarms.
  // The Brain (librarian/master-admin) helps via natural language.
  // Structured RECOMMENDATION + CONFIG blocks are inferred from the latest user
  // message (setup vs during-run). ?structured=true still forces it for API callers.
  r.post("/brain/chat", async (req: Request, res: Response) => {
    try {
      const body = req.body || {};
      const { messages = [], runContext, clonePath, structured } = body;
      if (!Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: "messages array required" });
      }

      const lastUserMsg =
        [...messages].reverse().find((m: { role?: string }) => m.role === "user")?.content ??
        messages[messages.length - 1]?.content ??
        "";
      const { inferStructuredBrainMode } = await import("../swarm/brainChatMode.js");
      const wantsStructured =
        structured === true ||
        req.query.structured === "true" ||
        req.query.explain === "options" ||
        inferStructuredBrainMode(String(lastUserMsg ?? ""), { duringRun: !!runContext });

      // Ground recommendations using the real preset recommender (outcome history + seeds + heuristics).
      // Proactively quote real numbers from /outcome/stats when possible.
      let recommenderHint = "";
      try {
        const { recommendPreset, readOutcomeHistory, computeStats } = await import("../swarm/outcomeHistory.js");
        let outcomes: any[] = [];
        if (clonePath) {
          const resolved = guardClonePath(orch, res, clonePath);
          if (resolved) outcomes = await readOutcomeHistory(resolved).catch(() => []);
        }
        const lastUserMsg = [...messages].reverse().find((m: any) => m.role === "user")?.content || messages[messages.length-1]?.content || "";
        if (lastUserMsg && lastUserMsg.length > 5) {
          const rec = recommendPreset(lastUserMsg, outcomes);
          let statsLine = "";
          if (outcomes.length >= 3) {
            const stats = computeStats(outcomes);
            const s = stats.get(rec.preset as any);
            if (s) {
              statsLine = `\nReal performance: ${rec.preset} has median score ${(s.medianScore * 10).toFixed(1)}/10 (avg ${(s.avgScore * 10).toFixed(1)}/10) over ${s.sampleSize} similar runs.`;
            }
          }
          recommenderHint = `\n\nSYSTEM RECOMMENDER SUGGESTION (incorporate this for accuracy):\n- Best preset: ${rec.preset}\n- Rationale: ${rec.rationale}${statsLine}\n- Suggested: agentCount=${rec.agentCount}, rounds=${rec.rounds}, confidence=${rec.confidence.toFixed(2)} (source: ${rec.source})\n\nYou may use or refine this after reading the user's full description. Always provide your own supporting analysis referencing the user's words and any numbers above.`;

          // Support "explain all options" mode
          if (/explain all|all options|compare (all|options|presets)|show me the options/i.test(lastUserMsg)) {
            const table = buildOptionsTable(lastUserMsg);
            recommenderHint += `\n\nOPTIONS TABLE FOR THIS GOAL:\n${table}\n\nPresent the top 3 matches with a short table in your reply.`;
          }
        }
      } catch (e) {
        // recommender optional; prompt guide is still excellent
      }

      // Use shared module for the preset decision guide (avoids duplication).
      // The guide is built from docs/swarm-patterns.md and STATUS.md tables.
      const presetGuide = buildPresetGuideString();

      let systemPrompt = `You are Brain, the master-admin and librarian for ollama_swarm.
${BRAIN_ALIAS_USER_NOTE}

Your job is to help the user configure and START a swarm run using natural language. The user may be using the web UI **or** talking to you from a terminal / agent loop that can execute commands.

${presetGuide}
${recommenderHint}

Key rules:
- For local folders without a Git repo: use "parentPath" + "repoUrl": "".
- Default: model "deepseek-v4-flash:cloud", agentCount 5. For research-heavy tasks prefer enabling webTools + plannerTools.
- When user describes their *goal or use-case* (e.g. "I need to analyze many papers and find common patterns", "add OAuth and session handling to my API", "debate pros and cons of migrating", "explore this repo and understand its structure"), analyze it against the guide above and recommend the SINGLE best preset.

CRITICAL: When the user does not know which "swarm mode" / preset to pick:
- Clearly state: "Recommended Preset: council (or blackboard, map-reduce, etc.)"
- Give a short supporting analysis: "Because your goal sounds like X (quote user), and council excels at Y while map-reduce is better for Z."
- Suggest the matching UI filter if relevant: e.g. "Try the Research filter in the Swarm Mode card — it will highlight council + map-reduce + moa."
- Then output the full config JSON (including any webTools: true, etc. that fit the analysis).

When the user gives enough details, output the config **and** a ready-to-run command:

\`\`\`json
{
  "parentPath": "C:\\Users\\you\\workspace\\my-project",
  "repoUrl": "",
  "userDirective": "the full directive here",
  "preset": "blackboard",
  "agentCount": 5,
  "rounds": 0,
  "model": "deepseek-v4-flash:cloud",
  "webTools": true
}
\`\`\`

Then say:

"Ready to start this swarm?  
Run this in your terminal:

\`\`\`bash
ollama-swarm start --config swarm_config.json
\`\`\`

(You can also paste flags directly: ollama-swarm start --parent-path \"...\" --directive \"...\")"

CRITICAL BEHAVIOR:
- When the user says "yes", "start", "go", "launch", "do it", etc., re-emit the JSON block + tell them to run the \`ollama-swarm start\` command (or if they are in the web UI, the UI can auto-start).
- The real CLI is now \`ollama-swarm\` (provided by this project). It talks to the running server.
- Never invent fake commands.
- Be concise and actionable.
- Always ground your preset recommendation in the user's described use-case + the guide above. Provide supporting analysis.`;

      let modelStr = "deepseek-v4-flash:cloud";
      let brainTools: typeof import("../swarm/brainDuringRun.js").BRAIN_EXPLORE_TOOLS | undefined;
      let brainDispatcher: import("../swarm/brainDuringRun.js").BrainExplorerDispatcher | undefined;
      let brainRunId: string | undefined;

      if (runContext && typeof runContext === "object") {
        const {
          enrichBrainRunContext,
          buildDuringRunSystemPrompt,
          BRAIN_EXPLORE_TOOLS,
          BrainExplorerDispatcher,
        } = await import("../swarm/brainDuringRun.js");
        const enriched = enrichBrainRunContext(orch, runContext);
        if (enriched) {
          systemPrompt = buildDuringRunSystemPrompt(enriched.markdown, enriched.toolsEnabled);
          modelStr = enriched.modelString;
          brainRunId = enriched.runId;
          if (enriched.toolsEnabled && enriched.clonePath) {
            brainTools = BRAIN_EXPLORE_TOOLS;
            brainDispatcher = new BrainExplorerDispatcher(enriched.clonePath);
          }
        } else {
          systemPrompt += `

You are now in DURING-RUN assistance mode for an active swarm.

Current run context (use this to give real-time help, suggestions, analysis, or draft amendments):
${JSON.stringify(runContext, null, 2)}

Focus on helping the user understand the current state. Format replies in Markdown.`;
        }
      }

      const { provider, modelId } = pickProvider(modelStr);

      // For structured mode, instruct LLM to output parseable sections
      if (wantsStructured) {
        systemPrompt += `\n\nSTRUCTURED OUTPUT MODE: After your normal reply, also output exactly:
RECOMMENDATION: { "preset": "...", "confidence": 0.8, "rationale": "..." }
CONFIG: { the json config }
Use the tables and recommender data.`;
      }

      const chatMessages = [
        { role: "system" as const, content: systemPrompt },
        ...messages.map((m: any) => ({
          role: (m.role === "assistant" ? "assistant" : "user") as "user" | "assistant",
          content: String(m.content || ""),
        })),
      ];

      const result = await provider.chat({
        model: modelId,
        messages: chatMessages,
        signal: AbortSignal.timeout(90_000),
        ...(brainTools && brainDispatcher
          ? {
              tools: [...brainTools],
              dispatcher: brainDispatcher as unknown as import("../tools/ToolDispatcher.js").ToolDispatcher,
              maxToolTurns: 8,
              runId: brainRunId,
              brainInitiated: true,
            }
          : {}),
      });

      const text = result.text;
      let structuredData = null;
      if (wantsStructured) {
        // Use dedicated labeled extractor + shared balanced parser for robustness.
        // This is significantly better than naive regex (handles fences, strings, first-balanced, etc.).
        const rec = extractLabeledJson(text, 'RECOMMENDATION');
        const cfg = extractLabeledJson(text, 'CONFIG');
        structuredData = {
          recommendation: rec,
          config: cfg,
        };
      }

      if (wantsStructured && structuredData) {
        res.json({ reply: text, model: modelStr, structured: structuredData });
      } else {
        res.json({ reply: text, model: modelStr });
      }
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}

// Unit 52e: thin digest of a run's summary for the history dropdown.
// (type now sourced from the extracted RunsScanner service)
import type { RunSummaryDigest } from "../services/RunsScanner.js";

// (moved to RunsScanner service for deeper extraction of parent-scanning logic)

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
