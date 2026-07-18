/**
 * Tool-enabled chat for baseline + discussion wrap-up apply.
 * Binds swarm-builder tools so the model can write/edit the clone,
 * then emit {workingTree:true,...} or classic hunks JSON.
 */

import { pickProvider } from "../providers/pickProvider.js";
import {
  ToolDispatcher,
  defaultToolsForProfile,
} from "../tools/ToolDispatcher.js";
import { recordChatUsage } from "../services/ollamaProxy.js";

export interface GitNativeApplyChatInput {
  model: string;
  agentId: string;
  clonePath: string;
  prompt: string;
  signal: AbortSignal;
  runId?: string;
  /** Default 24 — enough for inspect + a few writes. */
  maxToolTurns?: number;
  /** Usage ledger path label. */
  pathLabel?: string;
}

export interface GitNativeApplyChatResult {
  text: string;
  finishReason: string;
  errorMessage?: string;
  elapsedMs: number;
}

/**
 * One tool-loop chat with write/edit/git_status/git_diff (+ read tools).
 * Caller parses text via parseWorkerResponse and commits workingTree or applies hunks.
 */
export async function runGitNativeApplyChat(
  input: GitNativeApplyChatInput,
): Promise<GitNativeApplyChatResult> {
  const profile = "swarm-builder" as const;
  const tools = defaultToolsForProfile(profile);
  const dispatcher = new ToolDispatcher(
    profile,
    input.clonePath,
    undefined,
    input.agentId,
    undefined,
    input.runId,
  );
  const t0 = Date.now();
  try {
    const { provider, modelId } = pickProvider(input.model);
    const result = await provider.chat({
      model: modelId,
      messages: [{ role: "user", content: input.prompt }],
      signal: input.signal,
      agentId: input.agentId,
      tools,
      dispatcher,
      maxToolTurns: input.maxToolTurns ?? 24,
      runId: input.runId,
      // Prefer free text so the model can use tools then emit JSON envelope.
      // (Some providers skip format when tools are active anyway.)
    });
    recordChatUsage({
      promptTokens: result.usage?.promptTokens,
      responseTokens: result.usage?.responseTokens,
      promptText: input.prompt,
      responseText: result.text,
      durationMs: Date.now() - t0,
      model: input.model,
      path: input.pathLabel ?? `/git-native-apply (${provider.id})`,
      runId: input.runId,
    });
    return {
      text: result.text,
      finishReason: result.finishReason,
      ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
      elapsedMs: Date.now() - t0,
    };
  } finally {
    try {
      await dispatcher.closeMcp();
    } catch {
      /* best-effort */
    }
  }
}
