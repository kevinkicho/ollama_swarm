/**
 * Cross-platform open-in-file-manager helpers + POST /open route.
 */

import { spawn, spawnSync } from "node:child_process";
import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import type { Request, Response, Router } from "express";
import type { Orchestrator } from "../services/Orchestrator.js";
import { normalizeWslPath } from "../services/pathNormalize.js";
import { OpenBody } from "./schemas.js";

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

export function registerOpenPathRoute(r: Router, orch: Orchestrator): void {
  // Unit 52c + 52e: open a run's clone path in the OS file manager
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
      res.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `open: spawn failed (${msg})` });
    }
  });
}
