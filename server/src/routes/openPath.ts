/**
 * Cross-platform open-in-file-manager helpers + POST /open routes.
 * Includes /open-summary-dir so history UI can take users to where
 * summary.json files live (delete to flush history data).
 */

import { spawn, spawnSync } from "node:child_process";
import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import type { Request, Response, Router } from "express";
import type { Orchestrator } from "../services/Orchestrator.js";
import { normalizeWslPath } from "../services/pathNormalize.js";
import { OpenBody, OpenSummaryDirBody } from "./schemas.js";

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

function openInOsFileManager(absPath: string): void {
  const opts = { detached: true, stdio: "ignore" as const };

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

  const child = spawn("xdg-open", [absPath], opts);
  child.on("error", (err) => {
    console.warn(
      `[open] xdg-open spawn failed: ${err.message}. Install xdg-utils to enable open-in-file-manager.`,
    );
  });
  child.unref();
}

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

function underRoot(resolved: string, root: string): boolean {
  const r = path.resolve(root);
  return resolved === r || resolved.startsWith(r + path.sep);
}

/**
 * Allow open only for local project/run artifacts — not arbitrary filesystem paths.
 * Works with no active run (history modal / idle).
 */
function isAllowedOpenDir(requested: string, orch: Orchestrator): boolean {
  const resolved = path.resolve(requested);
  const cwd = process.cwd();

  // App-level summary registries (always scanned by RunsScanner).
  if (underRoot(resolved, path.join(cwd, "logs"))) return true;
  if (underRoot(resolved, path.join(cwd, "server", "logs"))) return true;

  // Known workspaces / last parent from orchestrator persistence.
  try {
    for (const p of orch.getKnownParentPaths?.() ?? []) {
      if (p && underRoot(resolved, p)) return true;
    }
  } catch {
    /* ignore */
  }
  try {
    const last = orch.getLastParentPath?.();
    if (last && underRoot(resolved, last)) return true;
  } catch {
    /* ignore */
  }

  // Active run clone or sibling under same parent (legacy Unit 52).
  const status = orch.status();
  const activeClone = status.localPath ? path.resolve(status.localPath) : null;
  if (activeClone) {
    if (resolved === activeClone) return true;
    const activeParent = path.dirname(activeClone);
    if (underRoot(resolved, activeParent)) return true;
  }

  // Tracked runPaths clone parents (post-completion still in map briefly).
  try {
    for (const p of orch.getTrackedClonePaths?.() ?? []) {
      if (p && underRoot(resolved, path.dirname(path.resolve(p)))) return true;
      if (p && underRoot(resolved, path.resolve(p))) return true;
    }
  } catch {
    /* ignore */
  }

  return false;
}

async function dirExists(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Prefer per-run summary dirs (clone/logs/<runId> or app logs/<runId>),
 * then clone/logs, then app logs roots.
 */
export async function resolveSummaryStorageDirs(
  clonePath: string,
  runId?: string,
): Promise<{ primary: string | null; candidates: string[] }> {
  const clone = path.resolve(normalizeWslPath(clonePath));
  const cwd = process.cwd();
  const rid = runId?.trim() || "";
  const short = rid.length >= 8 ? rid.slice(0, 8) : rid;

  const candidates: string[] = [];
  const push = (p: string) => {
    const r = path.resolve(p);
    if (!candidates.includes(r)) candidates.push(r);
  };

  if (rid) {
    push(path.join(clone, "logs", rid));
    if (short && short !== rid) push(path.join(clone, "logs", short));
    push(path.join(cwd, "logs", rid));
    push(path.join(cwd, "server", "logs", rid));
    if (short && short !== rid) {
      push(path.join(cwd, "logs", short));
      push(path.join(cwd, "server", "logs", short));
    }
  }
  push(path.join(clone, "logs"));
  push(clone);
  push(path.join(cwd, "logs"));
  push(path.join(cwd, "server", "logs"));

  let primary: string | null = null;
  for (const c of candidates) {
    if (await dirExists(c)) {
      primary = c;
      break;
    }
  }
  return { primary, candidates };
}

export function registerOpenPathRoute(r: Router, orch: Orchestrator): void {
  // Open any allowed project/run directory in the OS file manager.
  r.post("/open", async (req: Request, res: Response) => {
    const parsed = OpenBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const requested = path.resolve(normalizeWslPath(parsed.data.path));
    if (!isAllowedOpenDir(requested, orch)) {
      res.status(403).json({
        error:
          "open: path is outside allowed project/run roots (clone, known parents, app logs/)",
      });
      return;
    }
    try {
      const stat = await fs.stat(requested);
      if (!stat.isDirectory()) {
        res.status(400).json({ error: "open: path is not a directory" });
        return;
      }
    } catch (err) {
      console.warn(
        "[swarm] open-stat-failed:",
        err instanceof Error ? err.message : String(err),
      );
      res.status(404).json({ error: "open: path does not exist" });
      return;
    }
    try {
      openInOsFileManager(requested);
      res.json({ ok: true, path: requested });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `open: spawn failed (${msg})` });
    }
  });

  /**
   * Resolve + open the folder where summary.json / summary-*.json live for a run.
   * UI: history modal "Open summary folder" — delete files there to flush history.
   */
  r.post("/open-summary-dir", async (req: Request, res: Response) => {
    const parsed = OpenSummaryDirBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const clonePath = path.resolve(normalizeWslPath(parsed.data.clonePath));
    const runId = parsed.data.runId;

    // Allow resolving from clonePath itself (must be under known roots or exist with logs).
    if (!isAllowedOpenDir(clonePath, orch) && !(await dirExists(path.join(clonePath, "logs")))) {
      // Still allow if app logs have the runId
      if (!runId) {
        res.status(403).json({
          error: "open-summary-dir: clonePath is not under an allowed project root",
        });
        return;
      }
    }

    const { primary, candidates } = await resolveSummaryStorageDirs(clonePath, runId);
    if (!primary) {
      res.status(404).json({
        error: "open-summary-dir: no summary directory found on disk",
        candidates,
      });
      return;
    }
    if (!isAllowedOpenDir(primary, orch)) {
      // App logs and clone/logs under workspace should pass; if not, refuse.
      res.status(403).json({
        error: "open-summary-dir: resolved path not allowed",
        path: primary,
      });
      return;
    }
    try {
      openInOsFileManager(primary);
      res.json({
        ok: true,
        path: primary,
        candidates: candidates.filter((c) => c !== primary).slice(0, 8),
        hint:
          "Delete summary.json / summary-*.json (or this folder) to remove the run from history. App mirrors may also live under <swarm>/logs/<runId>/.",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `open-summary-dir: spawn failed (${msg})` });
    }
  });
}
