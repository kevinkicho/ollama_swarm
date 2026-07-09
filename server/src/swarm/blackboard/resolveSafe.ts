// Resolve a worker-supplied relative path to an absolute path inside the
// clone, failing loudly on any form of escape — including via symlinks. The
// target itself does not have to exist (writes create new files), but every
// ancestor component that *does* exist must realpath back inside the clone.

import { promises as fs } from "node:fs";
import path from "node:path";

export async function resolveSafe(clone: string, relPath: string): Promise<string> {
  if (!clone) throw new Error("no active clone path");

  // Normalize separators early for robustness on Windows (mixed / and \ are common
  // from WSL, user input, prompts, etc.). This helps lexical checks.
  const normalizedRel = relPath.replace(/\\/g, "/");

  // Cross-platform absolute detection:
  // - Native path.isAbsolute (covers / on POSIX, C:\ or C:/ on Windows)
  // - Windows drive letters (C:foo etc.) even when running on Linux CI
  // - UNC paths (\\server or //server) — models may emit host-OS paths
  const isWinDrive = /^[a-zA-Z]:[\/\\]/.test(relPath) || /^[a-zA-Z]:[\/]/.test(normalizedRel);
  const isUNC = relPath.startsWith("\\\\") || normalizedRel.startsWith("//");
  const looksAbsolute = path.isAbsolute(normalizedRel) || isWinDrive || isUNC;
  // UNC shares are never inside a local clone workspace.
  if (isUNC) {
    throw new Error(`absolute path not allowed: ${relPath}`);
  }
  if (looksAbsolute) {
    // Models often pass the full clone path from the prompt (e.g.
    // C:\Users\…\kyahoofinance032926). Accept absolutes that resolve inside
    // the clone; still reject paths outside it (C:\evil\secret.txt).
    const cloneReal = await fs.realpath(clone);
    const absCandidate = path.resolve(relPath);
    let relFromClone: string;
    try {
      relFromClone = path.relative(cloneReal, await fs.realpath(absCandidate));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      relFromClone = path.relative(cloneReal, absCandidate);
    }
    if (relFromClone.startsWith("..") || path.isAbsolute(relFromClone)) {
      throw new Error(`absolute path not allowed: ${relPath}`);
    }
    relPath = relFromClone || ".";
  }

  // Lexical check first — cheap, and catches the obvious `../` cases without
  // touching the filesystem.
  const abs = path.resolve(clone, normalizedRel);
  const lexRel = path.relative(clone, abs);
  if (lexRel.startsWith("..") || path.isAbsolute(lexRel)) {
    throw new Error(`path escapes clone: ${relPath}`);
  }
  const lexParts = lexRel.split(/[\\/]/);
  if (lexParts.includes(".git")) throw new Error(`path inside .git: ${relPath}`);

  // Filesystem check. Walk up from the requested path until we find an
  // existing ancestor (lstat so we detect symlinks even when dangling), then
  // realpath that ancestor and re-append the non-existent tail. A dangling
  // symlink along the chain is treated as an escape — we can't verify where
  // it would eventually resolve to.
  const cloneReal = await fs.realpath(clone);

  let existing = abs;
  const tail: string[] = [];
  // Task #208: paranoid iteration cap. The implicit exit (parent ===
  // existing at filesystem root) handles the normal case, but a
  // pathological symlink race could in theory loop indefinitely.
  // 1000 levels is far beyond any plausible legitimate depth.
  let depth = 0;
  while (true) {
    if (++depth > 1000) {
      throw new Error(`path resolution depth exceeded (>1000) for ${relPath}`);
    }
    try {
      await fs.lstat(existing);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      const parent = path.dirname(existing);
      if (parent === existing) break;
      tail.unshift(path.basename(existing));
      existing = parent;
    }
  }

  let existingReal: string;
  try {
    existingReal = await fs.realpath(existing);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`path escapes clone via dangling symlink: ${relPath}`);
    }
    throw err;
  }

  const realAbs = tail.length > 0 ? path.join(existingReal, ...tail) : existingReal;
  const realRel = path.relative(cloneReal, realAbs);
  if (realRel.startsWith("..") || path.isAbsolute(realRel)) {
    throw new Error(`path escapes clone via symlink: ${relPath}`);
  }
  const realParts = realRel.split(/[\\/]/);
  if (realParts.includes(".git")) throw new Error(`path inside .git via symlink: ${relPath}`);

  return realAbs;
}
