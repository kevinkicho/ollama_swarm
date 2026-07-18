import type { SwarmStatus, AgentState, TranscriptEntry, TranscriptEntrySummary } from "../../types.js";
import type { RunConfig } from "../SwarmRunner.js";
import type { ExitContract } from "./types.js";
import type { RunSummary } from "./summary.js";
import { boardCounts as boardCountsExtracted, boardSnapshot as boardSnapshotExtracted, type RunnerUtilContext } from "./runnerUtil.js";
import { isDrainEligible, drainIneligibleReason } from "@ollama-swarm/shared/drainEligibility";
import { resolveThinkGuardRefereeBudget } from "@ollama-swarm/shared/thinkGuardBudget";
import { resolveDisplayPhase } from "@ollama-swarm/shared/mapRunPhase";
import type { RunPhase } from "@ollama-swarm/shared/runStateMachine";
import { config } from "../../config.js";
import { snapshotProgressHeartbeat } from "../progressHeartbeat.js";
import { snapshotCycleIntegrityForRun } from "../cycleIntegrityStats.js";
import { listActiveHelpers } from "../brainOs/helperActivity.js";

export interface StatusContext {
  phase: string;
  /** V2 state machine snapshot — when set, terminal/pause display prefers V2. */
  v2Phase?: RunPhase;
  v2PausedReason?: string;
  planningSubphase?: import("@ollama-swarm/shared/planningSubphase").PlanningSubphase;
  getDrainEligibilityInput?: (partial: { claimed: number; pendingCommit: number }) => import("./drainEligibility.js").DrainEligibilityInput;
  getTodoQueueCounts?: () => { pendingCommit: number };
  round: number;
  active?: RunConfig;
  transcript: TranscriptEntry[];
  lastSummary?: RunSummary;
  contract?: ExitContract;
  cloneStateForStatus?: {
    alreadyPresent: boolean;
    clonePath: string;
    priorCommits: number;
    priorChangedFiles: number;
    priorUntrackedFiles: number;
  };
  runBootedAt?: number;
  recentLatencySamples: Map<string, Array<{ ts: number; elapsedMs: number; success: boolean; attempt: number }>>;
  cloneContract: (c: ExitContract) => ExitContract;
  agentStates: () => AgentState[];
  getPartialStreams: () => Record<string, { text: string; updatedAt: number }>;
  getActivitySnapshot?: () => NonNullable<SwarmStatus["agentActivity"]>;
  /** Cap termination reason (wall-clock / token / cost) for early-stop UI. */
  getTerminationReason?: () => string | undefined;
  /** Natural stop / stuck / no-progress reason (not always a cap). */
  getCompletionDetail?: () => string | undefined;
  utilCtx: () => RunnerUtilContext;
}

