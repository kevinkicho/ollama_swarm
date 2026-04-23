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
// cloud-glm-5.1 occasionally crosses 90 s.
//
// Unit 39 (2026-04-23): bumped 180 s → 300 s after live kyahoofinance
// smoke showed agent-1 hitting the 180 s cap TWICE in a row at almost
// exactly 182 s, then succeeding on attempt 3 at 80 s. The 182 s reads
// are "undici gave up at the cap, cloud was still producing" — the
// same request would have succeeded at maybe 190-220 s. The 180 s cap
// was throwing away work rather than saving time. At 300 s we still
// kill a truly-stuck connection well under the 20 min absolute turn
// watchdog, but give legitimately-slow cold-starts room to finish.
// Healthy runs (25-60 s TTFB) are unaffected.
//
// Unit 46a (2026-04-23): bumped 300 s → 600 s after the post-Unit-41
// seaj-tsia-study run showed the planner agent (glm-5.1:cloud) hit the
// 300 s cap THREE TIMES IN A ROW on a single audit prompt — not a
// "occasionally slow" pattern, a "this prompt is genuinely too big to
// finish in 5 minutes" pattern. Unit 46b shrinks the audit prompt
// (rationale caps, file-state budget) which should mean 600 s is
// almost never approached; this bump is the safety net for when the
// shrinking isn't enough. Workers (gemma4:31b-cloud, mean 12 s,
// p95 47 s) are nowhere near this cap. The 20-min absolute-turn
// watchdog (BlackboardRunner ABSOLUTE_MAX_MS) is still the outer fence.
export const HEADERS_TIMEOUT_MS = 600_000;

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
