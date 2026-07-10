// Small helpers extracted from lifecycleRunner.ts (no LifecycleContext import cycle).

import type { AgentManager } from "../../services/AgentManager.js";
import type { AgentState } from "../../types.js";
import type { LifecycleState } from "./lifecycleState.js";
import {
  isStopping as lifecycleIsStopping,
  isDraining as lifecycleIsDraining,
} from "./lifecycleState.js";
import type { ChatStreamingSurface } from "./promptRunner.js";
import type { RunConfig } from "../SwarmRunner.js";
import { isPlanningWallClockExceeded } from "./planningPolicy.js";

export interface LifecycleChatSurfaceHost {
  getManager: () => AgentManager;
  emitAgentState: (s: AgentState) => void;
  getActiveAborts: () => Set<AbortController>;
  getLifecycleState: () => LifecycleState;
}

export function lifecycleChatSurface(
  ctx: LifecycleChatSurfaceHost,
  activity: { kind: string; label: string },
): ChatStreamingSurface {
  return {
    manager: ctx.getManager(),
    emitAgentState: (s) => ctx.emitAgentState(s),
    activity,
    abort: {
      activeAborts: ctx.getActiveAborts(),
      isStopping: () => lifecycleIsStopping(ctx.getLifecycleState()),
      isDraining: () => lifecycleIsDraining(ctx.getLifecycleState()),
    },
  };
}

export interface PlanningWallClockHost {
  getPlanningStartedAt: () => number | undefined;
  getActive: () => RunConfig | undefined;
}

export function assertPlanningWithinWallClock(ctx: PlanningWallClockHost): void {
  if (!isPlanningWallClockExceeded(ctx.getPlanningStartedAt(), ctx.getActive())) return;
  const capMin = Math.round(
    ((ctx.getActive()?.planningWallClockCapMs ?? 15 * 60_000) / 60_000),
  );
  throw new Error(`planning wall-clock cap (${capMin} min) exceeded`);
}
