/**
 * Swarm HTTP router — composition root.
 * Heavy handlers live in focused modules (start / history / brain / open).
 */

import { createLogger } from "../services/logger.js";
import path from "node:path";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { resolveBrainAgentId } from "@ollama-swarm/shared/brainAlias";
import { resolveModels, type ModelDefaults } from "@ollama-swarm/shared/modelConfig";
import type { Todo } from "../swarm/blackboard/types.js";
import { config } from "../config.js";
import {
  validate,
  PreflightQuery,
  SayPerRunBody,
  StatusQuery,
  LegacyRunBody,
  SayBody,
  ReconfigBody,
} from "./schemas.js";
import { resolveLegacyActiveRunId } from "./legacyRunResolve.js";
import type { Orchestrator } from "../services/Orchestrator.js";
import { deriveCloneDir, RepoService } from "../services/RepoService.js";
import { normalizeWslPath } from "../services/pathNormalize.js";
import { preflightDiskCheck } from "../swarm/preflightDiskCheck.js";
import { projectRunCost, exceedsBudget } from "../swarm/preflightCostProjector.js";
import { decideStopAction } from "../swarm/drainStopPolicy.js";
import { PerRunStopDebounce } from "../swarm/control/perRunStopDebounce.js";
import { registerBrainRoutes } from "./brainRoutes.js";
import { registerOpenPathRoute } from "./openPath.js";
import { registerStartRoute } from "./startRoute.js";
import { registerHistoryRoutes } from "./historyRoutes.js";
import { missingProviderKeysForModels } from "../providers/providerKeyCheck.js";
import {
  healthSummariesForProviders,
  probeWarningsForModels,
  uniqueProvidersForModels,
} from "../providers/providerHealth.js";

// parentPath on setup form → clone under <parentPath>/<repo-name>.

export function swarmRouter(orch: Orchestrator): Router {
  const log = createLogger();
  const r = Router();
  // Stateless helper — RepoService methods we use here (dirExists,
  // cloneStats) don't touch orchestrator state, so a fresh instance is
  // fine and avoids threading orch.opts.repos through.
  const repos = new RepoService();
  // R6 + multi-run fix: per-runId last stop click for double-click-within-5s.
  const lastStopClickAtByRun = new PerRunStopDebounce();

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

  // POST /start → registerStartRoute
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
          lastStopAt: lastStopClickAtByRun.get(resolved.runId),
        });
        lastStopClickAtByRun.touch(resolved.runId);
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

  // Mid-run limit extension (rounds, wall-clock cap, token budget).
  r.post("/reconfig", async (req: Request, res: Response) => {
    const parsed = ReconfigBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const { runId, ...patch } = parsed.data;
    const result = orch.reconfigRun(runId, patch);
    if (result === null) {
      res.status(404).json({ error: "No active run with that runId" });
      return;
    }
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json({ ok: true, message: result.message, changes: result.changes });
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

  // Modular slices (start, history, open-in-file-manager, brain/maintenance)
  registerStartRoute(r, orch, { log, repos });
  registerHistoryRoutes(r, orch);
  registerOpenPathRoute(r, orch);
  registerBrainRoutes(r, orch);

  return r;
}
