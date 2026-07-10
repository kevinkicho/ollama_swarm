import path from "node:path";
import { config } from "../config.js";
import { normalizeWslPath } from "./pathNormalize.js";

/**
 * When SWARM_WORKSPACE_ROOTS is set, ensure candidate absolute path is
 * under one of the configured roots (or equal to a root).
 */
export function assertUnderWorkspaceRoots(candidateAbs: string): { ok: true } | { ok: false; error: string } {
  const roots = config.SWARM_WORKSPACE_ROOTS;
  if (!roots || roots.length === 0) return { ok: true };

  const resolved = path.resolve(normalizeWslPath(candidateAbs));
  const win = process.platform === "win32";
  const norm = (p: string) => (win ? p.toLowerCase() : p);

  for (const root of roots) {
    const r = path.resolve(normalizeWslPath(root));
    const nr = norm(r);
    const nc = norm(resolved);
    if (nc === nr || nc.startsWith(nr + path.sep) || (win && nc.startsWith(nr + "/"))) {
      return { ok: true };
    }
  }
  return {
    ok: false,
    error: `path is outside configured SWARM_WORKSPACE_ROOTS (${roots.join(", ")}): ${resolved}`,
  };
}
