// Path normalization for the WSL ↔ Windows boundary.
//
// Background: the dev server binds on the Windows side (npm run dev
// runs as a Windows process so it can spawn opencode.cmd subprocesses).
// REST clients commonly come from WSL — Claude Code sessions, curl
// scripts under /mnt/c — and they send paths in WSL form like
// "/mnt/c/Users/kevin/Desktop/ollama_swarm/runs".
//
// Without normalization, Node's path.resolve treats these literally:
// path.resolve("/mnt/c/Users/foo") on Windows → "C:\mnt\c\Users\foo"
// (a parallel directory tree under C:\mnt\), NOT the intended
// "C:\Users\foo". This bit us in run 0254ca7c — the swarm wrote its
// summary, commits, and design memory to C:\mnt\c\... instead of
// the expected runs/ folder, and downstream code (auditor reading
// criteria's expectedFiles) looked at the wrong path entirely.
//
// This module is intentionally narrow: it converts /mnt/<drive>/...
// to <DRIVE>:\... on Windows, and is a no-op everywhere else. Other
// path shapes (Windows absolute, Linux home, UNC, relative) pass
// through unchanged.

/**
 * Convert a WSL-style path (e.g. "/mnt/c/Users/foo") to its Windows
 * equivalent ("C:\\Users\\foo") when running on Windows. No-op on
 * other platforms or for paths that don't match the WSL pattern.
 */
import { readFileSync } from "node:fs";

function isWsl(): boolean {
  try {
    return readFileSync("/proc/version", "utf8").toLowerCase().includes("microsoft");
  } catch { return false; }
}

export function normalizeWslPath(input: string): string {
  const normalized = input.replace(/\\/g, "/");

  // Windows platform: convert /mnt/c/... → C:\...
  if (process.platform === "win32") {
    const m = /^\/mnt\/([a-zA-Z])(\/.*)?$/.exec(normalized);
    if (!m) return input;
    const drive = m[1].toUpperCase();
    const rest = (m[2] ?? "").replace(/\//g, "\\");
    return `${drive}:${rest || "\\"}`;
  }

  // WSL (Linux kernel, Microsoft version): convert C:/... → /mnt/c/...
  if (isWsl()) {
    const m = /^([a-zA-Z]):(\/.*)?$/i.exec(normalized);
    if (m) return `/mnt/${m[1].toLowerCase()}${m[2] || ""}`;
  }

  return input;
}
