// E3 Phase 3: one-shot chat helper for the 5 direct session.prompt
// callers that bypass promptWithRetry's retry loop (auditorSeedBuilder,
// goalGenerationPrePass, reflectionPasses, runEndReflection,
// promptAndExtract). When USE_SESSION_NO_OPENCODE OR USE_SESSION_PROVIDER
// is set, routes through pickProvider; else falls back to opencode's
// session.prompt for back-compat.
//
// Returns the {data: {parts: [{type, text}]}} SDK shape every existing
// caller already handles, so the migration is a pure call-site swap
// without touching response-extraction code.

import type { Agent } from "../services/AgentManager.js";
import { pickProvider } from "../providers/pickProvider.js";
import { config } from "../config.js";
import { tokenTracker } from "../services/ollamaProxy.js";
import { toOpenCodeModelRef } from "../../../shared/src/providers.js";

export interface ChatOnceOpts {
  /** opencode agent profile to invoke under (swarm / swarm-read / swarm-builder / swarm-ui).
   *  Honored only on the legacy SDK path; the provider path doesn't have profiles. */
  agentName: string;
  /** Prompt text to send. */
  promptText: string;
  /** Cancel the in-flight call. When undefined, an internal never-fired
   *  AbortController is used (matches legacy behavior of session.prompt
   *  callers that didn't pass a signal). */
  signal?: AbortSignal;
  /** Optional cumulative-text streaming hook (provider path only today). */
  onChunk?: (cumulativeText: string) => void;
  /** Diagnostic logger (provider path only today). */
  logDiag?: (record: unknown) => void;
}

// Mirrors what `agent.client.session.prompt` returns so callers don't
// need to branch on shape. Only `text` parts are populated by the
// provider path; tool-use parts arrive in Phase 4 part 2.
export interface ChatOnceResult {
  data: {
    parts: Array<{ type: "text"; text: string }>;
  };
}

export async function chatOnce(
  agent: Agent,
  opts: ChatOnceOpts,
): Promise<ChatOnceResult> {
  const signal = opts.signal ?? new AbortController().signal;
  if (config.USE_SESSION_NO_OPENCODE || config.USE_SESSION_PROVIDER) {
    const t0 = Date.now();
    const { provider, modelId } = pickProvider(agent.model);
    const result = await provider.chat({
      model: modelId,
      messages: [{ role: "user", content: opts.promptText }],
      signal,
      agentId: agent.id,
      logDiag: opts.logDiag,
      ...(opts.onChunk ? { onChunk: opts.onChunk } : {}),
    });
    if (result.usage) {
      tokenTracker.add({
        ts: Date.now(),
        promptTokens: result.usage.promptTokens,
        responseTokens: result.usage.responseTokens,
        durationMs: Date.now() - t0,
        model: agent.model,
        path: `/sdk-direct (${provider.id})`,
      });
    }
    if (result.finishReason === "error") {
      throw new Error(result.errorMessage ?? "chatOnce: provider error");
    }
    if (result.finishReason === "aborted") {
      throw new Error("aborted");
    }
    return { data: { parts: [{ type: "text", text: result.text }] } };
  }
  // Legacy SDK path — preserved verbatim from the old call sites.
  const res = await agent.client.session.prompt(
    {
      sessionID: agent.sessionId,
      agent: opts.agentName,
      model: toOpenCodeModelRef(agent.model),
      parts: [{ type: "text", text: opts.promptText }],
    },
    { signal },
  );
  return res as unknown as ChatOnceResult;
}
