/**
 * Post-run forward-chain: after a run stops, read next-actions and start
 * a follow-up preset. Extracted from Orchestrator.scheduleForwardChain.
 */

import type { SwarmEvent } from "../types.js";
import type { RunConfig, SwarmRunner } from "../swarm/SwarmRunner.js";

export interface ForwardChainDeps {
  runsHas: (runId: string) => boolean;
  stopRun: (runId: string) => Promise<boolean>;
  start: (cfg: RunConfig) => Promise<string>;
  emit: (e: SwarmEvent) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
}

/**
 * Poll until the original runner stops, then chain to blackboard/baseline
 * using the top next-action from the prior run's deliverable.
 */
export async function scheduleForwardChain(
  deps: ForwardChainDeps,
  originalCfg: RunConfig,
  originalRunId: string,
  originalRunner: SwarmRunner,
  chainPreset: "blackboard" | "baseline",
): Promise<void> {
  const POLL_MS = 5_000;
  const MAX_WAIT_MS = 4 * 60 * 60_000;
  const waitStartedAt = Date.now();
  while (
    originalRunner.isRunning()
    && Date.now() - waitStartedAt < MAX_WAIT_MS
  ) {
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  if (!deps.runsHas(originalRunId)) return;

  let topAction: string | null = null;
  try {
    const { readTopNextAction } = await import("../swarm/wrapUpApplyPhase.js");
    topAction = await readTopNextAction({
      clonePath: originalCfg.localPath,
      runId: originalRunId,
      presetName: originalCfg.preset,
    });
  } catch (err) {
    deps.emit({
      type: "error",
      message: `forward-chain: failed to read next-actions JSON — ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }
  if (!topAction) {
    deps.emit({
      type: "error",
      message: `forward-chain: no extractable next-action in deliverable; nothing to chain to ${chainPreset}.`,
    });
    return;
  }

  try {
    await deps.stopRun(originalRunId);
  } catch (err) {
    deps.warn("forward-chain-stop-failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const chainedCfg: RunConfig = {
    ...originalCfg,
    preset: chainPreset,
    userDirective: topAction,
    chainTo: undefined,
    agentCount:
      chainPreset === "blackboard" && originalCfg.agentCount < 3
        ? 3
        : originalCfg.agentCount,
  };
  try {
    await deps.start(chainedCfg);
  } catch (err) {
    deps.emit({
      type: "error",
      message: `forward-chain: chained ${chainPreset} run failed to start — ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}
