// Resolve a worker-supplied relative path to an absolute path inside the
// clone, failing loudly on any form of escape — including via symlinks. The
// target itself does not have to exist (writes create new files), but every
// ancestor component that *does* exist must realpath back inside the clone.

import { promises as fs } from "node:fs";
import path from "node:path";

export async function resolveSafe(clone: string, relPath: string): Promise<string> {
  if (!clone) throw new Error("no active clone path");
  if (path.isAbsolute(relPath)) throw new Error(`absolute path not allowed: ${relPath}`);

  // Lexical check first — cheap, and catches the obvious `../` cases without
  // touching the filesystem.
  const abs = path.resolve(clone, relPath);
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
