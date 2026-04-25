// Unit 38: on dev-server startup, reclaim orphaned opencode subprocesses
// that survived the previous server instance. Reads the
// AgentPidTracker log, probes each PID for liveness, kills the
// live-but-unowned ones, and clears the log so the next run starts with
// a blank slate.
//
// Called from `server/src/index.ts` BEFORE `server.listen` so the dev
// server doesn't start accepting swarm-start requests until orphans are
// cleaned up. This prevents port-allocator collisions (new agents
// getting a port an orphan still holds) and bounds cumulative resource
// leak across restarts.

import { AgentPidTracker, type AgentPidRecord } from "./agentPids.js";
import { isProcessAlive, killByPid, killByPort } from "./treeKill.js";

export interface ReclaimResult {
  scanned: number;
  alive: number;
  killed: number;
  portKilled: number;
  records: AgentPidRecord[];
}

export async function reclaimOrphans(repoRoot: string): Promise<ReclaimResult> {
  const tracker = new AgentPidTracker(repoRoot);
  const records = await tracker.readAll();
  let alive = 0;
  let killed = 0;
  let portKilled = 0;
  for (const record of records) {
    // Stage 1: kill by PID if it's alive.
    if (isProcessAlive(record.pid)) {
      alive += 1;
      killByPid(record.pid);
      killed += 1;
    }
    // Task #122: stage 2 — kill anything still holding the port. The
    // tracked PID may be a launcher that already exited; the actual
    // long-running opencode process has a different PID. We still
    // know its port, so look up whoever owns it and kill them too.
    const portTargets = killByPort(record.port);
    if (portTargets.length > 0) {
      portKilled += portTargets.length;
    }
  }
  // Always clear the log regardless of alive count — every record was
  // either already dead (nothing to do) or just got killed. Any NEW
  // agent a running swarm is about to spawn will re-populate the log.
  if (records.length > 0) {
    await tracker.clear();
  }
  return { scanned: records.length, alive, killed, portKilled, records };
}
