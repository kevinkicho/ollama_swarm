// Per-run wrapped emit + persistence scheduling — extracted from Orchestrator.

import type { RunConfig } from "../swarm/SwarmRunner.js";
import type { SwarmRunner } from "../swarm/SwarmRunner.js";
import type { SwarmEvent } from "../types.js";
import type { RunStatePersister } from "./RunStatePersister.js";
import type { RunEventHub } from "./RunEventHub.js";
import type { AmendmentsBuffer } from "./AmendmentsBuffer.js";
import type { BrainIntegration } from "./BrainIntegration.js";

export interface CreateWrappedEmitParams {
  runId: string;
  startedAt: number;
  cfg: RunConfig;
  persister: RunStatePersister;
  hub?: RunEventHub;
  getRunner: () => SwarmRunner;
  baseEmit: (e: SwarmEvent) => void;
  brain: BrainIntegration;
  amendments: AmendmentsBuffer;
}

/**
 * Creates the wrapped emit that stamps runId, routes via hub, calls base
 * emit, tracks brain health, and schedules persistence snapshots.
 */
export function createWrappedEmit(params: CreateWrappedEmitParams): (e: SwarmEvent) => void {
  const {
    runId,
    startedAt,
    cfg,
    persister,
    hub,
    getRunner,
    baseEmit,
    brain,
    amendments,
  } = params;
  return (e: SwarmEvent) => {
    const stamped: SwarmEvent =
      e.runId === undefined ? { ...e, runId } : e;

    if (hub) hub.emit(stamped as any, "lifecycle");
    baseEmit(stamped);
    brain.trackRunHealth(stamped);
    const runner = getRunner();
    if (!runner) return;
    const status = runner.status();
    const { preset: p, repoUrl, localPath, agentCount, rounds, model, ...extras } = cfg;
    persister.schedule({
      runId,
      preset: cfg.preset,
      phase: status?.phase ?? "unknown",
      startedAt,
      transcript: status?.transcript ?? [],
      amendments: amendments.list(runId),
      brainChatHistory: brain.getChatHistory(runId),
      runConfig: {
        preset: p,
        repoUrl,
        localPath,
        agentCount,
        rounds,
        model,
        ...(Object.keys(extras).length > 0 ? { extras } : {}),
      },
      contract: status?.contract,
    });
  };
}