export function status(ctx: StatusContext): SwarmStatus {
  const board = boardSnapshotExtracted(ctx.utilCtx());
  const counts = boardCountsExtracted(ctx.utilCtx());
  const latency: Record<string, Array<{ ts: number; elapsedMs: number; success: boolean; attempt: number }>> = {};
  for (const [agentId, samples] of ctx.recentLatencySamples.entries()) {
    latency[agentId] = samples.map((s) => ({ ...s }));
  }
  const runConfig = ctx.active
    ? {
        preset: ctx.active.preset,
        plannerModel: ctx.active.plannerModel ?? ctx.active.model,
        workerModel: ctx.active.workerModel ?? ctx.active.model,
        auditorModel: ctx.active.auditorModel ?? ctx.active.plannerModel ?? ctx.active.model,
        dedicatedAuditor: ctx.active.dedicatedAuditor === true,
        repoUrl: ctx.active.repoUrl,
        clonePath: ctx.active.localPath,
        agentCount: ctx.active.agentCount,
        rounds: ctx.active.rounds,
        topology: ctx.active.topology,
        wallClockCapMin: ctx.active.wallClockCapMs
          ? Math.round(ctx.active.wallClockCapMs / 60000).toString()
          : undefined,
        ambitionTiers:
          ctx.active.ambitionTiers !== undefined
            ? String(ctx.active.ambitionTiers)
            : undefined,
        ...(ctx.active.userDirective?.trim()
          ? { userDirective: ctx.active.userDirective.trim() }
          : {}),
        ...(ctx.active.plannerTools !== undefined
          ? { plannerTools: ctx.active.plannerTools }
          : {}),
        ...(ctx.active.webTools !== undefined ? { webTools: ctx.active.webTools } : {}),
        ...(ctx.active.mcpServers ? { mcpServers: ctx.active.mcpServers } : {}),
        ...(ctx.active.thinkGuardRefereeEnabled != null
          ? { thinkGuardRefereeEnabled: ctx.active.thinkGuardRefereeEnabled }
          : {}),
        ...(ctx.active.thinkGuardRefereeMaxCallsPerRun != null
          ? { thinkGuardRefereeMaxCallsPerRun: ctx.active.thinkGuardRefereeMaxCallsPerRun }
          : {}),
        ...(ctx.active.thinkGuardRefereeMinThinkChars != null
          ? { thinkGuardRefereeMinThinkChars: ctx.active.thinkGuardRefereeMinThinkChars }
          : {}),
        ...(ctx.active.thinkGuardRefereeThinkTailMinChars != null
          ? { thinkGuardRefereeThinkTailMinChars: ctx.active.thinkGuardRefereeThinkTailMinChars }
          : {}),
        ...(ctx.active.thinkGuardRefereeThinkTailMaxChars != null
          ? { thinkGuardRefereeThinkTailMaxChars: ctx.active.thinkGuardRefereeThinkTailMaxChars }
          : {}),
        ...(ctx.active.thinkGuardRefereeMaxOutputTokens != null
          ? { thinkGuardRefereeMaxOutputTokens: ctx.active.thinkGuardRefereeMaxOutputTokens }
          : {}),
      }
    : undefined;
  const thinkGuardReferee = ctx.active
    ? resolveThinkGuardRefereeBudget(ctx.active, config.THINK_GUARD_REFEREE_ENABLED)
    : undefined;
  const pendingCommit = ctx.getTodoQueueCounts?.().pendingCommit ?? 0;
  const drainInput = ctx.getDrainEligibilityInput
    ? ctx.getDrainEligibilityInput({ claimed: counts.claimed, pendingCommit })
    : { phase: ctx.phase, claimed: counts.claimed, pendingCommit };
  const drainEligible = isDrainEligible(drainInput);
  const drainReason = drainEligible ? undefined : drainIneligibleReason(drainInput);

  const wallCap = ctx.active?.wallClockCapMs;
  let wallClockMsRemaining: number | undefined;
  if (wallCap && wallCap > 0 && ctx.runBootedAt != null) {
    // Coarse remaining (display only); exec-active elapsed is clamped separately in capManager.
    wallClockMsRemaining = Math.max(0, wallCap - (Date.now() - ctx.runBootedAt));
  }

  const displayPhase =
    ctx.v2Phase !== undefined
      ? resolveDisplayPhase(ctx.phase, {
          phase: ctx.v2Phase,
          pausedReason: ctx.v2PausedReason,
        })
      : ctx.phase;

  return {
    phase: displayPhase as import("../../types.js").SwarmPhase,
    ...(ctx.v2Phase
      ? {
          runStateV2: {
            phase: ctx.v2Phase,
            pausedReason: ctx.v2PausedReason,
          },
        }
      : {}),
    ...(ctx.planningSubphase ? { planningSubphase: ctx.planningSubphase } : {}),
    drainEligible,
    ...(drainReason ? { drainIneligibleReason: drainReason } : {}),
    ...(wallClockMsRemaining != null
      ? { capsRemaining: { wallClockMsRemaining } }
      : {}),
    ...(() => {
      const hb = snapshotProgressHeartbeat(ctx.active?.runId);
      return hb ? { progressHeartbeat: hb } : {};
    })(),
    ...(() => {
      const cycleIntegrity = snapshotCycleIntegrityForRun(ctx.active?.runId);
      return cycleIntegrity ? { cycleIntegrity } : {};
    })(),
    round: ctx.round,
    repoUrl: ctx.active?.repoUrl,
    localPath: ctx.active?.localPath,
    model: ctx.active?.model,
    agents: ctx.agentStates(),
    transcript: [...ctx.transcript],
    summary: ctx.lastSummary,
    contract: ctx.contract ? ctx.cloneContract(ctx.contract) : undefined,
    cloneState: ctx.cloneStateForStatus,
    runConfig,
    runStartedAt: ctx.runBootedAt,
    board: { todos: board.todos, findings: board.findings, counts },
    latency,
    streaming: ctx.getPartialStreams(),
    ...((): { agentActivity?: SwarmStatus["agentActivity"] } => {
      const agentActivity = ctx.getActivitySnapshot?.();
      return agentActivity && Object.keys(agentActivity).length > 0
        ? { agentActivity }
        : {};
    })(),
    ...((): { earlyStopDetail?: string } => {
      // Prefer hard cap/termination; fall back to completionDetail so
      // no-productive-progress / stuck stops surface on RunHealthChip live.
      const reason =
        ctx.getTerminationReason?.()
        || ctx.getCompletionDetail?.();
      return reason ? { earlyStopDetail: reason } : {};
    })(),
    ...(thinkGuardReferee ? { thinkGuardReferee } : {}),
    ...((): { brainOsHelpers?: SwarmStatus["brainOsHelpers"] } => {
      const runId = ctx.active?.runId;
      if (!runId) return {};
      const helpers = listActiveHelpers(runId);
      if (helpers.length === 0) return {};
      return {
        brainOsHelpers: helpers.map((h) => ({
          helperId: h.helperId,
          kind: h.kind,
          privilege: h.privilege,
          depth: h.depth,
          model: h.model,
          startedAt: h.startedAt,
          phase: h.phase,
        })),
      };
    })(),
  };
}