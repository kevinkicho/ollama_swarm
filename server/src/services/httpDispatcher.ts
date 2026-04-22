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

// 90 s is deliberately generous — healthy cloud TTFB is usually <30 s, but
// the first turn on a cold cloud shard can ramp to ~60 s while the model
// warms. 90 s keeps healthy runs unaffected while cutting a stalled
// connection off ~3× faster than undici's default.
export const HEADERS_TIMEOUT_MS = 90_000;

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
