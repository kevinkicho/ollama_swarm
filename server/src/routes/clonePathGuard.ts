import path from "node:path";
import type { Orchestrator } from "../services/Orchestrator.js";
import { normalizeWslPath } from "../services/pathNormalize.js";

export type ClonePathGuardResult =
  | { ok: true; resolved: string }
  | { ok: false; status: number; error: string };

/** Resolve clonePath and verify it is a known run directory. */
export function assertAllowedClonePath(
  orch: Orchestrator,
  clonePath: string,
): ClonePathGuardResult {
  const resolved = path.resolve(normalizeWslPath(clonePath));

  for (const tracked of orch.getTrackedClonePaths()) {
    const t = path.resolve(normalizeWslPath(tracked));
    if (resolved === t) {
      return { ok: true, resolved };
    }
    // Allow the clone root's subdirectories (logs/<runid>/ etc) and the logs dir itself.
    // Covers review ?path= that point at per-run summary folders under the project clone.
    const tLogs = path.join(t, "logs");
    if (resolved.startsWith(t + path.sep) || resolved === tLogs || resolved.startsWith(tLogs + path.sep)) {
      return { ok: true, resolved };
    }
  }

  const parent = path.dirname(resolved);
  const parentsToCheck: string[] = [...orch.getKnownParentPaths()];
  const lastParent = orch.getLastParentPath();
  if (lastParent) parentsToCheck.push(lastParent);

  for (const knownParent of parentsToCheck) {
    const kp = path.resolve(normalizeWslPath(knownParent));
    if (parent === kp || resolved === kp || resolved.startsWith(kp + path.sep)) {
      return { ok: true, resolved };
    }
    const logsDir = path.join(kp, "logs");
    if (resolved === logsDir || resolved.startsWith(logsDir + path.sep)) {
      return { ok: true, resolved };
    }
  }

  return {
    ok: false,
    status: 403,
    error: "clonePath is not an allowed run directory",
  };
}