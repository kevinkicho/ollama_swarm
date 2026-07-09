import path from "node:path";
import { readdir, stat } from "node:fs/promises";
import { normalizeWslPath } from "../services/pathNormalize.js";
import type { Orchestrator } from "../services/Orchestrator.js";

/** Mirror GET /api/swarm/runs parent discovery for graph scans. */
export async function collectParentsToScan(
  orch: Orchestrator,
  queryParentPath?: string,
): Promise<Set<string>> {
  const status = orch.status();
  const activeParent = queryParentPath
    ? normalizeWslPath(queryParentPath)
    : (status.localPath ? path.dirname(path.resolve(status.localPath)) : null)
      ?? orch.getLastParentPath();

  const parentsToScan = new Set<string>();
  if (activeParent) parentsToScan.add(activeParent);

  if (activeParent) {
    const logsDir = activeParent.endsWith("/logs") || activeParent.endsWith("\\logs")
      ? activeParent
      : path.join(activeParent, "logs");
    try {
      const st = await stat(logsDir);
      if (st.isDirectory()) {
        const logEntries = await readdir(logsDir);
        for (const entry of logEntries) {
          const entryPath = path.join(logsDir, entry);
          try {
            if ((await stat(entryPath)).isDirectory()) parentsToScan.add(entryPath);
          } catch { /* skip */ }
        }
      }
    } catch { /* no logs */ }
  }

  const initialParents = [...parentsToScan];
  for (const p of initialParents) {
    const clogs = path.join(p, "logs");
    try {
      const st = await stat(clogs);
      if (st.isDirectory()) {
        const subs = await readdir(clogs);
        for (const s of subs) {
          const sp = path.join(clogs, s);
          try {
            if ((await stat(sp)).isDirectory()) parentsToScan.add(sp);
          } catch { /* skip */ }
        }
      }
    } catch { /* skip */ }
  }

  if (parentsToScan.size === 0) {
    const cwd = process.cwd();
    parentsToScan.add(cwd);
    parentsToScan.add(path.join(cwd, "logs"));
    for (const p of orch.getKnownParentPaths()) parentsToScan.add(p);
    const last = orch.getLastParentPath();
    if (last) parentsToScan.add(last);
  }

  return parentsToScan;
}