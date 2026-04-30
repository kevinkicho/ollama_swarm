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
import { tokenTracker } from "../services/ollamaProxy.js";
import { ToolDispatcher, defaultToolsForProfile, type ProfileName } from "../tools/ToolDispatcher.js";

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
  /** E3 Phase 4 part 2: when set + provider path, the model gets tools
   *  bound to this clone. Profile (read from agentName) gates which
   *  tools the dispatcher will execute. Without clonePath, no tools
   *  are advertised — the model answers from prompt context only. */
  clonePath?: string;
  /** Tool-call notification callback — fires per dispatch with name + ok + preview. */
  onTool?: (info: { tool: string; ok: boolean; preview: string }) => void;
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
  // E3 Phase 5: provider path is the only path. Legacy SDK fallback gone.
  {
    const t0 = Date.now();
    const { provider, modelId } = pickProvider(agent.model);
    // E3 Phase 4 part 2: bind tools to the dispatcher when clonePath
    // is supplied AND the agent profile grants any tools.
    const profileForTools: ProfileName | null =
      opts.agentName === "swarm" || opts.agentName === "swarm-read" || opts.agentName === "swarm-builder"
        ? (opts.agentName as ProfileName)
        : opts.agentName === "swarm-ui"
          ? "swarm-read" // swarm-ui inherits read-side tools
          : null;
    // Default clonePath to agent.cwd (set by AgentManager.spawnAgent /
    // spawnAgentNoOpencode) so callers don't have to plumb it through
    // explicitly. Override via opts.clonePath when needed.
    const clonePath = opts.clonePath ?? agent.cwd;
    const tools = clonePath && profileForTools ? defaultToolsForProfile(profileForTools) : [];
    const dispatcher = clonePath && profileForTools && tools.length > 0
      ? new ToolDispatcher(profileForTools, clonePath)
      : undefined;
    const result = await provider.chat({
      model: modelId,
      messages: [{ role: "user", content: opts.promptText }],
      signal,
      agentId: agent.id,
      logDiag: opts.logDiag,
      ...(opts.onChunk ? { onChunk: opts.onChunk } : {}),
      ...(tools.length > 0 ? { tools } : {}),
      ...(dispatcher ? { dispatcher } : {}),
      ...(opts.onTool ? { onTool: opts.onTool } : {}),
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
}
