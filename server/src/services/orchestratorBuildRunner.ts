/**
 * Runner construction for Orchestrator (buildRunner + createRunnerOpts).
 * Extracted for LOC hygiene — keeps Orchestrator focused on run lifecycle.
 */

import type { AgentManager } from "./AgentManager.js";
import type { RepoService } from "./RepoService.js";
import type { SwarmEvent } from "../types.js";
import type { PresetId, RunConfig, RunnerOpts, SwarmRunner } from "../swarm/SwarmRunner.js";
import type { RunStatePersister } from "./RunStatePersister.js";
import type { RunEventHub } from "./RunEventHub.js";
import type { AmendmentsBuffer } from "./AmendmentsBuffer.js";
import type { BrainIntegration } from "./BrainIntegration.js";
import { prepareResearchConfig } from "../swarm/researchHelpers.js";
import { selectRoleCatalog } from "../swarm/roles.js";
import { createWrappedEmit as createWrappedEmitExtracted } from "./orchestratorEmit.js";

/** Per-run context threaded into buildRunner. */
export interface BuildRunnerContext {
  runId: string;
  startedAt: number;
  persister: RunStatePersister;
  manager: AgentManager;
  getRunner: () => SwarmRunner;
  hub?: RunEventHub;
}

export interface BuildRunnerDeps {
  repos: RepoService;
  emit: (e: SwarmEvent) => void;
  logDiag?: (record: unknown) => void;
  ollamaBaseUrl?: string;
  brain: BrainIntegration;
  amendments: AmendmentsBuffer;
}

export function createRunnerOpts(
  deps: BuildRunnerDeps,
  runId: string,
  manager: AgentManager,
  wrappedEmit: (e: SwarmEvent) => void,
  cfg: RunConfig,
): RunnerOpts {
  return {
    manager,
    repos: deps.repos,
    emit: wrappedEmit,
    logDiag: deps.logDiag,
    ollamaBaseUrl: deps.ollamaBaseUrl,
    getAmendments: () => deps.amendments.list(runId),
    // Brain enablement controlled only by enableBrainAnalysis.
    getBrainService: cfg.enableBrainAnalysis === false
      ? () => null
      : () => deps.brain.getService(),
  };
}

export async function buildRunner(
  deps: BuildRunnerDeps,
  preset: PresetId,
  cfg: RunConfig,
  ctx: BuildRunnerContext,
): Promise<SwarmRunner> {
  // Carved research helper: normalize for scientific/internet use cases
  cfg = prepareResearchConfig(cfg);
  const { runId, startedAt, persister, manager, getRunner } = ctx;
  const wrappedEmit = createWrappedEmitExtracted({
    runId,
    startedAt,
    cfg,
    persister,
    hub: ctx.hub,
    getRunner,
    baseEmit: deps.emit,
    brain: deps.brain,
    amendments: deps.amendments,
  });
  const opts: RunnerOpts = createRunnerOpts(deps, runId, manager, wrappedEmit, cfg);

  const { createRunner } = await import("../swarm/presetRouter.js");
  const roles =
    preset === "role-diff"
      ? selectRoleCatalog({
          customRoles: cfg.roles,
          userDirective: cfg.userDirective,
          dynamicRoles: cfg.dynamicRoles,
        })
      : undefined;
  return createRunner(cfg, opts, {
    rolesForRoleDiff: roles,
    baselineMultiAttempt: preset === "baseline" && (cfg.baselineAttempts ?? 1) > 1,
    pipelineFactory:
      preset === "pipeline"
        ? async (p: PresetId) => buildRunner(deps, p, cfg, ctx)
        : undefined,
  });
}
