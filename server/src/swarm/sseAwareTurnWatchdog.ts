// 2026-06-27: SSE-aware turn watchdog — PASSIVE ONLY.
// No longer aborts anything. The model runs until it finishes naturally.
// This module exists to track SSE activity for display purposes.
// If the model is truly stuck, the user sees it in the streaming dock
// and can stop the run manually.

import type { AgentManager } from "../services/AgentManager.js";

export interface SseAwareTurnWatchdogOpts {
  manager: AgentManager;
  sessionId: string;
  controller: AbortController;
  abortSession: () => Promise<void>;
  sseIdleCapMs?: number;
  hardMaxMs?: number;
  pollIntervalMs?: number;
}

export interface SseAwareTurnWatchdogResult {
  cancel: () => void;
  getAbortReason: () => string | null;
}

export function startSseAwareTurnWatchdog(opts: SseAwareTurnWatchdogOpts): SseAwareTurnWatchdogResult {
  const turnStart = Date.now();
  opts.manager.touchActivity(opts.sessionId, turnStart);

  return {
    cancel: () => {},
    getAbortReason: () => null,
  };
}
