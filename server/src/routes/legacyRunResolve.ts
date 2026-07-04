import type { Orchestrator } from "../services/Orchestrator.js";

export type LegacyRunResolveResult =
  | { ok: true; runId: string }
  | { ok: false; status: number; error: string; runIds?: string[] };

/** Resolve a single active run for legacy /stop /say /drain /status routes. */
export function resolveLegacyActiveRunId(
  orch: Orchestrator,
  runId?: string,
): LegacyRunResolveResult {
  if (runId) {
    const active = orch.listActiveRuns();
    const match = active.find((r) => r.runId === runId || (runId && (r.runId.startsWith(runId) || runId.startsWith(r.runId))));
    if (match) {
      return { ok: true, runId: match.runId };
    }
    // Explicit runId provided (e.g. from a /runs/<id> view of a just-finished run).
    // Pass it through; the downstream drain/stopRun will succeed (idempotent)
    // for known-finished runs or 404 for completely unknown.
    return { ok: true, runId };
  }

  const active = orch.listActiveRuns();
  if (active.length === 0) {
    return { ok: false, status: 404, error: "No active run" };
  }
  if (active.length === 1) {
    return { ok: true, runId: active[0].runId };
  }

  return {
    ok: false,
    status: 409,
    error: "Multiple active runs; use /api/swarm/runs/:runId/* or pass runId",
    runIds: active.map((r) => r.runId),
  };
}