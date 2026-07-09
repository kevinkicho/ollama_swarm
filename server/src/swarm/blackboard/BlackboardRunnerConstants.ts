// Module-level constants and pure helpers extracted from BlackboardRunner.
// Zero runtime coupling to BlackboardRunner state — these are either numeric
// constants or pure functions.

import type { Topology } from "../../../../shared/src/topology.js";

// V2 cutover Phase 2c (2026-04-28): in-progress timeout. The reaper
// transitions any in-progress todo older than this to failed →
// replan. Was originally V1's CLAIM_TTL_MS (10 min); kept the same
// value so behavior carries over.
export const IN_PROGRESS_TTL_MS = 10 * 60_000;
export const REAPER_INTERVAL_MS = 30_000;
export const WORKER_POLL_MS = 2_000;
export const WORKER_POLL_JITTER_MS = 500;
export const WORKER_COOLDOWN_MS = 5_000;
// Phase 6: after this many replans, stop trying and mark the todo skipped.
// Keeps a pathological todo from burning planner turns indefinitely.
export const MAX_REPLAN_ATTEMPTS = 3;
// Fallback sweep in case the event path missed a stale (e.g. replanOne threw).
export const REPLAN_FALLBACK_TICK_MS = 20_000;
// Backstop on the drain-audit-repeat loop. Without this, a confused auditor
// could keep proposing todos that workers produce empty diffs for, cycling
// forever. The cap is now `cfg.rounds` (the setup-form "Rounds" value) —
// Unit 11 flipped this from a hardcoded 5 so users can turn the knob.
// `cfg.rounds` is validated to [1, 10] by the Zod schema on the start
// endpoint. See `maxAuditInvocations` getter below.
// No "idle silence" cap. OpenCode's SSE /event stream is observed to stay
// completely silent across session.prompt's entire duration for our setup, so
// there is no reliable activity signal to gate on. We rely solely on the
// absolute turn cap below — if a prompt hasn't returned in 20 minutes, abort.
export const ABSOLUTE_MAX_MS = 20 * 60_000;
// Task #165: pause-on-quota constants. When the proxy detects a
// persistent Ollama-quota wall, the run pauses (workers idle, no
// new prompts) and probes upstream on an exponential schedule
// (1m, 2m, 4m, 8m, 16m, capped at 30m — see quotaProbeBackoff.ts).
// Resume on first successful probe. Total pause time is capped so
// a never-clearing wall (plan exhausted till next billing cycle)
// eventually escalates to a real cap:quota halt rather than
// pausing forever.
//
// 2026-05-04 (R2 wiring): replaced the fixed 5-min PAUSE_PROBE_INTERVAL_MS
// with nextQuotaProbeDelayMs(attempt). Brief blips clear in 1-2 min
// without the full 5; long walls don't churn the transcript every 5.
export const MAX_PAUSE_TOTAL_MS = 2 * 60 * 60_000;
// Task #167: soft-stop deadline. After drain() fires we wait up to
// this long for in-flight worker claims to commit cleanly; if they
// don't, escalate to hard stop. 3 minutes covers a normal worker
// turn (usually <60s on glm/gemma) plus headroom for retries.
export const DRAIN_DEADLINE_MS = 3 * 60_000;
/** Abort hung in-flight prompts during drain so the UI does not sit on
 *  "thinking" with an empty transcript until the full 3-minute backstop. */
export const DRAIN_STUCK_PROMPT_MS = 90_000;
/** When drain is eligible but only prompts are hung (0 claims), abort sooner. */
export const DRAIN_STUCK_PROMPT_NO_CLAIMS_MS = 5_000;
export const DRAIN_WATCHER_INTERVAL_MS = 2_000;

/** Default planning-phase wall clock (separate from worker-loop cap). */
export const PLANNING_WALL_CLOCK_CAP_MS = 15 * 60_000;

// Issue #3 (2026-04-27): planner-empty model fallback. When the
// primary planner returns 0 valid todos after parse + grounding +
// repair, we re-prompt ONCE with a sibling model — same prompt,
// different model. Hardcoded for the REASONING-tier models we ship;
// per-run cfg.plannerFallbackModel overrides. Returns undefined for
// unknown / coding-tier / verifier-tier models so the caller falls
// through to "no fallback."
//
// 2026-04-27 (later): pair is glm-5.1 ↔ nemotron now. deepseek-v4-pro
// kept as a fallback target FROM either (in case user picks it
// explicitly), but it's unstable and not chosen as a sibling FOR
// either. nemotron is the safer fallback for all three.
// 2026-06-29: disabled. Model switching for content issues (invalid JSON,
// empty response) is dead code — both models route through the same provider
// path and fail the same way. The real safety net is stuck-cycle detection +
// planner fallback + auditor re-fires. Empty map makes withSiblingRetry
// return false immediately at its guard clause.
export const SIBLING_MODELS: Readonly<Record<string, string>> = {};

export function siblingModelFor(model: string): string | undefined {
  return SIBLING_MODELS[model];
}

// Phase 5c of #243: derive {tag → count} for the planner prompt's
// AVAILABLE WORKER TAGS section. Empty array when no workers carry a
// tag — the planner sees no tag block + emits no preferredTag.
export function computeWorkerTagCounts(
  topology: Topology | undefined,
): Array<{ tag: string; count: number }> {
  if (!topology) return [];
  const counts = new Map<string, number>();
  for (const a of topology.agents) {
    if (!a.tag) continue;
    const t = a.tag.trim();
    if (t.length === 0) continue;
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return Array.from(counts.entries()).map(([tag, count]) => ({ tag, count }));
}