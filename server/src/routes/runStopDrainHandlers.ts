/**
 * Shared stop/drain handlers so legacy `/stop`/`/drain` and multi-tenant
 * `/runs/:runId/stop`/`/runs/:runId/drain` share one policy (including
 * SWARM_DRAIN_ON_STOP double-click kill).
 */

import { decideStopAction } from "../swarm/drainStopPolicy.js";
import type { PerRunStopDebounce } from "../swarm/control/perRunStopDebounce.js";

export type DrainMode = "soft" | "hard-fallback" | "already-stopped";

export type StopDrainOrchestrator = {
  stopRun(runId: string): Promise<boolean>;
  drainRun(
    runId: string,
  ): Promise<false | { ok: true; mode: DrainMode }>;
};

export type JsonResult = {
  status: number;
  body: Record<string, unknown>;
};

export async function executeStopForRun(
  orch: StopDrainOrchestrator,
  runId: string,
  opts: {
    drainOnStop: boolean;
    debounce: PerRunStopDebounce;
  },
): Promise<JsonResult> {
  try {
    if (opts.drainOnStop) {
      const decision = decideStopAction({
        now: Date.now(),
        lastStopAt: opts.debounce.get(runId),
      });
      opts.debounce.touch(runId);
      if (decision.action === "drain") {
        const result = await orch.drainRun(runId);
        if (!result) {
          return { status: 404, body: { error: "runId not active" } };
        }
        return {
          status: 200,
          body: {
            ok: true,
            action: "drain",
            mode: result.mode,
            reason: decision.reason,
          },
        };
      }
    }
    const ok = await orch.stopRun(runId);
    if (!ok) {
      return { status: 404, body: { error: "runId not active" } };
    }
    return { status: 200, body: { ok: true, action: "kill" } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 500, body: { error: msg } };
  }
}

export async function executeDrainForRun(
  orch: StopDrainOrchestrator,
  runId: string,
): Promise<JsonResult> {
  try {
    const result = await orch.drainRun(runId);
    if (!result) {
      return { status: 404, body: { error: "runId not active" } };
    }
    const message =
      result.mode === "soft"
        ? "Soft drain started — finish in-flight work, then stop."
        : result.mode === "hard-fallback"
          ? "Runner has no soft drain — hard-stopped instead."
          : "Run already stopped.";
    return {
      status: 200,
      body: {
        ok: true,
        mode: result.mode,
        message,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 500, body: { error: msg } };
  }
}
