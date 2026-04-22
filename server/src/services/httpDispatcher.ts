// Unit 7: bound undici's per-request header timeout.
//
// The SDK calls `fetch` → undici → OpenCode HTTP server → Ollama → cloud model.
// On large prompts (README + windowed files + transcript) the cloud model's
// time-to-first-byte can exceed undici's default ~5-min headers timeout; the
// socket then drops with UND_ERR_HEADERS_TIMEOUT. The retry layer
// (`swarm/blackboard/retry.ts`) treats that as a transient and tries again, so
// a stuck prompt consumes up to 3 × 5 min + 20 s backoff = ~15 min of
// wall-clock before surfacing to the UI. That's the stall seen on v9 agent-2
// and again on v10.
//
// Fix: install a global undici Dispatcher with a tight headersTimeout. Once
// bytes start flowing we don't care how long the whole body takes (generation
// of a large test file legitimately takes minutes on cloud) — only the
// TTFB window.
//
// bodyTimeout: 0 is critical. If we bounded bodyTimeout to anything finite,
// a legitimately-slow stream would get guillotined mid-response. We only
// want to fail connections that never produced a first byte.

import { Agent, setGlobalDispatcher } from "undici";

// Unit 16 (2026-04-22): bumped 90 s → 180 s after the battle test
// surfaced 25 UND_ERR_HEADERS_TIMEOUT events in 60 minutes of runs,
// concentrated on agents' first prompts where cold-start TTFB on
// cloud-glm-5.1 occasionally crosses 90 s. With the cross-runner retry
// helper landed in the same unit, 3 attempts × 180 s = 540 s worst
// case per turn — still well under the 20 min absolute turn watchdog
// every runner enforces. Healthy runs are unaffected (returns happen
// in the first 30-60 s normally); only the cold-start tail benefits.
export const HEADERS_TIMEOUT_MS = 180_000;

// Exported so the retry layer's budget comment stays honest: 3 attempts
// × HEADERS_TIMEOUT_MS + RETRY_BACKOFF_MS totals = ~5 min worst case.
export const DISPATCHER_OPTIONS = {
  headersTimeout: HEADERS_TIMEOUT_MS,
  bodyTimeout: 0,
} as const;

let installed = false;

export function configureHttpDispatcher(): void {
  if (installed) return;
  setGlobalDispatcher(new Agent(DISPATCHER_OPTIONS));
  installed = true;
}
