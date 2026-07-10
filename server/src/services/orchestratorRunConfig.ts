// Build SwarmStatusRunConfig snapshot for run_started + status() — extracted from Orchestrator.start.

import type { RunConfig } from "../swarm/SwarmRunner.js";
import type { SwarmStatusRunConfig } from "../types.js";

/** Snapshot of start-time config for WS run_started and REST status. */
export function buildSwarmStatusRunConfig(
  cfg: RunConfig,
  rolesForRunStarted: string[] | undefined,
): SwarmStatusRunConfig {
  return {
    preset: cfg.preset,
    // Per-agent overrides (Unit 42) fall back to cfg.model when absent.
    plannerModel: cfg.plannerModel ?? cfg.model,
    workerModel: cfg.workerModel ?? cfg.model,
    // Auditor model fallback chain matches BlackboardRunner: explicit
    // override → planner override → main model. Same surface as the
    // runner so the UI label is honest about what's actually running.
    auditorModel: cfg.auditorModel ?? cfg.plannerModel ?? cfg.model,
    dedicatedAuditor: cfg.dedicatedAuditor === true,
    roles: rolesForRunStarted,
    repoUrl: cfg.repoUrl,
    clonePath: cfg.localPath,
    agentCount: cfg.agentCount,
    rounds: cfg.rounds,
    // Phase 4b of #243: include the resolved topology so the UI can
    // mirror exact agent specs (role chip + model override) without
    // re-deriving from preset+index. cfg.topology is always populated
    // by the route layer (synthesized from legacy fields when client
    // didn't post one).
    topology: cfg.topology,
    // Map server cfg caps to client strings for run events / status.
    wallClockCapMin: cfg.wallClockCapMs
      ? Math.round(cfg.wallClockCapMs / 60000).toString()
      : undefined,
    ambitionTiers: cfg.ambitionTiers !== undefined ? String(cfg.ambitionTiers) : undefined,
    ...(cfg.userDirective?.trim()
      ? { userDirective: cfg.userDirective.trim() }
      : {}),
    ...(cfg.plannerTools !== undefined ? { plannerTools: cfg.plannerTools } : {}),
    ...(cfg.webTools !== undefined ? { webTools: cfg.webTools } : {}),
    ...(cfg.mcpServers ? { mcpServers: cfg.mcpServers } : {}),
    ...(cfg.thinkGuardRefereeEnabled != null
      ? { thinkGuardRefereeEnabled: cfg.thinkGuardRefereeEnabled }
      : {}),
    ...(cfg.thinkGuardRefereeMaxCallsPerRun != null
      ? { thinkGuardRefereeMaxCallsPerRun: cfg.thinkGuardRefereeMaxCallsPerRun }
      : {}),
    ...(cfg.thinkGuardRefereeMinThinkChars != null
      ? { thinkGuardRefereeMinThinkChars: cfg.thinkGuardRefereeMinThinkChars }
      : {}),
    ...(cfg.thinkGuardRefereeThinkTailMinChars != null
      ? { thinkGuardRefereeThinkTailMinChars: cfg.thinkGuardRefereeThinkTailMinChars }
      : {}),
    ...(cfg.thinkGuardRefereeThinkTailMaxChars != null
      ? { thinkGuardRefereeThinkTailMaxChars: cfg.thinkGuardRefereeThinkTailMaxChars }
      : {}),
    ...(cfg.thinkGuardRefereeMaxOutputTokens != null
      ? { thinkGuardRefereeMaxOutputTokens: cfg.thinkGuardRefereeMaxOutputTokens }
      : {}),
  };
}
