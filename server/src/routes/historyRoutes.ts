/**
 * History / clone-data routes: runs list, run-summary, memory, outcomes,
 * checkpoints, timeline, project-graph, memory-store.
 * Extracted from swarm.ts.
 */

import path from "node:path";
import { promises as fs } from "node:fs";
import type { Request, Response, Router } from "express";
import { z } from "zod";
import {
  validate,
  MemoryStorePostBody,
  MemoryStoreDeleteParams,
  ClonePathQuery,
  RunSummaryQuery,
  OutcomeStatsQuery,
  OutcomeRecommendQuery,
  CheckpointsParams,
  CheckpointFileParams,
  TimelineParams,
  RunsQuery,
  ProjectGraphQuery,
} from "./schemas.js";
import { assertAllowedClonePath } from "./clonePathGuard.js";
import { scanForRunDigests } from "../services/RunsScanner.js";
import type { Orchestrator } from "../services/Orchestrator.js";
import { normalizeWslPath } from "../services/pathNormalize.js";
import { config } from "../config.js";
import { filterKnownParentPaths } from "../services/knownParents.js";

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


export function registerHistoryRoutes(r: Router, orch: Orchestrator): void {
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
      // Strip recover-me / per-run log dirs that used to flood knownParents.
      for (const p of filterKnownParentPaths(orch.getKnownParentPaths())) {
        parentsToScan.add(p);
      }
    }
    if (parentsToScan.size === 0) {
      // Broader default when nothing is known (e.g. fresh start, no active run, no ?parentPath):
      // scan cwd + its logs/ + any known parents from the orchestrator.
      const cwd = process.cwd();
      parentsToScan.add(cwd);
      const cwdLogs = path.join(cwd, "logs");
      parentsToScan.add(cwdLogs);
      for (const p of filterKnownParentPaths(orch.getKnownParentPaths())) {
        parentsToScan.add(p);
      }
      const last = orch.getLastParentPath();
      if (last) parentsToScan.add(last);
    }
    // Always include app cwd so app-level log mirrors are parent-reachable too.
    parentsToScan.add(process.cwd());
    const activeClone = status.localPath ? path.resolve(status.localPath) : null;
    const activeRunId = status.runConfig?.preset
      ? status.runId ?? null
      : null;

    // Direct-workspace runs store summaries under <clone>/logs/<runId>/ —
    // scan the active clone itself, not only its parent directory.
    if (activeClone) parentsToScan.add(activeClone);
    if (query.parentPath) {
      const resolvedParent = path.resolve(normalizeWslPath(query.parentPath));
      parentsToScan.add(resolvedParent);
    }

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

}
