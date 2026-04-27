// 2026-04-27: SSE-aware turn watchdog. Replaces the old wall-clock
// "4-min absolute turn cap" pattern that killed prompts the model was
// actively producing (cloud streaming has long-tail latency for big
// prompts, but SSE chunks keep arriving — wall clock saw "4 min" and
// killed regardless).
//
// New behavior: abort only if EITHER
//   1. SSE has been idle > SSE_IDLE_CAP_MS (real model-is-stuck signal,
//      derived from AgentManager.getLastActivity which touches on every
//      matching SSE event), AND turn has been running > SSE_IDLE_CAP_MS
//      (so we don't false-fire before the first chunk arrives).
//   2. Total wall-clock exceeded HARD_MAX_MS (runaway protection — a
//      model emitting heartbeats forever still gets killed eventually).
//
// Both conditions are independent; either trips the abort. The clean
// abort path also tells opencode to cancel via session.abort so the
// upstream cloud generator releases its slot promptly.

import type { AgentManager } from "../services/AgentManager.js";

export interface SseAwareTurnWatchdogOpts {
  manager: AgentManager;
  sessionId: string;
  controller: AbortController;
  /** Best-effort opencode-level cancellation. Called when the watchdog
   *  trips so the cloud generator releases its slot. */
  abortSession: () => Promise<void>;
  /** Default 90s. Aborts when no SSE event has touched this session
   *  for this long (after at least this long has elapsed since turnStart). */
  sseIdleCapMs?: number;
  /** Default 30 min. Hard wall-clock ceiling — runaway protection. */
  hardMaxMs?: number;
  /** Default 10s. How often the watchdog checks. */
  pollIntervalMs?: number;
}

export interface SseAwareTurnWatchdogResult {
  /** Stop the watchdog (call in finally). */
  cancel: () => void;
  /** When non-null, the abort reason — one of: SSE_IDLE / HARD_MAX. */
  getAbortReason: () => string | null;
}

export function startSseAwareTurnWatchdog(opts: SseAwareTurnWatchdogOpts): SseAwareTurnWatchdogResult {
  const sseIdleCapMs = opts.sseIdleCapMs ?? 90_000;
  const hardMaxMs = opts.hardMaxMs ?? 30 * 60_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 10_000;
  const turnStart = Date.now();
  let abortedReason: string | null = null;
  // Touch activity at turn start so the SSE-idle check has a baseline
  // before the first SSE event arrives. AgentManager.getLastActivity
  // would otherwise return undefined for a fresh session.
  opts.manager.touchActivity(opts.sessionId, turnStart);

  const handle = setInterval(() => {
    if (abortedReason !== null) return; // already aborted
    const now = Date.now();
    const elapsed = now - turnStart;
    if (elapsed > hardMaxMs) {
      abortedReason = `hard wall-clock cap hit (${(hardMaxMs / 60_000).toFixed(0)}min)`;
      opts.controller.abort(new Error(abortedReason));
      void opts.abortSession().catch(() => {});
      return;
    }
    const lastActivity = opts.manager.getLastActivity(opts.sessionId) ?? turnStart;
    const sseIdleMs = now - lastActivity;
    if (sseIdleMs > sseIdleCapMs && elapsed > sseIdleCapMs) {
      abortedReason = `SSE idle ${(sseIdleMs / 1000).toFixed(0)}s (turn elapsed ${(elapsed / 1000).toFixed(0)}s)`;
      opts.controller.abort(new Error(abortedReason));
      void opts.abortSession().catch(() => {});
    }
  }, pollIntervalMs);

  return {
    cancel: () => clearInterval(handle),
    getAbortReason: () => abortedReason,
  };
}
