// E3 Phase 3 (slice): lightweight replacement for the opencode session.
// Holds the minimal state an Agent actually needs when prompts route
// through pickProvider (E3 Phase 1+2) instead of through opencode.
//
// Today (Phase 3 slice): only BaselineRunner consumes this. The 8 other
// runners still spawn an opencode subprocess via AgentManager.spawnAgent.
// Generalizing to all runners is the rest of Phase 3 — bigger surface
// because each runner uses opencode-specific shapes (session.prompt,
// event.subscribe, message routing, tool grants).

import { randomUUID } from "node:crypto";

export interface Session {
  /** Stable id used by callers that previously consumed agent.sessionId. */
  id: string;
  /** Model string — provider-prefixed form (e.g. "anthropic/claude-opus-4-7" or "glm-5.1:cloud"). */
  model: string;
  /** AbortController for any in-flight provider call. killAll fires it. */
  abortController: AbortController;
  /** Wall-clock ms session was minted. */
  createdAt: number;
}

export function createSession(model: string): Session {
  return {
    id: randomUUID(),
    model,
    abortController: new AbortController(),
    createdAt: Date.now(),
  };
}

// Test seam: lets unit tests build a Session with a known id without
// pulling in randomUUID's non-determinism.
export function createSessionForTest(model: string, id: string): Session {
  return {
    id,
    model,
    abortController: new AbortController(),
    createdAt: 0,
  };
}
