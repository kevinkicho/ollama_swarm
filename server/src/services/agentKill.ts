/**
 * Multi-stage process kill escalation used by AgentManager.killAll.
 * Extracted for modularity; pure enough to unit-test without full manager.
 */

import type { ChildProcess } from "node:child_process";
import { treeKill, killByPid, killByPort, isProcessAlive } from "./treeKill.js";

/**
 * Stage 1: treeKill + poll
 * Stage 2: killByPid + poll
 * Stage 3: killByPort (when port still held by a different PID)
 *
 * @returns escaped=true if process(es) still alive after all stages
 */
export async function escalateProcessKill(opts: {
  child?: ChildProcess;
  port?: number;
}): Promise<{ escaped: boolean }> {
  const { child, port } = opts;
  treeKill(child);
  const pid = child?.pid;
  if (pid === undefined) {
    return { escaped: false };
  }

  let dead = !isProcessAlive(pid);
  for (let i = 0; i < 10 && !dead; i++) {
    await new Promise((r) => setTimeout(r, 300));
    if (!isProcessAlive(pid)) {
      dead = true;
      break;
    }
    if (i === 2) treeKill(child);
  }
  if (!dead) {
    killByPid(pid);
    for (let i = 0; i < 10 && !dead; i++) {
      await new Promise((r) => setTimeout(r, 300));
      if (!isProcessAlive(pid)) {
        dead = true;
        break;
      }
      if (i === 2) killByPid(pid);
    }
  }

  const portKilled = port !== undefined && port > 0 ? killByPort(port) : [];
  if (portKilled.length > 0) {
    let allPortDead = false;
    for (let i = 0; i < 10 && !allPortDead; i++) {
      await new Promise((r) => setTimeout(r, 300));
      allPortDead = portKilled.every((p) => !isProcessAlive(p));
      if (i === 2 && !allPortDead) {
        for (const p of portKilled) killByPid(p);
      }
    }
    if (!allPortDead) return { escaped: true };
    return { escaped: false };
  }

  return { escaped: !dead };
}
